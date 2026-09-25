/**
 * 设置卡片的渲染断言：把"开关依赖关系"当成契约钉死。
 *
 * 为什么单独测一遍渲染：面板最容易骗人的地方就是**层级看不出来** ——
 *   读侧总开关(enabled) → 召回 / 注入 → 注入下的 4 段；写侧回流(captureEnabled) 独立。
 * 用户凭直觉安排开关，所以卡片必须在视觉上把这件事讲清楚：
 *   - 上层关掉 → 下层**置灰**（opacity .55，仍可点，便于先配好再开总闸）；
 *   - 注入总闸关掉 → 只灰它下面那 4 段，**不能**连 L1 召回一起灰；
 *   - 回流**永远不灰**（它是独立的写侧开关）；
 *   - 身份不全 → 在读侧那组下面显式告警（这是"开关都开着却没注入"最常见的原因）。
 *
 * 做法：esbuild 把 tsx 转成 ESM 后用 react-dom/server 静态渲染，不引 jsdom。
 * 面板默认折叠、body 在 `{open && …}` 里，所以转换前把初始值改成 true ——
 * 源码里找不到那行会**直接抛错**，不会静默退化成"什么都没测"。
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
// 2026-09-25：卡片挂成**顶层设置页**之后去掉了可折叠头部（左侧导航已是标题，进页面即见全部开关）。
// 这条源码护栏防止折叠交互被无意加回来。
assert.ok(!tsx.includes('aria-expanded'), '卡片不该再有折叠头部（aria-expanded）')

const { code } = await transform(tsx, {
  loader: 'tsx', format: 'esm', jsx: 'transform', target: 'esnext',
})
const tmpDir = join(here, '.tmp')
mkdirSync(tmpDir, { recursive: true })
const tmpFile = join(tmpDir, 'card-render.mjs')
// 组件本身不是导出（只导出 CARD_FIELDS / 纯函数），这里补一行导出以便渲染
writeFileSync(tmpFile, `${code}\nexport { TdaiMemoryCard };\n`, 'utf8')
let Card
let CARD_FIELDS
try {
  const mod = await import(pathToFileURL(tmpFile).href)
  Card = mod.TdaiMemoryCard
  CARD_FIELDS = mod.CARD_FIELDS
} finally {
  rmSync(tmpFile, { force: true })
}

const FULL = {
  enabled: true, captureEnabled: true, recallEnabled: true, injectionEnabled: true,
  sessionContextEnabled: true, profileMemoryEnabled: true, skillsEnabled: true, knowledgeEnabled: false,
  endpoint: 'http://127.0.0.1:8420', serviceId: 'default', teamId: 'team-x', agentId: 'agt-x', userId: 'usr-x',
  userKey: '', knowledgeEndpoint: '', taskId: '', recallLimit: 7,
}

/**
 * 渲染一次面板（快照 ready、可写；草稿在首次渲染时尚未灌入，正好反映真实配置）。
 *
 * 0.1.7-rc.1 起组件拿的是 `form`（ConfigForm）与只读的 `describe` 面，
 * 不再是 `ctx.settingsScope.bind(...)`。
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
  return ReactDOMServer.renderToStaticMarkup(React.createElement(Card, { form, describe }))
}

/** 某个开关项当前是否被置灰（它自己的 label 上带着 opacity:.55）。 */
function dimmed(html, label) {
  const at = html.indexOf(label)
  assert.ok(at >= 0, `渲染结果里找不到「${label}」`)
  const start = html.lastIndexOf('<label', at)
  return html.slice(start, at).includes('opacity:0.55')
}

// ── 1) 结构：三个分组 + 召回条数上限是个数字输入 ────────────────────────────
{
  const html = render()
  for (const title of ['读侧 · 把记忆读进上下文', '写侧 · 把对话回流给 MemoryCore', '子 agent · 委派出去的子会话', '身份与地址']) {
    assert.ok(html.includes(title), `应有分组标题「${title}」`)
  }
  // 顶层设置页：没有折叠头部，进入即见全部开关（一次点击都不需要）
  assert.ok(!html.includes('aria-expanded'), '不该再有折叠头部的按钮')
  assert.ok(html.includes('读侧总开关'), '开关应直接渲染在页面里，不需要展开')
  // 条数上限必须紧跟 L1 召回（读起来是同一件事），且在 System prompt 注入之前
  const recallAt = html.indexOf('L1 自动召回')
  const limitAt = html.indexOf('单轮召回条数上限')
  const injectAt = html.indexOf('System prompt 注入')
  assert.ok(recallAt < limitAt && limitAt < injectAt, '条数上限应排在「L1 自动召回」之后、「System prompt 注入」之前')

  const input = html.slice(html.indexOf('单轮召回条数上限'), html.indexOf('条（自有 + 借入'))
  assert.ok(input.includes('type="number"'), '条数上限应是 number 输入')
  assert.ok(input.includes('min="1"') && input.includes('max="20"'), '数字框的上下界应与 schema 一致（1–20）')
  assert.ok(input.includes('value="7"'), '数字框应回显当前配置值')

  // checkbox 与标签同一个 <label> 且 nowrap：沿用"逐项不拆行"的既有偏好。
  // 数量从 CARD_FIELDS 推导，避免每加一个开关就要来改这个魔数（原先就是它先红）。
  assert.equal(
    (html.match(/white-space:nowrap/g) || []).length,
    CARD_FIELDS.toggles.length + 1,
    `${CARD_FIELDS.toggles.length} 个开关 + 1 个数字框都应是 nowrap 项`,
  )
  // 子 agent 两个开关默认关：渲染出的 checkbox 必须是未勾选状态
  const subagentAt = html.indexOf('子 agent 继承注入与召回')
  const subagentBlock = html.slice(html.lastIndexOf('<label', subagentAt), html.indexOf('</label>', subagentAt))
  assert.ok(!subagentBlock.includes('checked=""'), '「子 agent 继承注入与召回」默认应为未勾选')
  const subCaptureAt = html.indexOf('子 agent 对话回流')
  const subCaptureBlock = html.slice(html.lastIndexOf('<label', subCaptureAt), html.indexOf('</label>', subCaptureAt))
  assert.ok(!subCaptureBlock.includes('checked=""'), '「子 agent 对话回流」默认应为未勾选')
}

// ── 2) 身份齐全：无告警，所有开关都不置灰 ───────────────────────────────────
{
  const html = render()
  assert.ok(!html.includes('身份未填全'), '身份齐全时不应有告警')
  for (const label of ['L1 自动召回', 'System prompt 注入', 'Skill 列表', '对话回流到 MemoryCore', '子 agent 继承注入与召回', '子 agent 对话回流']) {
    assert.equal(dimmed(html, label), false, `身份齐全 + 开关全开时「${label}」不该置灰`)
  }
}

// ── 3) 读侧总开关关闭：读侧全灰，**回流不灰**（写侧独立）────────────────────
{
  const html = render({ enabled: false })
  for (const label of ['L1 自动召回', 'System prompt 注入', '会话上下文（Agent / Task）', '知识库（wiki / code-graph）']) {
    assert.equal(dimmed(html, label), true, `读侧总开关关闭时「${label}」应置灰`)
  }
  assert.equal(dimmed(html, '对话回流到 MemoryCore'), false, '回流是独立的写侧开关，读侧关闭不该影响它')
  assert.equal(dimmed(html, '子 agent 继承注入与召回'), true, '读侧总开关关闭时「子 agent 继承注入」也该灰（它属于读侧）')
  assert.equal(dimmed(html, '子 agent 对话回流'), false, '「子 agent 对话回流」属于写侧，读侧关闭不该影响它')
  assert.ok(!html.includes('身份未填全'), '读侧总开关已关时不重复告警（告警只在"开关开着但无效"时才有意义）')
}

// ── 4) 只关注入总闸：只有那 4 段灰，L1 召回与回流都不灰 ──────────────────────
{
  const html = render({ injectionEnabled: false })
  for (const label of ['会话上下文（Agent / Task）', '长期记忆（L3 画像 + L2 索引）', 'Skill 列表', '知识库（wiki / code-graph）']) {
    assert.equal(dimmed(html, label), true, `注入总闸关闭时「${label}」应置灰`)
  }
  assert.equal(dimmed(html, 'L1 自动召回'), false, 'L1 召回不依赖注入总闸（recall.mjs 只判 readEnabled + recallEnabled）')
  assert.equal(dimmed(html, '对话回流到 MemoryCore'), false, '回流与注入总闸无关')
}

// ── 5) 身份不全：读侧开着 → 告警点名缺失字段 ────────────────────────────────
{
  const html = render({ agentId: '', teamId: '' })
  assert.ok(html.includes('身份未填全'), '身份不全且读侧开启时应告警')
  assert.ok(html.includes('缺 teamId / agentId'), `告警应点名缺失字段，实际渲染：${html.match(/身份未填全[^<]*/)?.[0]}`)
  assert.ok(html.includes('「对话回流」不受影响'), '告警要说明回流不受影响，否则用户会误以为整插件失效')
}

// ── 6) secret 字段：明文永远拿不到，只能从 describe 的 secrets 侧信道显示"已设置"──
{
  const unset = render()
  assert.ok(unset.includes('meta 面需要'), 'userKey 未设置时应显示原来的用途说明')

  const set = render({}, { secrets: [{ path: ['userKey'], set: true }] })
  assert.ok(set.includes('已设置（留空表示不改动）'), 'userKey 已设置时应提示"留空表示不改动"')
  assert.ok(!set.includes('value="sk-'), 'secret 明文绝不能出现在渲染结果里')
}

// ── 7) 命名空间缺失：必须**可见地**自解释，而不是渲染空 ──────────────────────
// 无条件注册成顶层设置页之后，这个分支就是客户端/宿主之间最关键的诊断信号：
// 页面在 = 客户端半边已加载；这句在 = 宿主没暴露设置命名空间。
{
  const html = render({}, { status: 'unavailable' })
  assert.ok(html.includes('TDAI Memory'), '不可用状态也要有标题，用户才知道这是谁的页面')
  assert.ok(html.includes('设置当前不可用'), '应给出可见的不可用说明，而不是静默渲染空')
  assert.ok(html.includes('tdai-memory'), '应点名缺失的命名空间')
  assert.ok(!html.includes('读侧总开关'), '不可用时不该渲染可编辑控件')
}

console.log('settings card render tests passed: 分组 / 条数上限输入框 / 依赖置灰矩阵 / 身份告警 / secret 侧信道 / 不可用自解释')
