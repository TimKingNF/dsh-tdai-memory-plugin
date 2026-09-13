/**
 * TDAI Memory 设置卡片。
 *
 * 完全对齐 Modlens 的设置卡 chrome：原生插件卡（border + 分层背景 + 12px 圆角）、
 * 可折叠头部（标题+副标题+自定义 SVG 箭头）、字段为「标签在上控件在下」的堆叠行、
 * 底部「放弃修改(ghost) + 保存(primary)」草稿式提交。全部行内样式 + --dsw-* 变量。
 *
 * 读写：通过 settingsScope 绑定命名空间。编辑进草稿（secret 字段脱敏显示、初始置空），
 * 用 touched 集合记录用户改过的字段（避免脱敏导致"永远脏"），保存时只批量 mutate 改过的字段。
 */
import React from 'react'
import type { Context } from '@deepseek-ai/cordis'

const NS = 'tdai-memory'

const TOGGLES = [
  { key: 'enabled', label: '启用上下文召回与注入', hint: '总开关；关闭后召回/注入/工具停用' },
  { key: 'captureEnabled', label: '对话回流到 MemoryCore', hint: '每轮写回 L0 + 触发 Skill 归档' },
  { key: 'recallEnabled', label: 'L1 自动召回', hint: '每轮自动检索相关记忆' },
  { key: 'injectionEnabled', label: 'System prompt 注入', hint: 'session_context / L2L3 / Skill / Knowledge 总闸' },
  { key: 'sessionContextEnabled', label: '会话上下文（Agent / Task）' },
  { key: 'profileMemoryEnabled', label: '长期记忆（L3 persona + L2 索引）' },
  { key: 'skillsEnabled', label: 'Skill 列表注入' },
  { key: 'knowledgeEnabled', label: '知识库（wiki / code-graph）' },
]

const IDENTITY_FIELDS = [
  { key: 'endpoint', label: 'MemoryCore 地址', placeholder: 'http://127.0.0.1:8420' },
  { key: 'serviceId', label: 'Memory 实例 ID（x-tdai-service-id）', placeholder: 'default' },
  { key: 'teamId', label: 'Team ID' },
  { key: 'agentId', label: 'Agent ID' },
  { key: 'userId', label: 'User ID' },
  { key: 'userKey', label: 'User Key（sk-mem-…）', hint: 'meta 面需要；缺省则借入与 session_context 降级', secret: true },
  { key: 'taskId', label: 'Task ID（可选）' },
]

const C = {
  border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
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
    setNote('保存中…')
    const ops: Array<{ op: 'set' | 'unset'; path: string[]; value?: unknown }> = []
    for (const key of touched) {
      const v = draft[key]
      if (typeof v === 'string' && v === '') ops.push({ op: 'unset', path: [key] })
      else ops.push({ op: 'set', path: [key], value: v })
    }
    Promise.resolve(scope.mutate(ops))
      .then(() => {
        setNote('已保存')
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
          <div style={{ color: C.tertiary, fontSize: '12px', marginTop: '2px' }}>团队记忆接入：上下文注入 / 召回 / 回流 / 身份</div>
        </div>
        <Chevron open={open} />
      </button>
      {open && (
        <>
          <div style={{ borderTop: C.border, margin: '0 16px' }}>
            {!writable && <p style={{ color: C.tertiary, margin: '12px 0 4px', fontSize: '12px' }} role="status">当前设置为只读。</p>}
            {/* 开关：checkbox + 标签并排，横向流式排布，尽量不换行 */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 18px', padding: '6px 0' }}>
              {TOGGLES.map((t) => {
                const checked = t.key === 'knowledgeEnabled' ? value[t.key] === true : value[t.key] !== false
                return (
                  <label key={t.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', fontSize: 13, padding: '5px 0', cursor: writable ? 'pointer' : 'default' }}>
                    <input type="checkbox" checked={checked} disabled={!writable || saving} onChange={(e) => edit(t.key, e.target.checked)} style={{ width: 15, height: 15, accentColor: 'var(--dsw-alias-label-primary, #5b8def)', cursor: 'pointer', flex: 'none' }} />
                    <span>{t.label}</span>
                    {t.hint ? <span style={{ color: C.tertiary, fontSize: '12px', marginLeft: '2px' }}>{t.hint}</span> : null}
                  </label>
                )
              })}
            </div>
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
