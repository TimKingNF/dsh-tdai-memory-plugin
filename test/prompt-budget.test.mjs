/**
 * prompt 体积基线测试。
 *
 * 改造的核心目标之一是**让注入的字节变少、且不丢信息**，但"变少了多少"如果没人测，
 * 几轮迭代后就会悄悄涨回去。这个测试把每个块的渲染字节固定成可断言的数字。
 *
 * 用法有两种：
 *   1. 直接跑 `node test/prompt-budget.test.mjs` —— 打印当前各块字节数并断言上界。
 *   2. 想要精确差值：`node test/prompt-budget.test.mjs --save` 把当前值写成基线文件
 *      `test/prompt-budget.baseline.json`，之后每次跑都会和基线对比，涨了就让测试红。
 *
 * 上界（UPPER_BOUNDS）是硬约束；基线是软提醒。两者都要过。
 *
 * 运行：node test/prompt-budget.test.mjs [--save]
 */
import assert from 'node:assert'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { apply } from '../index.mjs'
import {
  renderSessionContext,
  renderProfileMemory,
  renderRecalledSkills,
  renderKnowledgeRouteBlock,
  renderKnowledgeSkillContent,
  resolveAgentPrompt,
  MEMORY_TOOLS_GUIDE,
} from '../lib/prompts.mjs'
import { OVERVIEW_TEXT } from '../lib/sections.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const baselinePath = join(here, 'prompt-budget.baseline.json')

// ── 工具 schema 预算（14 个工具每轮都在上下文里，按 token 付费）─────────────────
//
// 口径（与 CHANGELOG / docs/prompt-design 的 9165 B 同源，**别再换算法**）：
//   逐项 = Buffer.byteLength(JSON.stringify({ name, description, parameters }), 'utf8')
//   合计 = 逐项之和（不是整数组序列化——否则逗号/括号/字段顺序一变数就漂）
//   不含 output schema，也不含调用参数。
// 两道闸：
//   1) 逐项等值 baseline：任一 description +200 B 必红；baseline 由 --save 现场生成，不手填；
//   2) 合计 ≤ 10000 B 政策上界（9165 × 1.09 取整）。只靠 1 挡不住"一次性刷新 baseline
//      顺带涨 20%"，所以这道独立兜底闸不能少。
const TOOL_SCHEMA_TOTAL_CAP = 10_000
const TOOL_COUNT = 14

/** 用与 test/load.test.mjs 同款的 mock cordis ctx 跑一次 apply()，
 *  拿**真正注册进 DSH 的工具清单**——手抄名字表会在新增工具时悄悄漏测。 */
function captureRegisteredTools() {
  const tools = []
  const settingsCtx = {
    effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {} },
    settings: {
      configure() {},
      describe() {
        return [{
          ns: 'tdai-memory', autoGenerate: false, schema: {}, value: {},
          user: { serviceId: 'from-panel' }, base: { serviceId: 'from-env' },
          revision: 1, applies: 'live',
        }]
      },
    },
  }
  const commandsCtx = { commands: { register() {} } }
  const ctx = {
    logger: { warn() {} },
    fiber: { id: 'tdai-memory' },
    inject(deps, cb) {
      if (!Array.isArray(deps)) return
      if (deps.includes('settings')) cb(settingsCtx)
      if (deps.includes('commands')) cb(commandsCtx)
    },
    tools: { register(def) { tools.push(def) } },
    systemPrompt: { section() {} },
    sessions: { list() { return [] } },
    on() {},
    get() { return undefined },
  }
  apply(ctx, {})
  return tools
}

const serializeToolSchema = (tool) => JSON.stringify({
  name: tool.name, description: tool.description, parameters: tool.parameters,
})

function measureToolSchema(tools) {
  const perTool = {}
  for (const tool of tools) perTool[tool.name] = Buffer.byteLength(serializeToolSchema(tool), 'utf8')
  const total = Object.values(perTool).reduce((a, b) => a + b, 0)
  return { perTool, total }
}

/** 判定函数单独抽出来：变异验证直接喂克隆对象，不用真改源码。 */
function assertToolSchemaBudget(measured, baseline, cap) {
  assert.equal(Object.keys(measured.perTool).length, TOOL_COUNT, `注册工具数应为 ${TOOL_COUNT}`)
  for (const [name, bytes] of Object.entries(measured.perTool)) {
    assert.notEqual(baseline.perTool[name], undefined,
      `baseline 缺少工具 ${name} 的字节数（确认是有意新增工具后跑 --save）`)
    assert.equal(bytes, baseline.perTool[name],
      `工具 ${name} 的 schema 从 ${baseline.perTool[name]} → ${bytes} B。确认是有意改 description 再跑 --save`)
  }
  for (const name of Object.keys(baseline.perTool)) {
    assert.notEqual(measured.perTool[name], undefined, `baseline 里有已不存在的工具 ${name}（跑 --save 重生成）`)
  }
  const sum = Object.values(baseline.perTool).reduce((a, b) => a + b, 0)
  assert.equal(sum, baseline.total, 'baseline 自洽：逐项之和必须等于合计（防止只改一处）')
  assert.ok(measured.total <= cap,
    `工具 schema 合计 ${measured.total} B 超出政策上界 ${cap} B（当前 ${TOOL_COUNT} 个工具）`)
}

const measuredToolSchema = measureToolSchema(captureRegisteredTools())

// ── 代表性样例（贴近真实会话的规模）──────────────────────────────────────────
const agent = { id: 'agt-demo', name: 'ARK-ALPHA', description: '旧人类留下的最后一座人工智能核心' }
const task = { id: 'task-demo', name: '提示词注入改造', description: '把 proxy 的注入方式改成 DSH 原生接口', goal: '降低字节并去掉重复' }
const profiles = [{
  ctx: { agentId: 'agt-demo', agentName: 'ARK-ALPHA', isSelf: true },
  l3: { content: '# User Narrative Profile\n\n' + '画像正文。'.repeat(200) },
  l2Entries: [
    { path: '个人背景-职业轨迹与生活诉求.md', summary: '用户是1995年出生的深圳后端程序员，10年经验。' },
    { path: '个人财务-记账与资产状况.md', summary: '税前月薪3.4万、到手约2.3万、净资产271万元。' },
    { path: '技术开发-记忆插件项目.md', summary: '开发 dsh-tdai-memory-plugin。' },
  ],
}]
// skill 召回块的样例：3 条命中、描述接近截断上限（每轮注入的真实形态）
// 描述**不截断**（2026-10 用户决定），所以这块的体积完全由 skill 库里的描述长度决定。
// fixture 用本机真实命中的长度分布：一条长（900+ 字符，本机实测最大 923）、两条中短。
// 别用短句凑数 —— 用短句会把这块低估一个数量级（历史上"fixture 太小、上界形同虚设"就是这么来的）。
const skillHits = [
  { name: 'tdai-memory-cloud-skill-listing-triage', description: 'DSH tdai-memory 插件「云端 skill 目录」的定位与处置 SOP —— 从 `tdai:available-skills` 常驻目录改成每轮按需召回（`<tdai_recalled_skills>`）之后，如何判断一份 skill 库该不该继续常驻、该常驻哪些、以及本文档自身描述过期的信号与更新方式；含历史事故（query 未截断导致永久 40001）、字节账（15.3 KB → 0 常驻 + 命中时 2.5–4.5 KB）与两个面板旋钮（条数上限 / 分数下限）的调法。'.repeat(3), score: 4.49 },
  { name: 'dsh-runtime-skill-registration', description: '把 DSH agent 插件里的大段常驻能力说明改造成 DSH 运行时 skill（ctx.skills.register()）——system 只留一行路由、正文按需加载，含 cordis inject 语义与幂等坑。', score: 4.47 },
  { name: 'dsh-plugin-tool-render-contract', description: 'DSH 工具输出投影的 `render(args, value)` 契约：第一形参是参数不是返回值，写错会静默把参数当结果回显。', score: 4.27 },
]
const knowledge = [{
  knowledge_id: 'k1', type: 'code-graph', service_url: 'http://kb.example.com',
  repo_url: 'https://github.com/acme/repo.git', repo_slug: 'acme/repo', branch: 'main', name: 'repo 索引',
}]

// ── 渲染各块 ─────────────────────────────────────────────────────────────────
const blocks = {
  'tdai:session-context': renderSessionContext(agent, task),
  'tdai:profile-memory': renderProfileMemory(profiles, OVERVIEW_TEXT),
  'tdai:knowledge-tools': renderKnowledgeRouteBlock(knowledge),
  '(memory-tools-guide)': MEMORY_TOOLS_GUIDE,
}
const sizes = Object.fromEntries(Object.entries(blocks).map(([k, v]) => [k, Buffer.byteLength(v, 'utf8')]))
const total = Object.values(sizes).reduce((a, b) => a + b, 0)
// 单独观测：知识 skill 正身体积（按需加载，不计入常驻预算）
const skillBodyBytes = Buffer.byteLength(renderKnowledgeSkillContent(knowledge), 'utf8')

// 单独观测：每轮 skill 召回块（消息通道，不在 system 里，但一样吃上下文）
const skillRecallBytes = Buffer.byteLength(renderRecalledSkills(skillHits), 'utf8')

// 单独观测：TDAI agent 的「角色定位 + 规则固定」prompt（注入 persona 槽的那份）。
//
// **刻意不进 UPPER_BOUNDS、也不进基线**：它的体积完全由用户在 MemoryPanel 里填的内容
// 决定（本机实测 7162 字符 / 19090 字节），把它钉成常数只会天天误报。这里只做一件
// 有回归价值的事：确认取到的是**未截断、未加壳**的原文（旧实现在 persona 槽里既可能
// 漏注入、也可能被别的预算截断）。逐字节相等的功能性断言在 test/sections.test.mjs。
const agentRawSample = {
  metadata_json: JSON.stringify({
    ui: { role_prompt: '# 角色定位\n\n' + '世界观。'.repeat(300), rules_prompt: '# 规则\n\n' + '固定规则。'.repeat(100) },
  }),
  prompt: 'ignored-when-split-fields-exist',
}
const agentPromptText = resolveAgentPrompt(agentRawSample)
const agentPromptBytes = Buffer.byteLength(agentPromptText, 'utf8')
assert.equal(agentPromptText, JSON.parse(agentRawSample.metadata_json).ui.role_prompt + '\n\n' + JSON.parse(agentRawSample.metadata_json).ui.rules_prompt,
  'persona 槽注入的必须是拆分字段合并后的原文（无截断、无包裹）')

console.log('── 各块字节数（UTF-8）──')
for (const [k, v] of Object.entries(sizes)) console.log(`  ${v.toString().padStart(6)}  ${k}`)
console.log(`  ${total.toString().padStart(6)}  合计（常驻部分）`)
console.log(`  ${skillRecallBytes.toString().padStart(6)}  <tdai_recalled_skills>（每轮按需，命中 3 条时的上界）`)
console.log(`  ${skillBodyBytes.toString().padStart(6)}  知识 skill 正文（按需加载，不计入常驻）`)
console.log(`  ${agentPromptBytes.toString().padStart(6)}  deployment:persona-prefix（TDAI 角色/规则 prompt，体积随 agent 配置变化）`)

// ── 硬上界：**改造后的目标值**，涨过就是回退 ──────────────────────────────────
// 这些数字来自阶段 2（瘦身）完成时的实测值，留了约 20% 余量。
// 依据 docs/prompt-injection-redesign.md §5.5 / 阶段 2。
const UPPER_BOUNDS = {
  // 小块会话上下文只放 id/name/description；agent 的角色/规则 prompt 走 persona 槽
  // （deployment:persona-prefix），体积随用户配置变化，见下面单列的那一行观测值。
  'tdai:session-context': 400,
  // persona 画像 + L2 索引 + 总述 + 工具总纲（样例里画像正文约 3000 字节）
  'tdai:profile-memory': 6000,
  // 知识能力已改成 DSH runtime skill：system 里只剩一行路由信息（数千字节 → 数百字节），
  // 完整判据与 curl 配方在 skill 正文里按需加载。见 test/knowledge-skill.test.mjs。
  // 注意：**skill 正文不计入这里的预算** —— 它只在模型调用 `skill` 工具时才进上下文。
  'tdai:knowledge-tools': 600,
  '(memory-tools-guide)': 500,
}

// 每轮 skill 召回块的上界。它替代了原来 15.3 KB 的常驻目录（见 CHANGELOG 2026-10）。
//
// 描述不截断后，这块的体积 ≈ 引导句 250 B + Σ(名字 + 完整描述)；本机真实命中实测：
// 3 条 2,541 B、4 条 3,456 B、5 条 4,486 B（最长的一条描述 923 字符 ≈ 2.8 KB）。
// 所以**改 skillRecallLimit（面板）时必须一起改这里** —— 它是"条数 × 描述长度"的乘积项。
assert.ok(skillRecallBytes <= 4500, `skill 召回块 ${skillRecallBytes} 字节超出上界 4500——命中条数被调大，或描述被加长到失控了？`)
for (const [k, limit] of Object.entries(UPPER_BOUNDS)) {
  assert.ok(sizes[k] <= limit, `块 "${k}" 体积 ${sizes[k]} 字节超出上界 ${limit}——请确认是有意加内容，而不是文案回涨`)
}

// ── 工具 schema 体积：打印 + 变异验证（判定函数必须真能红）──────────────────────
console.log('\n── 工具 schema 字节数（UTF-8，name+description+parameters）──')
for (const [name, bytes] of Object.entries(measuredToolSchema.perTool)) {
  console.log(`  ${String(bytes).padStart(6)}  ${name}`)
}
console.log(`  ${String(measuredToolSchema.total).padStart(6)}  合计（${TOOL_COUNT} 个工具）`)

{
  // 变异验证：给任一 description 加 200 B，判定必须红。喂克隆对象，不碰源码。
  const names = Object.keys(measuredToolSchema.perTool)
  const mutated = {
    perTool: { ...measuredToolSchema.perTool },
    total: measuredToolSchema.total + 200,
  }
  mutated.perTool[names[0]] += 200
  assert.throws(
    () => assertToolSchemaBudget(mutated, measuredToolSchema, TOOL_SCHEMA_TOTAL_CAP),
    /description|schema/,
    '变异验证失败：某条 description 加 200 B 居然没让预算测试红',
  )
}

// ── 软基线：--save 写入，之后每次对比 ────────────────────────────────────────
if (process.argv.includes('--save')) {
  writeFileSync(baselinePath, `${JSON.stringify({ ...sizes, toolSchema: measuredToolSchema }, null, 2)}\n`, 'utf8')
  console.log(`\n已写入基线：${baselinePath}`)
} else if (existsSync(baselinePath)) {
  const saved = JSON.parse(readFileSync(baselinePath, 'utf8'))
  const grew = Object.entries(sizes).filter(([k, v]) => saved[k] !== undefined && v > saved[k])
  for (const [k, v] of grew) {
    console.log(`  ↑ ${k}: ${saved[k]} → ${v}（+${v - saved[k]}）`)
  }
  assert.equal(grew.length, 0,
    `有 ${grew.length} 个块比基线变大：${grew.map(([k]) => k).join(', ')}。确认是有意的就重跑 --save。`)
  assert.ok(saved.toolSchema, '基线文件缺 toolSchema 段：跑 node test/prompt-budget.test.mjs --save 重新生成')
  assertToolSchemaBudget(measuredToolSchema, saved.toolSchema, TOOL_SCHEMA_TOTAL_CAP)
}

console.log('\nprompt budget tests passed')
