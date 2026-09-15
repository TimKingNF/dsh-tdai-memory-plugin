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
import {
  renderSessionContext,
  renderProfileMemory,
  renderSkillsBlock,
  renderKnowledgeRouteBlock,
  renderKnowledgeSkillContent,
  MEMORY_TOOLS_GUIDE,
} from '../lib/prompts.mjs'
import { OVERVIEW_TEXT } from '../lib/sections.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const baselinePath = join(here, 'prompt-budget.baseline.json')

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
const skills = { listing: '<available_skills>\n- `skill-a`: 描述一\n- `skill-b`: 描述二\n</available_skills>' }
const knowledge = [{
  knowledge_id: 'k1', type: 'code-graph', service_url: 'http://kb.example.com',
  repo_url: 'https://github.com/acme/repo.git', repo_slug: 'acme/repo', branch: 'main', name: 'repo 索引',
}]

// ── 渲染各块 ─────────────────────────────────────────────────────────────────
const blocks = {
  'tdai:session-context': renderSessionContext(agent, task),
  'tdai:profile-memory': renderProfileMemory(profiles, OVERVIEW_TEXT),
  'tdai:available-skills': renderSkillsBlock(skills),
  'tdai:knowledge-tools': renderKnowledgeRouteBlock(knowledge),
  '(memory-tools-guide)': MEMORY_TOOLS_GUIDE,
}
const sizes = Object.fromEntries(Object.entries(blocks).map(([k, v]) => [k, Buffer.byteLength(v, 'utf8')]))
const total = Object.values(sizes).reduce((a, b) => a + b, 0)
// 单独观测：知识 skill 正身体积（按需加载，不计入常驻预算）
const skillBodyBytes = Buffer.byteLength(renderKnowledgeSkillContent(knowledge), 'utf8')

console.log('── 各块字节数（UTF-8）──')
for (const [k, v] of Object.entries(sizes)) console.log(`  ${v.toString().padStart(6)}  ${k}`)
console.log(`  ${total.toString().padStart(6)}  合计（常驻部分）`)
console.log(`  ${skillBodyBytes.toString().padStart(6)}  知识 skill 正文（按需加载，不计入常驻）`)

// ── 硬上界：**改造后的目标值**，涨过就是回退 ──────────────────────────────────
// 这些数字来自阶段 2（瘦身）完成时的实测值，留了约 20% 余量。
// 依据 docs/prompt-injection-redesign.md §5.5 / 阶段 2。
const UPPER_BOUNDS = {
  // 不含 agent.prompt 全文（那份 persona 由 DSH preset 的 deployment:persona 段注入）
  'tdai:session-context': 400,
  // persona 画像 + L2 索引 + 总述 + 工具总纲（样例里画像正文约 3000 字节）
  'tdai:profile-memory': 6000,
  'tdai:available-skills': 700,
  // 知识能力已改成 DSH runtime skill：system 里只剩一行路由信息（数千字节 → 数百字节），
  // 完整判据与 curl 配方在 skill 正文里按需加载。见 test/knowledge-skill.test.mjs。
  // 注意：**skill 正文不计入这里的预算** —— 它只在模型调用 `skill` 工具时才进上下文。
  'tdai:knowledge-tools': 600,
  '(memory-tools-guide)': 500,
}
for (const [k, limit] of Object.entries(UPPER_BOUNDS)) {
  assert.ok(sizes[k] <= limit, `块 "${k}" 体积 ${sizes[k]} 字节超出上界 ${limit}——请确认是有意加内容，而不是文案回涨`)
}

// ── 软基线：--save 写入，之后每次对比 ────────────────────────────────────────
if (process.argv.includes('--save')) {
  writeFileSync(baselinePath, JSON.stringify(sizes, null, 2) + '\n', 'utf8')
  console.log(`\n已写入基线：${baselinePath}`)
} else if (existsSync(baselinePath)) {
  const saved = JSON.parse(readFileSync(baselinePath, 'utf8'))
  const grew = Object.entries(sizes).filter(([k, v]) => saved[k] !== undefined && v > saved[k])
  for (const [k, v] of grew) {
    console.log(`  ↑ ${k}: ${saved[k]} → ${v}（+${v - saved[k]}）`)
  }
  assert.equal(grew.length, 0,
    `有 ${grew.length} 个块比基线变大：${grew.map(([k]) => k).join(', ')}。确认是有意的就重跑 --save。`)
}

console.log('\nprompt budget tests passed')
