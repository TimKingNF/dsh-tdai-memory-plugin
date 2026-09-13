/**
 * GatewayClient — MemoryCore Gateway HTTP 客户端。
 *
 * 端点与 header/body 形状对齐 MemoryProxy（src/tdai/client.ts、src/skill/core-client.ts、
 * src/knowledge/core-client.ts、src/meta/client.ts），已验证可用的最小集合：
 *
 *   数据面（Bearer apiKey + x-tdai-service-id + 身份 header）：
 *     /v3/conversation/add            L0 短期记忆写入
 *     /v3/skill/conversation/add      Skill 归档触发（core 侧按阈值归档）
 *     /v3/atomic/search               L1 原子记忆 hybrid search
 *     /v3/conversation/search         L0 对话原文检索
 *     /v3/scenario/ls | /v3/scenario/read   L2 场景索引 / 全文
 *     /v3/core/read                   L3 persona
 *     /v3/skill/search | /v3/skill/listing | /v3/skill/get-by-name
 *     /v3/knowledge/list              团队知识资源
 *   meta 面（另需 x-tdai-user-key）：
 *     /v3/meta/agent/get | /v3/meta/task/get | /v3/meta/agent-fixed-asset/list-with-detail
 *
 * 所有方法 fail-open：网络/HTTP/envelope 错误返回 fallback 并经 logger 记录，
 * 绝不把异常抛进 DSH 主链路。
 */
const TAG = '[tdai-memory]'
const META_PAGE_SIZE = 100
const META_HARD_LIMIT = 500

function stripUndefined(body) {
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined))
}

function toCtxIds(ctx) {
  return { team_id: ctx.teamId, user_id: ctx.userId, agent_id: ctx.agentId }
}

/** 会话级身份的 body 形态（写侧与检索共用）。 */
function identityBody(identity) {
  return {
    space_id: identity.space_id,
    team_id: identity.team_id,
    user_id: identity.user_id,
    agent_id: identity.agent_id,
    session_id: identity.session_id,
    task_id: identity.task_id,
  }
}

export class GatewayClient {
  constructor(config, logger = () => {}) {
    this.endpoint = String(config.endpoint || 'http://127.0.0.1:8420').replace(/\/$/, '')
    this.apiKey = config.apiKey || ''
    this.serviceId = config.serviceId || ''
    this.userKey = config.userKey || ''
    this.timeoutMs = config.timeoutMs || 5000
    this.log = logger
  }

  headers(identity, { session = true, task = true, userKey = false } = {}) {
    const h = {
      'content-type': 'application/json',
      authorization: `Bearer ${this.apiKey || 'local'}`,
      'x-tdai-service-id': this.serviceId || 'default',
    }
    if (identity?.team_id) h['x-tdai-team-id'] = identity.team_id
    if (identity?.user_id) h['x-tdai-user-id'] = identity.user_id
    if (identity?.agent_id) h['x-tdai-agent-id'] = identity.agent_id
    if (session && identity?.session_id) h['x-tdai-session-id'] = identity.session_id
    if (task && identity?.task_id) h['x-tdai-task-id'] = identity.task_id
    if (userKey && this.userKey) h['x-tdai-user-key'] = this.userKey
    return h
  }

  /** 原始 POST：失败抛错，由 safe() 或调用方决定降级策略。 */
  async post(path, body, opts = {}) {
    const resp = await fetch(`${this.endpoint}${path}`, {
      method: 'POST',
      headers: this.headers(opts.identity, opts),
      body: JSON.stringify(stripUndefined(body ?? {})),
      signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs),
    })
    const payload = await resp.json().catch(() => ({}))
    if (!resp.ok) throw new Error(`${TAG} ${path} HTTP ${resp.status}`)
    if (typeof payload?.code === 'number' && payload.code !== 0) {
      throw new Error(`${TAG} ${path} code=${payload.code} ${payload.message ?? ''}`.trim())
    }
    return payload?.data ?? {}
  }

  /** fail-open 包装：出错记日志并返回 fallback。 */
  async safe(path, body, opts = {}, fallback = null) {
    try {
      return await this.post(path, body, opts)
    } catch (error) {
      this.log(`${path} failed: ${error.message}`)
      return fallback
    }
  }

  // ── 写侧（对话回流）──────────────────────────────────────────────────────

  /** L0 短期记忆写入。调用方负责分片/分批与同 session 串行。 */
  addConversation(identity, messages) {
    return this.safe('/v3/conversation/add', { ...identityBody(identity), messages }, { identity })
  }

  /** Skill 归档触发：core 侧累计到阈值后归档并异步抽取。 */
  addSkillConversation(identity, messages) {
    return this.safe('/v3/skill/conversation/add', { ...identityBody(identity), messages }, { identity })
  }

  /** 强制归档当前 session 的 Skill 缓冲（对应 mem:create-skill / /tdai-archive）。 */
  forceArchive(identity, reason) {
    return this.safe('/v3/skill/conversation/force-archive', {
      ...identityBody(identity),
      reason,
    }, { identity }, null)
  }

  // ── L0 / L1 检索 ─────────────────────────────────────────────────────────

  /**
   * L1 召回。ctx = { teamId, userId, agentId }（自有或借入 agent）；
   * session/task 归属用调用方的，与 proxy searchL1ForCtx 语义一致。
   */
  async searchL1(ctx, query, { sessionId, taskId, limit } = {}, signal) {
    if (!query || !query.trim()) return []
    const identity = { ...toCtxIds(ctx), session_id: sessionId, task_id: taskId }
    const data = await this.safe('/v3/atomic/search', {
      ...identity, query: query.slice(0, 2048), limit,
    }, { identity, signal }, {})
    return (data?.items ?? [])
      .map((item) => ({
        id: String(item?.id ?? ''),
        type: typeof item?.type === 'string' ? item.type : undefined,
        content: typeof item?.content === 'string' ? item.content : '',
        score: typeof item?.score === 'number' ? item.score : undefined,
        updatedAt: typeof item?.updated_at === 'string' ? item.updated_at : undefined,
      }))
      .filter((m) => m.id && m.content)
  }

  /** L0 对话原文检索（tdai_conversation_search 工具用）。 */
  searchConversation(identity, query, limit, signal) {
    return this.safe('/v3/conversation/search', {
      ...identityBody(identity),
      query: String(query ?? '').slice(0, 2048), limit,
    }, { identity, signal }, {})
  }

  /** L1 结构化查询：按 type / 时间窗 / 分页（tdai_memory_query 工具用）。 */
  atomicQuery(identity, { type, timeStart, timeEnd, limit, offset } = {}, signal) {
    return this.safe('/v3/atomic/query', {
      ...identityBody(identity),
      type,
      time_start: timeStart,
      time_end: timeEnd,
      limit,
      offset,
    }, { identity, signal }, {})
  }

  /** L0 结构化查询：按 session / 时间窗 / 分页（tdai_conversation_query 工具用）。 */
  conversationQuery(identity, { sessionId, timeStart, timeEnd, limit, offset } = {}, signal) {
    return this.safe('/v3/conversation/query', {
      ...identityBody(identity),
      session_id: sessionId ?? identity.session_id,
      time_start: timeStart,
      time_end: timeEnd,
      limit,
      offset,
    }, { identity, signal }, {})
  }

  // ── L2 / L3 ──────────────────────────────────────────────────────────────

  /** L2 场景索引：仅 path + summary，不读全文。prefix 可选前缀过滤。 */
  async listL2(ctx, limit, prefix = '') {
    const identity = toCtxIds(ctx)
    const data = await this.safe('/v3/scenario/ls',
      { team_id: ctx.teamId, agent_id: ctx.agentId, path_prefix: prefix },
      { identity, session: false, task: false }, {})
    return (data?.entries ?? [])
      .map((e) => ({
        path: String(e?.path ?? ''),
        summary: typeof e?.summary === 'string' ? e.summary : undefined,
        updatedAt: typeof e?.updated_at === 'string' ? e.updated_at : undefined,
      }))
      .filter((e) => e.path && !e.path.endsWith('/'))
      .slice(0, limit)
  }

  /** L2 场景全文（tdai_read_scene 工具用）。 */
  async readL2(ctx, path) {
    if (!path) return null
    const identity = toCtxIds(ctx)
    const data = await this.safe('/v3/scenario/read',
      { team_id: ctx.teamId, agent_id: ctx.agentId, path },
      { identity, session: false, task: false }, null)
    const content = typeof data?.content === 'string' ? data.content : ''
    if (!content) return null
    return { path, content, updatedAt: typeof data?.updated_at === 'string' ? data.updated_at : undefined }
  }

  /** L3 persona（可能内嵌 Scene Navigation 段，由调用方剥离）。 */
  async readL3(ctx) {
    const identity = toCtxIds(ctx)
    const data = await this.safe('/v3/core/read',
      { team_id: ctx.teamId, agent_id: ctx.agentId },
      { identity, session: false, task: false }, null)
    const content = typeof data?.content === 'string' ? data.content : ''
    if (!content) return null
    return { content, updatedAt: typeof data?.updated_at === 'string' ? data.updated_at : undefined }
  }

  // ── Skill ────────────────────────────────────────────────────────────────

  /** 团队 Skill 库检索（tdai_skill_search 工具用，跨 agent）。 */
  searchSkills(identity, query, topK, signal) {
    return this.safe('/v3/skill/search', {
      ...identityBody(identity),
      query: String(query ?? '').slice(0, 2048), top_k: topK,
    }, { identity, signal }, {})
  }

  /** agent 自有 skill 目录；返回含预渲染 <available_skills> 块。query 缺省时 core 走 mode=full。 */
  async skillListing({ teamId, agentId, query }) {
    const data = await this.safe('/v3/skill/listing',
      { team_id: teamId, agent_id: agentId, query }, {}, null)
    if (!data || typeof data.listing !== 'string') return null
    return { mode: data.mode, listing: data.listing, hits: Array.isArray(data.hits) ? data.hits : [] }
  }

  /** 打开单个 skill：SKILL.md 全文 + manifest（tdai_skill_view 工具用）。 */
  skillView(identity, skillName) {
    return this.safe('/v3/skill/get-by-name', {
      team_id: identity.team_id, agent_id: identity.agent_id, user_id: identity.user_id,
      skill_name: skillName, include_content: true, include_manifest: true,
    }, { identity }, null)
  }

  // ── Knowledge ────────────────────────────────────────────────────────────

  /** 团队知识资源；ids 非空时按 knowledge_ids 联查（per-agent 绑定视图）。 */
  async knowledgeList(teamId, ids) {
    const body = { team_id: teamId }
    if (Array.isArray(ids) && ids.length > 0) body.knowledge_ids = ids
    const data = await this.safe('/v3/knowledge/list', body, {}, null)
    return Array.isArray(data?.items) ? data.items : []
  }

  // ── meta 面（需 userKey；缺省时调用方应跳过并降级）─────────────────────────

  metaGetAgent(agentId) {
    if (!agentId) return Promise.resolve(null)
    return this.safe('/v3/meta/agent/get', { agent_id: agentId }, { userKey: true }, null)
  }

  metaGetTask(taskId) {
    if (!taskId) return Promise.resolve(null)
    return this.safe('/v3/meta/task/get', { task_id: taskId }, { userKey: true }, null)
  }

  /**
   * agent 固定资产列表（分页聚合，停止条件对齐 proxy meta/client.ts）。
   * assetTypes 非空时加服务端过滤（借入 chat_memory / knowledge 两路复用）。
   */
  async metaAgentFixedAssets(agentId, assetTypes) {
    if (!agentId || !this.userKey) return null
    const items = []
    let agent = {}
    let offset = 0
    for (;;) {
      const body = { agent_id: agentId, limit: META_PAGE_SIZE, offset, apply_visibility_filter: true }
      if (Array.isArray(assetTypes) && assetTypes.length > 0) {
        body.asset_types = assetTypes
        body.touch_usage = false
      }
      const resp = await this.safe('/v3/meta/agent-fixed-asset/list-with-detail', body, { userKey: true }, null)
      if (!resp) return null
      agent = resp.agent ?? agent
      const page = Array.isArray(resp.items) ? resp.items : []
      items.push(...page)
      const total = typeof resp.total === 'number' ? resp.total : items.length
      if (items.length >= total || page.length === 0 || page.length < META_PAGE_SIZE) break
      if (items.length >= META_HARD_LIMIT) break
      offset += META_PAGE_SIZE
    }
    return { agent, items, total: items.length }
  }

  /** agent 绑定的 knowledge asset_id（= knowledge_id）集合。 */
  async metaAgentKnowledgeIds(agentId) {
    const detail = await this.metaAgentFixedAssets(agentId, ['llm_wiki', 'code_graph'])
    if (!detail) return []
    return detail.items
      .filter((it) => (it.asset_type === 'llm_wiki' || it.asset_type === 'code_graph')
        && it.status !== 'archived' && it.status !== 'deprecated' && it.status !== 'failed')
      .map((it) => it.asset_id)
      .filter(Boolean)
  }
}
