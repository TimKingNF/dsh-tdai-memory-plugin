/**
 * TDAI Memory 设置卡片。
 *
 * 完全对齐 Modlens 的设置卡 chrome：原生插件卡（border + 分层背景 + 12px 圆角）、
 * 可折叠头部（标题+副标题+自定义 SVG 箭头）、字段为「标签在上控件在下」的堆叠行、
 * 底部「放弃修改(ghost) + 保存(primary)」草稿式提交。全部行内样式 + --dsw-* 变量。
 *
 * 读写（DSH 0.1.7-rc.1）：通过 `ctx.configForms.get(ENTRY_ID)` 拿到本 entry 的设置表单；
 * 旧的 `ctx.settingsScope.bind({namespace})` 已随 0.1.7-rc.1 一起被删除。编辑进草稿
 * （secret 字段脱敏显示、初始置空），用 touched 集合记录用户改过的字段（避免脱敏导致
 * "永远脏"），保存时只批量 mutate 改过的字段。
 *
 * 挂载位置：`settings.section` —— 设置面板左侧的**顶层导航页**（「设置 → TDAI Memory」），
 * 与 profile 里其它第三方插件（`dsh-better-sidebar` / `dsh-workspace-drag` / `dshmarket`）一致。
 *
 * 走过的弯路：先挂的是 `settings.plugins.tab`（「内置插件」分区里的二级 tab，官方 inventory
 * 用那个）——实测用户**在设置导航里根本看不到**，反馈"没有设置项"。旧的 `settings.plugin.item`
 * 已不存在；`plugins.item` 是 Plugin Manager 的 **keyed** 槽（要 `bundle#rowId` 的 key +
 * summary/full 双视图），语义不符。
 *
 * 这里**无条件注册**（不用 `configForms.whileServed` 包）：命名空间缺失时渲染一条可见的
 * 自解释说明——"客户端加载成功但宿主命名空间缺失"是可诊断状态，不该被藏成"什么都没有"。
 *
 * secret 字段（userKey）：`ConfigFormSnapshot.value` 里**没有**它（宿主的 redact 会把它从
 * value 里删掉），所以只能"留空 = 不改动"。是否已设置从 `describe()` 的 `secrets` 侧信道读。
 *
 * ── 开关的依赖关系（文案必须与真实语义一致，改动前先看这张表）─────────────────
 *
 *   读侧总开关 enabled
 *     ├─ L1 自动召回 recallEnabled（另有条数上限 recallLimit）
 *     ├─ 云端 skill 召回 skillsEnabled（每轮按当前对话检索，另有条数上限 / 分数闸门）
 *     ├─ System prompt 注入 injectionEnabled
 *     │    ├─ sessionContextEnabled（<session_context> 信封）
 *     │    │    └─ agentPromptEnabled（[Role] / [Rules] 正文 + persona 槽的英文指引句）
 *     │    │         └─ agentPromptKeepBase（persona 槽要不要保留 DSH 原 persona 行）
 *     │    ├─ profileMemoryEnabled
 *     │    └─ knowledgeEnabled
 *     └─ 只读工具（无独立开关）
 *
 *   写侧总开关 captureEnabled —— **完全独立**，既不受 enabled 约束，
 *   也不受 injectionEnabled 约束（lib/capture.mjs 只判它自己）。
 *
 *   子 agent 会话（DSH 派出去的子会话）——能力面拆分，见 lib/subagent.mjs：
 *     subagentInjectionEnabled  默认**关**：子会话不注入身份（session_context）与记忆
 *                               （画像 / L1 召回 / 状态快照）、不为这些面预热资产；
 *                               但**团队知识库、知识 skill 与 10 个只读工具照常可用**
 *     subagentCaptureEnabled    默认**关**：子 agent 的执行过程不回流 L0
 *   两者都按 session.header.origin === 'subagent' 判定。

 * 几个容易搞错的点：
 *   0. 云端 skill 召回**也不**依赖 injectionEnabled：它与 L1 召回同样走 agent/pre-step、
 *      注入到消息尾部（同一轮里两条块共用一条 plugin 消息），与 system 段无关；
 *   1. L1 召回**不**依赖 injectionEnabled（recall.mjs 只判 readEnabled + recallEnabled）；
 *      injectionEnabled 只管 system prompt 里的那几个段 + persona 槽的指引句。
 *   2. 回流**不**依赖 enabled：读侧全关时回流照常写 L0（capture-only 模式）。
 *   3. 身份不全时读侧整体不生效（readEnabled = enabled && 身份齐全），回流不受影响。
 *      —— 这条最容易"看起来开关都开着但什么都没注入"，所以卡片里显式告警。
 *
 * 卡片的分组、缩进、置灰都只是把上面这张表画出来；真正的判据在上面这些 mjs 里。
 */
import React from 'react'
import type { Context } from '@deepseek-ai/cordis'

const NS = 'tdai-memory'

/**
 * 读侧总开关 + 它的两个直接子项（召回 / 注入）。
 *
 * 三个具名常量分别对应"一条直线上"的三个层次；`READ_TOGGLES` 只是给测试用的汇总，
 * 渲染顺序按下图的语义排（召回后面紧跟它的条数上限，见 recallLimitRow）。
 */
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
  hint: '每轮按当前对话检索这个 agent 名下的云端 skill，命中才注入（只给名字 + 一句描述，'
    + '正文按需用 tdai_skill_view 取）；不再常驻目录',
}
const INJECT_MASTER = {
  key: 'injectionEnabled',
  label: 'System prompt 注入',
  hint: '只管下面那几个注入段；不影响 L1 召回与 skill 召回',
}
const READ_TOGGLES = [READ_MASTER, RECALL_TOGGLE, SKILL_RECALL_TOGGLE, INJECT_MASTER]

/** 置灰时的原因（tooltip）；文案与真实依赖关系一一对应，别写成"总开关"这种含糊说法。 */
const READ_DIM_REASON = '「读侧总开关」已关闭，此项暂不生效'
const RECALL_DIM_REASON = '「L1 自动召回」已关闭，此项暂不生效'
const SKILL_RECALL_DIM_REASON = '「云端 skill 召回」已关闭，此项暂不生效'
const INJECT_DIM_REASON = '「System prompt 注入」总闸已关闭，此项暂不生效'
const AGENT_PROMPT_DIM_REASON = '「Agent 角色 / 规则 prompt」已关闭，此项暂不生效'
const SESSION_CONTEXT_DIM_REASON = '「会话上下文（Agent / Task）」已关闭，此项暂不生效'

/** 二级从属的置灰原因：键 = 那个父开关的 key。 */
const DEP_DIM_REASON: Record<string, string> = {
  sessionContextEnabled: SESSION_CONTEXT_DIM_REASON,
  agentPromptEnabled: AGENT_PROMPT_DIM_REASON,
}

/**
 * `dimmedBy` = 这一项在 UI 上从属于哪些开关（置灰判定用；不影响真实注入判据）——
 * 列表里**任何一个**关掉，本项就置灰。层级与 config.mjs 的开关树一致：
 * sessionContextEnabled → agentPromptEnabled → agentPromptKeepBase。
 */
const INJECT_TOGGLES = [
  { key: 'sessionContextEnabled', label: '会话上下文（Agent / Task）' },
  {
    key: 'agentPromptEnabled',
    label: 'Agent 角色 / 规则 prompt',
    hint: '把「角色定位 prompt」+「规则固定 prompt」写进会话上下文的 [Role] / [Rules]，'
      + '并在 persona 槽放一句英文指引；拿不到文本时两边都保持原样',
    dimmedBy: ['sessionContextEnabled'],
  },
  {
    key: 'agentPromptKeepBase',
    label: '保留原 persona 行',
    hint: '默认关：persona 槽只放那句英文指引。打开则先保留 DSH 原 persona 前缀，再接指引句',
    defaultOff: true,
    dimmedBy: ['sessionContextEnabled', 'agentPromptEnabled'],
  },
  { key: 'profileMemoryEnabled', label: '长期记忆（L3 画像 + L2 索引）' },
  { key: 'knowledgeEnabled', label: '知识库（wiki / code-graph）', hint: '默认关', defaultOff: true },
]

/**
 * 子 agent（DSH 派出去的子会话）的两个开关，**默认都关**。
 *
 * 默认关的理由：子 agent 的任务通常由父 agent 明确指定（"分析这段 diff"），
 * 父 agent 的身份与画像 / 召回是干扰；它的整段执行过程属于工作噪音，不该进长期记忆。
 * 但**知识库与工具是子 agent 干活要用的能力**，不随这两个开关关闭（见 lib/subagent.mjs
 * 的能力面表）—— 打开第一个开关只是把身份 / 记忆 / 云端 skill 召回也一并给子会话。
 */
const SUBAGENT_INJECT_TOGGLE = {
  key: 'subagentInjectionEnabled',
  label: '子 agent 全量继承读侧',
  hint: '默认关：子会话不注入身份与记忆、不做 L1 召回与 skill 召回（团队知识库与 10 个只读工具本就可用）',
  defaultOff: true,
}
const SUBAGENT_CAPTURE_TOGGLE = {
  key: 'subagentCaptureEnabled',
  label: '子 agent 对话回流',
  hint: '默认关：子 agent 的执行过程不写进长期记忆',
  defaultOff: true,
}
const SUBAGENT_TOGGLES = [SUBAGENT_INJECT_TOGGLE, SUBAGENT_CAPTURE_TOGGLE]

/** 写侧：两个开关，都与读侧完全独立。 */
const WRITE_TOGGLES = [
  {
    key: 'captureEnabled',
    label: '对话回流到 MemoryCore',
    hint: '独立开关：读侧全关也照常回流；每轮写回 L0 并触发 Skill 归档',
  },
  {
    key: 'taskWriteEnabled',
    label: '待办写入 task',
    hint: '默认关：打开后你在对话里明确说「记一下」的待办直接写进 MemoryCore 的 task'
      + '（另需 User Key），不再落到本地文件；写错可撤销',
    defaultOff: true,
  },
]

/**
 * 数值字段：面板里以字符串草稿编辑，**保存时**转成 number 再落库。
 *
 * 为什么必须转 number：用户层（面板）要存**真数字**，区间约束（1–20）与"面板改过"的
 * override 语义才干净。宿主 schema 另有 string 分支，但那是给组合层
 * （`cordis.patch.yml` 的 env 只能是 `"5"` 这种字符串）用的，不能据此让用户层也存字符串
 * —— 见 `lib/settings.mjs` 的 `numField` 与 `test/settings-card.test.mjs` 的两侧断言。
 * 越界按 [min, max] 收敛，并把收敛结果回填草稿 + 提示用户。
 */
const NUMERIC_FIELDS: Record<string, { min: number; max: number; label: string; dflt: number }> = {
  recallLimit: { min: 1, max: 20, label: '单轮召回条数上限', dflt: 5 },
  // 云端 skill 召回的两个旋钮：**实际注入条数 = 分数过闸门后的前 skillRecallLimit 条**，
  // 所以"召回少了/多了"通常是这两个一起调（见 lib/recall.mjs 的 pickSkillHits）。
  skillRecallLimit: { min: 1, max: 10, label: 'skill 召回条数上限', dflt: 3 },
  skillRecallMinScore: { min: 0, max: 100, label: 'skill 召回分数下限', dflt: 4 },
}

/** readEnabled() 需要的身份字段（缺一读侧就整体不生效）。 */
const REQUIRED_IDENTITY = ['serviceId', 'teamId', 'agentId', 'userId']

const IDENTITY_FIELDS = [
  { key: 'endpoint', label: 'MemoryCore 地址', placeholder: 'http://127.0.0.1:8420' },
  { key: 'serviceId', label: 'Memory 实例 ID（x-tdai-service-id）', placeholder: 'default' },
  { key: 'teamId', label: 'Team ID' },
  { key: 'agentId', label: 'Agent ID' },
  { key: 'userId', label: 'User ID' },
  { key: 'userKey', label: 'User Key（sk-mem-…）', hint: 'meta 面需要；缺省则借入与 session_context 降级', secret: true },
  { key: 'knowledgeEndpoint', label: '知识服务地址改写', placeholder: '如 http://127.0.0.1:8424', hint: '服务端返回容器内地址（host.docker.internal）时填宿主可达的 origin；留空则用服务端返回的地址' },
  { key: 'taskId', label: 'Task ID（可选）' },
]

/** 卡片字段的单一事实来源，导出给 test/settings-card.test.mjs 做一致性断言。 */
export const CARD_FIELDS = {
  toggles: [...READ_TOGGLES, ...INJECT_TOGGLES, ...WRITE_TOGGLES, ...SUBAGENT_TOGGLES],
  numeric: NUMERIC_FIELDS,
  identity: IDENTITY_FIELDS,
  requiredIdentity: REQUIRED_IDENTITY,
}

/**
 * 身份里缺哪些字段（读侧失效的判定与日志点名用的是同一组 key）。
 * 纯函数，便于单测。
 */
export function missingIdentity(value: Record<string, unknown> | undefined): string[] {
  return REQUIRED_IDENTITY.filter((k) => !String(value?.[k] ?? '').trim())
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
 * @returns ops 提交给 scope.mutate；patch 回填草稿；adjusted 面向用户的收敛说明；
 *          error 非空时不提交、直接提示（例如数字框里填了非数字）。
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
    if (typeof v === 'string' && v === '') ops.push({ op: 'unset', path: [key] })
    else ops.push({ op: 'set', path: [key], value: v })
  }

  return { ops, patch, adjusted, error: '' }
}

const C = {
  border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
  guide: '2px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.30))',
  tertiary: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
  secondary: 'var(--dsw-alias-label-secondary, inherit)',
}

function blankSecrets(value: Record<string, unknown>): Record<string, unknown> {
  const next = { ...value }
  for (const f of IDENTITY_FIELDS) if (f.secret) next[f.key] = ''
  return next
}

/**
 * 身份不全的告警：这是"开关都开着但什么都没注入"最常见的原因。
 * 放在读侧那组下面、紧挨着开关 —— 用户改开关时第一眼就能看到。
 */
function identityWarningNote(missing: string[], readOn: boolean): React.ReactNode {
  if (!readOn || missing.length === 0) return null
  return (
    <p style={{ color: C.tertiary, margin: '6px 0 0', fontSize: '12px' }} role="status">
      ⚠️ 身份未填全（缺 {missing.join(' / ')}）→ 读侧（召回 / 注入 / 工具）实际不会生效；「对话回流」不受影响。
    </p>
  )
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

function TdaiMemoryCard(props: { form: SettingsForm; describe?: SettingsDescribeFace; entryId?: string }) {
  const { form, describe } = props
  const entryId = props.entryId ?? NS
  const [snap, setSnap] = React.useState(() => form.getSnapshot())
  const [draft, setDraft] = React.useState<Record<string, unknown> | null>(null)
  const [touched, setTouched] = React.useState<Set<string>>(() => new Set())
  const [note, setNote] = React.useState('')
  React.useEffect(() => form.subscribe(() => setSnap(form.getSnapshot())), [form])

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

  if (snap.status === 'unavailable') {
    // 无条件注册成顶层设置页之后，这个分支是有意的"自解释失败"：
    // 页面在 → 说明客户端半边已加载；这句在 → 说明宿主没暴露本插件的设置命名空间。
    // 两者都没有 → 客户端半边根本没加载（那是另一类问题，别再猜这一层）。
    return (
      <div style={{ border: C.border, borderRadius: '12px', padding: '14px 16px' }} role="status">
        <div style={{ fontSize: '14px', fontWeight: 600 }}>TDAI Memory</div>
        <div style={{ color: C.tertiary, fontSize: '13px', marginTop: '6px' }}>
          设置当前不可用：宿主没有暴露本插件的设置命名空间（<code>{entryId}</code>）。
          请确认 dsh-tdai-memory-plugin 已在 profile 中启用（entry 状态应为 <code>schema</code>），
          并检查宿主日志里是否有 <code>[tdai-memory]</code> 的报错。
        </div>
      </div>
    )
  }
  const current = snap.status === 'ready' && snap.value ? snap.value as Record<string, unknown> : {}
  const writable = snap.writable !== false

  // 首次 ready 后把当前值灌进草稿（secret 脱敏置空）
  React.useEffect(() => {
    if (snap.status === 'ready' && draft === null) setDraft(blankSecrets(current))
  }, [snap.status, current, draft])

  const value: Record<string, unknown> = draft ?? current
  const dirty = touched.size > 0
  const saving = note === '保存中…'

  // ── 依赖链的实时状态：用来置灰"当前不生效"的项 ────────────────────────────
  const readOn = value.enabled !== false
  const recallOn = value.recallEnabled !== false
  const skillOn = value.skillsEnabled !== false
  const injectOn = value.injectionEnabled !== false
  // 身份不全 → 读侧整体不生效（readEnabled = enabled && identityComplete）。
  // 只在快照就绪后判断，否则首帧 current 为空会误报。
  const missingIdentityKeys = snap.status === 'ready' ? missingIdentity(value) : []

  const edit = (key: string, val: unknown) => {
    setDraft((d) => (d ? { ...d, [key]: val } : { [key]: val }))
    setTouched((s) => new Set(s).add(key))
    setNote('')
  }

  const reset = () => {
    setDraft(blankSecrets(current))
    setTouched(new Set())
    setNote('')
  }

  const save = () => {
    if (!draft || touched.size === 0) return
    // 归一化（空串=unset、数值=number 且收敛到 schema 区间）在纯函数里做，见 buildSaveOps
    const { ops, patch, adjusted, error: invalid } = buildSaveOps(draft, touched)
    if (invalid) { setNote(invalid); return }

    setNote('保存中…')
    Promise.resolve(form.mutate(ops))
      .then(() => {
        // 回填草稿：让面板显示与真正落库的值一致（数值字段会把 "07" / 50 收敛掉）
        setDraft((d) => (d ? { ...d, ...patch } : d))
        setNote(adjusted.length > 0 ? `已保存（${adjusted.join('；')}）` : '已保存')
        setTouched(new Set())
      })
      .catch((error) => setNote(`保存失败：${error?.message ?? '未知错误'}`))
  }

  const fieldRow = (label: React.ReactNode, control: React.ReactNode, key: string) => (
    <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '12px 0', borderTop: C.border }}>
      <div style={{ fontSize: '13px', color: C.secondary }}>{label}</div>
      {control}
    </div>
  )

  const inputStyle = {
    appearance: 'none', width: '100%', padding: '8px 12px', borderRadius: '8px',
    border: C.border, background: 'transparent', color: 'inherit', font: 'inherit', fontSize: '13px',
  } as const

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

  /** 每组开关的横向流式布局：**逐项 nowrap**，checkbox 与标签永不拆行。 */
  const flowStyle = { display: 'flex', flexWrap: 'wrap', gap: '2px 18px', alignItems: 'center' } as const

  const groupTitle = (text: string) => (
    <div style={{ fontSize: '12px', fontWeight: 600, color: C.tertiary, letterSpacing: '.02em', padding: '12px 0 2px' }}>{text}</div>
  )

  /**
   * 一个开关项。`dim` = 当前被上层开关关掉了 → 置灰 + tooltip 说明原因，
   * 但**仍可点击**（允许先配好再开总闸，比强制顺序更省事）。
   */
  const toggleItem = (
    t: { key: string; label: string; hint?: string; defaultOff?: boolean; dimmedBy?: string[] },
    dim: boolean,
    dimReason: string,
  ) => {
    // 默认开的项用 `!== false`（快照里缺字段也算开），默认关的项必须显式 `=== true`。
    const checked = t.defaultOff === true ? value[t.key] === true : value[t.key] !== false
    return (
      <label
        key={t.key}
        title={dim ? dimReason : undefined}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', fontSize: 13, padding: '5px 0', cursor: writable ? 'pointer' : 'default', opacity: dim ? 0.55 : 1 }}
      >
        <input type="checkbox" checked={checked} disabled={!writable || saving} onChange={(e) => edit(t.key, e.target.checked)} style={{ width: 15, height: 15, accentColor: 'var(--dsw-alias-label-primary, #5b8def)', cursor: 'pointer', flex: 'none' }} />
        <span>{t.label}</span>
        {t.hint ? <span style={{ color: C.tertiary, fontSize: '12px', marginLeft: '2px' }}>{t.hint}</span> : null}
      </label>
    )
  }

  /** 数字输入行（草稿存字符串，保存时收敛成 number 且收敛到 schema 区间，见 buildSaveOps）。 */
  const numericRow = (key: string, hint: string, dim: boolean, dimReason: string) => {
    const meta = NUMERIC_FIELDS[key]
    const raw = draft ? draft[key] : current[key]
    const shown = raw === undefined || raw === null ? '' : String(raw)
    return (
      <span
        key={key}
        title={dim ? dimReason : undefined}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', fontSize: 13, padding: '5px 0', opacity: dim ? 0.55 : 1 }}
      >
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
          style={{ appearance: 'textfield', width: 56, padding: '3px 6px', borderRadius: '6px', border: C.border, background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 13, textAlign: 'center' }}
        />
        <span style={{ color: C.tertiary, fontSize: 12 }}>{hint}</span>
      </span>
    )
  }

  /** L1 召回条数上限（挂在「L1 自动召回」下）。 */
  const recallLimitRow = () => numericRow(
    'recallLimit',
    '条（自有 + 借入合并后的上限，1–20；实际还受 4000 字符预算约束）',
    !readOn || !recallOn,
    !readOn ? READ_DIM_REASON : RECALL_DIM_REASON,
  )

  return (
    <div style={{ border: C.border, background: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.05))', borderRadius: '12px' }}>
      {/* 顶层设置页已由左侧导航承担"标题"职责，这里不再放可折叠头部：
          少一次点击，进页面即见全部开关（2026-09-25 改）。 */}
      <div style={{ margin: '0 16px', paddingTop: '4px' }}>
        {!writable && <p style={{ color: C.tertiary, margin: '12px 0 4px', fontSize: '12px' }} role="status">当前设置为只读。</p>}

            {/* ── 读侧：把记忆读进上下文（召回 / 注入 / 只读工具）─────────────── */}
            {groupTitle('读侧 · 把记忆读进上下文')}
            <div style={flowStyle}>
              {toggleItem(READ_MASTER, false, '')}
              {toggleItem(RECALL_TOGGLE, !readOn, READ_DIM_REASON)}
              {/* 条数上限紧跟「L1 自动召回」，读起来是同一件事 */}
              {recallLimitRow()}
              {/* 云端 skill 召回同样是"每轮读进上下文"，但不走 system 段，
                  所以放在注入总闸**之前**，不被它置灰 */}
              {toggleItem(SKILL_RECALL_TOGGLE, !readOn, READ_DIM_REASON)}
              {/* 两个旋钮紧跟它：实际注入条数 = 过分数闸门后的前 N 条 */}
              {numericRow('skillRecallLimit', '条（每轮最多注入几条命中，1–10）',
                !readOn || !skillOn, !readOn ? READ_DIM_REASON : SKILL_RECALL_DIM_REASON)}
              {numericRow('skillRecallMinScore', '分以下不注入（默认 4；0 = 关掉闸门）',
                !readOn || !skillOn, !readOn ? READ_DIM_REASON : SKILL_RECALL_DIM_REASON)}
              {toggleItem(INJECT_MASTER, !readOn, READ_DIM_REASON)}
            </div>
            {identityWarningNote(missingIdentityKeys, readOn)}
            {/* 注入段挂在「System prompt 注入」下：缩进 + 竖线表示从属关系 */}
            <div style={{ ...flowStyle, paddingLeft: 22, marginLeft: 2, marginTop: 2, borderLeft: C.guide }}>
              {INJECT_TOGGLES.map((t) => {
                // 多级从属（agentPromptKeepBase ← agentPromptEnabled ← sessionContext）
                // 也要算置灰原因，否则用户会以为"打开了但没生效"。
                const offParent = (t.dimmedBy ?? []).find((k: string) => value[k] === false)
                const dim = !readOn || !injectOn || offParent !== undefined
                const reason = !readOn ? READ_DIM_REASON
                  : (!injectOn ? INJECT_DIM_REASON : (DEP_DIM_REASON[offParent as string] ?? INJECT_DIM_REASON))
                return toggleItem(t, dim, reason)
              })}
            </div>

            {/* ── 写侧：把对话回流给 MemoryCore（与读侧完全独立）─────────────── */}
            {groupTitle('写侧 · 把对话回流给 MemoryCore')}
            <div style={flowStyle}>
              {WRITE_TOGGLES.map((t) => toggleItem(t, false, ''))}
            </div>

            {/* ── 子 agent：能力面拆分（读侧只关身份/记忆，写侧独立）───────────── */}
            {groupTitle('子 agent · 委派出去的子会话')}
            <div style={flowStyle}>
              {toggleItem(SUBAGENT_INJECT_TOGGLE, !readOn, READ_DIM_REASON)}
              {toggleItem(SUBAGENT_CAPTURE_TOGGLE, false, '')}
            </div>

            {/* ── 身份与地址（readEnabled = 读侧总开关 && 身份齐全）───────────── */}
            {groupTitle('身份与地址')}
            {IDENTITY_FIELDS.map((f) => {
              const shown = f.secret ? (draft?.[f.key] ?? '') : (typeof value[f.key] === 'string' ? value[f.key] : '')
              return fieldRow(
                <span>{f.label}{f.hint ? <span style={{ color: C.tertiary, marginLeft: '6px' }}>{f.hint}</span> : null}</span>,
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
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', padding: '0 16px 12px' }}>
            {note && <span style={{ color: C.tertiary, fontSize: '12px', marginRight: 'auto', alignSelf: 'center' }} role="status">{note}</span>}
            <button type="button" disabled={!dirty || saving} onClick={reset} style={ghostBtn}>放弃修改</button>
            <button type="button" disabled={!dirty || saving} onClick={save} style={primaryBtn}>保存</button>
          </div>
    </div>
  )
}

export const name = 'dsh-tdai-memory-plugin-client'
export const inject = ['configForms', 'slots']

/**
 * 设置命名空间 = profile patch 的 entry id，必须与 lib/settings.mjs 的
 * `SETTINGS_NAMESPACE` 和 cordis.patch.yml 的 `id` 三处一致。
 *
 * 依据（0.1.7-rc.1 实测）：settings 命名空间就是 **profile patch 的 entry id**
 * （官方 `dsh-client-ui-settings-*` 的 `_NS` 分别等于 `agent-loop` /
 * `web-search-deepseek` / `subagent-model-selection-settings`），不是带 `include:` 前缀的
 * loader 路径。
 */
export const SETTINGS_ENTRY_ID = NS

export function apply(ctx: Context) {
  // 读侧只读面：用来在卡片里显示 secret 字段"是否已设置"
  const describe = ctx.configForms.describe()
  const form = ctx.configForms.get(NS)
  // 挂到 **settings.section**（设置面板左侧的顶层导航页），与 profile 里其它第三方插件
  // （dsh-better-sidebar / dsh-workspace-drag / dshmarket）一致。
  //
  // 为什么不挂 settings.plugins.tab：那是「内置插件」分区里的二级 tab，藏得深、且那是给
  // DSH 内置插件清单用的；挂在那里用户会以为"没有设置项"（实测踩过）。
  // 为什么不用 whileServed 包一层：无条件注册让"客户端加载了但命名空间缺失"变成**可见**的
  // 自解释条目，而不是静默消失（故障可诊断性 > 少一次空条目）。
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
