/**
 * TDAI Memory 设置卡片。
 *
 * 完全对齐 Modlens 的设置卡 chrome：原生插件卡（border + 分层背景 + 12px 圆角）、
 * 可折叠头部（标题+副标题+自定义 SVG 箭头）、字段为「标签在上控件在下」的堆叠行、
 * 底部「放弃修改(ghost) + 保存(primary)」草稿式提交。全部行内样式 + --dsw-* 变量。
 *
 * 读写：通过 settingsScope 绑定命名空间。编辑进草稿（secret 字段脱敏显示、初始置空），
 * 用 touched 集合记录用户改过的字段（避免脱敏导致"永远脏"），保存时只批量 mutate 改过的字段。
 *
 * ── 开关的依赖关系（文案必须与真实语义一致，改动前先看这张表）─────────────────
 *
 *   读侧总开关 enabled
 *     ├─ L1 自动召回 recallEnabled（另有条数上限 recallLimit）
 *     ├─ System prompt 注入 injectionEnabled
 *     │    ├─ sessionContextEnabled
 *     │    ├─ profileMemoryEnabled
 *     │    ├─ skillsEnabled
 *     │    └─ knowledgeEnabled
 *     └─ 只读工具（无独立开关）
 *
 *   写侧总开关 captureEnabled —— **完全独立**，既不受 enabled 约束，
 *   也不受 injectionEnabled 约束（lib/capture.mjs 只判它自己）。
 *
 *   子 agent 会话（DSH 派出去的子会话）：
 *     subagentInjectionEnabled  默认**关**：子会话不注入 4 个段、不召回、不注册知识 skill
 *     subagentCaptureEnabled    默认**关**：子 agent 的执行过程不回流 L0
 *   两者都按 session.header.origin === 'subagent' 判定，见 lib/subagent.mjs。

 * 三个容易搞错的点：
 *   1. L1 召回**不**依赖 injectionEnabled（recall.mjs 只判 readEnabled + recallEnabled）；
 *      injectionEnabled 只管 system prompt 的那 4 个段。
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
const INJECT_MASTER = {
  key: 'injectionEnabled',
  label: 'System prompt 注入',
  hint: '只管下面那 4 个注入段；不影响 L1 召回',
}
const READ_TOGGLES = [READ_MASTER, RECALL_TOGGLE, INJECT_MASTER]

/** 置灰时的原因（tooltip）；文案与真实依赖关系一一对应，别写成"总开关"这种含糊说法。 */
const READ_DIM_REASON = '「读侧总开关」已关闭，此项暂不生效'
const RECALL_DIM_REASON = '「L1 自动召回」已关闭，此项暂不生效'
const INJECT_DIM_REASON = '「System prompt 注入」总闸已关闭，此项暂不生效'

/** 「System prompt 注入」总闸下的 4 个注入段。 */
const INJECT_TOGGLES = [
  { key: 'sessionContextEnabled', label: '会话上下文（Agent / Task）' },
  { key: 'profileMemoryEnabled', label: '长期记忆（L3 画像 + L2 索引）' },
  { key: 'skillsEnabled', label: 'Skill 列表' },
  { key: 'knowledgeEnabled', label: '知识库（wiki / code-graph）', hint: '默认关', defaultOff: true },
]

/**
 * 子 agent（DSH 派出去的子会话）的两个降级开关，**默认都关**。
 *
 * 默认关的理由：子 agent 的任务通常由父 agent 明确指定（"分析这段 diff"），
 * 父 agent 的画像 / 召回是干扰；它的整段执行过程属于工作噪音，不该进长期记忆。
 * 判定与语义见 lib/subagent.mjs（按 session.header.origin === 'subagent'）。
 */
const SUBAGENT_INJECT_TOGGLE = {
  key: 'subagentInjectionEnabled',
  label: '子 agent 继承注入与召回',
  hint: '默认关：子会话不注入记忆段、不做 L1 召回、不注册知识 skill（只读工具仍在）',
  defaultOff: true,
}
const SUBAGENT_CAPTURE_TOGGLE = {
  key: 'subagentCaptureEnabled',
  label: '子 agent 对话回流',
  hint: '默认关：子 agent 的执行过程不写进长期记忆',
  defaultOff: true,
}
const SUBAGENT_TOGGLES = [SUBAGENT_INJECT_TOGGLE, SUBAGENT_CAPTURE_TOGGLE]

/** 写侧：唯一的开关，且与读侧完全独立。 */
const WRITE_TOGGLES = [
  {
    key: 'captureEnabled',
    label: '对话回流到 MemoryCore',
    hint: '独立开关：读侧全关也照常回流；每轮写回 L0 并触发 Skill 归档',
  },
]

/**
 * 数值字段：面板里以字符串草稿编辑，**保存时**转成 number 再落库。
 *
 * 必须转 number：宿主 schema 是 `z.natural()`（= number().step(1).min(0)，见 settings.mjs），
 * 校验是 `typeof data !== 'number'` 直接抛，字符串 "5" 会被拒；越界同样被拒，
 * 所以这里在保存前就收敛到 [min, max]，并把收敛结果回填草稿 + 提示用户。
 */
const NUMERIC_FIELDS: Record<string, { min: number; max: number; label: string }> = {
  recallLimit: { min: 1, max: 20, label: '单轮召回条数上限' },
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
 *   - 数值字段必须转成 **number**（宿主 schema 是 z.natural()，字符串会被直接拒绝），
 *     越界按 [min, max] 收敛并把收敛结果回填草稿（patch）+ 记一句提示（adjusted）。
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

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" style={{ color: C.tertiary, flex: 'none', transition: 'transform .16s', transform: open ? 'rotate(180deg)' : 'none' }}>
      <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
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

function TdaiMemoryCard(props: { ctx: Context }) {
  const { ctx } = props
  const [scope] = React.useState(() => ctx.settingsScope.bind({ namespace: NS }))
  const [snap, setSnap] = React.useState(() => scope.getSnapshot())
  const [open, setOpen] = React.useState(false)
  const [draft, setDraft] = React.useState<Record<string, unknown> | null>(null)
  const [touched, setTouched] = React.useState<Set<string>>(() => new Set())
  const [note, setNote] = React.useState('')
  React.useEffect(() => scope.subscribe(() => setSnap(scope.getSnapshot())), [scope])

  if (snap.status === 'unavailable') return null
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
    Promise.resolve(scope.mutate(ops))
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
    t: { key: string; label: string; hint?: string; defaultOff?: boolean },
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

  /** L1 召回条数上限：数字输入（草稿存字符串，保存时收敛成 number，见 buildSaveOps）。 */
  const recallLimitRow = () => {
    const raw = draft ? draft.recallLimit : current.recallLimit
    const shown = raw === undefined || raw === null ? '' : String(raw)
    const dim = !readOn || !recallOn
    return (
      <span
        key="recallLimit"
        title={dim ? (!readOn ? READ_DIM_REASON : RECALL_DIM_REASON) : undefined}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', fontSize: 13, padding: '5px 0', opacity: dim ? 0.55 : 1 }}
      >
        <span style={{ color: C.secondary }}>{NUMERIC_FIELDS.recallLimit.label}</span>
        <input
          type="number"
          min={NUMERIC_FIELDS.recallLimit.min}
          max={NUMERIC_FIELDS.recallLimit.max}
          step={1}
          value={shown}
          placeholder="5"
          disabled={!writable || saving}
          onChange={(e) => edit('recallLimit', e.target.value)}
          style={{ appearance: 'textfield', width: 56, padding: '3px 6px', borderRadius: '6px', border: C.border, background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 13, textAlign: 'center' }}
        />
        <span style={{ color: C.tertiary, fontSize: 12 }}>
          条（自有 + 借入合并后的上限，1–20；实际还受 4000 字符预算约束）
        </span>
      </span>
    )
  }

  const openStyle = open
    ? { ...C, background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.10))', borderRadius: '12px' }
    : { ...C, background: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.05))', borderRadius: '12px' }

  return (
    <div style={{ ...openStyle, transition: 'border-color .16s, background .16s' }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        style={{ appearance: 'none', width: '100%', font: 'inherit', color: 'inherit', textAlign: 'left', cursor: 'pointer', background: 'none', border: 0, borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '12px', padding: '14px 16px' }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '14px', fontWeight: 600 }}>TDAI Memory</div>
          <div style={{ color: C.tertiary, fontSize: '12px', marginTop: '2px' }}>团队记忆接入：读侧（召回 / 注入 / 工具）与写侧（回流）开关互相独立</div>
        </div>
        <Chevron open={open} />
      </button>
      {open && (
        <>
          <div style={{ borderTop: C.border, margin: '0 16px' }}>
            {!writable && <p style={{ color: C.tertiary, margin: '12px 0 4px', fontSize: '12px' }} role="status">当前设置为只读。</p>}

            {/* ── 读侧：把记忆读进上下文（召回 / 注入 / 只读工具）─────────────── */}
            {groupTitle('读侧 · 把记忆读进上下文')}
            <div style={flowStyle}>
              {toggleItem(READ_MASTER, false, '')}
              {toggleItem(RECALL_TOGGLE, !readOn, READ_DIM_REASON)}
              {/* 条数上限紧跟「L1 自动召回」，读起来是同一件事 */}
              {recallLimitRow()}
              {toggleItem(INJECT_MASTER, !readOn, READ_DIM_REASON)}
            </div>
            {identityWarningNote(missingIdentityKeys, readOn)}
            {/* 4 个注入段挂在「System prompt 注入」下：缩进 + 竖线表示从属关系 */}
            <div style={{ ...flowStyle, paddingLeft: 22, marginLeft: 2, marginTop: 2, borderLeft: C.guide }}>
              {INJECT_TOGGLES.map((t) => toggleItem(
                t,
                !readOn || !injectOn,
                !readOn ? READ_DIM_REASON : INJECT_DIM_REASON,
              ))}
            </div>

            {/* ── 写侧：把对话回流给 MemoryCore（与读侧完全独立）─────────────── */}
            {groupTitle('写侧 · 把对话回流给 MemoryCore')}
            <div style={flowStyle}>
              {WRITE_TOGGLES.map((t) => toggleItem(t, false, ''))}
            </div>

            {/* ── 子 agent：默认降级（读侧 + 写侧各一个开关，互相独立）────────── */}
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
                  placeholder={f.placeholder}
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
        </>
      )}
    </div>
  )
}

export const name = 'dsh-tdai-memory-plugin-client'
export const inject = ['settingsScope', 'slots']

export function apply(ctx: Context) {
  // 槽位由 client-ui-settings-plugins 在运行时声明，跨插件注册必须走 slots.inject
  ctx.slots.inject('settings.plugin.item', () =>
    ctx.slots.register({ name: 'settings.plugin.item', key: NS }, () =>
      React.createElement(TdaiMemoryCard, { ctx }),
    ),
  )
}
