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
 *     /v3/skill/search | /v3/skill/get-by-name
 *     /v3/knowledge/list              团队知识资源
 *   meta 面（另需 x-tdai-user-key）：
 *     /v3/meta/agent/get | /v3/meta/task/get | /v3/meta/agent-fixed-asset/list-with-detail
 *     /v3/meta/task/create | update | list | delete          ← 对话内待办写入（读用 safe，写用 post）
 *
 * 读侧方法一律 fail-open：网络/HTTP/envelope 错误返回 fallback 并经 logger 记录，
 * 绝不把异常抛进 DSH 主链路。**例外是 meta 面的 task 写侧**（create/update/list/delete）：
 * 它们把异常原样抛给调用方，由工具层转成模型可见的失败信息（见下方方法上的说明）。
 */
const TAG = '[tdai-memory]'
const META_PAGE_SIZE = 100
const META_HARD_LIMIT = 500

function stripUndefined(body) {
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined))
}

/**
 * 错误摘要：fetch 的网络级失败会把真实原因藏在 `error.cause` 里
 * （`ECONNREFUSED` / `ENOTFOUND` / `UND_ERR_CONNECT_TIMEOUT` …），只打
 * `error.message`（就是一句 "fetch failed"）等于没打 —— 排查时定位不到连接层。
 * 这一层约定：日志里 cause 的 code 优先，没有 code 才退 message。
 */
function describeError(error) {
  const cause = error?.cause
  const causeText = typeof cause?.code === 'string' && cause.code
    ? cause.code
    : (typeof cause?.message === 'string' ? cause.message : '')
  const message = String(error?.message ?? error)
  return causeText ? `${message}（cause: ${causeText}）` : message
}

/**
 * wiki 的 `read_page` 成功时返回 `{ items: [{ ref, content }] }`：
 * **引用取不到内容时服务端照样回 `code=0` + 空 `content`**（实测 2026-10-14：
 * `wiki/concepts/不存在的页.md` → 空串，200 OK）。对模型来说，"页面不存在 / 路径写错 /
 * 空页"与"这页就是空的"长得一模一样，于是它会拿一个空结果当结论用。
 * 这里补一句显式说明（只在 JSON 分支上追加，不改服务端返回的结构）。
 */
function annotateEmptyRefs(data) {
  const items = data?.items
  if (!Array.isArray(items) || items.length === 0) return ''
  const empty = items
    .filter((it) => !String(it?.content ?? '').trim())
    .map((it) => String(it?.ref ?? '?'))
  if (empty.length === 0) return ''
  return `\n\n[tdai] ${empty.length} 个引用没取到内容（页面不存在、路径写错或本来就是空页）：${empty.join('、')}`
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
    if (!resp.ok) {
      // 非 2xx 时内核把原因放在**响应体**里（实测 401 `missing_user_key`、
      // 403 `permission_denied: caller is not resource owner`）。只抛一句 `HTTP 403`
      // 等于把唯一能修的线索丢掉 —— 而写侧（meta task）的错误是要回给模型看的，
      // 它必须能分清"没配 user key" / "没权限" / "服务不可达"。
      const detail = [payload?.code !== undefined ? `code=${payload.code}` : '', payload?.message ?? '']
        .filter(Boolean).join(' ')
      throw new Error(`${TAG} ${path} HTTP ${resp.status}${detail ? ` ${detail}` : ''}`)
    }
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
      this.log(`${path} failed: ${describeError(error)}`)
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
   *
   * `opts.signal` 让调用方（lib/recall.mjs）能施加**硬超时**：网关不响应时这一步
   * 必须放弃召回继续走，而不是把整轮挡住（超时由 safe() 归为失败 → 返回空命中）。
   */
  async searchL1(ctx, query, { sessionId, taskId, limit, signal } = {}, signalArg) {
    if (!query || !query.trim()) return []
    const identity = { ...toCtxIds(ctx), session_id: sessionId, task_id: taskId }
    const data = await this.safe('/v3/atomic/search', {
      ...identity, query: query.slice(0, 2048), limit,
    }, { identity, signal: signal ?? signalArg }, {})
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

  /** 团队 Skill 库检索（tdai_skill_search 工具用，跨 agent；也用于每轮 skill 召回）。 */
  searchSkills(identity, query, topK, signal) {
    return this.safe('/v3/skill/search', {
      ...identityBody(identity),
      // core 的 searchRequestSchema 限 query 1..2048 字符：**必须在客户端截断**，
      // 否则粘贴长日志/长文时会被 core 以 40001 拒绝。历史事故：`/v3/skill/listing`
      // 那条路径就是因为 query 没截断（7,162 字符）而永久失败、且静默。
      query: String(query ?? '').slice(0, 2048), top_k: topK,
    }, { identity, signal }, {})
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

  // ── 知识服务（wiki / code-graph）─────────────────────────────────────────────
  //
  // 注意：这两个端点**不在 MemoryCore 上**，而在每个知识资源自己的 `service_url`
  // （已含 API 路径，如 http://kb.internal/v3）。因此不能复用 this.post() 的固定
  // endpoint，需要按资源切换 base。
  //
  // 调用契约（TencentDB-Agent-Memory/MemoryKnowledge/v3-api-memoryknowledge-doc.md:507-575）：
  //   POST {service_url}/tools/list  body { knowledge_id }                  → { tools: [{name, description, params}] }
  //   POST {service_url}/tools/call  body { knowledge_id, tool_name, params }
  // 两者都要求 `x-tdai-service-id`（租户标识），无需密钥。

  /**
   * 对任意 base 发一次 POST（**带 1 次重试**），**永不外抛**。
   *
   * 返回 `{ ok: true, data }` 或 `{ ok: false, error }`：`error` 是**给模型看的一句话**，
   * 含 HTTP 状态 / 业务 code / 服务端 message（纯网络层失败才说"请求失败"，并带 cause）。
   *
   * ── 为什么不再是"失败返回 null"──────────────────────────────────────────────
   * 早先这里失败一律 `return fallback`（null），调用方只能回一句"知识服务不可达"。
   * 实测后果（2026-10-14）：模型把 `read_page` 的 `refs` 写成了 `path`，服务端明确回
   * `code=400 · refs is required (non-empty array)`，而模型收到的是"知识服务不可达" ——
   * 一个"对方挂了"的假诊断。它据此连试四种参数写法后放弃知识库、改用本地文件拼文档。
   * 诊断信息本来就有（服务端给了、日志里也打了），只是没转达给唯一能修它的那一方。
   *
   * ── 重试判据（别把确定性失败也重试一遍）─────────────────────────────────────
   *   - 网络错误 / 超时：重试（`error.retryable` 缺省为真）；
   *   - HTTP 5xx / 429：重试；
   *   - HTTP 4xx 与信封里的 `code != 0`：**不重试** —— 请求本身有问题，
   *     再要一遍只会得到同样的答案，白等一个 timeout。
   *
   * 日志把每次尝试分开打，并带上失败原因（含 cause 的 code）与耗时：
   * 重试成功留痕（"第 2 次尝试成功"），最终失败写明是第几次、是否重试过。
   */
  async #postTo(baseUrl, path, body) {
    const base = String(baseUrl || '').replace(/\/$/, '')
    if (!base) return { ok: false, error: '知识服务的 service_url 为空。' }
    const maxAttempts = 2
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const startedAt = Date.now()
      try {
        const resp = await fetch(`${base}${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-tdai-service-id': this.serviceId || 'default',
          },
          body: JSON.stringify(stripUndefined(body ?? {})),
          signal: AbortSignal.timeout(this.timeoutMs),
        })
        const payload = await resp.json().catch(() => ({}))
        if (!resp.ok) {
          const error = new Error(`${TAG} ${base}${path} HTTP ${resp.status}`)
          error.retryable = resp.status >= 500 || resp.status === 429
          // 服务端在 4xx 里通常也带了 message，一并转达
          error.brief = `HTTP ${resp.status}${payload?.message ? ` · ${payload.message}` : ''}`
          throw error
        }
        if (typeof payload?.code === 'number' && payload.code !== 0) {
          const error = new Error(`${TAG} ${base}${path} code=${payload.code} ${payload.message ?? ''}`.trim())
          error.retryable = false // 业务拒绝：重试无意义
          error.brief = `code=${payload.code}${payload.message ? ` · ${payload.message}` : ''}`
          throw error
        }
        if (attempt > 1) {
          this.log(`knowledge ${path} 第 ${attempt} 次尝试成功（${Date.now() - startedAt}ms）`)
        }
        return { ok: true, data: payload?.data ?? {} }
      } catch (error) {
        const detail = describeError(error)
        const elapsed = Date.now() - startedAt
        if (error?.retryable !== false && attempt < maxAttempts) {
          this.log(`knowledge ${path} 第 ${attempt}/${maxAttempts} 次尝试失败（${elapsed}ms）：${detail} —— 重试一次`)
          continue
        }
        const why = error?.retryable === false ? '确定性失败，不重试' : `重试后仍失败（共 ${attempt} 次）`
        this.log(`knowledge ${path} ${why}（${elapsed}ms）：${detail}`)
        return { ok: false, error: error?.brief ?? `请求失败（${detail}）` }
      }
    }
    return { ok: false, error: '知识服务请求失败。' }
  }

  /**
   * 列出某个知识资源可用的工具（tools/list）。
   * 返回 `{ ok: true, tools }` / `{ ok: false, error }` —— 失败与"资源确实没有工具"
   * （`tools: []`）必须分得开，否则调用方只能把两者都说成"不可达"。
   */
  async knowledgeToolsList(serviceUrl, knowledgeId) {
    const result = await this.#postTo(serviceUrl, '/tools/list', { knowledge_id: knowledgeId })
    if (!result.ok) return result
    const tools = result.data?.tools
    if (!Array.isArray(tools)) return { ok: false, error: '服务未返回 tools 字段。' }
    return { ok: true, tools }
  }

  /**
   * 执行某个知识资源的只读查询工具（tools/call）。
   *
   * 返回 `{ ok, text }` 而不是裸数据：知识服务在 code-graph 工具执行失败时仍回 code=0，
   * 把错误放在 `data.isError` 里（doc:573）。必须显式判一次，否则失败会被当成成功结果喂给模型。
   * 请求层失败（4xx / 业务码 / 网络）则把 `#postTo` 的 `error` 原样当 `text` 回给模型。
   */
  async knowledgeToolsCall(serviceUrl, knowledgeId, toolName, params) {
    const result = await this.#postTo(serviceUrl, '/tools/call', {
      knowledge_id: knowledgeId,
      tool_name: toolName,
      params: params ?? {},
    })
    if (!result.ok) return { ok: false, text: result.error }
    const data = result.data
    if (data === null || data === undefined) return { ok: false, text: '知识服务返回了空结果。' }
    if (data.isError === true) return { ok: false, text: String(data.text ?? '知识工具执行失败。') }
    if (typeof data.text === 'string') return { ok: true, text: data.text }
    return { ok: true, text: `${JSON.stringify(data)}${annotateEmptyRefs(data)}` }
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

  // ── meta 面 · task 写侧 ────────────────────────────────────────────────────
  //
  // 与上面读方法的关键差异：**这四个用 post() 而不是 safe()**。
  // safe() 的 fail-open 是读侧优点（失败返回 null、不阻断 DSH），但写侧静默失败
  // 等于"以为记上了其实没记上"—— 正是"对话里的待办要能可靠落库"要消灭的失败模式。
  // 错误必须原样抛给调用方（lib/tools.mjs 把它转成模型可见的工具输出）。
  //
  // header 不带 session/task：meta 面不吃这两个维度（内核按 x-tdai-user-key 解析 caller，
  // 再校验 creator_user_id == caller），带上只是语义噪音。

  /**
   * 建 task。`creator_user_id` 必须 == caller（内核 `assertCallerIsResourceOwner` 强制），
   * 由调用方从当前身份取，不能由模型指定。
   */
  metaCreateTask(body) {
    return this.post('/v3/meta/task/create', body, { userKey: true, session: false, task: false })
  }

  /** 列 task（查重用）。内核要求 team_id 或 creator_user_id / creator_user_key 至少给一个。 */
  metaListTasks(body) {
    return this.post('/v3/meta/task/list', body, { userKey: true, session: false, task: false })
  }

  /** 改 description / status。内核只允许 task creator 调。 */
  metaUpdateTask(body) {
    return this.post('/v3/meta/task/update', body, { userKey: true, session: false, task: false })
  }

  /** 撤销：物理删除（`{ task_ids: [...] }`）。同样只允许 creator。 */
  metaDeleteTasks(taskIds) {
    return this.post('/v3/meta/task/delete', { task_ids: taskIds }, { userKey: true, session: false, task: false })
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
