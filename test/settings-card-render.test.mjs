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

const FOLDED = 'const [open, setOpen] = React.useState(false)'
const tsx = readFileSync(join(root, 'client.card.tsx'), 'utf8')
assert.ok(tsx.includes(FOLDED), `卡片里找不到折叠初始值（${FOLDED}）—— 本测试需要随源码同步更新`)

const { code } = await transform(tsx.replace(FOLDED, 'const [open, setOpen] = React.useState(true)'), {
  loader: 'tsx', format: 'esm', jsx: 'transform', target: 'esnext',
})
const tmpDir = join(here, '.tmp')
mkdirSync(tmpDir, { recursive: true })
const tmpFile = join(tmpDir, 'card-render.mjs')
// 组件本身不是导出（只导出 CARD_FIELDS / 纯函数），这里补一行导出以便渲染
writeFileSync(tmpFile, `${code}\nexport { TdaiMemoryCard };\n`, 'utf8')
let Card
try {
  Card = (await import(pathToFileURL(tmpFile).href)).TdaiMemoryCard
} finally {
  rmSync(tmpFile, { force: true })
}

const FULL = {
  enabled: true, captureEnabled: true, recallEnabled: true, injectionEnabled: true,
  sessionContextEnabled: true, profileMemoryEnabled: true, skillsEnabled: true, knowledgeEnabled: false,
  endpoint: 'http://127.0.0.1:8420', serviceId: 'default', teamId: 'team-x', agentId: 'agt-x', userId: 'usr-x',
  userKey: '', knowledgeEndpoint: '', taskId: '', recallLimit: 7,
}

/** 渲染一次面板（快照 ready、可写；草稿在首次渲染时尚未灌入，正好反映真实配置）。 */
function render(overrides = {}) {
  const scope = {
    getSnapshot: () => ({ status: 'ready', writable: true, value: { ...FULL, ...overrides } }),
    subscribe: () => () => {},
    mutate: () => Promise.resolve(),
  }
  return ReactDOMServer.renderToStaticMarkup(React.createElement(Card, { ctx: { settingsScope: { bind: () => scope } } }))
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
  for (const title of ['读侧 · 把记忆读进上下文', '写侧 · 把对话回流给 MemoryCore', '身份与地址']) {
    assert.ok(html.includes(title), `应有分组标题「${title}」`)
  }
  // 条数上限必须紧跟 L1 召回（读起来是同一件事），且在 System prompt 注入之前
  const recallAt = html.indexOf('L1 自动召回')
  const limitAt = html.indexOf('单轮召回条数上限')
  const injectAt = html.indexOf('System prompt 注入')
  assert.ok(recallAt < limitAt && limitAt < injectAt, '条数上限应排在「L1 自动召回」之后、「System prompt 注入」之前')

  const input = html.slice(html.indexOf('单轮召回条数上限'), html.indexOf('条（自有 + 借入'))
  assert.ok(input.includes('type="number"'), '条数上限应是 number 输入')
  assert.ok(input.includes('min="1"') && input.includes('max="20"'), '数字框的上下界应与 schema 一致（1–20）')
  assert.ok(input.includes('value="7"'), '数字框应回显当前配置值')

  // checkbox 与标签同一个 <label> 且 nowrap：沿用"逐项不拆行"的既有偏好
  assert.equal((html.match(/white-space:nowrap/g) || []).length, 9, '8 个开关 + 1 个数字框都应是 nowrap 项')
}

// ── 2) 身份齐全：无告警，所有开关都不置灰 ───────────────────────────────────
{
  const html = render()
  assert.ok(!html.includes('身份未填全'), '身份齐全时不应有告警')
  for (const label of ['L1 自动召回', 'System prompt 注入', 'Skill 列表', '对话回流到 MemoryCore']) {
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

console.log('settings card render tests passed: 分组 / 条数上限输入框 / 依赖置灰矩阵 / 身份告警')
