/**
 * 只读原生工具注册。凭据（serviceToken / userKey）留在插件进程内，
 * 不进入模型可见的 prompt —— 这是相对 proxy bridge+curl 方案的本质改进。
 */
import { safeText } from './text.mjs'

/**
 * DSH 的工具输出投影。**签名必须是 `(args, value)`** —— 见
 * `dsh-tools/lib/types/index.d.ts` 的 `ToolOutputDefinition.render`：
 *
 *   "Pure projection from validated arguments and value to Native/model content."
 *
 * 第一个形参是**参数**，第二个才是 `execute()` 返回的规范值。
 * 早先写成 `function render(value)`，于是每次工具调用模型看到的内容都是自己的参数
 * （实测 `tdai_memory_query {limit:3}` 回显 `{"limit":3}`），真实检索结果被静默丢弃——
 * 而且不报错，只是"结果看起来像回显"，极难发现。`test/tools-render.test.mjs` 锁住它。
 */
function render(_args, value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
}

function clampLimit(value, dflt = 5) {
  const n = Number(value)
  if (!Number.isFinite(n)) return dflt
  return Math.min(Math.max(Math.floor(n), 1), 20)
}

function selfCtxOf(identity) {
  return { teamId: identity.team_id, userId: identity.user_id, agentId: identity.agent_id, agentName: identity.agent_id, isSelf: true }
}

/**
 * 取「当前会话」对象（id 与 header 都要用：header 判子 agent 的读侧能力面）。
 *
 * ── 为什么不能从插件 ctx 取 ─────────────────────────────────────────────────
 * DSH 调用工具时是**两个参数**：`tool.execute(exec.arguments, exec)`
 * （`dsh-tools/lib/index.js` 的 scheduler），当前 agent 挂在**第二参数**上：
 * `exec.agent.session`。
 *
 * 插件根 ctx 上**没有** `agent` 这个服务（不在顶层 `inject` 里），所以早先写的
 * `ctx.agent?.session || ctx.sessions?.list?.()[0]` 两个分支都不成立：前者恒 undefined，
 * 后者拿到的是 `SessionStore.list()` 的第一个元素 —— **进程里最早创建的 session**
 * （`dsh-session` 的 `[...this.store.values()]` 是插入序），根本不是当前会话。
 *
 * 后果是**静默用错会话**：资产按当前 session 缓存，工具却去老 session 下查，
 * `peek()` 恒空 → 知识工具永远回「当前会话没有绑定团队知识资源」，而 system prompt
 * 注入（走 assemble 的 `context.agent.session`，路径正确）照常显示绑定正常。
 * 实测证据：同一会话内注入显示"知识资源 1 个"，工具却 4 次全回"未绑定"。
 *
 * 回落顺序：`exec.agent.session` → `ctx.agent.session` → `exec.session`（裸会话，
 * 给老宿主与单测直接调用留的）。
 */
function sessionOf(exec, ctx) {
  const fromExec = exec?.agent?.session
  if (fromExec) return fromExec
  const fromCtx = ctx?.agent?.session
  if (fromCtx) return fromCtx
  // 老宿主/内部调用只给一个裸 session 时，兜成最小会话对象（只够拿 id 与 header）
  const bare = exec?.session
  return bare && typeof bare === 'object' ? bare : undefined
}

function sessionIdOf(exec, ctx) {
  const session = sessionOf(exec, ctx)
  return session?.id ?? session?.sessionId
}

/**
 * 把「扁平参数 spec」编译成 DSH 要求的 JSON Schema 对象根。
 * ctx.tools.register 的 parameters 必须是已转换的 JSON Schema
 * （{ type:'object', properties, required }），内置工具都经 defineTool 里的
 * parameterSchemaSpecToJsonSchema 完成这一步；直接传扁平 spec 会导致上游
 * 报 "schema must be a JSON Schema of 'type: object'"。
 */
function toParameterJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, def] of Object.entries(spec)) {
    const { required: isRequired, description, ...node } = def
    properties[key] = description !== undefined ? { ...node, description } : { ...node }
    if (isRequired) required.push(key)
  }
  const schema = { type: 'object', properties }
  if (required.length > 0) schema.required = required
  return schema
}

const timeParams = {
  time_start: { type: 'string', required: false, description: 'ISO datetime lower bound (optional)' },
  time_end: { type: 'string', required: false, description: 'ISO datetime upper bound (optional)' },
}

export function registerTools(ctx, runtime) {
  const register = (name, description, parameters, run) => ctx.tools.register({
    name,
    description,
    parameters: toParameterJsonSchema(parameters),
    output: { schema: { type: 'string' }, render },
    async execute(args, exec) {
      if (!runtime.readEnabled()) return 'TDAI memory 未启用（总开关关闭或身份未配置）。'
      const identity = runtime.identityFor({ id: sessionIdOf(exec, ctx) })
      if (!identity) return 'TDAI memory 未取到当前会话身份（工具执行上下文里没有 session），本会话不可用。'
      try {
        const result = await run(identity, args ?? {})
        if (result === null || result === undefined) return '（无结果）'
        const text = typeof result === 'string' ? result : JSON.stringify(result)
        return text === '{}' || text === '[]' ? '（无结果）' : text
      } catch (error) {
        runtime.log(`${name} unavailable: ${error.message}`)
        return 'TDAI memory 暂时不可用。'
      }
    },
  })

  const queryParams = {
    query: { type: 'string', required: true, description: 'Search query' },
    limit: { type: 'number', required: false, description: 'Maximum results (1-20)' },
  }

  // ── 工具描述里承载"何时该用 / 何时不必用" ──────────────────────────────────
  //
  // 依据 docs/prompt-injection-redesign.md §5.5：这类规则属于**工具使用说明**，
  // 写在 description 里不额外占 prompt 预算（工具 schema 本来就要发给模型），
  // 而写进 system prompt 是重复付费。原先集中写在 <memory-tools-guide> 里的
  // 场景清单已按工具逐条搬到这里。
  //
  // 每轮检索次数上限（memory_search + conversation_search 合计）目前是**软约束**：
  // 只写在描述里，代码未强制。这是有意为之 —— 详见 docs 阶段 2 的说明。

  register(
    'tdai_memory_search',
    'Search the user\'s aggregated long-term memory (L1 atomic memories: preferences, rules, '
    + 'identity facts, past conclusions). Call it when the question depends on who the user is '
    + 'or what was settled before — e.g. "我叫什么 / 我喜欢什么 / 我不允许什么 / 我的团队 / '
    + '那个 bug 我们怎么修的 / 上次方案是啥 / 我们的约定是什么". Prefer this over '
    + 'tdai_conversation_search when you want the conclusion rather than the original wording. '
    + 'You do not need it when the answer is already visible in this conversation or in the '
    + 'injected L3 profile above. Budget: keep tdai_memory_search + tdai_conversation_search to '
    + '3 calls per turn combined.',
    queryParams,
    (identity, args) => runtime.client.searchL1(selfCtxOf(identity), safeText(args.query), {
      sessionId: identity.session_id,
      taskId: identity.task_id,
      limit: clampLimit(args.limit),
    }),
  )

  register(
    'tdai_memory_query',
    'Enumerate L1 memories by type / time window / pagination, without semantic search. Use it '
    + 'when you need a sweep or an audit ("我这周记了些什么 / 有哪些 instruction 类记忆") rather '
    + 'than a relevance ranking — for a relevance ranking use tdai_memory_search instead. Does '
    + 'not count against the 3-calls-per-turn budget.',
    { type: { type: 'string', required: false, description: "episodic | persona | instruction" }, ...timeParams, limit: { type: 'number', required: false }, offset: { type: 'number', required: false } },
    (identity, args) => runtime.client.atomicQuery(identity, {
      type: safeText(args.type) || undefined,
      timeStart: safeText(args.time_start) || undefined,
      timeEnd: safeText(args.time_end) || undefined,
      limit: clampLimit(args.limit, 20),
      offset: Number(args.offset) >= 0 ? Math.floor(Number(args.offset)) : undefined,
    }),
  )

  register(
    'tdai_conversation_search',
    'Search the raw conversation history (L0 messages) for the exact original wording. Call it '
    + 'when the user refers to the past itself — "我之前说过 / 我告诉过你 / 上次 / 你还记不记得 / '
    + '我们聊过 / 之前那个 / 回忆一下 / 查我们之前" — or when you need a quotation, a timeline, '
    + 'or a concrete detail that an aggregated memory would have flattened. Not needed when the '
    + 'answer is already visible in this conversation. Budget: shares 3 calls per turn with '
    + 'tdai_memory_search.',
    queryParams,
    (identity, args) => runtime.client.searchConversation(identity, safeText(args.query), clampLimit(args.limit)),
  )

  register(
    'tdai_conversation_query',
    'Read raw conversation messages in order by session / time window / pagination. Use it to '
    + 'replay a whole stretch of history rather than search it. Does not count against the '
    + '3-calls-per-turn budget.',
    { session_id: { type: 'string', required: false, description: 'Session id (defaults to current session)' }, ...timeParams, limit: { type: 'number', required: false }, offset: { type: 'number', required: false } },
    (identity, args) => runtime.client.conversationQuery(identity, {
      sessionId: safeText(args.session_id) || undefined,
      timeStart: safeText(args.time_start) || undefined,
      timeEnd: safeText(args.time_end) || undefined,
      limit: clampLimit(args.limit, 20),
      offset: Number(args.offset) >= 0 ? Math.floor(Number(args.offset)) : undefined,
    }),
  )

  register(
    'tdai_skill_search',
    'Search the cloud Skill library: this agent\'s own skills plus team-shared ones. '
    + 'Load the hit with tdai_skill_view. The library is NOT injected into the context — '
    + 'a few candidates may be recalled automatically for the current question, and this '
    + 'tool is the way to look further (e.g. a task that may have a stored procedure you '
    + 'or another agent already wrote).',
    queryParams,
    (identity, args) => runtime.client.searchSkills(identity, safeText(args.query), clampLimit(args.limit)),
  )

  register(
    'tdai_read_scene',
    'Read the full text of one L2 scenario memory by path. The injected <l2_scene_index> carries '
    + 'paths and one-line summaries only, so call this whenever a summarized scene looks relevant '
    + 'and you need its details. Paths must come from <l2_scene_index> or tdai_scenario_ls — never '
    + 'invent one. Do not re-read the same path. Does not count against the 3-calls-per-turn budget.',
    { path: { type: 'string', required: true, description: 'L2 scene path from <l2_scene_index>' } },
    async (identity, args) => {
      const file = await runtime.client.readL2(selfCtxOf(identity), safeText(args.path))
      return file?.content ?? null
    },
  )

  register(
    'tdai_scenario_ls',
    'List L2 scenario paths, optionally under a path prefix. Use it to refresh or filter the '
    + 'injected <l2_scene_index> (e.g. list only one topic prefix). The index is already injected, '
    + 'so a bare call is rarely needed.',
    { prefix: { type: 'string', required: false, description: 'Path prefix filter (optional)' } },
    (identity, args) => runtime.client.listL2(selfCtxOf(identity), 100, safeText(args.prefix) || ''),
  )

  register(
    'tdai_skill_view',
    'Open one cloud Skill: returns its SKILL.md content plus the resource manifest. Call it '
    + 'before acting on a task that a skill clearly matches — recall hints and search results '
    + 'carry the skill description only, so the actual instructions live behind this call. '
    + 'skill_name comes from the injected <tdai_recalled_skills> block or tdai_skill_search.',
    { skill_name: { type: 'string', required: true, description: 'Skill name from <tdai_recalled_skills> or tdai_skill_search' } },
    (identity, args) => runtime.client.skillView(identity, safeText(args.skill_name)),
  )
}

// ── 待办写入 task（写侧工具）────────────────────────────────────────────────

/**
 * 会话级「最近写入的 task_id」记录（内存，不落盘）。
 *
 * 为什么要有：回执里的 task_id 是撤销的唯一把手，但用户不会背它 —— 他说的是
 * "撤销上一条"。模型通常能从上文回执里翻出来，翻不出来时这条兜底不依赖模型判断。
 * 只留内存：进程重启后旧 id 已无意义（跨重启的清理应该去 MemoryPanel 做）。
 * 上限 20：一次会话记几十条待办是极少数，超出丢最旧的（只影响最远那一条的撤销）。
 */
const LAST_WRITTEN = new Map()
const LAST_WRITTEN_MAX = 20

function rememberWrittenTask(sessionId, entry) {
  if (!sessionId) return
  const list = LAST_WRITTEN.get(sessionId) ?? []
  list.push(entry)
  while (list.length > LAST_WRITTEN_MAX) list.shift()
  LAST_WRITTEN.set(sessionId, list)
}

/** 本会话最近写入的 task（新 → 旧）。导出给 commands.mjs 的撤销命令。 */
export function lastWrittenTasks(sessionId) {
  return [...(LAST_WRITTEN.get(sessionId) ?? [])].reverse()
}

/** 删除成功后划掉它，避免重复撤销时对着一个不存在的 id 再删一次。 */
export function forgetWrittenTask(sessionId, taskId) {
  const list = LAST_WRITTEN.get(sessionId)
  if (!list) return
  const next = list.filter((it) => it.task_id !== taskId)
  if (next.length === 0) LAST_WRITTEN.delete(sessionId)
  else LAST_WRITTEN.set(sessionId, next)
}

/** 标题上限：与上游 MemoryProxy 的 40 字截断口径一致（`mem-command` 的 lockedTitle）。 */
const TASK_TITLE_MAX = 40
/** 内核枚举（v3-meta-schemas.ts 的 `taskStatus`），本地先拦一道，省一次 400 往返。 */
const TASK_STATUSES = ['running', 'completed']

/**
 * 本地日期。追加描述时用它做行首时间戳 —— 用 UTC 会让人看到"昨天的记录"
 * （HKT 的 23:40 在 UTC 还是 15:40）。
 */
function localDate(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** 标题归一：折行压成空格、去首尾空白，超过 40 字截断（不润色，只压）。 */
function clampTitle(text) {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > TASK_TITLE_MAX ? `${one.slice(0, TASK_TITLE_MAX - 1)}…` : one
}

/**
 * 写侧失败文案：把服务端给的原因翻译成"下一步能做什么"。
 *
 * 四类都是实测见过的（见 docs/task-capture-design.zh-CN.md §7）：
 *   401 `missing_user_key` / `invalid_user_key` → user key 没配或失效；
 *   403 `permission_denied`                     → 只能写自己创建的 task；
 *   404 `task_not_found`                        → 目标 task 已被删除；
 *   网络层（`fetch failed` + cause.code）        → 内核没起 / 地址不对。
 *
 * 这里**必须**把原文带上：读侧工具栏的兜底文案（"TDAI memory 暂时不可用。"）
 * 用在写侧是最糟的返回 —— 模型会以为记上了。
 */
function taskWriteFailure(error) {
  const raw = String(error?.message ?? error).replace(/^\[tdai-memory\]\s*/, '')
  const status = raw.match(/HTTP (\d{3})/)?.[1]
  const hint = status === '401'
    ? 'User Key 缺失或失效（meta 面需要 sk-mem-… 的 user key）：在「设置 → TDAI Memory」页补上。'
    : status === '403'
      ? '权限不足：只能改自己创建的 task，且必须是该 team 的活跃成员。'
      : status === '404'
        ? 'task 不存在（可能已被删除）。'
        : ''
  const causeText = typeof error?.cause?.code === 'string' && error.cause.code ? `（${error.cause.code}）` : ''
  return [`待办写入失败：${raw}${causeText}`, hint].filter(Boolean).join('\n')
}

/**
 * 待办写入 task：写侧工具（add / list / update / delete）。
 *
 * ── 为什么单独一个注册器，而不是塞进 registerTools ───────────────────────────
 * 三条判据与只读工具**全不一样**：
 *   1. 开关是 `taskWriteEnabled`（独立写侧），不受 `enabled`（读侧总开关）约束；
 *   2. 必须有 `userKey`（meta 面鉴权）；只读工具只靠身份四元组；
 *   3. **失败必须让模型看见真实原因**，不能像 registerTools 那样统一吞成
 *      "TDAI memory 暂时不可用。" —— 那句在写侧等于假成功。
 *
 * ── 触发口径（用户 2026-10-14 拍板，保守档）─────────────────────────────────
 * 只在用户**明确指示记录**时写（"记一下…" / "帮我记下来" / "加到 task 里"）。
 * 疑似待办但用户没说记 → 不调工具，最多口头问一句要不要记；不记推测、
 * 不记自己提议的事、不把提问当待办。这条口径写在工具 description 里
 * （工具 schema 本来每轮都在上下文里，写这里不额外占注入预算）。
 */
export function registerTaskTools(ctx, runtime) {
  const register = (name, description, parameters, run) => ctx.tools.register({
    name,
    description,
    parameters: toParameterJsonSchema(parameters),
    output: { schema: { type: 'string' }, render },
    async execute(args, exec) {
      if (!runtime.config.taskWriteEnabled) {
        return '待办写入未启用：在「设置 → TDAI Memory」页打开「待办写入 task」。'
      }
      const sessionId = sessionIdOf(exec, ctx)
      const identity = runtime.identityFor({ id: sessionId })
      if (!identity) {
        return 'TDAI memory 未取到当前会话身份（工具执行上下文里没有 session），本会话不可用。'
      }
      if (!runtime.hasUserKey()) {
        return 'TDAI memory 未配置 User Key（sk-mem-…）：meta 面的 task 读写需要它，当前无法写入。'
      }
      try {
        const text = await run(identity, sessionId, args ?? {})
        return text || '（无结果）'
      } catch (error) {
        runtime.log(`${name} failed: ${error.message}`)
        return taskWriteFailure(error)
      }
    },
  })

  register(
    'tdai_task_add',
    'Record one todo that the user EXPLICITLY asked to save, as a TDAI task (server-side: survives '
    + 'sessions, visible in the Memory panel and to other agents). Call it only on a record '
    + 'instruction — "记一下…", "帮我记下来", "加到 task 里", "待办加上…". Never write a todo you '
    + 'merely inferred, anything you proposed yourself, or a question / complaint; if you suspect a '
    + 'todo but no record instruction came, ask one short question instead. Said "记一下" once and '
    + 'then listed several todos in the same turn → one call per todo. title = their words compacted '
    + 'into an actionable phrase (<=40 chars, no "XX 事项跟进" filler); note = the original sentence '
    + 'plus one line of context. Quote the returned task_id back — it is how they undo.',
    {
      title: { type: 'string', required: true, description: 'Actionable title in the user\'s own words (<=40 chars)' },
      note: { type: 'string', required: false, description: 'Original sentence + context, kept as the task description' },
      dedupe: { type: 'boolean', required: false, description: 'Default true: if a running task with the exact same title exists, append to it instead of creating a duplicate' },
    },
    async (identity, sessionId, args) => {
      const title = clampTitle(safeText(args.title))
      if (!title) return '缺少 title：用用户原话压成一句可执行的待办标题。'
      const note = safeText(args.note).trim()
      const dedupe = args.dedupe !== false
      const metadata = JSON.stringify({
        source: 'dsh',
        session_id: identity.session_id,
        agent_id: identity.agent_id,
        quote: note || title,
        captured_at: new Date().toISOString(),
      })

      if (dedupe) {
        // 精确匹配，不用相似度：把两件不同的事合并成一件，比多一条重复记录糟得多。
        const page = await runtime.client.metaListTasks({
          team_id: identity.team_id, status: 'running', title, limit: 5, offset: 0,
        })
        const hit = (Array.isArray(page?.items) ? page.items : []).find((t) => t?.title === title)
        if (hit) {
          const merged = [hit.description, note ? `[${localDate()}] ${note}` : '']
            .filter(Boolean).join('\n')
          const updated = await runtime.client.metaUpdateTask({ task_id: hit.task_id, description: merged })
          rememberWrittenTask(sessionId, { task_id: hit.task_id, title: updated?.title ?? title, at: Date.now() })
          return `已存在同名待办，追加而非新建：${updated?.title ?? title}（${hit.task_id}）`
        }
      }

      const created = await runtime.client.metaCreateTask({
        team_id: identity.team_id,
        // 内核强制 creator == caller；这里取当前身份，模型无法指定。
        creator_user_id: identity.user_id,
        title,
        ...(note ? { description: note } : {}),
        source_type: 'manual',
        status: 'running',
        metadata_json: metadata,
      })
      rememberWrittenTask(sessionId, { task_id: created?.task_id, title: created?.title ?? title, at: Date.now() })
      return [
        `已记：${created?.title ?? title}（${created?.task_id ?? '未返回 id'}）`,
        note ? `描述：${note}` : '',
        '撤销：说「撤销上一条待办」，或用 /tdai-task-undo。',
      ].filter(Boolean).join('\n')
    },
  )

  register(
    'tdai_task_list',
    'List this team\'s TDAI tasks (default status=running): use it for a duplicate check before '
    + 'writing, or to answer "我现在有哪些待办".',
    {
      status: { type: 'string', required: false, description: 'running | completed (default running)' },
      limit: { type: 'number', required: false, description: 'Maximum results (1-20, default 20)' },
    },
    async (identity, _sessionId, args) => {
      const status = safeText(args.status).trim() || 'running'
      if (!TASK_STATUSES.includes(status)) return `status 只能是 ${TASK_STATUSES.join(' / ')}。`
      const page = await runtime.client.metaListTasks({
        team_id: identity.team_id, status, limit: clampLimit(args.limit, 20), offset: 0,
      })
      const items = Array.isArray(page?.items) ? page.items : []
      if (items.length === 0) return `团队 ${identity.team_id} 下没有 status=${status} 的 task。`
      const lines = items.map((t) => {
        const created = String(t.created_at ?? '').slice(0, 10)
        const desc = String(t.description ?? '').split('\n')[0].slice(0, 60)
        return `- ${t.task_id} [${t.status}] ${t.title}${created ? `（${created}）` : ''}${desc ? `\n    ${desc}` : ''}`
      })
      return [`团队 ${identity.team_id} 的 task（status=${status}，共 ${page.total ?? items.length} 条）：`, ...lines].join('\n')
    },
  )

  register(
    'tdai_task_update',
    'Update one TDAI task: description (REPLACES the stored text — read it with tdai_task_list first '
    + 'if the old text matters) or status (running | completed). Use it to mark a todo done. Only '
    + 'tasks created by the current user can be updated.',
    {
      task_id: { type: 'string', required: true, description: 'Task id (task-xxxxxxxxxx)' },
      note: { type: 'string', required: false, description: 'Replacement description text' },
      status: { type: 'string', required: false, description: 'running | completed' },
    },
    async (identity, _sessionId, args) => {
      const taskId = safeText(args.task_id).trim()
      if (!taskId) return '缺少 task_id。'
      const note = safeText(args.note).trim()
      const status = safeText(args.status).trim()
      if (!note && !status) return '至少要给 note 或 status 之一。'
      if (status && !TASK_STATUSES.includes(status)) return `status 只能是 ${TASK_STATUSES.join(' / ')}。`
      const updated = await runtime.client.metaUpdateTask({
        task_id: taskId,
        ...(note ? { description: note } : {}),
        ...(status ? { status } : {}),
      })
      return `已更新：${updated?.title ?? taskId}（${taskId}）status=${updated?.status ?? (status || '未变')}`
    },
  )

  register(
    'tdai_task_delete',
    'Delete a TDAI task (hard delete) when the user cancels a recorded todo or wants a wrong entry '
    + 'gone ("撤销上一条待办" / "记错了，删掉"). If "the last one" is ambiguous, ask — do not guess. '
    + 'Only tasks created by the current user can be deleted.',
    { task_id: { type: 'string', required: true, description: 'Task id to delete (task-xxxxxxxxxx)' } },
    async (identity, sessionId, args) => {
      const taskId = safeText(args.task_id).trim()
      if (!taskId) return '缺少 task_id。'
      const result = await runtime.client.metaDeleteTasks([taskId])
      const failed = Array.isArray(result?.failed) ? result.failed : []
      if (failed.length > 0) return `删除失败：${JSON.stringify(failed)}`
      forgetWrittenTask(sessionId, taskId)
      return `已删除 task：${taskId}`
    },
  )
}

/**
 * 知识服务（wiki / code-graph）的原生工具。
 *
 * ── 为什么要有它们 ──────────────────────────────────────────────────────────
 * 改造前，调用知识服务靠"教模型敲 curl"（那段配方 4.2KB，见
 * `renderKnowledgeSkillContent`）。现在：
 *   - 判据与调用方式仍在 `tdai-team-knowledge` skill 正文里（按需加载）；
 *   - **执行**改由这里两个原生工具承担：schema 由宿主校验、失败信息结构化、
 *     不需要模型记 URL 和请求头。
 *
 * ── 为什么只有两个工具 ──────────────────────────────────────────────────────
 * 知识服务的工具是**按资源动态定义**的（本机实测 `tools/list`：wiki 7 个、code-graph 9 个；
 * 计数随服务端版本变，插件不依赖它），插件无法在注册时静态展开。
 * 所以对外只暴露"发现"与"执行"两件事，工具名与参数由服务端定义、经 skill 正文带进来：
 *
 *   - `tdai_knowledge_tools`：列某个资源可用的工具（tools/list），
 *     一般用不到 —— 会话开始时已预取进 skill 正文；
 *   - `tdai_knowledge_call`：执行（tools/call）。
 *
 * 这是 DSH 里"progressive exposure"的标准做法：目录稳定（只有 2 个 schema），
 * 明细放到运行时数据里。
 *
 * ── 越权防护 ────────────────────────────────────────────────────────────────
 * `tdai_knowledge_call` 只接受**当前会话已绑定**的 knowledge_id。模型如果凭空编一个
 * id，直接拒绝而不是拿它去请求服务端。判据是 assets 缓存里的资源列表（会话级）。
 */
/**
 * 会话资产"还算新"的阈值：`tdai_knowledge_call` 命中不到目标 id 时，
 * 只有比这个年龄更老的资产才值得强制刷新一次（避免每次调用都打一遍网关）。
 * 取值不敏感：资产是"进会话时拉一次"的东西，几十秒的陈旧窗口足够覆盖
 * "查一次 → 发现没有 → 绑定 → 再查"这条人工路径。
 */
const ASSET_FRESH_MS = 10_000

export function registerKnowledgeTools(ctx, runtime) {
  const register = (name, description, parameters, run) => ctx.tools.register({
    name,
    description,
    parameters,
    output: { schema: { type: 'string' }, render },
    async execute(args, exec) {
      if (!runtime.readEnabled() || !runtime.config.knowledgeEnabled) {
        return '团队知识未启用（knowledgeEnabled=false 或读侧总开关关闭）。'
      }
      const session = sessionOf(exec, ctx)
      const sessionId = sessionIdOf(exec, ctx)
      // 能力面判定（lib/subagent.mjs）：子会话默认**允许**知识工具，这里不是拒子 agent
      // 的地方。保留这层防御是给"将来关掉知识面"的部署留的出口。
      const policy = runtime.readPolicyFor?.(session)
      if (policy && !policy.knowledge) {
        return '本会话的知识侧已被策略关闭（未加载团队知识资源）。'
      }
      // 工具可能先于 assemble 被调用（注入总闸关闭、宿主裁剪等），此时缓存还是空的。
      // 按同一份能力面补一次 bounded ensure：命中缓存时零开销，冷启动时最多等一个预算。
      let asset = sessionId ? runtime.assets.peek(sessionId) : undefined
      if (!asset && sessionId && typeof runtime.assets.ensure === 'function') {
        try { asset = await runtime.assets.ensure(sessionId, policy) } catch {}
      }
      let resources = asset?.knowledge ?? []

      // ── allowlist 与 skill 正文对齐（2026-10-14）────────────────────────────
      //
      // skill 正文是**进程级热更新**的（新绑定/新同步的资源会立刻出现在里面），而这里
      // 的 allowlist 取的是**会话级资产缓存** —— 会话不刷新，正文里刚列出的新资源在
      // 这里就是"未绑定"，模型拿着正文里的 id 过来只会被回一句"未绑定的知识资源"。
      //
      // 所以：目标 id 不在当前清单里、且手上这份资产已经**够老**时，强制刷新一次再判。
      // 两个边界都是刻意的：
      //   - 只在"有资产但老"时刷新：没有资产的分支上面已经 ensure 过（那条路径带失败冷却），
      //     不该在这里再打一遍网关；资产新（loadedAt 刚过）说明刚查过，也不必再查；
      //   - 刷新成功后 loadedAt 变新 → ASSET_FRESH_MS 内不会重复刷新，
      //     模型连喂几个不存在的 id 也不会把网关打穿。
      const wantedId = safeText(args?.knowledge_id)
      const assetAgeMs = asset ? Date.now() - (Number(asset.loadedAt) || 0) : 0
      const assetIsStale = Number(asset?.loadedAt) > 0 && assetAgeMs > ASSET_FRESH_MS
      if (wantedId && assetIsStale && sessionId
        && !resources.some((r) => r.knowledge_id === wantedId)
        && typeof runtime.assets.refresh === 'function') {
        try {
          const fresh = await runtime.assets.refresh(sessionId, policy)
          if (fresh) {
            resources = fresh.knowledge ?? []
            runtime.log(`knowledge asset refreshed on id miss (${wantedId}): ${resources.length} 个资源`)
          }
        } catch {}
      }

      if (resources.length === 0) {
        return '当前会话没有绑定团队知识资源。（可用 /tdai-sync 刷新资产，或确认 agent 是否绑定了知识资源。）'
      }
      try {
        return await run(resources, sessionId, args ?? {})
      } catch (error) {
        runtime.log(`${name} unavailable: ${error.message}`)
        return 'TDAI 知识服务暂时不可用。'
      }
    },
  })

  const resourceList = (resources) => resources
    .map((r) => `- \`${r.knowledge_id}\`（${r.type}）${r.name}`)
    .join('\n')

  register(
    'tdai_knowledge_tools',
    'List the read-only tools one bound knowledge resource offers (wiki / code-graph). '
    + 'Usually unnecessary: the tool inventory is already written into the `tdai-team-knowledge` '
    + 'skill body when you load it. Call this only if you need a refreshed list for a resource.',
    {
      type: 'object',
      properties: {
        knowledge_id: { type: 'string', description: 'Bound knowledge resource id' },
      },
      required: ['knowledge_id'],
    },
    async (resources, _sessionId, args) => {
      const id = safeText(args.knowledge_id)
      const resource = resources.find((r) => r.knowledge_id === id)
      if (!resource) return `未绑定的知识资源：${id}\n当前可用：\n${resourceList(resources)}`
      const result = await runtime.client.knowledgeToolsList(resource.service_url, id)
      // 失败必须带上服务端给的原因（"不可达"那种笼统说法会把 4xx 也伪装成故障）
      if (!result.ok) return `无法获取 ${id} 的工具清单：${result.error}`
      if (result.tools.length === 0) return `${id} 没有可用工具。`
      return result.tools
        .map((t) => `- \`${t.name}\`: ${t.description ?? ''}`)
        .join('\n')
    },
  )

  register(
    'tdai_knowledge_call',
    'Call one read-only tool on a bound knowledge resource: the code-graph (repository symbol / '
    + 'call graph / structure index) or the team wiki (design docs). Tool names and parameters are '
    + 'defined by the resource — take them from the `tdai-team-knowledge` skill body, or from '
    + 'tdai_knowledge_tools. Typical code-graph tools: explore (preferred: returns full source of '
    + 'relevant symbols grouped by file), search, node, callers, callees, impact. Typical wiki '
    + 'tools: search, read_page, list_pages. Prefer local grep/read when you need the exact current '
    + 'text of code you are editing; the index is a branch snapshot.',
    {
      type: 'object',
      properties: {
        knowledge_id: { type: 'string', description: 'Bound knowledge resource id (from the skill body)' },
        tool_name: { type: 'string', description: 'Tool name exactly as listed for that resource' },
        params: {
          type: 'object',
          description: 'Tool parameters as a JSON object; use {} when the tool takes none',
        },
      },
      required: ['knowledge_id', 'tool_name'],
    },
    async (resources, _sessionId, args) => {
      const id = safeText(args.knowledge_id)
      const resource = resources.find((r) => r.knowledge_id === id)
      // 越权/拼错防护：只认当前会话已绑定的资源，绝不拿模型编的 id 去请求服务端
      if (!resource) return `未绑定的知识资源：${id}\n当前可用：\n${resourceList(resources)}`
      const toolName = safeText(args.tool_name)
      if (!toolName) return '缺少 tool_name。'
      const params = args.params && typeof args.params === 'object' ? args.params : {}
      const { ok, text } = await runtime.client.knowledgeToolsCall(resource.service_url, id, toolName, params)
      return ok ? text : `知识工具调用失败：${text}`
    },
  )
}
