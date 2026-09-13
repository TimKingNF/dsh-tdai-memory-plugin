/**
 * recall 防御逻辑测试：验证 pre-step handler 在异常下游/禁用/无结果时
 * 不崩溃、不向链上传播 undefined、不改动正常 decision。
 * 运行：node test/recall.test.mjs
 */
import assert from 'node:assert'
import { wireRecall } from '../lib/recall.mjs'

function makeChain() {
  const inner = () => Promise.resolve({ kind: 'enter', messages: [{ role: 'user', content: 'hi', id: 'm1' }] })
  let called = 0
  const next = async () => { called++; return inner() }
  const payload = { agent: { session: { id: 's1' } }, messages: [{ role: 'user', content: 'hi', id: 'm1' }], turn: 1, step: 1 }
  return { payload, next, inner }
}

function harness(cfgOverrides, runtimeOverrides = {}) {
  const cfg = {
    enabled: false, recallEnabled: false, injectionEnabled: false, captureEnabled: true,
    teamId: 't', agentId: 'a', userId: 'u', taskId: undefined, recallLimit: 5,
    ...cfgOverrides,
  }
  const runtime = {
    readEnabled: () => cfg.enabled,
    config: cfg,
    assets: { ensure: async () => null, peek: () => ({ ctxs: [] }) },
    client: { searchL1: async () => [] },
    log: () => {},
    ...runtimeOverrides,
  }
  const events = []
  const ctx = { on: (ev, cb) => events.push([ev, cb]) }
  wireRecall(ctx, runtime)
  return events[0][1] // handler
}

// 1) 读侧禁用：原样返回 next() 的 decision
{
  const handler = harness({ enabled: false, recallEnabled: true })
  const { payload, inner } = makeChain()
  const result = await handler(payload, async () => inner())
  assert.deepEqual(result, await inner(), 'disabled 时应原样返回 decision')
}

// 2) next() 返回 undefined（异常下游）：不崩溃、兜底 enter、不传播 undefined
{
  const handler = harness({ enabled: true, recallEnabled: true, injectionEnabled: false })
  const payload = { agent: { session: { id: 's1' } }, messages: [{ role: 'user', content: 'hi' }], turn: 1, step: 1 }
  let threw = null
  let result = null
  try { result = await handler(payload, async () => undefined) } catch (error) { threw = error }
  assert.equal(threw, null, 'next()=undefined 不应抛错')
  assert.ok(result && result.kind === 'enter', '应兜底为 enter')
  assert.ok(Array.isArray(result.messages), '兜底应含 messages')
}

// 3) 正常 enter + 召回无结果：原样返回 decision
{
  const handler = harness({ enabled: true, recallEnabled: true, injectionEnabled: false })
  const decision = { kind: 'enter', messages: [{ role: 'user', content: 'hi' }] }
  const payload = { agent: { session: { id: 's1' } }, messages: [{ role: 'user', content: 'hi' }], turn: 1, step: 1 }
  const result = await handler(payload, async () => decision)
  assert.deepEqual(result, decision, '无召回结果时应原样返回')
}

// 4) reject decision：直接放行
{
  const handler = harness({ enabled: true, recallEnabled: true, injectionEnabled: false })
  const rejectDecision = { kind: 'reject' }
  const result = await handler({ agent: { session: { id: 's1' } }, messages: [] }, async () => rejectDecision)
  assert.deepEqual(result, rejectDecision, 'reject 应原样放行')
}

// 5) 召回有结果：追加 <tdai_recalled_l1_memories> user 消息
{
  const handler = harness({ enabled: true, recallEnabled: true, injectionEnabled: false }, {
    client: { searchL1: async () => [{ id: '1', type: 'rule', content: 'remember X', score: 0.9 }] },
  })
  const decision = { kind: 'enter', messages: [{ role: 'user', content: 'hi', id: 'm1' }] }
  const payload = { agent: { session: { id: 's1' } }, messages: [{ role: 'user', content: 'hi', id: 'm1' }], turn: 1, step: 1 }
  const result = await handler(payload, async () => decision)
  assert.equal(result.messages.length, 2, '应追加一条召回消息')
  assert.ok(result.messages[1].content.includes('<tdai_recalled_l1_memories>'), '应含召回标记')
}

// 6) 内层 next() 抛异常：作为最外层守卫应兜住，返回合法 enter 而非向链上抛
{
  const handler = harness({ enabled: true, recallEnabled: true, injectionEnabled: false })
  const payload = { agent: { session: { id: 's1' } }, messages: [{ role: 'user', content: 'hi' }], turn: 1, step: 1 }
  let threw = null
  let result = null
  try { result = await handler(payload, async () => { throw new Error('inner boom') }) } catch (error) { threw = error }
  assert.equal(threw, null, '内层异常不应向链上抛')
  assert.ok(result && result.kind === 'enter', '兜底为 enter')
  assert.ok(Array.isArray(result.messages), '兜底含 messages')
}

// 7) 内层返回带 enter 但缺 messages：补齐 messages，避免下游 .messages 崩
{
  const handler = harness({ enabled: true, recallEnabled: true, injectionEnabled: false })
  const payload = { agent: { session: { id: 's1' } }, messages: [{ role: 'user', content: 'hi' }], turn: 1, step: 1 }
  const result = await handler(payload, async () => ({ kind: 'enter' }))
  assert.ok(result && result.kind === 'enter', '保持 enter')
  assert.ok(Array.isArray(result.messages) && result.messages.length === 1, '缺 messages 时应补齐')
}

console.log('recall defensive tests passed')
