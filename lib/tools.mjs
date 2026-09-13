/**
 * 只读原生工具注册。凭据（serviceToken / userKey）留在插件进程内，
 * 不进入模型可见的 prompt —— 这是相对 proxy bridge+curl 方案的本质改进。
 */
import { safeText } from './text.mjs'

function render(value) {
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
    async execute(args) {
      if (!runtime.readEnabled()) return 'TDAI memory 未启用（总开关关闭或身份未配置）。'
      const identity = runtime.identityFor(ctx.agent?.session || ctx.sessions?.list?.()[0])
      if (!identity) return 'TDAI memory 未配置完整身份，本会话不可用。'
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

  register(
    'tdai_memory_search',
    'Search structured TencentDB long-term memory (L1 atomic memories: preferences, rules, facts).',
    queryParams,
    (identity, args) => runtime.client.searchL1(selfCtxOf(identity), safeText(args.query), {
      sessionId: identity.session_id,
      taskId: identity.task_id,
      limit: clampLimit(args.limit),
    }),
  )

  register(
    'tdai_memory_query',
    'Query structured L1 memories by type / time window / pagination (no semantic search).',
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
    'Search exact TencentDB conversation history (L0 raw messages).',
    queryParams,
    (identity, args) => runtime.client.searchConversation(identity, safeText(args.query), clampLimit(args.limit)),
  )

  register(
    'tdai_conversation_query',
    'Query raw L0 conversation messages by session / time window / pagination (no semantic search).',
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
    'Search the team Skill library managed by the memory backend (shared across agents).',
    queryParams,
    (identity, args) => runtime.client.searchSkills(identity, safeText(args.query), clampLimit(args.limit)),
  )

  register(
    'tdai_read_scene',
    'Read the full content of an L2 scenario memory by path (paths come from the <l2_scene_index> block).',
    { path: { type: 'string', required: true, description: 'L2 scene path from <l2_scene_index>' } },
    async (identity, args) => {
      const file = await runtime.client.readL2(selfCtxOf(identity), safeText(args.path))
      return file?.content ?? null
    },
  )

  register(
    'tdai_scenario_ls',
    'List L2 scenario paths (optionally under a path prefix).',
    { prefix: { type: 'string', required: false, description: 'Path prefix filter (optional)' } },
    (identity, args) => runtime.client.listL2(selfCtxOf(identity), 100, safeText(args.prefix) || ''),
  )

  register(
    'tdai_skill_view',
    'Open a Skill: returns the SKILL.md content and resource manifest. skill_name comes from the <available_skills> block or tdai_skill_search results.',
    { skill_name: { type: 'string', required: true, description: 'Skill name from <available_skills> or tdai_skill_search' } },
    (identity, args) => runtime.client.skillView(identity, safeText(args.skill_name)),
  )
}
