/**
 * TDAI Memory 设置卡片。
 *
 * 2026-11 改版（多工作区多 agent）：
 *   - 顶层按「读侧 / 写侧 / Bot 与子 agent / 身份与工作区」分 Tab；
 *   - 每个 Tab 内的分组可折叠（原生 <details>），高级参数默认收起；
 *   - 身份页新增「工作区 Agent」：工作目录 → { teamId?, agentId? } 规则表；
 *   - 所有长说明改为**标签下一行**并允许换行，输入框 min-width:0 / width:100%，
 *     修掉旧版 `white-space:nowrap` 造成的横向滚动条。
 *
 * 读写（DSH 0.1.7-rc.1）：通过 `ctx.configForms.get(ENTRY_ID)` 拿本 entry 的设置表单；
 * 编辑进草稿（secret 字段脱敏显示、初始置空），用 touched 集合记录用户改过的字段，
 * 保存时只批量 mutate 改过的字段。`workspaceAgents` 是数组节点，按整表替换提交。
 *
 * 挂载位置：`settings.section`（设置面板左侧的顶层导航页）。
 *
 * ── 开关依赖表（改文案前先看这张表）────────────────────────────────────────
 *
 *   读侧总开关 enabled
 *     ├─ L1 自动召回 recallEnabled（recallLimit）
 *     ├─ 云端 skill 召回 skillsEnabled（skillRecallLimit / skillRecallMinScore）
 *     ├─ System prompt 注入 injectionEnabled
 *     │    ├─ sessionContextEnabled
 *     │    │    └─ agentPromptEnabled
 *     │    │         └─ agentPromptKeepBase
 *     │    ├─ profileMemoryEnabled
 *     │    └─ knowledgeEnabled
 *     └─ 只读工具（无独立开关）
 *
 *   写侧总开关 captureEnabled —— 完全独立，不受 enabled / injectionEnabled 约束。
 *   taskWriteEnabled 也是独立写侧开关（默认关，另需 userKey）。
 *
 *   子 agent：subagentInjectionEnabled（读侧，默认关）/ subagentCaptureEnabled（写侧，默认关）。
 *
 *   ds-bot：dsbotAwarenessEnabled 总闸
 *     ├─ botSkillInjectEnabled（还要 AND 全局 enabled + skillsEnabled）
 *     └─ botWritebackEnabled（默认关，还要 AND captureEnabled）
 *          ├─ botContextDistillEnabled
 *          ├─ botContextMessages / botContextMaxTokens / botContextTimeoutMs
 *          └─ botContextReuseMemory
 *
 *   工作区身份覆盖：workspaceAgentsEnabled 总闸 + workspaceAgents 规则表。
 *     命中 → 用规则里的 teamId / agentId 覆盖默认身份（空项回落默认）；
 *     未命中 / 总开关关 → 默认身份。判定只在 config.mjs 的 identityForWorkspace()。
 */
import React from 'react'
import type { Context } from '@deepseek-ai/cordis'

const NS = 'tdai-memory'

type TabId = 'read' | 'write' | 'bot' | 'identity'

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'read', label: '读侧' },
  { id: 'write', label: '写侧' },
  { id: 'bot', label: 'Bot 与子 agent' },
  { id: 'identity', label: '身份与工作区' },
]

const READ_MASTER = {
  key: 'enabled',
  label: '读侧总开关',
  hint: '关闭后：L1 召回 / 注入 / 只读工具全部停用；不影响「对话回流」',
}
const RECALL_TOGGLE = {
  key: 'recallEnabled',
  label: 'L1 自动召回',
  hint: '每轮按你的输入检索相关记忆，作为独立消息插入本轮',
}
const SKILL_RECALL_TOGGLE = {
  key: 'skillsEnabled',
  label: '云端 skill 召回',
  hint: '每轮按当前对话检索这个 agent 名下的云端 skill，命中才注入（只给名字 + 一句描述，正文按需用 tdai_skill_view 取）',
}
const INJECT_MASTER = {
  key: 'injectionEnabled',
  label: 'System prompt 注入',
  hint: '只管下面那几个注入段；不影响 L1 召回与 skill 召回',
}

const READ_DIM_REASON = '「读侧总开关」已关闭，此项暂不生效'
const RECALL_DIM_REASON = '「L1 自动召回」已关闭，此项暂不生效'
const SKILL_RECALL_DIM_REASON = '「云端 skill 召回」已关闭，此项暂不生效'
const INJECT_DIM_REASON = '「System prompt 注入」总闸已关闭，此项暂不生效'
const AGENT_PROMPT_DIM_REASON = '「Agent 角色 / 规则 prompt」已关闭，此项暂不生效'
const SESSION_CONTEXT_DIM_REASON = '「会话上下文（Agent / Task）」已关闭，此项暂不生效'

const DEP_DIM_REASON: Record<string, string> = {
  sessionContextEnabled: SESSION_CONTEXT_DIM_REASON,
  agentPromptEnabled: AGENT_PROMPT_DIM_REASON,
}

/**
 * 注入段：`dimmedBy` = UI 上的从属关系（列表里任一开关关掉 → 置灰）。
 * 层级与 config.mjs 的开关树一致：sessionContext → agentPrompt → keepBase。
 */
const INJECT_TOGGLES = [
  {
    key: 'sessionContextEnabled',
    label: '会话上下文（Agent / Task）',
    hint: '把当前 agent / task 的身份写进 <session_context> 块',
  },
  {
    key: 'agentPromptEnabled',
    label: 'Agent 角色 / 规则 prompt',
    hint: '把「角色定位 prompt」+「规则固定 prompt」写进 [Role] / [Rules]，并在 persona 槽放一句英文指引',
    dimmedBy: ['sessionContextEnabled'],
  },
  {
    key: 'agentPromptKeepBase',
    label: '保留原 persona 行',
    hint: '默认关：persona 槽只放那句英文指引。打开则先保留 DSH 原 persona 前缀，再接指引句',
    defaultOff: true,
    dimmedBy: ['sessionContextEnabled', 'agentPromptEnabled'],
  },
  {
    key: 'profileMemoryEnabled',
    label: '长期记忆（L3 画像 + L2 索引）',
    hint: '把画像与场景索引注入 system prompt；L1 召回不受它影响',
  },
  {
    key: 'knowledgeEnabled',
    label: '知识库（wiki / code-graph）',
    hint: '默认关：开启后注入知识路由，并注册 tdai-team-knowledge skill 与知识工具',
    defaultOff: true,
  },
]

const SUBAGENT_INJECT_TOGGLE = {
  key: 'subagentInjectionEnabled',
  label: '子 agent 全量继承读侧',
  hint: '默认关：子会话不注入身份与记忆、不做 L1 召回与 skill 召回（团队知识库与只读工具本就可用）',
  defaultOff: true,
}
const SUBAGENT_CAPTURE_TOGGLE = {
  key: 'subagentCaptureEnabled',
  label: '子 agent 对话回流',
  hint: '默认关：子 agent 的执行过程不写进长期记忆',
  defaultOff: true,
}

const DSBOT_MASTER_TOGGLE = {
  key: 'dsbotAwarenessEnabled',
  label: '识别 ds-bot 会话',
  hint: '总闸：关掉后不索引 ds-bot 的 state.json，Bot 会话按普通会话处理',
}
const BOT_SKILL_INJECT_TOGGLE = {
  key: 'botSkillInjectEnabled',
  label: 'Bot 会话注入云端 skill',
  hint: '「Bot 会话识别 / 读侧总开关 / 云端 skill 召回」任一关闭时置灰；身份与记忆对 Bot 会话恒不注入',
  dimmedBy: ['dsbotAwarenessEnabled', 'enabled', 'skillsEnabled'],
}
const BOT_WRITEBACK_TOGGLE = {
  key: 'botWritebackEnabled',
  label: 'Bot 会话回写记忆',
  hint: '「Bot 会话识别 / 对话回流」任一关闭时置灰；默认关，首次上线手动打开',
  defaultOff: true,
  dimmedBy: ['dsbotAwarenessEnabled', 'captureEnabled'],
}
const BOT_CONTEXT_DISTILL_TOGGLE = {
  key: 'botContextDistillEnabled',
  label: '群聊前文蒸馏',
  hint: '回写关着时蒸馏没有意义；关掉后群聊只写人话',
  dimmedBy: ['dsbotAwarenessEnabled', 'botWritebackEnabled'],
}
const WORKSPACE_MASTER_TOGGLE = {
  key: 'workspaceAgentsEnabled',
  label: '按工作区覆盖 Agent / Team',
  hint: '默认关：所有工作区使用上面的默认身份。开启后，命中的工作区可以单独指定 Team / Agent',
  defaultOff: true,
}
const BOT_CONTEXT_REUSE_TOGGLE = {
  key: 'botContextReuseMemory',
  label: '复用本群 MEMORY 条目',
  hint: '默认关，避免归因回环；「Bot 会话识别 / 回写」任一关闭时置灰',
  defaultOff: true,
  dimmedBy: ['dsbotAwarenessEnabled', 'botWritebackEnabled'],
}

const DSBOT_TOGGLES = [DSBOT_MASTER_TOGGLE, BOT_SKILL_INJECT_TOGGLE, BOT_WRITEBACK_TOGGLE]
const BOT_CONTEXT_TOGGLES = [BOT_CONTEXT_DISTILL_TOGGLE, BOT_CONTEXT_REUSE_TOGGLE]

const DSBOT_DIM_REASON = '「识别 ds-bot 会话」已关闭，此项暂不生效'
const CAPTURE_DIM_REASON = '「对话回流到 MemoryCore」已关闭，此项暂不生效'
const BOT_CONTEXT_DIM_REASON = '「Bot 会话回写记忆」已关闭，群聊蒸馏没有意义'
const DSBOT_DIM_REASONS: Record<string, string> = {
  dsbotAwarenessEnabled: DSBOT_DIM_REASON,
  enabled: READ_DIM_REASON,
  skillsEnabled: SKILL_RECALL_DIM_REASON,
  captureEnabled: CAPTURE_DIM_REASON,
  botWritebackEnabled: BOT_CONTEXT_DIM_REASON,
}

const WRITE_TOGGLES = [
  {
    key: 'captureEnabled',
    label: '对话回流到 MemoryCore',
    hint: '独立开关：读侧全关也照常回流；每轮写回 L0 并触发 Skill 归档',
  },
  {
    key: 'taskWriteEnabled',
    label: '待办写入 task',
    hint: '默认关：打开后你在对话里明确说「记一下」的待办直接写进 MemoryCore 的 task（另需 User Key），不再落到本地文件',
    defaultOff: true,
  },
]

const NUMERIC_FIELDS: Record<string, { min: number; max: number; label: string; dflt: number; dimmedBy?: string[] }> = {
  recallLimit: { min: 1, max: 20, label: '单轮召回条数上限', dflt: 5 },
  skillRecallLimit: { min: 1, max: 10, label: 'skill 召回条数上限', dflt: 3 },
  skillRecallMinScore: { min: 0, max: 100, label: 'skill 召回分数下限', dflt: 4 },
  botContextMessages: {
    min: 0, max: 20, label: '群聊窗口条数', dflt: 5,
    dimmedBy: ['dsbotAwarenessEnabled', 'botWritebackEnabled'],
  },
  botContextMaxTokens: {
    min: 100, max: 32000, label: '蒸馏输出上限', dflt: 5000,
    dimmedBy: ['dsbotAwarenessEnabled', 'botWritebackEnabled'],
  },
  botContextTimeoutMs: {
    min: 2000, max: 60000, label: '蒸馏超时', dflt: 15000,
    dimmedBy: ['dsbotAwarenessEnabled', 'botWritebackEnabled'],
  },
}

/** readEnabled() 需要的身份字段（缺一读侧就整体不生效）。 */
const REQUIRED_IDENTITY = ['serviceId', 'teamId', 'agentId', 'userId']

const IDENTITY_FIELDS = [
  { key: 'endpoint', label: 'MemoryCore 地址', placeholder: 'http://127.0.0.1:8420' },
  { key: 'serviceId', label: 'Memory 实例 ID（x-tdai-service-id）', placeholder: 'default' },
  { key: 'teamId', label: '默认 Team ID' },
  { key: 'agentId', label: '默认 Agent ID' },
  { key: 'userId', label: 'User ID' },
  { key: 'userKey', label: 'User Key（sk-mem-…）', hint: 'meta 面需要；缺省则借入与 session_context 降级', secret: true },
  { key: 'knowledgeEndpoint', label: '知识服务地址改写', placeholder: '如 http://127.0.0.1:8424', hint: '服务端返回容器内地址（host.docker.internal）时填宿主可达的 origin；留空则用服务端返回的地址' },
  { key: 'taskId', label: 'Task ID（可选）' },
]

/** 非身份文本框：不参与身份告警 / secret 脱敏。 */
const BOT_TEXT_FIELDS = [
  {
    key: 'botContextModel',
    label: '蒸馏模型（provider/model）',
    placeholder: '空 = 主持 Bot 的模型；如 deepseek-official/deepseek-flash',
    hint: '群聊前文摘要用哪个模型蒸。主持 Bot 若挂在会思考的模型上，思考 token 会从输出预算里扣，容易把正文挤空（distill-empty）；换一个没有思考档位的小模型更稳也更省',
    dimmedBy: ['dsbotAwarenessEnabled', 'botWritebackEnabled'],
  },
  {
    key: 'dsbotLedgerPath',
    label: '台账路径',
    placeholder: '<DSH_HOME>/storages/tdai-memory-plugin/dsbot-state.json',
    hint: '空 = <DSH_HOME>/storages/tdai-memory-plugin/dsbot-state.json；不接受 <DSH_HOME>/bot 之下',
    dimmedBy: ['dsbotAwarenessEnabled'],
  },
]

/** 卡片字段的单一事实来源，导出给 test/settings-card.test.mjs 做一致性断言。 */
export const CARD_FIELDS = {
  toggles: [
    READ_MASTER,
    RECALL_TOGGLE,
    SKILL_RECALL_TOGGLE,
    INJECT_MASTER,
    ...INJECT_TOGGLES,
    ...WRITE_TOGGLES,
    SUBAGENT_INJECT_TOGGLE,
    SUBAGENT_CAPTURE_TOGGLE,
    ...DSBOT_TOGGLES,
    ...BOT_CONTEXT_TOGGLES,
    WORKSPACE_MASTER_TOGGLE,
  ],
  numeric: NUMERIC_FIELDS,
  identity: IDENTITY_FIELDS,
  text: BOT_TEXT_FIELDS,
  workspace: { master: 'workspaceAgentsEnabled', rules: 'workspaceAgents' },
  requiredIdentity: REQUIRED_IDENTITY,
}

const DEFAULT_OFF_KEYS = new Set(
  CARD_FIELDS.toggles.filter((t) => t.defaultOff === true).map((t) => t.key),
)

export function missingIdentity(value: Record<string, unknown> | undefined): string[] {
  return REQUIRED_IDENTITY.filter((k) => !String(value?.[k] ?? '').trim())
}

/**
 * 开关的"有效布尔值"。
 *
 * 为什么不能直接 `=== true` / `!== false`：schema 的布尔字段是
 * `z.union([z.boolean(), z.string()])`（组合层 env 只能是字符串，见 lib/settings.mjs
 * 的 boolField 注释）。于是 `workspaceAgentsEnabled` 可能是字符串 `"true"`，
 * `=== true` 会把"已启用"显示成关闭 —— 用户看着面板去回滚，等于看着一个假的开关。
 * 与 config.mjs 的 `boolOpt()` 同一口径。
 */
export function boolOn(value: unknown, defaultOn = true): boolean {
  if (value === undefined || value === null || value === '') return defaultOn
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  return !/^(0|false|no|off)$/i.test(String(value).trim())
}

/**
 * 工作目录的「判重键」（纯字符串运算，浏览器里没有 `node:path`）。
 *
 * 为什么必须有它：运行期按 `config.mjs` 的 `normalizeWorkspacePath()`（`path.resolve`
 * + 去尾分隔符 + win32 小写）匹配，且 `normalizeWorkspaceAgents()` 对同一路径是
 * **后者覆盖前者**。若面板按原始字符串判重，`/repo/a/` 与 `/repo/a` 都能存下去 ——
 * 面板显示两条规则，运行期只有后来那条生效，第一行配置静默失效。
 *
 * 这里做同一套归一（只是不碰文件系统）：
 *   - 反斜杠风格（`C:\`、`\\server`、含 `\`）视为 Windows：统一分隔符 + 小写；
 *   - 去掉 `.` 段、折叠 `..` 段、去掉尾分隔符（根路径除外）。
 * 绝对路径的判定与归一在同一处，避免两套口径。
 */
export function workspacePathKey(raw: unknown): string {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  const windows = /^[a-zA-Z]:[\\/]/.test(text) || text.startsWith('\\\\') || text.includes('\\')
  const slash = windows ? '\\' : '/'
  const unified = windows ? text.replace(/\//g, '\\') : text
  const drive = windows ? /^([a-zA-Z]):/.exec(unified) : null
  const body = drive ? unified.slice(2) : unified
  const parts: string[] = []
  for (const segment of body.split(/[\\/]+/)) {
    if (!segment || segment === '.') continue
    if (segment === '..') { parts.pop(); continue }
    parts.push(segment)
  }
  const lead = drive
    ? `${drive[1].toLowerCase()}:`
    : windows
      ? (unified.startsWith('\\\\') ? '\\\\' : '')
      : (unified.startsWith('/') ? '/' : '')
  const joined = `${lead}${parts.join(slash)}`
  return windows ? joined.toLowerCase() : joined
}

/** 工作区路径必须是绝对路径：相对路径会被运行期按插件进程 cwd 解析，规则永远不命中。 */
export function isAbsoluteWorkspacePath(raw: unknown): boolean {
  const text = String(raw ?? '').trim()
  if (!text) return false
  return text.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(text) || text.startsWith('\\\\')
}

/**
 * 工作区规则行归一化（纯函数，便于单测与保存前校验）。
 *
 * - 只保留有路径、且 teamId / agentId 至少填了一个的行；
 * - 路径必须是绝对路径（相对路径运行期永远匹配不上会话 cwd，属于静默失效）；
 * - 判重按 `workspacePathKey()`，与运行期的 `normalizeWorkspacePath()` 同口径：
 *   `/repo/a/` 与 `/repo/a` 算**同一条**，报错拦下保存，而不是静默丢一条；
 * - 不改存储里的路径写法（规范化仍在 config.mjs 做），只用于判重与校验。
 */
export function sanitizeWorkspaceAgents(rows: unknown): {
  rows: Array<{ workspace: string; title: string; teamId: string; agentId: string }>
  error: string
} {
  const list = Array.isArray(rows) ? rows : []
  const seen = new Map<string, string>()
  const out: Array<{ workspace: string; title: string; teamId: string; agentId: string }> = []
  for (const row of list) {
    if (!row || typeof row !== 'object') continue
    const workspace = String((row as Record<string, unknown>).workspace ?? '').trim()
    const title = String((row as Record<string, unknown>).title ?? '').trim()
    const teamId = String((row as Record<string, unknown>).teamId ?? '').trim()
    const agentId = String((row as Record<string, unknown>).agentId ?? '').trim()
    if (!workspace) continue
    if (!teamId && !agentId) continue
    if (!isAbsoluteWorkspacePath(workspace)) {
      return { rows: out, error: `工作区必须是绝对路径：${workspace}` }
    }
    const key = workspacePathKey(workspace)
    const previous = seen.get(key)
    if (previous !== undefined) {
      return {
        rows: out,
        error: previous === workspace
          ? `工作区重复：${workspace}`
          : `工作区重复：${previous} 与 ${workspace} 是同一个目录`,
      }
    }
    seen.set(key, workspace)
    out.push({ workspace, title, teamId, agentId })
  }
  return { rows: out, error: '' }
}

/** 把配置里的 workspaceAgents（数组 / JSON 字符串 / 空串）读成可编辑行。 */
export function asWorkspaceRows(raw: unknown): Array<{ workspace: string; title: string; teamId: string; agentId: string }> {
  let value = raw
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (!text) return []
    try { value = JSON.parse(text) } catch { return [] }
  }
  if (!Array.isArray(value)) return []
  return value.flatMap((row) => {
    if (!row || typeof row !== 'object') return []
    const workspace = String((row as Record<string, unknown>).workspace ?? '').trim()
    if (!workspace) return []
    return [{
      workspace,
      title: String((row as Record<string, unknown>).title ?? '').trim(),
      teamId: String((row as Record<string, unknown>).teamId ?? '').trim(),
      agentId: String((row as Record<string, unknown>).agentId ?? '').trim(),
    }]
  })
}

/**
 * 把面板草稿归一成可落库的操作列表（纯函数，便于单测；save() 只负责调用与提交）。
 *
 * 两条规则：
 *   - 空字符串 = `unset`，即清掉用户层、回落到 env / schema 默认值（文本框与数字框一致）；
 *   - 数值字段必须转成 **number**（schema 的 string 分支只服务组合层 env；用户层存数字，
 *     区间约束与 override 语义才干净），越界按 [min, max] 收敛并把收敛结果回填草稿（patch）
 *     + 记一句提示（adjusted）。
 *
 * `workspaceAgents` 是数组：走通用分支，整表 `set`（数组在 settings.mutate 里是整体替换）。
 */
export function buildSaveOps(
  draft: Record<string, unknown>,
  touched: Iterable<string>,
  numericFields: Record<string, { min: number; max: number; label: string }> = NUMERIC_FIELDS,
) {
  const ops: Array<{ op: 'set' | 'unset'; path: string[]; value?: unknown }> = []
  const patch: Record<string, unknown> = {}
  const adjusted: string[] = []

  for (const key of touched) {
    const numeric = numericFields[key]
    if (numeric) {
      const raw = draft[key]
      const text = typeof raw === 'string' ? raw.trim() : (raw === undefined || raw === null ? '' : String(raw))
      if (text === '') {
        ops.push({ op: 'unset', path: [key] })
        patch[key] = ''
        continue
      }
      const n = Number(text)
      if (!Number.isFinite(n)) {
        return { ops, patch, adjusted, error: `「${numeric.label}」需要填数字（${numeric.min}–${numeric.max}）` }
      }
      const bounded = Math.min(numeric.max, Math.max(numeric.min, Math.floor(n)))
      if (bounded !== n) adjusted.push(`${numeric.label} 按 ${numeric.min}–${numeric.max} 取为 ${bounded}`)
      ops.push({ op: 'set', path: [key], value: bounded })
      patch[key] = bounded
      continue
    }
    const v = draft[key]
    if (typeof v === 'string' && v === '') {
      ops.push({ op: 'unset', path: [key] })
      patch[key] = ''
    } else {
      ops.push({ op: 'set', path: [key], value: v })
      patch[key] = v
    }
  }

  return { ops, patch, adjusted, error: '' }
}

const C = {
  border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
  borderSoft: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.22))',
  guide: '2px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.30))',
  tertiary: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
  secondary: 'var(--dsw-alias-label-secondary, inherit)',
}

function blankSecrets(value: Record<string, unknown>): Record<string, unknown> {
  const next = { ...value }
  for (const f of IDENTITY_FIELDS) if (f.secret) next[f.key] = ''
  return next
}

function workspaceBasename(workspace: string): string {
  const parts = workspace.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || workspace
}

/**
 * 本卡片用到的最小设置表单契约（对应 dsh-client-ui-settings 的 `ConfigForm`）。
 *
 * 只声明用到的部分：客户端插件**不能**把 `@deepseek-ai/dsh-client-ui-*` 当模块导入
 * （跨包值导入被 client bundle 的纯度门禁拒绝，且随版本变），所以这里用结构化类型。
 */
export interface SettingsForm {
  getSnapshot(): {
    status: 'loading' | 'ready' | 'unavailable'
    value?: unknown
    writable?: boolean
  }
  subscribe(listener: () => void): () => void
  mutate(ops: unknown[]): Promise<unknown>
}

/** 只读的 describe 面：用来判断 secret 字段"是否已设置"（明文永远拿不到）。 */
export interface SettingsDescribeFace {
  getSnapshot(): {
    view?: { namespaces?: Array<{ ns: string; secrets?: Array<{ path: string[]; set: boolean }> }> }
  }
  subscribe(listener: () => void): () => void
}

/** 设置页标准 props 里的 workspace 快照（结构类型；缺失时退回手填路径）。 */
export interface WorkspacesFace {
  (selector?: (snapshot: any) => any): any
}

/**
 * `useWorkspaces` 缺失时的占位实现：让调用点保持**无条件**，hooks 数量不随 props 变化。
 * 没有工作区快照时面板退化为手填绝对路径（`workspaceOptions` 为空 → 换 placeholder）。
 */
const noWorkspaces: WorkspacesFace = () => undefined

interface CardProps {
  form: SettingsForm
  describe?: SettingsDescribeFace
  entryId?: string
  /** 测试 / 深链用：指定初始 Tab；应用不传，默认「读侧」。 */
  initialTab?: TabId
  /** 设置页标准 props 注入；缺失时工作区选择退化为手填路径。 */
  useWorkspaces?: WorkspacesFace
}

function TdaiMemoryCard(props: CardProps) {
  const { form, describe, useWorkspaces } = props
  const entryId = props.entryId ?? NS
  const [snap, setSnap] = React.useState(() => form.getSnapshot())
  const [draft, setDraft] = React.useState<Record<string, unknown> | null>(null)
  const [touched, setTouched] = React.useState<Set<string>>(() => new Set())
  const [note, setNote] = React.useState('')
  /**
   * 保存锁必须是独立状态，不能从 `note` 推断。
   *
   * 旧写法 `saving = note === '保存中…'` 会让**任何**清空 note 的操作（切 Tab 就会）
   * 在请求在飞时把锁摘掉：输入框重新可编辑，保存成功后又整体 `setTouched(new Set())`，
   * 于是这段时间里的编辑既没提交、也不再算"未保存"，关掉面板就丢了。
   */
  const [saving, setSaving] = React.useState(false)
  const [tab, setTab] = React.useState<TabId>(props.initialTab ?? 'read')
  const [newWorkspace, setNewWorkspace] = React.useState('')
  const [workspaceNote, setWorkspaceNote] = React.useState('')
  React.useEffect(() => form.subscribe(() => setSnap(form.getSnapshot())), [form])

  // 设置页把 useWorkspaces 作为标准 props 传进来。它不是必须的：没有它也能手填路径。
  // **无条件调用**（缺失时换成空实现）：条件调用会在 props 有无变化时改变 hook 数量，
  // React 会直接抛 "Rendered more hooks than during the previous render"。
  const workspaceSnap = (useWorkspaces ?? noWorkspaces)((snapshot: any) => snapshot)

  // secret 的"是否已设置"侧信道（值本身跨 wire 就被删掉了）
  const [dsnap, setDsnap] = React.useState(() => describe?.getSnapshot())
  React.useEffect(
    () => (describe ? describe.subscribe(() => setDsnap(describe.getSnapshot())) : undefined),
    [describe],
  )
  const secretSet = (key: string) => {
    const entry = dsnap?.view?.namespaces?.find((n) => n.ns === entryId)
    return entry?.secrets?.some((s) => s.path.length === 1 && s.path[0] === key && s.set) === true
  }

  // 所有 hooks 必须在任何 early return 之前调用：snap.status 从 loading 变 ready 时
  // 组件会重渲染，hook 顺序变化会让 React 直接抛错。
  const current = snap.status === 'ready' && snap.value ? snap.value as Record<string, unknown> : {}
  const writable = snap.writable !== false

  // 首次 ready 后把当前值灌进草稿（secret 脱敏置空）
  React.useEffect(() => {
    if (snap.status === 'ready' && draft === null) setDraft(blankSecrets(current))
  }, [snap.status, current, draft])

  const workspaceOptions = React.useMemo(() => {
    const items = workspaceSnap?.items
    if (!Array.isArray(items)) return [] as Array<{ path: string; title: string }>
    return items
      .map((item: any) => ({ path: String(item?.path ?? ''), title: String(item?.title ?? '') }))
      .filter((item: { path: string }) => item.path)
  }, [workspaceSnap])

  if (snap.status === 'unavailable') {
    return (
      <div style={rootStyle} role="status">
        <div style={{ fontSize: '14px', fontWeight: 600 }}>TDAI Memory</div>
        <div style={{ color: C.tertiary, fontSize: '13px', marginTop: '6px', lineHeight: 1.5 }}>
          设置当前不可用：宿主没有暴露本插件的设置命名空间（<code>{entryId}</code>）。
          请确认 dsh-tdai-memory-plugin 已在 profile 中启用（entry 状态应为 <code>schema</code>），
          并检查宿主日志里是否有 <code>[tdai-memory]</code> 的报错。
        </div>
      </div>
    )
  }

  const value: Record<string, unknown> = draft ?? current
  const dirty = touched.size > 0

  // 开关一律按"有效布尔值"判（schema 允许字符串，见 boolOn 注释）。
  const readOn = boolOn(value.enabled)
  const recallOn = boolOn(value.recallEnabled)
  const skillOn = boolOn(value.skillsEnabled)
  const injectOn = boolOn(value.injectionEnabled)
  const writeOn = boolOn(value.captureEnabled)
  const missingIdentityKeys = snap.status === 'ready' ? missingIdentity(value) : []
  const workspaceRows = asWorkspaceRows(value.workspaceAgents)
  const workspaceOn = boolOn(value.workspaceAgentsEnabled, false)

  const switchOff = (key: string) =>
    (DEFAULT_OFF_KEYS.has(key) ? !boolOn(value[key], false) : !boolOn(value[key], true))
  const dsbotDim = (t: { dimmedBy?: string[] }) => {
    const offParent = (t.dimmedBy ?? []).find(switchOff)
    return {
      dim: offParent !== undefined,
      reason: offParent === undefined ? '' : (DSBOT_DIM_REASONS[offParent] ?? DSBOT_DIM_REASON),
    }
  }

  const edit = (key: string, val: unknown) => {
    setDraft((d) => (d ? { ...d, [key]: val } : { [key]: val }))
    setTouched((s) => new Set(s).add(key))
    setNote('')
  }

  const editWorkspaces = (rows: Array<{ workspace: string; title: string; teamId: string; agentId: string }>) => {
    edit('workspaceAgents', rows)
  }

  const updateWorkspaceRow = (index: number, patch: Partial<{ title: string; teamId: string; agentId: string }>) => {
    editWorkspaces(workspaceRows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  const removeWorkspaceRow = (index: number) => {
    editWorkspaces(workspaceRows.filter((_, i) => i !== index))
    setWorkspaceNote('')
  }

  const addWorkspaceRow = () => {
    const path = newWorkspace.trim()
    if (!path) {
      setWorkspaceNote('先填写或选择一个工作区路径')
      return
    }
    if (!isAbsoluteWorkspacePath(path)) {
      setWorkspaceNote(`工作区必须是绝对路径：${path}`)
      return
    }
    // 判重键与运行期同口径（`/repo/a/` 与 `/repo/a` 是同一条），否则存下去会被后者覆盖
    const key = workspacePathKey(path)
    const duplicate = workspaceRows.find((row) => workspacePathKey(row.workspace) === key)
    if (duplicate) {
      setWorkspaceNote(duplicate.workspace === path
        ? '这个工作区已经在列表里了'
        : `这个目录已经在列表里了（${duplicate.workspace}）`)
      return
    }
    const matched = workspaceOptions.find((item) => workspacePathKey(item.path) === key)
    editWorkspaces([...workspaceRows, { workspace: path, title: matched?.title ?? '', teamId: '', agentId: '' }])
    setNewWorkspace('')
    setWorkspaceNote('')
  }

  const reset = () => {
    setDraft(blankSecrets(current))
    setTouched(new Set())
    setNote('')
    setWorkspaceNote('')
  }

  const save = () => {
    if (!draft || touched.size === 0) return
    let nextDraft = draft
    if (touched.has('workspaceAgents')) {
      const sanitized = sanitizeWorkspaceAgents(draft.workspaceAgents)
      if (sanitized.error) {
        setNote(sanitized.error)
        return
      }
      nextDraft = { ...draft, workspaceAgents: sanitized.rows }
      setDraft(nextDraft)
    }
    const { ops, patch, adjusted, error: invalid } = buildSaveOps(nextDraft, touched)
    if (invalid) { setNote(invalid); return }

    // 只清「本次真正提交成功的键」：请求在飞时用户仍可能继续编辑（Tab 切换不再摘锁，
    // 但慢网关上保存锁本身也可能被超时/失败放开），整表清空会把这些编辑吞掉。
    const submitted = new Set(touched)
    setSaving(true)
    setNote('保存中…')
    // 放进微任务里调用：`form.mutate` 若**同步**抛错，直接写 `Promise.resolve(form.mutate(...))`
    // 会绕过下面的 catch，`saving` 停在 true 把整个面板锁死。
    Promise.resolve()
      .then(() => form.mutate(ops))
      .then((ok) => {
        // 宿主用 `false` 表示"拒绝写入 / 未写入"（不是抛错）。当成成功会显示"已保存"
        // 而实际没落盘，用户回面板看到的还是旧值。
        if (ok === false) {
          setNote('保存失败：宿主拒绝了本次写入（可能有其他窗口同时修改，请重试）')
          return
        }
        setDraft((d) => (d ? { ...d, ...patch } : d))
        setNote(adjusted.length > 0 ? `已保存（${adjusted.join('；')}）` : '已保存')
        setTouched((previous) => new Set([...previous].filter((key) => !submitted.has(key))))
      })
      .catch((error) => setNote(`保存失败：${error?.message ?? '未知错误'}`))
      .finally(() => setSaving(false))
  }

  const fieldRow = (label: React.ReactNode, control: React.ReactNode, key: string) => (
    <div key={key} style={fieldRowStyle}>
      <div style={labelStyle}>{label}</div>
      {control}
    </div>
  )

  const inputStyleFor = (dim = false): React.CSSProperties => ({
    ...inputStyle,
    opacity: dim ? 0.55 : 1,
  })

  const textFieldRow = (
    f: { key: string; label: string; hint?: string; placeholder?: string; dimmedBy?: string[] },
    dim: boolean,
    dimReason: string,
  ) => {
    const shown = typeof value[f.key] === 'string' ? value[f.key] as string : ''
    return (
      <div key={f.key} title={dim ? dimReason : undefined} style={{ ...fieldRowStyle, opacity: dim ? 0.55 : 1 }}>
        <div style={labelStyle}>{f.label}</div>
        <input
          type="text"
          value={shown}
          placeholder={f.placeholder}
          disabled={!writable || saving}
          style={inputStyleFor(dim)}
          onChange={(e) => edit(f.key, e.target.value)}
        />
        {f.hint ? <div style={hintStyle}>{f.hint}</div> : null}
      </div>
    )
  }

  const ghostBtn = {
    appearance: 'none', font: 'inherit', fontSize: '13px', lineHeight: 1.5,
    cursor: dirty && !saving ? 'pointer' : 'default', border: C.border, borderRadius: '8px',
    padding: '5px 14px', background: 'none', color: C.secondary, opacity: dirty ? 1 : 0.4,
  } as const

  const primaryBtn = {
    appearance: 'none', font: 'inherit', fontSize: '13px', lineHeight: 1.5,
    cursor: dirty && !saving ? 'pointer' : 'default', border: '1px solid transparent', borderRadius: '8px',
    padding: '5px 14px', background: 'var(--dsw-alias-label-primary, currentColor)',
    color: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.05))', opacity: dirty ? 1 : 0.4,
  } as const

  const toggleRow = (
    t: { key: string; label: string; hint?: string; defaultOff?: boolean; dimmedBy?: string[] },
    dim: boolean,
    dimReason: string,
  ) => {
    // 有效布尔值（env 传的是字符串 "true"/"false"，见 boolOn 注释）：默认关的开关
    // 缺省 = 关，默认开的开关缺省 = 开。
    const checked = boolOn(value[t.key], t.defaultOff !== true)
    return (
      <label key={t.key} title={dim ? dimReason : undefined} style={{ ...toggleStyle, opacity: dim ? 0.55 : 1 }}>
        <input
          type="checkbox"
          checked={checked}
          disabled={!writable || saving}
          onChange={(e) => edit(t.key, e.target.checked)}
          style={checkboxStyle}
        />
        <span style={toggleTextStyle}>
          <span>{t.label}</span>
          {t.hint ? <span style={hintStyle}>{t.hint}</span> : null}
        </span>
      </label>
    )
  }

  const numericRow = (key: string, hint: string, dim: boolean, dimReason: string) => {
    const meta = NUMERIC_FIELDS[key]
    const raw = draft ? draft[key] : current[key]
    const shown = raw === undefined || raw === null ? '' : String(raw)
    return (
      <div key={key} title={dim ? dimReason : undefined} style={{ ...numericStyle, opacity: dim ? 0.55 : 1 }}>
        <div style={numericLineStyle}>
          <span style={{ color: C.secondary }}>{meta.label}</span>
          <input
            type="number"
            min={meta.min}
            max={meta.max}
            step={1}
            value={shown}
            placeholder={String(meta.dflt)}
            disabled={!writable || saving}
            onChange={(e) => edit(key, e.target.value)}
            style={numberInputStyle}
          />
        </div>
        <div style={hintStyle}>{hint}</div>
      </div>
    )
  }

  /** 一个可折叠分组。原生 details 不依赖 JS；测试也能拿到隐藏内容。 */
  const section = (
    title: string,
    summary: string,
    children: React.ReactNode,
    options: { open?: boolean; key?: string } = {},
  ) => (
    <details key={options.key ?? title} open={options.open} className="tdai-section" style={sectionStyle}>
      <summary style={summaryStyle}>
        <span className="tdai-chevron" aria-hidden="true">▸</span>
        <span style={summaryTitleStyle}>{title}</span>
        <span style={summaryHintStyle}>{summary}</span>
      </summary>
      <div style={sectionBodyStyle}>{children}</div>
    </details>
  )

  const identityWarning = () => {
    if (!readOn || missingIdentityKeys.length === 0) return null
    return (
      <p style={warningStyle} role="status">
        ⚠️ 默认身份未填全（缺 {missingIdentityKeys.join(' / ')}）→ 读侧（召回 / 注入 / 工具）默认不生效；
        若某个工作区覆盖补全了缺失字段，该工作区仍可用。「对话回流」不受影响。
      </p>
    )
  }

  const readTab = (
    <div>
      {section('召回', 'L1 记忆 + 云端 skill', (
        <>
          {toggleRow(READ_MASTER, false, '')}
          {toggleRow(RECALL_TOGGLE, !readOn, READ_DIM_REASON)}
          {numericRow('recallLimit', '条（自有 + 借入合并后的上限，1–20；实际还受 4000 字符预算约束）', !readOn || !recallOn, !readOn ? READ_DIM_REASON : RECALL_DIM_REASON)}
          {toggleRow(SKILL_RECALL_TOGGLE, !readOn, READ_DIM_REASON)}
          {numericRow('skillRecallLimit', '条（每轮最多注入几条命中，1–10）', !readOn || !skillOn, !readOn ? READ_DIM_REASON : SKILL_RECALL_DIM_REASON)}
          {numericRow('skillRecallMinScore', '分以下不注入（默认 4；0 = 关掉闸门）', !readOn || !skillOn, !readOn ? READ_DIM_REASON : SKILL_RECALL_DIM_REASON)}
        </>
      ), { open: true, key: 'recall' })}

      {section('System prompt 注入', '身份 / 画像 / 知识路由', (
        <>
          {toggleRow(INJECT_MASTER, !readOn, READ_DIM_REASON)}
          <div style={indentStyle}>
            {INJECT_TOGGLES.map((t) => {
              // 与 dsbotDim 同口径：置灰判据也走 switchOff（env 字符串值同样成立）
              const offParent = (t.dimmedBy ?? []).find((k: string) => switchOff(k))
              const dim = !readOn || !injectOn || offParent !== undefined
              const reason = !readOn ? READ_DIM_REASON
                : (!injectOn ? INJECT_DIM_REASON : (DEP_DIM_REASON[offParent as string] ?? INJECT_DIM_REASON))
              return toggleRow(t, dim, reason)
            })}
          </div>
          {identityWarning()}
        </>
      ), { open: true, key: 'inject' })}
    </div>
  )

  const writeTab = (
    <div>
      {section('对话回流', '写侧独立开关', (
        <>
          {WRITE_TOGGLES.map((t) => toggleRow(t, false, ''))}
          <p style={plainHintStyle}>写侧与读侧完全独立：读侧全关也照常回流；回流写 L0 并触发 Skill 归档。</p>
        </>
      ), { open: true, key: 'write' })}

      {section('子 agent', '委派出去的子会话', (
        <>
          {toggleRow(SUBAGENT_CAPTURE_TOGGLE, false, '')}
          <p style={plainHintStyle}>子 agent 的读侧继承在「Bot 与子 agent」页；这里只管它的执行过程是否回流。</p>
        </>
      ), { open: true, key: 'subagent-write' })}
    </div>
  )

  const botTab = (
    <div>
      {section('Bot 会话 · ds-bot', '识别总闸 + 读写子开关', (
        <>
          <p style={plainHintStyle}>
            识别 ds-bot 的 Bot / 房间会话：读侧只注入云端 skill，写侧按人锚点回写；
            身份与记忆对 Bot 会话恒不注入（没有开关）。
          </p>
          {DSBOT_TOGGLES.map((t) => {
            const d = dsbotDim(t)
            return toggleRow(t, d.dim, d.reason)
          })}
          <div style={indentStyle}>
            {(() => {
              const d = dsbotDim(BOT_CONTEXT_DISTILL_TOGGLE)
              return toggleRow(BOT_CONTEXT_DISTILL_TOGGLE, d.dim, d.reason)
            })()}
            {(() => {
              const d = dsbotDim(BOT_CONTEXT_REUSE_TOGGLE)
              return toggleRow(BOT_CONTEXT_REUSE_TOGGLE, d.dim, d.reason)
            })()}
          </div>
        </>
      ), { open: true, key: 'dsbot' })}

      {section('群聊蒸馏参数', '高级 · 默认收起', (
        <>
          {(() => {
            const d = dsbotDim(NUMERIC_FIELDS.botContextMessages)
            return numericRow('botContextMessages', '条（0 = 不蒸；窗口取断点之后、锚点之前的最后 N 条，0–20）', d.dim, d.reason)
          })()}
          {(() => {
            const d = dsbotDim(NUMERIC_FIELDS.botContextMaxTokens)
            return numericRow('botContextMaxTokens', 'token（输出上限，100–32000；思考 token 也从这里扣，摘要正文通常只花 200–300）', d.dim, d.reason)
          })()}
          {(() => {
            const d = dsbotDim(NUMERIC_FIELDS.botContextTimeoutMs)
            return numericRow('botContextTimeoutMs', '毫秒（2000–60000；思考型模型建议 ≥15000，超时只写人话）', d.dim, d.reason)
          })()}
          {BOT_TEXT_FIELDS.map((f) => {
            const d = dsbotDim(f)
            return textFieldRow(f, d.dim, d.reason)
          })}
        </>
      ), { open: false, key: 'distill' })}

      {section('子 agent', '读侧能力面', (
        <>
          {toggleRow(SUBAGENT_INJECT_TOGGLE, !readOn, READ_DIM_REASON)}
          <p style={plainHintStyle}>
            默认关：子会话只保留团队知识库与只读工具，不注入身份 / 记忆 / 云端 skill 召回。
          </p>
        </>
      ), { open: true, key: 'subagent-read' })}
    </div>
  )

  const workspaceRow = (row: { workspace: string; title: string; teamId: string; agentId: string }, index: number) => (
    <div key={`${row.workspace}-${index}`} style={workspaceCardStyle}>
      <div style={workspaceHeaderStyle}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={workspaceTitleStyle}>{row.title || workspaceBasename(row.workspace)}</div>
          <div style={workspacePathStyle}>{row.workspace}</div>
        </div>
        <button
          type="button"
          disabled={!writable || saving}
          onClick={() => removeWorkspaceRow(index)}
          style={miniGhostBtn}
        >
          移除
        </button>
      </div>
      <div style={workspaceInputsStyle}>
        <label style={workspaceFieldStyle}>
          <span style={workspaceFieldLabelStyle}>Team ID</span>
          <input
            type="text"
            value={row.teamId}
            placeholder={typeof value.teamId === 'string' && value.teamId ? `默认 ${value.teamId}` : '默认（未配置）'}
            disabled={!writable || saving}
            style={inputStyle}
            onChange={(e) => updateWorkspaceRow(index, { teamId: e.target.value })}
          />
        </label>
        <label style={workspaceFieldStyle}>
          <span style={workspaceFieldLabelStyle}>Agent ID</span>
          <input
            type="text"
            value={row.agentId}
            placeholder={typeof value.agentId === 'string' && value.agentId ? `默认 ${value.agentId}` : '默认（未配置）'}
            disabled={!writable || saving}
            style={inputStyle}
            onChange={(e) => updateWorkspaceRow(index, { agentId: e.target.value })}
          />
        </label>
      </div>
    </div>
  )

  const identityTab = (
    <div>
      {section('默认身份', '未命中工作区时使用', (
        <>
          <div style={identityGridStyle}>
            {IDENTITY_FIELDS.map((f) => {
              const shown = f.secret ? (draft?.[f.key] ?? '') : (typeof value[f.key] === 'string' ? value[f.key] : '')
              return fieldRow(
                <span>
                  {f.label}
                  {f.hint ? <span style={inlineHintStyle}>{f.hint}</span> : null}
                </span>,
                <input
                  type={f.secret ? 'password' : 'text'}
                  value={shown}
                  placeholder={f.secret && secretSet(f.key) ? '已设置（留空表示不改动）' : f.placeholder}
                  disabled={!writable || saving}
                  style={inputStyle}
                  onChange={(e) => edit(f.key, e.target.value)}
                />,
                f.key,
              )
            })}
          </div>
          <p style={plainHintStyle}>
            读侧需要 instance / team / agent / user 四项齐全；缺项时读侧不生效，写侧不受影响。
          </p>
        </>
      ), { open: true, key: 'identity' })}

      {section('工作区 Agent', '按会话工作目录覆盖 Team / Agent', (
        <>
          {toggleRow(WORKSPACE_MASTER_TOGGLE, false, '')}
          <p style={plainHintStyle}>
            开启后，命中下表工作区的会话使用对应 Agent / Team；未命中、规则为空或总开关关闭时，
            回落到上面的「默认身份」。匹配依据是会话创建时的工作目录（cwd）。
          </p>

          {!workspaceOn ? (
            <p style={plainHintStyle}>当前未启用：所有工作区都使用默认身份。</p>
          ) : null}

          <div style={{ opacity: workspaceOn ? 1 : 0.6 }}>
            {workspaceRows.length === 0 ? (
              <p style={emptyStyle}>还没有绑定。添加一个工作区后，只有该目录下的会话使用这里的 Agent。</p>
            ) : workspaceRows.map(workspaceRow)}
          </div>

          <div style={addRowStyle}>
            <input
              type="text"
              list="tdai-workspace-options"
              value={newWorkspace}
              placeholder={workspaceOptions.length > 0 ? '选择或输入工作区路径' : '输入工作区绝对路径'}
              disabled={!writable || saving}
              style={{ ...inputStyle, flex: 1, minWidth: 0 }}
              onChange={(e) => { setNewWorkspace(e.target.value); setWorkspaceNote('') }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addWorkspaceRow() } }}
            />
            <datalist id="tdai-workspace-options">
              {workspaceOptions.map((item) => (
                <option key={item.path} value={item.path}>{item.title || workspaceBasename(item.path)}</option>
              ))}
            </datalist>
            <button type="button" disabled={!writable || saving} onClick={addWorkspaceRow} style={smallBtn}>
              添加
            </button>
          </div>
          {workspaceNote ? <p style={warningStyle} role="status">{workspaceNote}</p> : null}
          {workspaceOn && workspaceRows.length > 0 ? (
            <p style={plainHintStyle}>
              共 {workspaceRows.length} 条规则。Team / Agent 留空表示沿用默认；两栏都空的行保存时会被丢弃。
              User Key 仍是全局一份，跨 team 使用时请确认它在该 team 有效。
            </p>
          ) : null}
        </>
      ), { open: true, key: 'workspace' })}
    </div>
  )

  const content = tab === 'read' ? readTab
    : tab === 'write' ? writeTab
      : tab === 'bot' ? botTab
        : identityTab

  return (
    <div style={rootStyle}>
      <style>{`
        .tdai-section > summary { list-style: none; }
        .tdai-section > summary::-webkit-details-marker { display: none; }
        .tdai-chevron {
          display: inline-block; flex: none; width: 10px; margin-top: 1px;
          color: var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8));
          font-size: 12px; line-height: 1.4;
          transition: transform .15s ease; transform: rotate(0deg);
        }
        .tdai-section[open] > summary .tdai-chevron { transform: rotate(90deg); }
      `}</style>
      <div style={statusLineStyle}>
        <span>读侧{readOn ? '开' : '关'}</span>
        <span style={dotStyle}>·</span>
        <span>写侧{writeOn ? '开' : '关'}</span>
        <span style={dotStyle}>·</span>
        <span>工作区覆盖{workspaceOn ? `开（${workspaceRows.length} 条）` : '关'}</span>
        {missingIdentityKeys.length > 0 ? (
          <>
            <span style={dotStyle}>·</span>
            <span style={{ color: 'var(--dsw-alias-label-warning, #b7791f)' }}>默认身份缺 {missingIdentityKeys.join('/')}</span>
          </>
        ) : null}
      </div>

      <div style={tabBarStyle} role="tablist" aria-label="TDAI Memory 设置分组">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => { setTab(t.id); setNote('') }}
            style={tab === t.id ? activeTabStyle : tabStyle}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div style={contentStyle}>
        {!writable && <p style={plainHintStyle} role="status">当前设置为只读。</p>}
        {content}
      </div>

      <div style={footerStyle}>
        {note && <span style={footerNoteStyle} role="status">{note}</span>}
        <button type="button" disabled={!dirty || saving} onClick={reset} style={ghostBtn}>放弃修改</button>
        <button type="button" disabled={!dirty || saving} onClick={save} style={primaryBtn}>保存</button>
      </div>
    </div>
  )
}

const rootStyle: React.CSSProperties = {
  border: C.border,
  background: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.05))',
  borderRadius: '12px',
  width: '100%',
  maxWidth: '100%',
  minWidth: 0,
  boxSizing: 'border-box',
}

const statusLineStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '6px',
  alignItems: 'center',
  padding: '10px 16px 0',
  fontSize: '12px',
  color: C.tertiary,
  lineHeight: 1.4,
  minWidth: 0,
}

const dotStyle: React.CSSProperties = { opacity: 0.5 }

const tabBarStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '2px',
  padding: '8px 16px 0',
  borderBottom: C.borderSoft,
  minWidth: 0,
}

const tabStyle: React.CSSProperties = {
  appearance: 'none',
  font: 'inherit',
  fontSize: '13px',
  lineHeight: 1.4,
  padding: '7px 10px',
  border: 'none',
  borderBottom: '2px solid transparent',
  background: 'none',
  color: C.tertiary,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  marginBottom: '-1px',
}

const activeTabStyle: React.CSSProperties = {
  ...tabStyle,
  color: 'var(--dsw-alias-label-primary, inherit)',
  borderBottom: '2px solid var(--dsw-alias-label-primary, currentColor)',
}

const contentStyle: React.CSSProperties = {
  padding: '4px 16px 8px',
  minWidth: 0,
}

const footerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '8px',
  padding: '10px 16px 12px',
  borderTop: C.borderSoft,
  minWidth: 0,
}

const footerNoteStyle: React.CSSProperties = {
  color: C.tertiary,
  fontSize: '12px',
  marginRight: 'auto',
  alignSelf: 'center',
  minWidth: 0,
  overflowWrap: 'anywhere',
}

const fieldRowStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '5px',
  padding: '8px 0',
  minWidth: 0,
}

const labelStyle: React.CSSProperties = {
  fontSize: '13px',
  color: C.secondary,
  lineHeight: 1.45,
  minWidth: 0,
  overflowWrap: 'anywhere',
}

const inlineHintStyle: React.CSSProperties = {
  color: C.tertiary,
  marginLeft: '6px',
  fontSize: '12px',
  overflowWrap: 'anywhere',
}

const hintStyle: React.CSSProperties = {
  display: 'block',
  color: C.tertiary,
  fontSize: '12px',
  lineHeight: 1.45,
  marginTop: '2px',
  minWidth: 0,
  overflowWrap: 'anywhere',
}

const inputStyle: React.CSSProperties = {
  appearance: 'none',
  width: '100%',
  minWidth: 0,
  maxWidth: '100%',
  boxSizing: 'border-box',
  padding: '7px 10px',
  borderRadius: '8px',
  border: C.border,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  fontSize: '13px',
}

const toggleStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: '8px',
  padding: '7px 0',
  minWidth: 0,
  cursor: 'pointer',
}

const checkboxStyle: React.CSSProperties = {
  width: 15,
  height: 15,
  marginTop: 2,
  accentColor: 'var(--dsw-alias-label-primary, #5b8def)',
  cursor: 'pointer',
  flex: 'none',
}

const toggleTextStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
  fontSize: '13px',
  lineHeight: 1.45,
}

const numericStyle: React.CSSProperties = {
  padding: '7px 0',
  minWidth: 0,
}

const numericLineStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  flexWrap: 'wrap',
  minWidth: 0,
  fontSize: '13px',
}

const numberInputStyle: React.CSSProperties = {
  appearance: 'textfield',
  width: 64,
  minWidth: 0,
  padding: '3px 6px',
  borderRadius: '6px',
  border: C.border,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  fontSize: '13px',
  textAlign: 'center',
}

const sectionStyle: React.CSSProperties = {
  borderTop: C.borderSoft,
  padding: '2px 0',
  minWidth: 0,
}

const summaryStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'baseline',
  gap: '8px',
  padding: '9px 0',
  cursor: 'pointer',
  minWidth: 0,
  listStyle: 'none',
}

const summaryTitleStyle: React.CSSProperties = {
  fontSize: '13px',
  fontWeight: 600,
  color: C.secondary,
}

const summaryHintStyle: React.CSSProperties = {
  fontSize: '12px',
  color: C.tertiary,
  overflowWrap: 'anywhere',
}

const sectionBodyStyle: React.CSSProperties = {
  padding: '0 0 8px',
  minWidth: 0,
}

const indentStyle: React.CSSProperties = {
  paddingLeft: 22,
  marginLeft: 2,
  borderLeft: C.guide,
  minWidth: 0,
}

const plainHintStyle: React.CSSProperties = {
  color: C.tertiary,
  margin: '4px 0 8px',
  fontSize: '12px',
  lineHeight: 1.5,
  overflowWrap: 'anywhere',
  minWidth: 0,
}

const warningStyle: React.CSSProperties = {
  color: 'var(--dsw-alias-label-warning, #b7791f)',
  margin: '6px 0 4px',
  fontSize: '12px',
  lineHeight: 1.5,
  overflowWrap: 'anywhere',
  minWidth: 0,
}

const identityGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  columnGap: '14px',
  minWidth: 0,
}

const workspaceCardStyle: React.CSSProperties = {
  border: C.borderSoft,
  borderRadius: '8px',
  padding: '8px 10px',
  margin: '8px 0',
  minWidth: 0,
  boxSizing: 'border-box',
}

const workspaceHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: '8px',
  minWidth: 0,
}

const workspaceTitleStyle: React.CSSProperties = {
  fontSize: '13px',
  fontWeight: 500,
  lineHeight: 1.4,
  overflowWrap: 'anywhere',
}

const workspacePathStyle: React.CSSProperties = {
  fontSize: '11px',
  color: C.tertiary,
  lineHeight: 1.4,
  marginTop: '2px',
  overflowWrap: 'anywhere',
}

const workspaceInputsStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
  gap: '8px',
  marginTop: '8px',
  minWidth: 0,
}

const workspaceFieldStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  minWidth: 0,
}

const workspaceFieldLabelStyle: React.CSSProperties = {
  fontSize: '12px',
  color: C.tertiary,
}

const addRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: '8px',
  alignItems: 'center',
  marginTop: '10px',
  minWidth: 0,
}

const emptyStyle: React.CSSProperties = {
  color: C.tertiary,
  fontSize: '12px',
  lineHeight: 1.5,
  margin: '6px 0',
  padding: '8px 10px',
  border: C.borderSoft,
  borderRadius: '8px',
  overflowWrap: 'anywhere',
}

const smallBtn: React.CSSProperties = {
  appearance: 'none',
  font: 'inherit',
  fontSize: '13px',
  lineHeight: 1.4,
  cursor: 'pointer',
  border: C.border,
  borderRadius: '8px',
  padding: '6px 12px',
  background: 'none',
  color: C.secondary,
  flex: 'none',
}

const miniGhostBtn: React.CSSProperties = {
  appearance: 'none',
  font: 'inherit',
  fontSize: '12px',
  lineHeight: 1.4,
  cursor: 'pointer',
  border: 'none',
  background: 'none',
  color: C.tertiary,
  padding: '2px 4px',
  flex: 'none',
}

export const name = 'dsh-tdai-memory-plugin-client'
export const inject = ['configForms', 'slots']

/**
 * 设置命名空间 = profile patch 的 entry id，必须与 lib/settings.mjs 的
 * `SETTINGS_NAMESPACE` 和 cordis.patch.yml 的 `id` 三处一致。
 */
export const SETTINGS_ENTRY_ID = NS

export function apply(ctx: Context) {
  const describe = ctx.configForms.describe()
  const form = ctx.configForms.get(NS)
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register({
      name: 'settings.section',
      id: NS,
      order: 200,
      label: () => 'TDAI Memory',
      inject: () => ({ form, describe, entryId: NS }),
    }, TdaiMemoryCard),
  )
}
