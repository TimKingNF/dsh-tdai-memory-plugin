/**
 * SessionAssets — 会话级资产加载与缓存。
 *
 * 每个 DSH session 首次使用时加载一次（session-start 预热 + pre-step 懒加载兜底）：
 *   - agentDetail / taskDetail   meta 面（需 userKey，缺省降级为 null）
 *   - ctxs                        自有 + 借入（≤2）agent 身份，供 L1 召回与 L2/L3 注入
 *   - profiles                    每个 ctx 的 L3 persona（剥 Scene Navigation）+ L2 索引
 *   - skills                      /v3/skill/listing 的预渲染 <available_skills> 结果
 *   - knowledge                   团队/agent 绑定的知识资源列表（默认关）
 *
 * 对应 MemoryProxy 的 prewarm + hook cache（session_init 缓存策略）。
 * 全部 fail-open：任一来源失败只降级对应块，不影响其它块与 DSH 主链路。
 */
import { stripSceneNavigation } from './text.mjs'
import { buildListingQuery } from './prompts.mjs'

/** chat_memory-{team}-{agent} → { teamId, agentId }（移植自 proxy tdai-fixed-asset.ts）。 */
function parseChatMemoryAssetId(assetId) {
  if (!assetId.startsWith('chat_memory-')) return null
  const marker = '-agt'
  const inner = assetId.slice('chat_memory-'.length)
  const dashAgt = inner.lastIndexOf(marker)
  if (dashAgt < 0) return null
  return { teamId: inner.slice(0, dashAgt), agentId: inner.slice(dashAgt + 1) }
}

export class SessionAssets {
  constructor(client, config, logger = () => {}) {
    this.client = client
    this.config = config
    this.log = logger
    /** Map<sessionId, { promise, value }> */
    this.cache = new Map()
  }

  /** 同步读取（systemPrompt section 的 text 函数是同步的，只能读缓存）。 */
  peek(sessionId) {
    return sessionId ? this.cache.get(sessionId)?.value : undefined
  }

  /** 幂等加载：并发调用共享同一 promise。 */
  ensure(sessionId) {
    if (!sessionId) return Promise.resolve(null)
    let entry = this.cache.get(sessionId)
    if (!entry) {
      entry = { promise: null, value: null }
      entry.promise = this.#load(sessionId)
        .then((value) => { entry.value = value; return value })
        .catch((error) => {
          this.log(`asset load failed for session ${sessionId}: ${error.message}`)
          this.cache.delete(sessionId) // 失败不留毒缓存，下次重试
          return null
        })
      this.cache.set(sessionId, entry)
    }
    return entry.promise
  }

  refresh(sessionId) {
    this.cache.delete(sessionId)
    return this.ensure(sessionId)
  }

  dispose(sessionId) {
    if (sessionId) this.cache.delete(sessionId)
  }

  async #load(sessionId) {
    const cfg = this.config
    const client = this.client
    const identity = {
      space_id: cfg.serviceId,
      team_id: cfg.teamId,
      agent_id: cfg.agentId,
      user_id: cfg.userId,
      task_id: cfg.taskId,
      session_id: sessionId,
    }

    const needAgentDetail = cfg.sessionContextEnabled || cfg.skillsEnabled
    const [agentRaw, taskRaw] = await Promise.all([
      needAgentDetail ? client.metaGetAgent(cfg.agentId) : Promise.resolve(null),
      cfg.taskId && cfg.sessionContextEnabled ? client.metaGetTask(cfg.taskId) : Promise.resolve(null),
    ])
    const agentDetail = agentRaw
      ? { id: agentRaw.agent_id, name: agentRaw.name, description: agentRaw.description, prompt: agentRaw.prompt }
      : null
    const taskDetail = taskRaw
      ? { id: taskRaw.task_id, name: taskRaw.title ?? taskRaw.name, description: taskRaw.description, goal: taskRaw.goal }
      : null

    const ctxs = await this.#resolveFixedAssetCtxs()

    const profiles = cfg.profileMemoryEnabled
      ? await Promise.all(ctxs.map((c) => this.#loadAgentProfile(c)))
      : []

    let skills = null
    if (cfg.skillsEnabled) {
      skills = await client.skillListing({
        teamId: cfg.teamId,
        agentId: cfg.agentId,
        query: buildListingQuery(agentDetail, taskDetail),
      })
    }

    const knowledge = cfg.knowledgeEnabled ? await this.#loadKnowledge() : []

    return { identity, agentDetail, taskDetail, ctxs, profiles, skills, knowledge, loadedAt: Date.now() }
  }

  /**
   * 自有 + 借入 agent 身份（移植自 proxy tdai-fixed-asset.ts）：
   * 读 agent-fixed-asset 里的 chat_memory 绑定 → 同 team 过滤 → 借入 ≤2。
   * 无 userKey / meta 不可达 → 仅自有（向后兼容）。
   */
  async #resolveFixedAssetCtxs() {
    const cfg = this.config
    const self = { teamId: cfg.teamId, userId: cfg.userId, agentId: cfg.agentId, agentName: cfg.agentId, isSelf: true }
    if (!cfg.userKey) return [self]

    const detail = await this.client.metaAgentFixedAssets(cfg.agentId)
    if (!detail) return [self]

    const selfAgent = detail.agent ?? {}
    const selfTeamId = selfAgent.team_id || cfg.teamId
    const items = []
    for (const item of detail.items ?? []) {
      if (item.asset_type !== 'chat_memory') continue
      const parsed = parseChatMemoryAssetId(String(item.asset_id ?? ''))
      if (!parsed || parsed.teamId !== selfTeamId) continue
      if (parsed.agentId === (selfAgent.agent_id ?? cfg.agentId)) continue
      const source = await this.client.metaGetAgent(parsed.agentId)
      if (!source || source.team_id !== selfTeamId) continue
      items.push({
        teamId: source.team_id,
        userId: source.owner_user_id ?? cfg.userId,
        agentId: source.agent_id,
        agentName: source.name || item.name || source.agent_id,
        isSelf: false,
      })
      if (items.length >= 2) break
    }
    if (items.length === 0) return [self]
    return [
      {
        teamId: selfTeamId,
        userId: selfAgent.owner_user_id ?? cfg.userId,
        agentId: selfAgent.agent_id ?? cfg.agentId,
        agentName: selfAgent.name ?? cfg.agentId,
        isSelf: true,
      },
      ...items,
    ]
  }

  async #loadAgentProfile(ctx) {
    const [l3, l2Entries] = await Promise.all([
      this.client.readL3(ctx),
      this.client.listL2(ctx, this.config.l2Limit),
    ])
    const l3Stripped = l3 ? stripSceneNavigation(l3.content) : ''
    return { ctx, l3: l3Stripped.trim() ? { content: l3Stripped } : null, l2Entries: l2Entries ?? [] }
  }

  /** per-agent 绑定优先（需 userKey）；无绑定/无 userKey → team 全量（过渡兼容，对齐 proxy）。 */
  async #loadKnowledge() {
    const cfg = this.config
    if (cfg.userKey) {
      const ids = await this.client.metaAgentKnowledgeIds(cfg.agentId)
      if (ids.length > 0) return this.client.knowledgeList(cfg.teamId, ids)
    }
    return this.client.knowledgeList(cfg.teamId)
  }
}
