/** 纯函数冒烟测试：node test/smoke.test.mjs */
import assert from 'node:assert'
import { chunkConversationMessages, stripSceneNavigation, cleanUserQuery, safeText } from '../lib/text.mjs'
import {
  renderSessionContext,
  buildListingQuery,
  renderRecalledL1,
  renderProfileMemory,
  renderSkillsBlock,
} from '../lib/prompts.mjs'
import { buildSettingsSchema } from '../lib/settings.mjs'

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
  { id: 'agt-1', name: 'Coder', description: 'd', prompt: 'p' },
  { id: 'task-1', name: 'T', description: 'td', goal: 'g' },
)
assert.ok(block.startsWith('<session_context>') && block.endsWith('</session_context>'))
assert.ok(block.includes('[Agent]') && block.includes('[Task]'))
// **不注入 agent.prompt**：persona 已由 DSH preset 的 deployment:persona 段注入，
// 再注一遍是同内容两遍（docs/prompt-injection-redesign.md 阶段 2）。
assert.ok(!block.includes('prompt:') && !block.includes('\np'), 'session_context 不应包含 agent.prompt 全文')
assert.equal(renderSessionContext(null, null), '')

// buildListingQuery：弱信号 → undefined（core 回落 mode=full）
assert.equal(buildListingQuery({ description: 'testagent1', prompt: 'testagent1' }, null), undefined)
assert.ok(buildListingQuery({ description: 'code review assistant for quality standards' }, null))
assert.equal(buildListingQuery(null, null), undefined)

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

// renderSkillsBlock
assert.equal(renderSkillsBlock(null), '')
assert.equal(renderSkillsBlock({ listing: '(none)' }), '')
assert.ok(renderSkillsBlock({ listing: '<available_skills>\n- foo: bar\n</available_skills>' }).includes('tdai_skill_view'))

// settings schema：校验合法值、拒绝越界
const schema = buildSettingsSchema()
const good = schema({ enabled: true, teamId: 'team-x', recallLimit: 7, l2Limit: 3, timeoutMs: 5000 })
assert.equal(good.teamId, 'team-x')
assert.equal(good.recallLimit, 7)
assert.throws(() => schema({ recallLimit: 999 }), 'recallLimit 越界应被拒')
assert.throws(() => schema({ timeoutMs: 1 }), 'timeoutMs 低于下限应被拒')

console.log('smoke tests passed')
