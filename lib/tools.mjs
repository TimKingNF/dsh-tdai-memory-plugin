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
 * 取「当前会话」的 id。
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
 * 第二参数兜底是给老宿主/内部调用留的（本插件单测也这么直接调）。
 */
function sessionIdOf(exec, ctx) {
  const fromExec = exec?.agent?.session?.id ?? exec?.agent?.session?.sessionId
  if (fromExec) return fromExec
  const fromCtx = ctx?.agent?.session?.id
  if (fromCtx) return fromCtx
  return exec?.session?.id
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
    'Search the team-wide Skill library (shared across agents) for skills that are NOT in this '
    + 'session\'s own catalog. Use it when your own catalog has nothing relevant, or when '
    + 'another agent may have already solved the same problem. Then load the hit with '
    + 'tdai_skill_view.',
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
    'Open one Skill: returns its SKILL.md content plus the resource manifest. Call it before '
    + 'acting on a task that a skill clearly matches — the catalog only carries summaries, so the '
    + 'actual instructions live behind this call. skill_name comes from this session\'s skill '
    + 'catalog, the injected <available_skills> block, or tdai_skill_search results.',
    { skill_name: { type: 'string', required: true, description: 'Skill name from <available_skills> or tdai_skill_search' } },
    (identity, args) => runtime.client.skillView(identity, safeText(args.skill_name)),
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
 * 知识服务的工具是**按资源动态定义**的（wiki 7 个、code-graph 9 个，
 * 见 MemoryKnowledge/v3-api-memoryknowledge-doc.md:568-575），插件无法在注册时静态展开。
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
      const sessionId = sessionIdOf(exec, ctx)
      const asset = sessionId ? runtime.assets.peek(sessionId) : undefined
      const resources = asset?.knowledge ?? []
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
      const tools = await runtime.client.knowledgeToolsList(resource.service_url, id)
      if (!tools) return `无法获取 ${id} 的工具清单（知识服务不可达）。`
      if (tools.length === 0) return `${id} 没有可用工具。`
      return tools
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
