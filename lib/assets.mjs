/**
 * SessionAssets — 会话级资产加载与缓存。
 *
 * 每个 DSH session 首次使用时加载一次（session-start / assemble 预热，热路径只读缓存）：
 *   - agentDetail / taskDetail   meta 面（需 userKey，缺省降级为 null）
 *   - ctxs                        自有 + 借入（≤2）agent 身份，供 L1 召回与 L2/L3 注入
 *   - profiles                    每个 ctx 的 L3 persona（剥 Scene Navigation）+ L2 索引
 *   - skills                      /v3/skill/listing 的预渲染 <available_skills> 结果
 *   - knowledge                   团队/agent 绑定的知识资源列表（默认关）
 *
 * 对应 MemoryProxy 的 prewarm + hook cache（session_init 缓存策略）。
 * 全部 fail-open：任一来源失败只降级对应块，不影响其它块与 DSH 主链路。
 *
 * ── 三条"不许卡住主链路"的硬约束（改这个文件前先读）─────────────────────────
 *   1. `peek()` 同步、绝不发请求 —— 热路径（pre-step 召回、同步 section text）只能用它；
 *   2. `warm()` 只负责把加载踢起来，调用方不该 await；
 *   3. `ensure()` 有**总预算**（assetLoadBudgetMs）与**失败冷却**（assetRetryCooldownMs），
 *      保证最坏情况下"第一步"最多等一个预算，且失败不会被每一步重复支付。
 *   为什么：这些 HTTP 全部指向 MemoryCore 网关，网关慢/挂时如果每一步都同步重拉，
 *   用户看到的就是"一开召回，发消息就一直阻塞等待"。
 */
import { stripSceneNavigation } from './text.mjs'
import { buildListingQuery } from './prompts.mjs'

/**
 * 知识服务地址改写：只换 scheme/host/port，path 原样保留。
 *
 * 场景：`/v3/knowledge/list` 返回的 `service_url` 是服务端视角的地址，容器化部署里
 * 常是 `http://host.docker.internal:8424/v3`；插件进程跑在宿主上时不可达。
 * 该情况下配 `knowledgeEndpoint`（如 `http://127.0.0.1:8424`），把 origin 换掉。
 *
 * 坏配置（非法 URL）一律**回落到原地址**，不抛：地址改写是尽力而为的补救，
 * 不该把整包资产加载拖成失败。
 */
export function withKnowledgeOrigin(serviceUrl, overrideEndpoint) {
  const base = String(serviceUrl ?? '').replace(/\/+$/, '')
  const target = String(overrideEndpoint ?? '').trim()
  if (!base || !target) return base
  try {
    const from = new URL(base)
    const to = new URL(target)
    from.protocol = to.protocol
    from.host = to.host
    return from.toString().replace(/\/+$/, '')
  } catch {
    return base
  }
}

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
    /** Map<sessionId, 上次失败时刻>：失败后的冷却期，见 ensure()。 */
    this.failedAt = new Map()
  }

  /** 同步读取（systemPrompt section 的 text 函数是同步的，只能读缓存）。 */
  peek(sessionId) {
    return sessionId ? this.cache.get(sessionId)?.value : undefined
  }

  /**
   * 后台预热：保证加载被发起，但**调用方不该 await 它**（热路径上用 peek 即可）。
   *
   * 与 ensure 的差别只在语义/意图上（同一个 promise 缓存）：热路径（pre-step 召回、
   * 同步 section text）不应该把整包资产加载挡在模型请求前面 —— 那些位置用
   * `peek()` 拿「已就绪就用」，再用本方法把加载踢起来。
   */
  warm(sessionId) {
    return this.ensure(sessionId)
  }

  /**
   * 幂等加载：并发调用共享同一 promise；**失败后有冷却期**，冷却期内立刻返回 null。
   *
   * 冷却期（`assetRetryCooldownMs`）是修"一开召回就卡"的关键一环：早先失败即删缓存，
   * 于是每一步 pre-step / assemble 都会把整包资产重新拉一遍（meta 面 + 各 agent 的
   * L3/L2 + skill listing + 知识资源，每个请求最多 5s 超时）。网关慢或某个端点一直
   * 失败时，每步都在重付这份代价，表现就是**一直阻塞等待、像死循环**。
   * 现在失败只记一个时间戳：冷却期内一律走降级路径（无 L2/L3/Skill 注入、
   * 召回退回自有 agent），冷却期过后下一次 ensure 才重试。
   *
   * 另外整包加载还有一个**总预算**（`assetLoadBudgetMs`）：超过预算按失败处理。
   * 单个请求有 timeoutMs，但请求是**串行分组**的（meta → 固定资产 → 画像 → skill），
   * 没有总闸门时最坏情况是所有分组各自吃满超时。
   */
  ensure(sessionId) {
    if (!sessionId) return Promise.resolve(null)
    const cached = this.cache.get(sessionId)
    if (cached) return cached.promise
    if (this.#coolingDown(sessionId)) return Promise.resolve(null)

    const entry = { promise: null, value: null }
    entry.promise = this.#loadBounded(sessionId)
      .then((value) => { entry.value = value; this.failedAt.delete(sessionId); return value })
      .catch((error) => {
        this.failedAt.set(sessionId, Date.now())
        this.cache.delete(sessionId) // 不留毒缓存；重试由冷却期闸门控制
        const cooldownMs = Number(this.config.assetRetryCooldownMs) || 0
        this.log(`asset load failed for session ${sessionId}: ${error?.message ?? error}`
          + (cooldownMs > 0 ? `（${Math.round(cooldownMs / 1000)}s 内不再重试，降级运行）` : ''))
        return null
      })
    this.cache.set(sessionId, entry)
    return entry.promise
  }

  refresh(sessionId) {
    this.cache.delete(sessionId)
    this.failedAt.delete(sessionId) // 显式刷新（/tdai-sync）无视冷却期
    return this.ensure(sessionId)
  }

  dispose(sessionId) {
    if (sessionId) {
      this.cache.delete(sessionId)
      this.failedAt.delete(sessionId)
    }
  }

  /** 是否在上次失败的冷却期内（期内不重试，走降级路径）。 */
  #coolingDown(sessionId) {
    const cooldownMs = Number(this.config.assetRetryCooldownMs) || 0
    if (cooldownMs <= 0) return false
    const failedAt = this.failedAt.get(sessionId)
    return failedAt !== undefined && Date.now() - failedAt < cooldownMs
  }

  /** 给 #load 加一个总预算；超时按失败处理（迟到的失败自己吞掉，不外溢）。 */
  async #loadBounded(sessionId) {
    const budgetMs = Number(this.config.assetLoadBudgetMs) || 0
    const load = this.#load(sessionId)
    if (budgetMs <= 0) return load
    // 超时后 load 还在跑：它的失败必须有人接住，否则会变成 unhandled rejection。
    load.catch(() => {})
    let timer
    try {
      return await Promise.race([
        load,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`整包资产加载超过 ${budgetMs}ms 预算`)), budgetMs)
          timer.unref?.()
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
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
    // per-agent 绑定优先（需要 userKey）；无绑定或没有 userKey 时退回团队全量
    let ids = []
    if (cfg.userKey) ids = await this.client.metaAgentKnowledgeIds(cfg.agentId)
    const items = await this.client.knowledgeList(cfg.teamId, ids)
    // 地址改写在"进入任何下游调用之前"完成：工具与 skill 正文都只认 asset 里的 service_url
    const normalized = items.map((item) => ({
      ...item,
      service_url: withKnowledgeOrigin(item.service_url, cfg.knowledgeEndpoint),
    }))
    return this.#enrichKnowledgeWithTools(normalized)
  }

  /**
   * 给每个知识资源附上它的可用工具清单（`tools/list`）。
   *
   * 为什么在会话开始时预取、而不是让模型自己发现：知识服务是
   * **progressive-exposure** 设计（先 tools/list 再 tools/call，doc:507-510）。
   * 预取之后，这份清单会写进 `tdai-team-knowledge` skill 的正文 —— 模型
   * **加载 skill 的那一刻就拿到了可用工具名与参数**，省掉一次往返；
   * 而原生工具 `tdai_knowledge_call` 只负责执行。
   *
   * 失败不抛：拿不到清单的资源 tools 为 undefined，skill 正文会退回
   * "先用 tdai_knowledge_tools 查一次"的指引。全部 fail-open。
   */
  async #enrichKnowledgeWithTools(items) {
    if (!Array.isArray(items) || items.length === 0) return []
    return Promise.all(items.map(async (item) => {
      const tools = await this.client.knowledgeToolsList(item.service_url, item.knowledge_id)
      return tools ? { ...item, tools } : item
    }))
  }
}
