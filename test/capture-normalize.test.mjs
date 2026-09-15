/**
 * 写侧归一化测试：L0 / Skill 两套投影 + 失败轮兜底。
 *
 * 为什么必须有这个测试：L0 是 L1/L2/L3 后台抽取的**唯一输入**。一旦归一化漏掉
 * reasoning，思考原文就会被当成对话语料永久写进长期记忆；而 reasoning 就在
 * assistant 的 content 数组里、和可见回复同源，靠"看文案"根本挡不住。
 *
 * 依据（TencentDB-Agent-Memory 仓库）：
 *   - `MemoryProxy/src/skill/normalize-conversation.ts`：reasoning/thinking/image 丢弃
 *   - `agents/asset-import.ts` `toMemoryMessages()`：L0 只收 user/assistant/system，
 *     工具折叠成 `[tool_call] name(args)` / `[tool_result:name] …`
 *
 * 运行：node test/capture-normalize.test.mjs
 */
import assert from 'node:assert'
import { wireCapture } from '../lib/capture.mjs'
import { toL0Records, toSkillMessages } from '../lib/normalize.mjs'

function harness() {
  const handlers = {}
  const written = []    // /v3/conversation/add
  const archived = []   // /v3/skill/conversation/add
  const logs = []
  const ctx = { on(ev, cb) { (handlers[ev] ||= []).push(cb) } }
  wireCapture(ctx, {
    config: { captureEnabled: true },
    identityFor: () => ({ session_id: 's1', team_id: 't', agent_id: 'a', user_id: 'u' }),
    client: {
      async addConversation(_i, messages) { written.push(...messages) },
      async addSkillConversation(_i, messages) { archived.push(...messages) },
    },
    log: (m) => logs.push(m),
  })
  const emit = (type, data, seq = 1) => {
    for (const cb of handlers['session/event'] || []) cb({ id: 's1' }, { type, seq, data })
  }
  const stopTurn = async (turn = 1) => {
    for (const cb of handlers['agent/turn-stopping'] || []) await cb({ turn, agent: { session: { id: 's1' } } })
  }
  const failTurn = (turn = 1, step = 1, error = new Error('INVALID_REQUEST')) => {
    for (const cb of handlers['agent/error'] || []) cb({ turn, step, error, agent: { session: { id: 's1' } } })
  }
  return { emit, stopTurn, failTurn, written, archived, logs }
}

const userEvent = (text) => ({
  message: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' }, id: 'm1' },
  surfaceOp: 'append',
})
const assistantEvent = (parts, { turn = 1, step = 1 } = {}) => ({
  turn,
  step,
  message: { role: 'assistant', content: parts, source: { kind: 'model' } },
})
const toolResultEvent = (toolCallId, text, { turn = 1, step = 1 } = {}) => ({
  turn,
  step,
  message: {
    source: { kind: 'tool', callId: toolCallId },
    content: [{ type: 'tool-result', toolCallId, content: [{ type: 'text', text }] }],
  },
})

// ── 1) reasoning / image 丢弃；可见回复与工具调用各自成条 ───────────────────
{
  const h = harness()
  h.emit('turn/start', { turn: 1 })
  h.emit('step/start', { turn: 1, step: 1 })
  h.emit('user/message', userEvent('帮我看下仓库状态'))
  h.emit('assistant/message', assistantEvent([
    { type: 'reasoning', text: '内部思考：用户想让我执行 git status，先想一下……' },
    { type: 'text', text: '我先查一下。' },
    { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"git status"}' },
    { type: 'image', source: { data: 'AAAA' } },
  ]))
  h.emit('tool/result', toolResultEvent('call-1', 'On branch main\nnothing to commit'))
  await h.stopTurn(1)

  const joined = JSON.stringify(h.written)
  assert.ok(!joined.includes('内部思考'), `reasoning 不得进 L0，实际：${joined}`)
  assert.deepEqual(h.written.map((m) => m.role), ['user', 'assistant'],
    `L0 只允许 user/assistant，实际：${h.written.map((m) => m.role)}`)

  const record = h.written[1].content
  assert.ok(record.includes('我先查一下。'), '可见回复要保留')
  assert.ok(record.includes('[tool_call] bash({"command":"git status"})'), `工具调用要折成标记：${record}`)
  assert.ok(record.includes('[tool_result:bash] On branch main nothing to commit'),
    `工具结果要折成标记、压空白、带工具名：${record}`)

  // Skill 端点：5-role + 配对锚点
  assert.deepEqual(h.archived.map((m) => m.role), ['user', 'assistant', 'tool_call', 'tool_result'])
  const call = h.archived[2]
  assert.equal(call.tool_name, 'bash')
  assert.equal(call.tool_call_id, 'call-1')
  assert.equal(h.archived[3].tool_call_id, 'call-1', 'tool_result 必须带同一个 tool_call_id（core 侧配对锚点）')
  assert.ok(!JSON.stringify(h.archived).includes('内部思考'), 'reasoning 也不得进 skill 语料')
}

// ── 2) 一条消息里混了多段 text：合成一条，不产生空记录 ──────────────────────
{
  const h = harness()
  h.emit('turn/start', { turn: 1 })
  h.emit('step/start', { turn: 1, step: 1 })
  h.emit('assistant/message', assistantEvent([{ type: 'reasoning', text: '只有思考' }]))
  await h.stopTurn(1)
  assert.equal(h.written.length, 0, '全是 reasoning 的消息不应产生任何记录')
  assert.equal(h.archived.length, 0)
}

// ── 3) 失败轮：捕获异常 + 丢弃缓冲，**不回流** ──────────────────────────────
{
  const h = harness()
  h.emit('turn/start', { turn: 1 })
  h.emit('step/start', { turn: 1, step: 1 })
  h.emit('user/message', userEvent('你是谁'))
  h.emit('assistant/message', assistantEvent([{ type: 'reasoning', text: 'x' }]))
  h.failTurn(1, 1, new Error('The supported API model names are …'))
  await h.stopTurn(1)   // 即便有人事后补触发，也不能写
  assert.equal(h.written.length, 0, '失败轮不得回流')
  assert.equal(h.archived.length, 0, '失败轮不得进 skill 归档')
  assert.ok(h.logs.some((m) => m.includes('INVALID_REQUEST') || m.includes('执行失败')),
    `失败轮必须留下日志（兜底捕获异常），实际：${JSON.stringify(h.logs)}`)
}

// ── 4) turn/end 兜底：blocked / aborted 不走 agent/error，也要清缓冲 ─────────
{
  const h = harness()
  h.emit('turn/start', { turn: 1 })
  h.emit('user/message', userEvent('这句不该被记住'))
  h.emit('turn/end', { turn: 1, reason: { kind: 'blocked' } })
  await h.stopTurn(1)
  assert.equal(h.written.length, 0, 'blocked 轮不得回流')
  assert.ok(h.logs.some((m) => m.includes('blocked')), `应记录轮次结束原因，实际：${JSON.stringify(h.logs)}`)
}

// ── 5) 成功轮：turn/end(completed) 不误报丢弃 ───────────────────────────────
{
  const h = harness()
  h.emit('turn/start', { turn: 1 })
  h.emit('user/message', userEvent('正常一轮'))
  await h.stopTurn(1)
  h.emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual(h.written.map((m) => m.content), ['正常一轮'])
  assert.equal(h.logs.filter((m) => m.includes('不回流')).length, 0,
    `成功轮不应出现丢弃日志，实际：${JSON.stringify(h.logs)}`)
}

// ── 6) 纯函数投影：recordKey 分组 + 空记录过滤 ─────────────────────────────
{
  const l0 = toL0Records([
    { role: 'user', content: '问题', recordKey: 'u:1' },
    { role: 'assistant', content: '回答', recordKey: 'a:1:1' },
    { role: 'tool_call', content: '{"a":1}', toolName: 'calc', recordKey: 'a:1:1' },
    { role: 'assistant', content: '   ', recordKey: 'a:1:2' },
  ])
  assert.deepEqual(l0, [
    { role: 'user', content: '问题' },
    { role: 'assistant', content: '回答\n[tool_call] calc({"a":1})' },
  ])

  const skill = toSkillMessages([{ role: 'tool_call', content: '{}', toolCallId: 'c1' }])
  assert.deepEqual(skill, [{ role: 'tool_call', content: '{}', tool_call_id: 'c1' }])
}

console.log('capture normalize tests passed: reasoning 丢弃 / L0 折叠 / skill 5-role / 失败轮不回流')
