/**
 * 配置解析：cordis.patch.yml 把 env 原样透传进来，这里统一做默认值与类型归一。
 *
 * 开关语义（与 Web 设置面板的分组一一对应，改文案前先看这里）：
 *
 *   enabled             读侧总开关：控制「L1 召回 + 上下文注入 + 只读工具」，
 *                       false 时这三类全部关闭（还要叠加 identityComplete）
 *     ├─ recallEnabled  L1 自动召回（agent/pre-step 注入 <tdai_recalled_l1_memories>）
 *     │    └─ recallLimit  自有 + 借入合并后的条数上限
 *     ├─ skillsEnabled  云端 skill **按需召回**（agent/pre-step 注入
 *     │                 <tdai_recalled_skills>，与本轮问题一起检索、命中才注入）。
 *     │                 2026-10 改版：不再在 system 里常驻 skill 目录（见 CHANGELOG）。
 *     │    ├─ skillRecallLimit     每轮最多注入几条命中
 *     │    └─ skillRecallMinScore  分数闸门，0 = 不设阈值（交给 core 的 BM25 判定）
 *     └─ injectionEnabled  system prompt 注入总闸，只管下面的注入段，
 *                          不影响 L1 召回与 skill 召回（两者都在消息尾部）
 *          ├─ sessionContextEnabled
 *          │    └─ agentPromptEnabled     TDAI agent 的角色 / 规则 prompt（写进该块的
 *          │         │                    [Role] / [Rules]）+ persona 槽的英文指引句
 *          │         └─ agentPromptKeepBase  persona 槽要不要保留 DSH 原 persona 行
 *          ├─ profileMemoryEnabled
 *          └─ knowledgeEnabled
 *
 *   captureEnabled     回流（写侧）**完全独立**：既不受 enabled 约束，也不受
 *                      injectionEnabled 约束（lib/capture.mjs 只判它自己），默认开
 *
 *   taskWriteEnabled   对话内待办写入 TDAI task（**独立写侧**，默认**关**）：
 *                      注册 tdai_task_add / tdai_task_list / tdai_task_update /
 *                      tdai_task_delete 四个工具，全部走 meta 面（另需 userKey）。
 *                      默认关的理由：写的是用户的**真实任务库**，先只读彩排、E2E
 *                      跑通再打开；且它同样不受 enabled（读侧总开关）约束
 *                      —— 对齐 captureEnabled 的"读写侧各自开门"先例。
 *                      设计与口径见 docs/task-capture-design.zh-CN.md。
 *
 *   subagentInjectionEnabled  子 agent 会话是否**全量继承**读侧（身份 + 记忆 + 云端 skill
 *                             召回）。**默认关**：子会话不注入身份（session_context）与
 *                             记忆（画像 / L1 召回 / 状态快照），也不为这些面预热资产；
 *                             但**团队知识库与 10 个只读工具照常可用**（知识面另受全局
 *                             knowledgeEnabled 约束，能力面定义见 lib/subagent.mjs）。
 *   subagentCaptureEnabled    子 agent 会话是否回流。**默认关**：子 agent 的执行过程
 *                             不进 L0，避免后台抽取把工作噪音当成用户记忆。
 *                             两者判定见 lib/subagent.mjs（按 session.header.origin）。
 *
 *   ── ds-bot 会话（方案 docs/proposals/ds-bot-tdai-integration/minimal.md）──────────
 *
 *   dsbotAwarenessEnabled     **总闸**：是否按 ds-bot 的 state.json 识别 Bot / 房间会话。
 *                             关掉后不索引 state.json，Bot 会话按普通会话处理 —— 这是
 *                             唯一能回到改动前行为的开关。
 *     ├─ botSkillInjectEnabled    读侧：Bot 会话注入云端 skill（身份与记忆**恒关**，
 *     │                           没有开关，理由见 minimal.md §1）。默认开。
 *     └─ botWritebackEnabled      写侧：Bot 会话回写 L0（按人锚点写回合）。默认**关**，
 *                                 首次上线手动打开。还要 AND 全局 captureEnabled。
 *          ├─ botContextDistillEnabled  群聊前文蒸馏（关掉后群聊只写人话）
 *          └─ botContextMessages        群聊窗口条数（0 = 同关闭蒸馏）
 *   botContextReuseMemory     群聊摘要是否复用本群 MEMORY 条目（默认关，避免归因回环）。
 *   dsbotLedgerPath           台账路径（空 = <DSH_HOME>/storages/tdai-memory-plugin/
 *                             dsbot-state.json）；不接受 <DSH_HOME>/bot 之下。
 *
 *   三个开关是**串联**的：Bot 侧两个子开关只有在总闸为真时才有效；有效值只在
 *   `lib/dsbot.mjs` 的 `sessionPolicy()` 与 `writebackAllowed()` 两处计算，调用点
 *   不得直接读 `botSkillInjectEnabled` / `botWritebackEnabled`。
 *
 *   ── 工作区身份覆盖（多工作区多 agent）──────────────────────────────────────
 *
 *   workspaceAgentsEnabled  总开关（默认**关**，保持历史行为不变）
 *   workspaceAgents         规则表：工作目录（会话 header.cwd，规范化后的绝对路径）
 *                           → { teamId?, agentId? }。命中时覆盖默认身份里的同名字段；
 *                           未命中 / 总开关关 / 字段为空 → 回落到默认身份。
 *
 *   解析语义只有一处：`identityForWorkspace()`（本文件底部）。调用点不要自己按 cwd
 *   匹配规则，也不要直接把 `cfg.agentId` 当成"当前会话的 agent"——会话级身份必须走
 *   `runtime.identityFor(session)` / `runtime.configFor(session)`。
 *
 *   为什么按**路径**而不是 Workspace 记录的 uuid：DSH 的 workspace 归属由会话
 *   `header.cwd` 决定，且同一个目录可能被多个入口创建（含未登记的目录）；路径是
 *   会话本来就有的、无需额外 RPC 的事实。Workspace 的 title 只作为面板显示名。
 */
import path from 'node:path'

const FALSEY = /^(0|false|no|off)$/i

/**
 * 取"实时值"。
 *
 * DSH 0.1.7-rc.1 起，`Config` 里标了 `.volatile()` 的字段经 cordis 校验后会变成
 * **`{ get() }` 访问器**（`{a: z.boolean().volatile()}` → `config.a.get()`），在面板写入时
 * **原地更新**（loader 的 `_commitVolatile` 改的是这个访问器，不会重新 apply 插件）。
 * 没标 volatile 的字段仍是普通值（部署期配置，如 `apiKeyEnv`）。这里统一拆掉这层，
 * 让下面的归一化逻辑对两种形态都成立。见 lib/settings.mjs 顶部对 volatile 约定的说明。
 */
export function liveValue(value) {
  return value && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
}

function boolOpt(value, dflt) {
  const v = liveValue(value)
  if (v === undefined || v === null || v === '') return dflt
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  return !FALSEY.test(String(v).trim())
}

function numOpt(value, dflt) {
  const n = Number(liveValue(value))
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt
}

/**
 * 同 numOpt，但**允许 0**（0 是有效语义，不是"没配"）。
 *
 * 目前只有 `assetRetryCooldownMs` 用它：0 = 不做冷却、每次失败都允许重试。
 * 用 numOpt 会把 0 判成非法值而悄悄换成默认值（15000），env 里配 `=0` 就完全无效 ——
 * 而设置面板（`z.natural().min(0)`）是允许 0 的，两侧语义必须一致。
 * 空串/缺省仍回落默认值（空串不能被 Number('') 的 0 骗过去）。
 */
function numOptZero(value, dflt) {
  const raw = liveValue(value)
  if (raw === undefined || raw === null || raw === '') return dflt
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt
}

export function str(value) {
  const raw = liveValue(value)
  const text = typeof raw === 'string' ? raw.trim() : ''
  return text || undefined
}

/**
 * 工作目录规范化：只做"同一路径不同写法"的归一，不碰文件系统。
 *
 * - 相对路径按插件进程的 cwd 解析（面板写入的应是绝对路径；手填相对路径至少能工作）；
 * - 去掉末尾分隔符（根路径除外）；
 * - Windows 下大小写不敏感（同一目录写成 `D:\Work` / `d:\work` 应命中同一条）。
 *
 * 为什么不做 `realpath`：这一步在 pre-step / assemble 热路径上，且路径可能暂时不存在
 * （工作区目录被移动）；`fs.realpath` 会让"目录暂时不可用"变成匹配失败。DSH 的
 * Workspace 记录本身存的是 canonical path，面板选择工作区时拿到的已经是规范路径，
 * 手填路径的边界由这里的轻量归一兜住。
 */
export function normalizeWorkspacePath(value) {
  const raw = liveValue(value)
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return ''
  let resolved
  try {
    resolved = path.resolve(text)
  } catch {
    return ''
  }
  const root = path.parse(resolved).root
  if (resolved !== root) resolved = resolved.replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * 工作区覆盖规则的归一化。坏条目一律丢弃（不抛）：这是面板/配置文件里的数据，
 * 一条写错不该让整个插件加载失败。
 *
 * 规则至少要有一个覆盖字段（teamId / agentId）；只有路径、两个覆盖都为空的条目
 * 等价于"没配"，保留它只会让面板看起来有配置、实际不生效。
 *
 * 同一路径重复出现时**后者覆盖前者**：面板保存前会先去重，但 env / 手改配置文件
 * 不受面板约束，这里给一个确定性的兜底。
 */
export function normalizeWorkspaceAgents(value) {
  const raw = liveValue(value)
  let list = raw
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (!text) return []
    try { list = JSON.parse(text) } catch { return [] }
  }
  if (!Array.isArray(list)) return []
  const byPath = new Map()
  for (const item of list.slice(0, 100)) {
    if (!item || typeof item !== 'object') continue
    const workspace = normalizeWorkspacePath(item.workspace ?? item.path)
    const teamId = typeof item.teamId === 'string' ? item.teamId.trim() : ''
    const agentId = typeof item.agentId === 'string' ? item.agentId.trim() : ''
    if (!workspace || (!teamId && !agentId)) continue
    const title = typeof item.title === 'string' ? item.title.trim() : ''
    byPath.set(workspace, { workspace, title, teamId, agentId })
  }
  return [...byPath.values()]
}

/**
 * 当前会话命中的工作区覆盖规则（未启用 / 无 cwd / 未命中 → undefined）。
 *
 * `cwd` 传会话的 `header.cwd`。Bot 会话、子会话也走同一条规则：它们同样是 DSH
 * 会话，header.cwd 是创建时的工作目录；ds-bot 的身份/记忆本来就恒关，覆盖不会
 * 改变那部分策略（见 lib/dsbot.mjs），只是让普通会话能按工作区换 agent。
 */
export function workspaceBindingFor(cfg, cwd) {
  if (!cfg?.workspaceAgentsEnabled) return undefined
  const rules = cfg.workspaceAgents
  if (!Array.isArray(rules) || rules.length === 0) return undefined
  const key = normalizeWorkspacePath(cwd)
  if (!key) return undefined
  return rules.find((rule) => rule.workspace === key)
}

/**
 * 会话级有效配置：默认身份 + 命中的工作区覆盖。
 *
 * 只覆盖 `teamId` / `agentId` 两个字段（用户维度仍共用同一个人，serviceId / userId /
 * userKey / taskId 保持默认）。规则里某一项为空 → 该项回落默认值，因此可以只覆盖
 * agent、把 team 留给默认，也可以两个都换。
 *
 * @returns {{ cfg: object, rule: object | undefined }} cfg 恒为对象；rule 为命中的规则。
 */
export function identityForWorkspace(cfg, cwd) {
  const rule = workspaceBindingFor(cfg, cwd)
  if (!rule) return { cfg, rule: undefined }
  return {
    cfg: {
      ...cfg,
      teamId: rule.teamId || cfg.teamId,
      agentId: rule.agentId || cfg.agentId,
    },
    rule,
  }
}

export function resolveConfig(config = {}) {
  return {
    enabled: boolOpt(config.enabled, true),
    captureEnabled: boolOpt(config.captureEnabled, true),
    /** 对话内待办写入 task（独立写侧开关，默认关；见文件头开关树）。 */
    taskWriteEnabled: boolOpt(config.taskWriteEnabled, false),
    recallEnabled: boolOpt(config.recallEnabled, true),
    injectionEnabled: boolOpt(config.injectionEnabled, true),
    sessionContextEnabled: boolOpt(config.sessionContextEnabled, true),

    /**
     * TDAI agent 自己的「角色定位 prompt + 规则固定 prompt」（MemoryCore 的 agent meta）。
     *
     * 这两个 prompt 存在 `metadata_json.ui.role_prompt` / `ui.rules_prompt` 里，
     * 服务端另把二者按 `[role, rules].filter(Boolean).join('\n\n')` 合并进 `prompt` 字段
     * （拆分口径见 MemoryCore `src/metadata/service/metadata-service.ts` 与 MemoryPanel
     * `AgentEditDialog.tsx`；合并后的 `prompt` 才是"运行时完整文本"）。
     * 注入方式（2026-10 改版，模板经用户确认）：
     *   - `[Role]` / `[Rules]` 两段正文写进 `<session_context>`（跟在 `[Agent]` 后面，
     *     见 lib/prompts.mjs 的 renderSessionContext）；
     *   - persona 槽（`deployment:persona-prefix`，order 0）只放**一句英文指引**
     *     （`SESSION_CONTEXT_POINTER`），告诉模型身份 / 角色 / 规则在下面的块里、回答时按它来。
     *
     * 归属**身份面**（policy.identity）；因为两段正文本就住在会话上下文块里，
     * 所以它**挂在 `sessionContextEnabled` 之下**（块关掉 → 标签与指引句一起消失）。
     */
    agentPromptEnabled: boolOpt(config.agentPromptEnabled, true),
    /**
     * persona 槽要不要保留 DSH 原来那句 persona（默认**关** = 替换）。
     *
     * 打开时：`<原 personaPrefix>\n\n<英文指引句>`；关闭时：槽里只有英文指引句。
     * 保留时**不能**关该段的插值（原句里的 `{{model}}` / `{{cwd}}` 还要展开），见 lib/sections.mjs。
     */
    agentPromptKeepBase: boolOpt(config.agentPromptKeepBase, false),

    profileMemoryEnabled: boolOpt(config.profileMemoryEnabled, true),
    /**
     * 云端 skill **按需召回**（2026-10 改版）：每轮用"最近几条真人消息"检索一次
     * agent 名下的云端 skill，命中才渲染成 `<tdai_recalled_skills>` 注入（消息尾部，
     * 与 L1 召回同一条 plugin 消息）。
     *
     * 为什么不再常驻目录：`/v3/skill/listing` 的 top-20 全量目录在本机实测 15.3 KB，
     * 却只覆盖 77 个自有 skill 里的 20 个，而且排序依据是 agent prompt、与当前这一轮
     * 说的话无关 —— 贵、不全、不准。改按需召回后常驻字节为 0，命中时约 0.3–0.5 KB。
     */
    skillsEnabled: boolOpt(config.skillsEnabled, true),
    /** 每轮最多注入几条 skill 命中（1–10）。 */
    skillRecallLimit: numOpt(config.skillRecallLimit, 3),
    /**
     * 分数闸门：低于它的命中丢弃。
     *
     * 默认 **4**，来自本机实测的分带（同一个 agent 的 77 条自有 skill）：
     *   - 无信息轮次（"继续"、"今天天气不错，随便聊聊"）的 top 分落在 1.9–3.6；
     *   - 真相关轮次（"帮我按 RRG 日评 skill 跑一遍今天的板块"、"这个报错怎么修"）
     *     的 top 分落在 4.1–15.4（前者命中 rrg-*，后者命中 dsh-cordis-patch-config-reload 等）。
     * 默认取 **4**：它拦得住"继续"（1.9–2.7）与"今天天气不错，随便聊聊"（3.4–3.6）这类
     * 无信息轮次，同时保留真相关轮次（最低一条实测 4.14）。显式设 **0** 可关掉闸门
     * （完全交给 core 的 BM25），设 3 则放宽一档（代价是闲聊轮次也会注入 3 条不相关候选）。
     *
     * 与 `skillRecallLimit` 的关系：**先过闸门、再取前 N 条**，两者共同决定真正的注入条数
     * （见 lib/recall.mjs 的 pickSkillHits）。
     */
    skillRecallMinScore: numOptZero(config.skillRecallMinScore, 4),
    knowledgeEnabled: boolOpt(config.knowledgeEnabled, false),

    /**
     * 子 agent 会话的策略开关（见 lib/subagent.mjs 顶部的能力面表）。
     * 默认都是 false：子会话只保留**知识面与工具**，不继承身份 / 记忆 / 云端 skill 召回，
     * 中间过程也不进长期记忆。要恢复"子会话与父会话完全一致"，把第一个打开即可。
     */
    subagentInjectionEnabled: boolOpt(config.subagentInjectionEnabled, false),
    subagentCaptureEnabled: boolOpt(config.subagentCaptureEnabled, false),

    /**
     * ds-bot 会话识别（总闸 + 两个子开关 + 群聊蒸馏参数），见文件头开关树。
     *
     * 有效值**不在这里算**：`dsbotAwarenessEnabled` 只是开关本身，与 `enabled` /
     * `skillsEnabled` / `captureEnabled` 的 AND 在 `lib/dsbot.mjs`
     * （`sessionPolicy()` 与 `writebackAllowed()`）里做一次，避免散落到各调用点。
     */
    dsbotAwarenessEnabled: boolOpt(config.dsbotAwarenessEnabled, true),
    botSkillInjectEnabled: boolOpt(config.botSkillInjectEnabled, true),
    /** 回写默认关：写 L0 不可逆，首次上线由人手打开。 */
    botWritebackEnabled: boolOpt(config.botWritebackEnabled, false),
    botContextDistillEnabled: boolOpt(config.botContextDistillEnabled, true),
    /** 群聊窗口条数：0 是有效语义（= 不蒸），所以用 numOptZero；上限 20 与面板一致。 */
    botContextMessages: Math.min(20, numOptZero(config.botContextMessages, 5)),
    botContextReuseMemory: boolOpt(config.botContextReuseMemory, false),
    /**
     * 蒸馏用哪家的模型：空 = 主持 Bot 的模型（`rooms[*].admin` → `bots[admin].model`）。
     *
     * 为什么要能换：主持 Bot 多半挂在「会思考」的模型上，而 pi-ai 对这类模型**没有
     * `off` 档**（`thinkingLevelMap.off = null`）——`reasoningEffort:'off'` 只是省略参数，
     * 供应商默认照样思考，思考 token 从 `maxTokens` 里扣，正文被挤空（2026-10-23 现场：
     * `distill-empty`）。换一个 DSH 层面没有思考档位的小模型，蒸馏更快也更省。
     * 形如 `provider/model`（例：`deepseek-official/deepseek-flash`）；写错 → 该轮只写人话。
     */
    botContextModel: str(config.botContextModel) || '',
    /**
     * 蒸馏的输出上限（completion token）。默认 5,000。
     *
     * 为什么给这么大：会思考的模型把思考 token 也算进输出预算，600 那种量级会被思考吃光
     * （现场 `distill-empty`）。5,000 是"思考随便写、正文留够"的兜底；实际输出通常只有
     * 二三百 token，这个值只是上限，不产生额外成本。要省额度可以自己调小。
     */
    botContextMaxTokens: Math.min(32000, Math.max(100, numOpt(config.botContextMaxTokens, 5000))),
    /**
     * 蒸馏超时（毫秒）。默认 15,000。
     *
     * 为什么不再是写死的 8,000：会思考的模型在 5,000 输出预算下可能想十几秒（2026-10-23
     * 现场：8 秒直接 timeout，台账 skip=distill-timeout）。turn-stopping 里等一会儿不影响
     * 用户看到回复（回复已经渲染完），只是记忆写入晚几秒。
     */
    botContextTimeoutMs: Math.min(60000, Math.max(2000, numOpt(config.botContextTimeoutMs, 15000))),
    /** 台账路径：空 = 默认位置（lib/dsbot-ledger.mjs 负责展开与校验）。 */
    dsbotLedgerPath: str(config.dsbotLedgerPath) || '',

    /**
     * 工作区身份覆盖（多工作区多 agent）。默认关：历史部署升级后行为不变。
     * 开关关着时 `workspaceAgents` 仍会被归一化（面板需要回显），但不参与解析。
     */
    workspaceAgentsEnabled: boolOpt(config.workspaceAgentsEnabled, false),
    workspaceAgents: normalizeWorkspaceAgents(config.workspaceAgents),

    endpoint: str(config.endpoint) || 'http://127.0.0.1:8420',
    apiKeyEnv: str(config.apiKeyEnv) || 'TDAI_MEMORY_API_KEY',
    /** memory 实例 id（x-tdai-service-id / space_id）。 */
    serviceId: str(config.serviceId),
    teamId: str(config.teamId),
    agentId: str(config.agentId),
    userId: str(config.userId),
    /** x-tdai-user-key：meta 面（agent/task 详情、借入资产解析）需要；缺省时这些能力降级。 */
    userKey: str(config.userKey),
    /**
     * 知识服务地址改写（可选，**只改 origin**）。
     *
     * 为什么需要：`/v3/knowledge/list` 返回的 `service_url` 是"服务端自己通得到"的地址，
     * 容器化部署里常见 `http://host.docker.internal:8424/v3` 这类**容器内地址**；本插件
     * 进程跑在宿主上时该地址不可达（实测 `fetch failed` → tools/list 全空 → skill 正文
     * 只剩"可用工具：未取到"）。配置本项后把 scheme/host/port 换成这里给的 origin，
     * **path 原样保留**，所以服务端换前缀也不用改配置。
     */
    knowledgeEndpoint: str(config.knowledgeEndpoint),
    /** 可选：session_context 的 [Task] 段 + 回流/召回的 task_id 归属。 */
    taskId: str(config.taskId),

    recallLimit: numOpt(config.recallLimit, 5),
    l2Limit: numOpt(config.l2Limit, 3),
    timeoutMs: numOpt(config.timeoutMs, 5000),

    /**
     * L1 检索的单次硬超时。pre-step 里必须能在有限时间内放弃召回 ——
     * 否则网关不响应时这一步会一直挂着（用户看到的是"发消息一直阻塞等待"）。
     */
    recallTimeoutMs: numOpt(config.recallTimeoutMs, 3000),
    /** 整包资产（meta + L3/L2 + skill + knowledge）加载的总预算，超预算按失败降级。 */
    assetLoadBudgetMs: numOpt(config.assetLoadBudgetMs, 5000),
    /**
     * 资产加载失败后的冷却期：期内不重试，避免每一步都重付一次失败的代价。
     * **允许 0**：0 = 不冷却（每次失败后下一步就会再试一次），用 numOptZero 解析。
     */
    assetRetryCooldownMs: numOptZero(config.assetRetryCooldownMs, 15000),
  }
}

/** 召回 / 注入 / 工具 / 回流 所需的最小身份是否齐全。 */
export function identityComplete(cfg) {
  return Boolean(cfg.serviceId && cfg.teamId && cfg.agentId && cfg.userId)
}

export function baseIdentity(cfg) {
  return {
    space_id: cfg.serviceId,
    team_id: cfg.teamId,
    agent_id: cfg.agentId,
    user_id: cfg.userId,
    task_id: cfg.taskId,
  }
}
