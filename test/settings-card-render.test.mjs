/**
 * 设置卡片的渲染断言（0.9 改版：Tab + 可折叠分组 + 工作区 Agent）。
 *
 * 为什么单独测渲染：面板最容易骗人的地方是**层级与状态看不出来**——
 *   读侧总开关(enabled) → 召回 / 注入 → 注入下的段；写侧回流独立；
 *   Bot 会话总闸 → skill 注入 / 回写 → 蒸馏；工作区覆盖默认关。
 * 这个测试把「Tab 可见内容 + 依赖置灰 + 工作区列表 + 横向溢出修复」钉死。
 *
 * 做法：esbuild 把 tsx 转成 ESM 后用 react-dom/server 静态渲染，不引 jsdom。
 * Tab 内容按 `initialTab` 逐个渲染；原生 <details> 的隐藏内容也会出现在静态 HTML 里。
 *
 * 运行：node test/settings-card-render.test.mjs
 */
import assert from 'node:assert'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { transform } from 'esbuild'
import React from 'react'
import ReactDOMServer from 'react-dom/server'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const tsx = readFileSync(join(root, 'client.card.tsx'), 'utf8')
// 0.9 改版用 Tab + 原生 details；旧的折叠头（aria-expanded 按钮）仍然不存在。
// 但 Tab 按钮带 role=tab / aria-selected，所以这里只拦旧折叠头的特征。
const { code } = await transform(tsx, {
  loader: 'tsx', format: 'esm', jsx: 'transform', target: 'esnext',
})
const tmpDir = join(here, '.tmp')
mkdirSync(tmpDir, { recursive: true })
const tmpFile = join(tmpDir, 'card-render.mjs')
writeFileSync(tmpFile, `${code}\nexport { TdaiMemoryCard };\n`, 'utf8')
let Card
try {
  const mod = await import(pathToFileURL(tmpFile).href)
  Card = mod.TdaiMemoryCard
} finally {
  rmSync(tmpFile, { force: true })
}

const FULL = {
  enabled: true, captureEnabled: true, recallEnabled: true, injectionEnabled: true,
  sessionContextEnabled: true, agentPromptEnabled: true, agentPromptKeepBase: false,
  profileMemoryEnabled: true, skillsEnabled: true, knowledgeEnabled: false,
  endpoint: 'http://127.0.0.1:8420', serviceId: 'default', teamId: 'team-x', agentId: 'agt-x', userId: 'usr-x',
  userKey: '', knowledgeEndpoint: '', taskId: '', recallLimit: 7,
  skillRecallLimit: 3, skillRecallMinScore: 4,
  dsbotAwarenessEnabled: true, botSkillInjectEnabled: true, botWritebackEnabled: false,
  botContextDistillEnabled: true, botContextMessages: 5, botContextReuseMemory: false,
  dsbotLedgerPath: '',
  workspaceAgentsEnabled: false, workspaceAgents: [],
}

/**
 * 渲染一次面板。`options.tab` 选 Tab；`options.useWorkspaces` 模拟设置页标准 props。
 */
function render(overrides = {}, options = {}) {
  const form = {
    getSnapshot: () => ({
      status: options.status ?? 'ready',
      writable: true,
      value: { ...FULL, ...overrides },
    }),
    subscribe: () => () => {},
    mutate: () => Promise.resolve(),
  }
  const describe = {
    getSnapshot: () => ({
      view: { namespaces: [{ ns: 'tdai-memory', secrets: options.secrets ?? [] }] },
    }),
    subscribe: () => () => {},
  }
  return ReactDOMServer.renderToStaticMarkup(React.createElement(Card, {
    form,
    describe,
    initialTab: options.tab ?? 'read',
    useWorkspaces: options.useWorkspaces,
  }))
}

/** 某个开关项当前是否被置灰（自身 label 带 opacity:.55）。 */
function dimmed(html, label) {
  const at = html.indexOf(label)
  assert.ok(at >= 0, `渲染结果里找不到「${label}」`)
  const start = html.lastIndexOf('<label', at)
  return html.slice(start, at).includes('opacity:0.55')
}

// ── 1) Tab 与分组：读侧默认可见，其它 Tab 分开渲染 ──────────────────────────
{
  const html = render()
  for (const label of ['读侧', '写侧', 'Bot 与子 agent', '身份与工作区']) {
    assert.ok(html.includes(`>${label}</button>`), `应有 Tab「${label}」`)
  }
  assert.ok(html.includes('role="tablist"'), 'Tab 容器应有 role=tablist')
  assert.ok(html.includes('aria-selected="true"'), '默认 Tab 应 aria-selected')
  assert.ok(html.includes('读侧总开关'), '读侧 Tab 应直接看到读侧总开关')
  assert.ok(html.includes('L1 自动召回'), '读侧 Tab 应有 L1 召回')
  assert.ok(html.includes('System prompt 注入'), '读侧 Tab 应有注入总闸')
  assert.ok(!html.includes('对话回流到 MemoryCore'), '读侧 Tab 不该混入写侧开关')
  assert.ok(!html.includes('默认 Team ID'), '读侧 Tab 不该混入身份表单')
  // 原生 details：分组可折叠，标题在 summary 里
  assert.ok(html.includes('<details'), '分组应使用 details 折叠')
  assert.ok(html.includes('<summary'), '分组应有 summary 标题')

  const write = render({}, { tab: 'write' })
  assert.ok(write.includes('对话回流到 MemoryCore'), '写侧 Tab 应有回流开关')
  assert.ok(write.includes('子 agent 对话回流'), '写侧 Tab 应有子 agent 回写开关')
  assert.ok(!write.includes('L1 自动召回'), '写侧 Tab 不该混入读侧开关')

  const bot = render({}, { tab: 'bot' })
  for (const text of ['识别 ds-bot 会话', 'Bot 会话注入云端 skill', 'Bot 会话回写记忆', '群聊前文蒸馏', '子 agent 全量继承读侧']) {
    assert.ok(bot.includes(text), `Bot Tab 应包含「${text}」`)
  }
  // 高级蒸馏参数在默认收起的 details 里，但静态 HTML 仍可断言
  assert.ok(bot.includes('群聊窗口条数'), 'Bot Tab 应包含群聊窗口参数')
  assert.ok(bot.includes('蒸馏模型'), 'Bot Tab 应包含蒸馏模型')
  assert.ok(bot.includes('台账路径'), 'Bot Tab 应包含台账路径')

  const identity = render({}, { tab: 'identity' })
  for (const text of ['默认 Team ID', '默认 Agent ID', 'MemoryCore 地址', '工作区 Agent']) {
    assert.ok(identity.includes(text), `身份 Tab 应包含「${text}」`)
  }
}

// ── 2) 横向溢出修复：长说明换行、输入框不撑破容器 ──────────────────────────
{
  const html = render({}, { tab: 'identity' })
  assert.ok(html.includes('box-sizing:border-box'), '根容器 / 输入框应使用 border-box')
  assert.ok(html.includes('min-width:0'), '关键容器应有 min-width:0')
  assert.ok(html.includes('overflow-wrap:anywhere'), '长说明 / 路径应允许任意位置换行')
  assert.ok(html.includes('width:100%'), '输入框应占满容器而不是固定宽度')
  // 长 hint 不能再用 nowrap（旧版横向滚动条的根因）
  const hintAt = html.indexOf('服务端返回容器内地址')
  assert.ok(hintAt > 0, '应渲染知识服务地址的长说明')
  const hintSeg = html.slice(Math.max(0, hintAt - 400), hintAt)
  assert.ok(!hintSeg.includes('white-space:nowrap'), '长说明外层不能 nowrap')
}

// ── 3) 身份齐全：无告警；读侧开关不置灰 ─────────────────────────────────────
{
  const html = render()
  assert.ok(!html.includes('默认身份未填全'), '身份齐全时不应有告警')
  for (const label of ['L1 自动召回', '云端 skill 召回', 'System prompt 注入']) {
    assert.equal(dimmed(html, label), false, `身份齐全 + 开关全开时「${label}」不该置灰`)
  }
}

// ── 4) 读侧总开关关闭：读侧置灰；写侧 Tab 不受影响 ──────────────────────────
{
  const html = render({ enabled: false })
  for (const label of ['L1 自动召回', 'System prompt 注入', '会话上下文（Agent / Task）', '知识库（wiki / code-graph）']) {
    assert.equal(dimmed(html, label), true, `读侧总开关关闭时「${label}」应置灰`)
  }
  assert.ok(!html.includes('默认身份未填全'), '读侧总开关已关时不重复告警')

  const write = render({ enabled: false }, { tab: 'write' })
  assert.equal(dimmed(write, '对话回流到 MemoryCore'), false, '回流是独立写侧开关，读侧关闭不该影响它')
  assert.equal(dimmed(write, '子 agent 对话回流'), false, '子 agent 回写属于写侧，读侧关闭不该影响它')
}

// ── 5) 只关注入总闸：注入段灰，L1 召回不灰 ──────────────────────────────────
{
  const html = render({ injectionEnabled: false })
  for (const label of [
    '会话上下文（Agent / Task）', 'Agent 角色 / 规则 prompt', '保留原 persona 行',
    '长期记忆（L3 画像 + L2 索引）', '知识库（wiki / code-graph）',
  ]) {
    assert.equal(dimmed(html, label), true, `注入总闸关闭时「${label}」应置灰`)
  }
  assert.equal(dimmed(html, 'L1 自动召回'), false, 'L1 召回不依赖注入总闸')
}

// ── 6) 多级从属：agentPrompt ← sessionContext，keepBase ← agentPrompt + sessionContext ──
{
  const ctxOff = render({ sessionContextEnabled: false })
  assert.equal(dimmed(ctxOff, 'Agent 角色 / 规则 prompt'), true, '父项（会话上下文）关闭时它必须灰')
  assert.equal(dimmed(ctxOff, '保留原 persona 行'), true, '更下面一级也必须灰')

  const promptOff = render({ agentPromptEnabled: false })
  assert.equal(dimmed(promptOff, 'Agent 角色 / 规则 prompt'), false, '它自己只受父项约束')
  assert.equal(dimmed(promptOff, '保留原 persona 行'), true, '父项关闭时子项必须灰')

  const allOn = render()
  assert.equal(dimmed(allOn, 'Agent 角色 / 规则 prompt'), false, '全开时不灰')
  assert.equal(dimmed(allOn, '保留原 persona 行'), false, '全开时不灰')
}

// ── 7) 身份不全：读侧告警点名缺失字段，并说明工作区覆盖例外 ─────────────────
{
  const html = render({ agentId: '', teamId: '' })
  assert.ok(html.includes('默认身份未填全'), '默认身份不全且读侧开启时应告警')
  assert.ok(html.includes('缺 teamId / agentId'), `告警应点名缺失字段，实际：${html.match(/默认身份未填全[^<]*/)?.[0]}`)
  assert.ok(html.includes('工作区覆盖补全了缺失字段'), '告警要说明工作区覆盖可能补全身份')
  assert.ok(html.includes('「对话回流」不受影响'), '告警要说明回流不受影响')
}

// ── 8) secret：明文拿不到，只能从 describe 的 secrets 侧信道显示"已设置" ─────
{
  const unset = render({}, { tab: 'identity' })
  assert.ok(unset.includes('meta 面需要'), 'userKey 未设置时应显示用途说明')

  const set = render({}, { tab: 'identity', secrets: [{ path: ['userKey'], set: true }] })
  assert.ok(set.includes('已设置（留空表示不改动）'), 'userKey 已设置时应提示"留空表示不改动"')
  assert.ok(!set.includes('value="sk-'), 'secret 明文绝不能出现在渲染结果里')
}

// ── 9) 工作区 Agent：总开关、列表、占位回落、注册工作区下拉 ──────────────────
{
  const off = render({}, { tab: 'identity' })
  assert.ok(off.includes('按工作区覆盖 Agent / Team'), '应有工作区覆盖总开关')
  assert.ok(off.includes('当前未启用：所有工作区都使用默认身份'), '总开关关闭时要有明确说明')
  assert.ok(off.includes('还没有绑定'), '空列表要有空状态')

  const on = render({
    workspaceAgentsEnabled: true,
    workspaceAgents: [
      { workspace: '/mnt/d/repo-a', title: 'Repo A', teamId: 'team-a', agentId: 'agt-a' },
      { workspace: '/mnt/d/repo-b', title: '', teamId: '', agentId: 'agt-b' },
    ],
  }, { tab: 'identity' })
  assert.ok(on.includes('Repo A'), '规则行应显示工作区标题')
  assert.ok(on.includes('/mnt/d/repo-a'), '规则行应显示完整路径')
  assert.ok(on.includes('value="team-a"'), '规则行应回显 Team ID')
  assert.ok(on.includes('value="agt-b"'), '规则行应回显 Agent ID')
  assert.ok(on.includes('placeholder="默认 team-x"'), 'Team 留空时应提示回落默认 team')
  assert.ok(on.includes('placeholder="默认 agt-x"'), 'Agent 留空时应提示回落默认 agent')
  assert.ok(on.includes('>移除</button>'), '规则行应有移除按钮')
  assert.ok(on.includes('list="tdai-workspace-options"'), '添加输入应支持工作区下拉')
  assert.ok(on.includes('>添加</button>'), '应有添加按钮')

  // 设置页标准 props：注册工作区列表进 datalist
  const withOptions = render({ workspaceAgentsEnabled: true }, {
    tab: 'identity',
    useWorkspaces: (selector) => selector({ items: [{ path: '/mnt/d/repo-c', title: 'Repo C' }] }),
  })
  assert.ok(withOptions.includes('<option value="/mnt/d/repo-c">Repo C</option>'), '应把注册工作区渲染进 datalist')

  // env 形态：组合层传的是字符串（cordis.patch.yml 的 `!!js process.env.X`），
  // 面板不能把它读成"关" —— 否则用户看着一个假的开关去回滚。
  const fromEnv = render({
    workspaceAgentsEnabled: 'true',
    workspaceAgents: [{ workspace: '/mnt/d/repo-a', agentId: 'agt-a' }],
  }, { tab: 'identity' })
  assert.ok(fromEnv.includes('>工作区覆盖开（1 条）<'), `字符串 "true" 应显示为开：${fromEnv.match(/工作区覆盖[^<]*/)?.[0]}`)
  assert.ok(!fromEnv.includes('当前未启用：所有工作区都使用默认身份'), '字符串 "true" 不该再显示未启用说明')
  const workspaceToggle = fromEnv.slice(fromEnv.indexOf('按工作区覆盖 Agent / Team') - 600)
  assert.ok(workspaceToggle.includes('checked=""'), '总开关勾选框应为勾选态')

  const envOff = render({ enabled: 'false' }, { tab: 'read' })
  assert.ok(envOff.includes('读侧关'), `字符串 "false" 应显示为关：${envOff.match(/读侧[^<]*/)?.[0]}`)
}

// ── 10) Bot 会话 · ds-bot：总闸串联（父关闭 → 子置灰）──────────────────────────
{
  const base = render({}, { tab: 'bot' })
  assert.equal(dimmed(base, '识别 ds-bot 会话'), false, '总闸是根，默认开且不置灰')
  assert.equal(dimmed(base, 'Bot 会话注入云端 skill'), false, 'enabled + skillsEnabled 都开着 → 不灰')
  assert.equal(dimmed(base, 'Bot 会话回写记忆'), false, '回写默认关但不置灰（它只受总闸与全局回流约束）')
  assert.equal(dimmed(base, '群聊前文蒸馏'), true, '回写默认关 → 蒸馏置灰')
  assert.equal(dimmed(base, '复用本群 MEMORY 条目'), true, '回写默认关 → 复用置灰')
  assert.ok(base.includes('「Bot 会话回写记忆」已关闭，群聊蒸馏没有意义'), '置灰 tooltip 应点名回写开关')
  {
    const at = base.indexOf('群聊窗口条数')
    const row = base.slice(at, at + 800)
    assert.ok(row.includes('type="number"'), '群聊窗口条数应是数字输入')
    assert.ok(row.includes('min="0"') && row.includes('max="20"'), '窗口条数的上下界应与 schema 一致（0–20）')
    assert.ok(row.includes('value="5"'), '窗口条数应回显生效值 5')
  }

  const off = render({ dsbotAwarenessEnabled: false }, { tab: 'bot' })
  for (const label of ['Bot 会话注入云端 skill', 'Bot 会话回写记忆', '群聊前文蒸馏', '复用本群 MEMORY 条目']) {
    assert.equal(dimmed(off, label), true, `总闸关闭时「${label}」应置灰`)
  }
  assert.ok(off.includes('「识别 ds-bot 会话」已关闭'), '置灰 tooltip 应点名总闸')
  assert.ok(off.includes('title="「识别 ds-bot 会话」已关闭，此项暂不生效"'), '台账路径文本框也只受总闸约束')
  assert.equal(dimmed(off, '识别 ds-bot 会话'), false, '总闸自己不能被置灰')

  const writeOn = render({ botWritebackEnabled: true }, { tab: 'bot' })
  assert.equal(dimmed(writeOn, '群聊前文蒸馏'), false, '回写打开后蒸馏解灰')
  assert.equal(dimmed(writeOn, '复用本群 MEMORY 条目'), false, '回写打开后复用解灰')
  assert.ok(!writeOn.includes('「Bot 会话回写记忆」已关闭'), '回写打开后不该再有"回写已关闭"的 tooltip')

  assert.equal(dimmed(render({ enabled: false }, { tab: 'bot' }), 'Bot 会话注入云端 skill'), true, '读侧总开关关闭 → Bot skill 注入灰')
  assert.equal(dimmed(render({ skillsEnabled: false }, { tab: 'bot' }), 'Bot 会话注入云端 skill'), true, '云端 skill 召回关闭 → Bot skill 注入灰')
  assert.equal(dimmed(render({ enabled: false }, { tab: 'bot' }), 'Bot 会话回写记忆'), false, '回写不受读侧总开关影响')

  const captureOff = render({ botWritebackEnabled: true, captureEnabled: false }, { tab: 'bot' })
  assert.equal(dimmed(captureOff, 'Bot 会话回写记忆'), true, '全局「对话回流」关闭 → Bot 回写灰')
  assert.equal(dimmed(captureOff, '群聊前文蒸馏'), false, '蒸馏只挂 Bot 回写开关（方案 §3.1 的 dimmedBy 表）')
}

// ── 11) 命名空间缺失：可见自解释，不渲染可编辑控件 ──────────────────────────
{
  const html = render({}, { status: 'unavailable' })
  assert.ok(html.includes('TDAI Memory'), '不可用状态也要有标题')
  assert.ok(html.includes('设置当前不可用'), '应给出可见的不可用说明')
  assert.ok(html.includes('tdai-memory'), '应点名缺失的命名空间')
  assert.ok(!html.includes('读侧总开关'), '不可用时不该渲染可编辑控件')
}

console.log('settings card render tests passed: Tab / 折叠分组 / 横向溢出 / 置灰矩阵 / 工作区 Agent / secret / 不可用自解释')
