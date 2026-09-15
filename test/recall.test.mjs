/**
 * recall 测试：
 *   A. 防御逻辑：pre-step handler 在异常下游 / 禁用 / 无结果时不崩溃、
 *      不向链上传播 undefined、不改动正常 decision；
 *   B. 注入形态：召回块是**独立一条 plugin 消息**（form: 'notice'），插在真人消息之后，
 *      用户那条消息**一个字节都不能动**（前端回显、L0 回流、宿主"真人发言"判据都靠它）；
 *   C. 不许卡住主链路：资产没就绪时不等待、abort 时不检索、检索失败/超时都 fail-open。
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
    recallTimeoutMs: 3000, assetLoadBudgetMs: 5000, assetRetryCooldownMs: 15000,
    ...cfgOverrides,
  }
  const calls = { warm: 0 }
  const runtime = {
    readEnabled: () => cfg.enabled,
    config: cfg,
    assets: {
      ensure: async () => null,
      warm: () => { calls.warm += 1; return Promise.resolve(null) },
      peek: () => ({ ctxs: [] }),
    },
    client: { searchL1: async () => [] },
    log: () => {},
    ...runtimeOverrides,
  }
  const events = []
  const ctx = { on: (ev, cb) => events.push([ev, cb]) }
  wireRecall(ctx, runtime)
  return { handler: events[0][1], calls, cfg, runtime }
}

const hit = (content = 'remember X', score = 0.9) => [{ id: '1', type: 'rule', content, score }]

/** 找到注入的召回消息（插件消息 + notice 形态）。 */
function recalledMessage(messages) {
  return messages.find((m) => m?.source?.kind === 'plugin' && m.source.plugin === 'dsh-tdai-memory-plugin')
}

// ── A. 防御逻辑 ───────────────────────────────────────────────────────────────

// 1) 读侧禁用：原样返回 next() 的 decision
{
  const { handler } = harness({ enabled: false, recallEnabled: true })
  const { payload, inner } = makeChain()
  const result = await handler(payload, async () => inner())
  assert.deepEqual(result, await inner(), 'disabled 时应原样返回 decision')
}

// 2) next() 返回 undefined（异常下游）：不崩溃、兜底 enter、不传播 undefined
{
  const { handler } = harness({ enabled: true, recallEnabled: true, injectionEnabled: false })
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
  const { handler } = harness({ enabled: true, recallEnabled: true, injectionEnabled: false })
  const decision = { kind: 'enter', messages: [{ role: 'user', content: 'hi' }] }
  const payload = { agent: { session: { id: 's1' } }, messages: [{ role: 'user', content: 'hi' }], turn: 1, step: 1 }
  const result = await handler(payload, async () => decision)
  assert.deepEqual(result, decision, '无召回结果时应原样返回')
}

// 4) reject decision：直接放行
{
  const { handler } = harness({ enabled: true, recallEnabled: true, injectionEnabled: false })
  const rejectDecision = { kind: 'reject' }
  const result = await handler({ agent: { session: { id: 's1' } }, messages: [] }, async () => rejectDecision)
  assert.deepEqual(result, rejectDecision, 'reject 应原样放行')
}

// ── B. 注入形态：独立 plugin 消息 + 真人消息零改动 ────────────────────────────

// 5) 召回有结果：**新增一条**独立消息，真人那条**原样不动**
{
  const { handler } = harness({ enabled: true, recallEnabled: true, injectionEnabled: false }, {
    client: { searchL1: async () => hit() },
  })
  const user = { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user', rpcId: 'r1' } }
  const snapshot = {
    id: 'ctx1', role: 'user', content: [{ type: 'text', text: 'Current runtime context…' }],
    source: { kind: 'plugin', plugin: 'dsh-agent-loop', form: 'snapshot', sections: [] },
  }
  const decision = { kind: 'enter', messages: [user, snapshot] }
  const payload = { agent: { session: { id: 's1' } }, messages: [user], turn: 1, step: 1 }

  const result = await handler(payload, async () => decision)

  assert.equal(result.messages.length, 3, '应新增 1 条召回消息')
  // 真人消息必须**逐字段**保持原样：宿主会把 decision.messages 原样持久化
  //（dsh-agent-loop/lib/index.js:557），一旦在这里改写，前端回显、L0 回流、
  // 宿主所有 `source.kind === 'user'` 判据都会跟着变形。
  assert.deepEqual(result.messages[0], user, '真人消息必须原样保留（含 content 与 source）')

  const injected = recalledMessage(result.messages)
  assert.ok(injected, '应注入一条 plugin 消息')
  assert.equal(result.messages[1], injected, '召回块应紧跟真人消息之后')
  assert.deepEqual(result.messages[2], snapshot, '宿主 runtime-context 快照不能被改动（仍在最后）')

  // ⚠️ content 必须是**块数组**：宿主契约是 ContentBlock[]
  //（dsh-llm/lib/types/message.d.ts:126）。早先写成模板字符串，发请求时
  // dsh-llm-deepseek 的 serializeMessages 会 message.content.filter → TypeError，
  // 一开召回就整轮失败（线上事故）。这条断言是那个事故的护栏。
  assert.ok(Array.isArray(injected.content), 'content 必须是 ContentBlock[]，不能是裸字符串')
  assert.equal(injected.content[0].type, 'text', '召回块应是 text 块')
  assert.ok(injected.content[0].text.startsWith('<tdai_recalled_l1_memories>'), '召回块应以哨兵开头')
  assert.ok(injected.content[0].text.includes('remember X'), '召回内容应在')

  // source 形态：capture 靠 kind!=='user' 整条丢弃；客户端靠 form:'notice' 渲染成
  // 一行折叠的"上下文注入"（不塞进用户气泡）。
  assert.equal(injected.source.kind, 'plugin', '注入消息的 source 必须是 plugin')
  assert.equal(injected.source.plugin, 'dsh-tdai-memory-plugin')
  assert.equal(injected.source.form, 'notice', 'notice 让前端渲染成折叠的一行说明')
  assert.equal(typeof injected.source.summary, 'string')
  assert.ok(injected.source.summary.length <= 120, 'summary 必须 ≤120 字符（宿主 CONTEXT_SUMMARY_MAX_CHARS）')
  assert.ok(!injected.source.summary.includes('remember X'), 'summary 不该泄露记忆正文')

  assert.equal(typeof injected.id, 'string')
  assert.ok(injected.id.length > 0, '注入消息必须带 id（持久化边界要求）')
  assert.equal(injected.role, 'user', '注入消息走 user 角色随本轮进入')
}

// 5b) 召回块超字符预算：按分数从低到高丢弃，保证不撑爆上下文
{
  // 每条 ~850 字符：5 条合计约 4.3K，超过 4000 字符预算 → 应丢到只剩 4 条
  const big = (n) => ({ id: String(n), type: 'rule', content: 'x'.repeat(800), score: 1 - n / 10 })
  const { handler } = harness(
    { enabled: true, recallEnabled: true, injectionEnabled: false, recallLimit: 5 },
    { client: { searchL1: async () => [big(0), big(1), big(2), big(3), big(4)] } },
  )
  const user = { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }
  const payload = { agent: { session: { id: 's1' } }, messages: [user], turn: 1, step: 1 }
  const result = await handler(payload, async () => ({ kind: 'enter', messages: [user] }))
  const block = recalledMessage(result.messages).content[0].text
  assert.ok(block.length <= 4000, `召回块必须被预算压到 4000 字符以内，实际 ${block.length}`)
  // 预算函数只做"从末尾丢"，不重排：留下的是得分最高的前几条，编号仍连续
  assert.ok(block.includes('1. [rule]') && block.includes('2. [rule]'), '得分最高的前两条必须保留')
  assert.ok(!block.includes('5. [rule]'), '得分最低的那条应被丢弃')
}

// 5c) 命中里的借入来源要带上 agent 名（渲染色 self / from <name>）
{
  const { handler } = harness({ enabled: true, recallEnabled: true, injectionEnabled: false }, {
    assets: {
      warm: () => Promise.resolve(null),
      peek: () => ({
        ctxs: [
          { teamId: 't', userId: 'u', agentId: 'a', agentName: 'self-agent', isSelf: true },
          { teamId: 't', userId: 'u2', agentId: 'b', agentName: 'Helper', isSelf: false },
        ],
      }),
    },
    client: { searchL1: async (ctx) => (ctx.isSelf ? [{ id: '1', type: 'rule', content: 'mine', score: 0.9 }] : [{ id: '2', type: 'rule', content: 'theirs', score: 0.5 }]) },
  })
  const user = { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }
  const result = await handler(
    { agent: { session: { id: 's1' } }, messages: [user], turn: 1, step: 1 },
    async () => ({ kind: 'enter', messages: [user] }),
  )
  const block = recalledMessage(result.messages).content[0].text
  assert.ok(block.includes('[self score=0.900]'), '自有来源标记 self')
  assert.ok(block.includes('[from Helper score=0.500]'), '借入来源标记 from <agentName>')
}

// 5d) decision 里没有真人消息（tool 续跑步）：追加到末尾，且必须是结构完整的消息
//      —— id + source 齐全、content 是块数组，否则 dsh-session 的
//      assertMessageEventShape 会在持久化/恢复边界判它 "message has invalid content"。
{
  const { handler } = harness({ enabled: true, recallEnabled: true, injectionEnabled: false }, {
    client: { searchL1: async () => hit() },
  })
  const toolMsg = { id: 't1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'tool out' }] }], source: { kind: 'tool', callId: 'c1' } }
  const result = await handler(
    { agent: { session: { id: 's1' } }, messages: [toolMsg], turn: 1, step: 1 },
    async () => ({ kind: 'enter', messages: [toolMsg] }),
  )

  assert.equal(result.messages.length, 2, '无真人消息时追加一条')
  assert.deepEqual(result.messages[0], toolMsg, '工具结果消息不能被改动')
  const appended = result.messages[1]
  assert.equal(appended.source.kind, 'plugin')
  assert.equal(appended.source.plugin, 'dsh-tdai-memory-plugin')
  assert.equal(appended.source.form, 'notice')
  assert.ok(Array.isArray(appended.content) && appended.content[0].type === 'text', 'content 必须是块数组')
  assert.ok(appended.content[0].text.startsWith('<tdai_recalled_l1_memories>'))
}

// 5e) decision.messages 为空：**绝不能**注入
//     宿主靠 `decision.messages.length === 0` 判定轮次结束
//     （dsh-agent-loop/lib/index.js:551 `if (turnEnds && decision.messages.length === 0) break`）。
//     在这里塞一条消息进去 = 轮次永远不结束（每一步都再来一次模型请求）。
{
  const { handler } = harness({ enabled: true, recallEnabled: true, injectionEnabled: false }, {
    client: { searchL1: async () => hit() },
  })
  const empty = { kind: 'enter', messages: [] }
  const result = await handler(
    { agent: { session: { id: 's1' } }, messages: [{ role: 'user', content: 'hi' }], turn: 1, step: 1 },
    async () => empty,
  )
  assert.deepEqual(result, empty, '空 messages 时必须原样返回，否则轮次无法结束')
}

// ── C. 不许卡住主链路 ────────────────────────────────────────────────────────

// 6) 资产没就绪（缓存为空）：**不等待**，先用自有 agent 检索并注入，同时后台预热
{
  const callsFallback = { warm: 0, ctxs: [] }
  const { handler } = harness({ enabled: true, recallEnabled: true, injectionEnabled: false }, {
    assets: {
      warm: () => { callsFallback.warm += 1; return new Promise(() => {}) }, // 永不落定：等它就等于卡死
      peek: () => undefined, // 缓存为空
    },
    client: {
      searchL1: async (ctx) => {
        callsFallback.ctxs.push(ctx.agentId)
        return hit()
      },
    },
  })
  const user = { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }
  const result = await Promise.race([
    handler({ agent: { session: { id: 's1' } }, messages: [user], turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [user] })),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('pre-step 被资产加载挡住了')), 500)
      timer.unref?.()
    }),
  ])
  assert.equal(callsFallback.warm, 1, '应发起后台预热')
  assert.deepEqual(callsFallback.ctxs, ['a'], '缓存为空时退回自有 agent 检索（配置里的 agentId）')
  assert.ok(recalledMessage(result.messages), '即使资产没就绪也要完成本轮召回')
}

// 7) 本轮已被 abort：不检索、不注入
{
  const { handler } = harness({ enabled: true, recallEnabled: true, injectionEnabled: false }, {
    client: { searchL1: async () => { throw new Error('不该被调用') } },
  })
  const user = { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }
  const decision = { kind: 'enter', messages: [user] }
  const controller = new AbortController()
  controller.abort()
  const result = await handler(
    { agent: { session: { id: 's1' } }, messages: [user], turn: 1, step: 1, signal: controller.signal },
    async () => decision,
  )
  assert.deepEqual(result, decision, 'abort 后应原样返回')
}

// 8) 检索抛异常：fail-open，原样返回 decision（不向链上抛）
{
  const { handler } = harness({ enabled: true, recallEnabled: true, injectionEnabled: false }, {
    client: { searchL1: async () => { throw new Error('gateway down') } },
  })
  const user = { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }
  const decision = { kind: 'enter', messages: [user] }
  const result = await handler(
    { agent: { session: { id: 's1' } }, messages: [user], turn: 1, step: 1 },
    async () => decision,
  )
  assert.deepEqual(result, decision, '检索失败应 fail-open')
}

// 9) 内层 next() 抛异常：作为最外层守卫应兜住，返回合法 enter 而非向链上抛
{
  const { handler } = harness({ enabled: true, recallEnabled: true, injectionEnabled: false })
  const payload = { agent: { session: { id: 's1' } }, messages: [{ role: 'user', content: 'hi' }], turn: 1, step: 1 }
  let threw = null
  let result = null
  try { result = await handler(payload, async () => { throw new Error('inner boom') }) } catch (error) { threw = error }
  assert.equal(threw, null, '内层异常不应向链上抛')
  assert.ok(result && result.kind === 'enter', '兜底为 enter')
  assert.ok(Array.isArray(result.messages), '兜底含 messages')
}

// 10) 内层返回带 enter 但缺 messages：补齐 messages，避免下游 .messages 崩
{
  const { handler } = harness({ enabled: true, recallEnabled: true, injectionEnabled: false })
  const payload = { agent: { session: { id: 's1' } }, messages: [{ role: 'user', content: 'hi' }], turn: 1, step: 1 }
  const result = await handler(payload, async () => ({ kind: 'enter' }))
  assert.ok(result && result.kind === 'enter', '保持 enter')
  assert.ok(Array.isArray(result.messages) && result.messages.length === 1, '缺 messages 时应补齐')
}

console.log('recall tests passed: 防御兜底 / 独立 inject 消息 / 真人消息零改动 / 不阻塞主链路')
