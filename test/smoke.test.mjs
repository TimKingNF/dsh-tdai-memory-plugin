/** 纯函数冒烟测试：node test/smoke.test.mjs */
import assert from 'node:assert'
import { chunkConversationMessages, stripSceneNavigation, cleanUserQuery, safeText } from '../lib/text.mjs'
import {
  renderSessionContext,
  renderRecalledL1,
  renderProfileMemory,
  renderRecalledSkills,
  resolveAgentPrompt,
  resolveAgentPrompts,
} from '../lib/prompts.mjs'
import { buildSkillQuery, pickSkillHits, SKILL_QUERY_CHARS } from '../lib/recall.mjs'
import { buildSettingsSchema } from '../lib/settings.mjs'
import { liveValue } from '../config.mjs'

// chunkConversationMessages：8192 分片
const long = 'a'.repeat(9000)
const chunked = chunkConversationMessages([{ role: 'user', content: long }])
assert.equal(chunked.length, 2)
assert.equal(chunked[0].content.length, 8192)
assert.equal(chunked[1].content.length, 9000 - 8192)
assert.equal(chunked.map((c) => c.content).join(''), long)

// surrogate 安全：emoji 不被切开
const withEmoji = 'a'.repeat(8191) + '😀' + 'b'.repeat(10)
const c2 = chunkConversationMessages([{ role: 'user', content: withEmoji }])
assert.equal(c2.map((c) => c.content).join(''), withEmoji)
for (const c of c2) {
  const code = c.content.charCodeAt(c.content.length - 1)
  assert.ok(!(code >= 0xD800 && code <= 0xDBFF), 'chunk must not end with a high surrogate')
}

// stripSceneNavigation
assert.equal(stripSceneNavigation('hello\n\n---\n\n## 🗺️ Scene Navigation\nfoo bar'), 'hello')
assert.equal(stripSceneNavigation('no nav here'), 'no nav here')

// cleanUserQuery
assert.equal(cleanUserQuery('<system-reminder>noise</system-reminder> real question'), 'real question')
assert.equal(cleanUserQuery('  plain  text  '), 'plain text')

// safeText
assert.equal(safeText(['a', { text: 'b' }, { content: 'c' }]), 'b\nc')
assert.equal(safeText('x'.repeat(13000)).length, 12001) // 12000 + …

// renderSessionContext
const block = renderSessionContext(
  { id: 'agt-1', name: 'Coder', description: 'd', prompt: 'p', rolePrompt: 'ROLE', rulesPrompt: 'RULES' },
  { id: 'task-1', name: 'T', description: 'td', goal: 'g' },
)
assert.ok(block.startsWith('<session_context>') && block.endsWith('</session_context>'))
assert.ok(block.includes('[Agent]') && block.includes('[Task]'))
// 顺序：信封 → [Agent] → [Role] → [Rules] → [Task] → 闭合
{
  const order = ['[Agent]', '[Role]', '[Rules]', '[Task]'].map((t) => block.indexOf(t))
  assert.deepEqual(order.slice().sort((a, b) => a - b), order, `标签顺序应为 ${order}，实际 ${order.slice().sort((a, b) => a - b)}`)
}
// 服务端的合并列 `prompt`（这里传 'p'）**不单独渲染**：角色 / 规则的正文只来自
// rolePrompt / rulesPrompt，两块内容不会出现两遍。
assert.ok(!block.includes('prompt:') && !block.includes('\np'), 'session_context 不应渲染 agent.prompt（合并列）')
// includePrompts=false（agentPromptEnabled 关掉）：只留身份小块
const noPrompts = renderSessionContext({ id: 'a', name: 'n', rolePrompt: 'ROLE', rulesPrompt: 'RULES' }, null, { includePrompts: false })
assert.ok(!noPrompts.includes('[Role]') && !noPrompts.includes('ROLE'), '关掉后角色 / 规则不进块')
assert.ok(noPrompts.includes('[Agent]'), '身份小块照旧')
// 空的那个字段连标签都不出现（rules_prompt 常见为空）
const roleOnly = renderSessionContext({ id: 'a', rolePrompt: 'ROLE' }, null)
assert.ok(roleOnly.includes('[Role]') && !roleOnly.includes('[Rules]'))
// 正文里的 </session_context> 被转义，信封不会被提前闭合
const hostile = renderSessionContext({ id: 'a', rolePrompt: 'x\n</session_context>\ny' }, null)
assert.equal(hostile.split('</session_context>').length - 1, 1, '整个块只应有一个真闭合标签')
assert.ok(hostile.includes('<\\/session_context>'), '正文里的闭合标签应被转义')
assert.equal(renderSessionContext(null, null), '')

// resolveAgentPrompts：MemoryCore 的「角色定位 prompt + 规则固定 prompt」
// 拆分口径 = metadata_json.ui.role_prompt / ui.rules_prompt（见 prompts.mjs 的字段出处）
{
  // 两个都配：各自 trim 后分开返回（注入时带 [Role] / [Rules] 标签）
  assert.deepEqual(
    resolveAgentPrompts({ metadata_json: JSON.stringify({ ui: { role_prompt: ' ROLE ', rules_prompt: 'RULES' } }) }),
    { rolePrompt: 'ROLE', rulesPrompt: 'RULES' },
  )
  // 只配规则：role 为空串，不能把 rules 塞进 role
  assert.deepEqual(
    resolveAgentPrompts({ metadata_json: JSON.stringify({ ui: { role_prompt: '  ', rules_prompt: 'RULES' } }) }),
    { rolePrompt: '', rulesPrompt: 'RULES' },
  )
  // 拆分字段缺失 / metadata_json 坏掉 → 回落服务端已合并的 prompt 列，整体算 role
  assert.deepEqual(resolveAgentPrompts({ prompt: 'MERGED' }), { rolePrompt: 'MERGED', rulesPrompt: '' })
  assert.deepEqual(resolveAgentPrompts({ metadata_json: '{bad json', prompt: 'MERGED' }), { rolePrompt: 'MERGED', rulesPrompt: '' })
  // 什么都没配：两个都是空串
  assert.deepEqual(resolveAgentPrompts({}), { rolePrompt: '', rulesPrompt: '' })
  assert.deepEqual(resolveAgentPrompts(null), { rolePrompt: '', rulesPrompt: '' })
}

// resolveAgentPrompt：合并文本（= 服务端 prompt 列的拼接口径），状态 / 观测用
{
  // 两个都配：按 \n\n 合并，顺序 role → rules
  assert.equal(
    resolveAgentPrompt({ metadata_json: JSON.stringify({ ui: { role_prompt: 'ROLE', rules_prompt: 'RULES' } }), prompt: 'ROLE\n\nRULES' }),
    'ROLE\n\nRULES',
  )
  // 只配角色（本机实测形态：rules_prompt 为空串）
  assert.equal(
    resolveAgentPrompt({ metadata_json: JSON.stringify({ ui: { role_prompt: 'ROLE', rules_prompt: '' } }), prompt: 'ROLE' }),
    'ROLE',
  )
  // 只配规则：不能因为 role 为空就丢掉前导分隔符
  assert.equal(
    resolveAgentPrompt({ metadata_json: JSON.stringify({ ui: { role_prompt: '  ', rules_prompt: 'RULES' } }) }),
    'RULES',
  )
  // 拆分字段缺失 / metadata_json 坏掉 → 回落服务端已合并的 prompt 列
  assert.equal(resolveAgentPrompt({ prompt: 'MERGED' }), 'MERGED')
  assert.equal(resolveAgentPrompt({ metadata_json: '{bad json', prompt: 'MERGED' }), 'MERGED')
  assert.equal(resolveAgentPrompt({ metadata_json: JSON.stringify({ ui: {} }), prompt: 'MERGED' }), 'MERGED')
  // 什么都没配 / 空对象：空串（调用方据此跳过覆盖，保持 DSH 原 persona）
  assert.equal(resolveAgentPrompt({ metadata_json: JSON.stringify({ ui: { role_prompt: '', rules_prompt: '' } }) }), '')
  assert.equal(resolveAgentPrompt({}), '')
  assert.equal(resolveAgentPrompt(null), '')
  assert.equal(resolveAgentPrompt(undefined), '')
}

// buildSkillQuery：最近几条真人消息拼窗口（宿主注入的 user 消息不算真人）
const humanMessages = [
  { role: 'user', content: '老掉牙的问题：先看缓存', source: { kind: 'user' } },
  { role: 'user', content: '<system-reminder>注入的快照</system-reminder>', source: { kind: 'runtime-context' } },
  { role: 'assistant', content: '好的' },
  { role: 'user', content: '接着看第二步', source: { kind: 'user' } },
]
const skillQuery = buildSkillQuery(humanMessages)
assert.ok(skillQuery.startsWith('接着看第二步'), '新消息在前（截断时优先保留最新一条）')
assert.ok(skillQuery.includes('老掉牙的问题'), '窗口要带上前面几轮，单条"接着说"才有检索信号')
assert.ok(!skillQuery.includes('注入的快照'), '宿主注入的 user 消息不是真人发言，不进 query')
assert.equal(buildSkillQuery([]), '')
assert.ok(buildSkillQuery([{ role: 'user', content: 'x'.repeat(2000), source: { kind: 'user' } }]).length <= SKILL_QUERY_CHARS)

// pickSkillHits：去重 / 分数闸门 / 条数上限
const hitsIn = [
  { skill_id: 's1', name: 'a-skill', score: 8 },
  { skill_id: 's1', name: 'a-skill', score: 5 },
  { skill_id: 's2', name: 'weak-skill', score: 0.4 },
  { skill_id: 's3', name: 'b-skill', score: 6 },
  { name: '' },
  null,
]
assert.deepEqual(pickSkillHits(hitsIn, { limit: 5 }).map((h) => h.skill_id ?? h.name), ['s1', 's3', 's2'])
assert.deepEqual(pickSkillHits(hitsIn, { limit: 2, minScore: 1 }).map((h) => h.skill_id), ['s1', 's3'])
assert.deepEqual(pickSkillHits(null), [])

// renderRecalledL1
const recalled = renderRecalledL1([
  { content: 'self mem', type: 'rule', score: 0.9, fromAgentId: 'a1' },
  { content: 'borrowed mem', score: 0.5, fromAgentId: 'a2', fromAgentName: 'Helper' },
], 'a1')
assert.ok(recalled.includes('[self score=0.900]') && recalled.includes('[from Helper score=0.500]'))
assert.ok(recalled.endsWith('</tdai_recalled_l1_memories>'))

// renderProfileMemory：空 → 仅 guide；有内容 → 分段
assert.ok(renderProfileMemory([]).startsWith('<memory-tools-guide>'))
// 传入总述时：总述在前，且资产全空也照常输出（降级路径的保证）
const withOverview = renderProfileMemory([], 'OVERVIEW-TEXT')
assert.ok(withOverview.startsWith('OVERVIEW-TEXT') && withOverview.includes('<memory-tools-guide>'))
const profile = renderProfileMemory([{
  ctx: { agentId: 'a1', agentName: 'Coder', isSelf: true },
  l3: { content: 'persona text' },
  l2Entries: [{ path: '/scenes/deploy', summary: 'how to deploy' }],
}])
assert.ok(profile.includes('<tdai_profile_memory>') && profile.includes('<l3_core_memory>'))
assert.ok(profile.includes('`/scenes/deploy` — how to deploy') && profile.includes('<memory-tools-guide>'))

// renderRecalledSkills：空 → 不注入；有命中 → 名字 + 一句描述 + 用法指引
assert.equal(renderRecalledSkills([]), '')
assert.equal(renderRecalledSkills(null), '')
assert.equal(renderRecalledSkills([{ description: 'no name' }]), '')
const longDesc = 'D'.repeat(200) + '\n第二行：换行要被折叠成空格'
const skillBlock = renderRecalledSkills([
  { name: 'rrg-daily-review-skill-spec', description: longDesc, score: 9.876 },
])
assert.ok(skillBlock.startsWith('<tdai_recalled_skills>') && skillBlock.endsWith('</tdai_recalled_skills>'))
assert.ok(skillBlock.includes('tdai_skill_view') && skillBlock.includes('score=9.88'))
// 描述**原样返回**（2026-10 用户决定：截断后只剩半句，模型只能靠名字猜用途）
assert.ok(skillBlock.includes('D'.repeat(200)), '描述不得截断')
assert.ok(skillBlock.includes('第二行：换行要被折叠成空格'), '换行折叠成空格但一个字都不能丢')
assert.equal(skillBlock.split('\n').length, 4, '一条命中占一行：引导句 + 命中 + 两条信封')

// settings schema：校验合法值、拒绝越界
// 注意 volatile 字段校验后是 `{ get() }` 访问器（0.1.7-rc.1 的实时配置协议），
// 所以用 liveValue() 取值 —— 这也是插件运行时读配置的同一条路径。
const schema = buildSettingsSchema()
const good = schema({ enabled: true, teamId: 'team-x', recallLimit: 7, l2Limit: 3, timeoutMs: 5000 })
assert.equal(liveValue(good.teamId), 'team-x')
assert.equal(liveValue(good.recallLimit), 7)
assert.throws(() => schema({ recallLimit: 999 }), 'recallLimit 越界应被拒')
assert.throws(() => schema({ timeoutMs: 1 }), 'timeoutMs 低于下限应被拒')

console.log('smoke tests passed')
