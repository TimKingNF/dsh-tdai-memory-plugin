/**
 * 回流过滤测试（写侧护栏）。
 *
 * 为什么必须有这个测试：注入过滤一旦失效，失效的方向是**把插件注入的内容当成
 * 用户真实发言写进长期记忆**（L0 → 后台抽取 L1/L2/L3）。这种污染是永久的，
 * 事后很难清理。而过滤依赖的两条判据都会随改造漂移：
 *   - `source` 判据依赖宿主给消息打的元数据；
 *   - 文本哨兵依赖注入块的渲染文案。
 * 所以两条都必须有测试锁住。
 *
 * 依据：docs/prompt-injection-redesign.md §6.3 与 §0.1（prepend 语义带来的冲突）。
 * 运行：node test/capture-filter.test.mjs
 */
import assert from 'node:assert'
import { wireCapture } from '../lib/capture.mjs'

// ── 假宿主：收集 session/event handler，并提供 turn-stopping 触发 ──────────────
function harness() {
  const handlers = {}
  const written = []        // 回流到 L0 的消息（/v3/conversation/add）
  const archived = []       // Skill 归档用的消息（/v3/skill/conversation/add）
  const ctx = {
    on(ev, cb) { (handlers[ev] ||= []).push(cb) },
  }
  const runtime = {
    config: { captureEnabled: true },
    identityFor: () => ({ session_id: 's1', team_id: 't', agent_id: 'a', user_id: 'u' }),
    client: {
      async addConversation(_identity, messages) { written.push(...messages) },
      async addSkillConversation(_identity, messages) { archived.push(...messages) },
    },
    log: () => {},
    readEnabled: () => true,
    assets: { ensure: async () => null, peek: () => undefined },
  }
  wireCapture(ctx, runtime)

  const emit = (type, data, seq = 1) => {
    for (const cb of handlers['session/event'] || []) cb({ id: 's1' }, { type, seq, data })
  }
  const stopTurn = async (turn = 1) => {
    for (const cb of handlers['agent/turn-stopping'] || []) {
      await cb({ turn, agent: { session: { id: 's1' } } })
    }
  }
  return { ctx, runtime, emit, stopTurn, written, archived }
}

/**
 * 造一条**与真实会话日志同形**的 user/message 事件。
 * 真实结构：{ type:'user/message', seq, data:{ message:{ role, content, source, id }, surfaceOp } }
 * 见 ~/.dsh/sessions/<session-id>/session.jsonl.zstd 里的实测记录。
 */
const userEvent = (text, source) => {
  const message = { role: 'user', content: [{ type: 'text', text }], id: 'msg-1' }
  if (source !== undefined) message.source = source
  return { message, surfaceOp: 'append' }
}
/** 真实结构：{ type:'assistant/message', data:{ turn, step, message:{ role, content, source } } } */
const assistantEvent = (text) => ({
  turn: 1,
  step: 1,
  message: { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } },
})

// ── 1) 真人消息：必须回流 ────────────────────────────────────────────────────
{
  const h = harness()
  h.emit('turn/start', { turn: 1 })
  h.emit('user/message', userEvent('我叫什么？', {
    kind: 'user', rpcId: 'r1', clientTimeZone: 'Asia/Hong_Kong',
  }))
  h.emit('assistant/message', assistantEvent('你是……'))
  await h.stopTurn(1)
  const roles = h.written.map((m) => m.role)
  assert.deepEqual(roles, ['user', 'assistant'], `真人与模型消息都应回流，实际：${JSON.stringify(roles)}`)
  assert.equal(h.written[0].content, '我叫什么？')
}

// ── 2) 宿主/插件注入的消息：一条都不能回流 ───────────────────────────────────
{
  const h = harness()
  h.emit('turn/start', { turn: 1 })
  // 宿主 runtime context 快照
  h.emit('user/message', userEvent('Current runtime context. … Approval policy: ask.', {
    kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot',
  }))
  // 宿主 skill 目录
  h.emit('user/message', userEvent('<system-reminder>A skill is …</system-reminder>', {
    kind: 'skill-catalog', form: 'catalog', entries: [],
  }))
  // 本插件注入的独立消息
  h.emit('user/message', userEvent('<tdai_profile_memory>…</tdai_profile_memory>', {
    kind: 'plugin', plugin: 'dsh-tdai-memory-plugin', form: 'snapshot',
  }))
  // 真人消息
  h.emit('user/message', userEvent('真正的用户输入', { kind: 'user', rpcId: 'r2' }))
  await h.stopTurn(1)
  assert.equal(h.written.length, 1, `只有真人消息该回流，实际回流了 ${h.written.length} 条`)
  assert.equal(h.written[0].content, '真正的用户输入')
}

// ── 3) prepend 形态：召回块混进真人消息里，只剥块、**保留真人正文** ─────────
// 这是 L1 召回改成 prepend 语义之后的真实形态（§5.3 / 阶段 4）：
// 那条消息的 source 是 { kind: 'user' }，结构判据认不出注入部分，只能按块剥离。
// 早期实现是整条丢弃，会把用户真实说的话一起丢掉 —— 这条断言就是那个回归的护栏。
{
  const h = harness()
  h.emit('turn/start', { turn: 1 })
  const mixed = [
    '<tdai_recalled_l1_memories>',
    '1. [rule] [self score=0.900] 用户偏好 Go',
    '</tdai_recalled_l1_memories>',
    '',
    '我上次说的那个偏好是什么？',
  ].join('\n')
  h.emit('user/message', userEvent(mixed, { kind: 'user', rpcId: 'r3' }))
  await h.stopTurn(1)
  assert.equal(h.written.length, 1, '剥掉召回块后正文仍在，消息应被回流')
  assert.equal(h.written[0].content, '我上次说的那个偏好是什么？',
    '回流内容必须只剩真人正文，召回块不能进 L0')
}

// ── 3b) 只有注入块、没有正文：整条丢弃（不产生空消息）──────────────────────
{
  const h = harness()
  h.emit('turn/start', { turn: 1 })
  h.emit('user/message', userEvent(
    '<tdai_recalled_l1_memories>\n1. [rule] x\n</tdai_recalled_l1_memories>',
    { kind: 'user', rpcId: 'r3b' },
  ))
  await h.stopTurn(1)
  assert.equal(h.written.length, 0, '剥完为空的消息不应回流')
}

// ── 4) 召回块作为**独立** user 消息（当前实现）：必须被丢弃 ──────────────────
{
  const h = harness()
  h.emit('turn/start', { turn: 1 })
  h.emit('user/message', userEvent('<tdai_recalled_l1_memories>\n1. [rule] [self] x\n</tdai_recalled_l1_memories>', {
    kind: 'plugin', plugin: 'dsh-tdai-memory-plugin',
  }))
  h.emit('user/message', userEvent('正常问题', { kind: 'user', rpcId: 'r4' }))
  await h.stopTurn(1)
  assert.deepEqual(h.written.map((m) => m.content), ['正常问题'])
}

// ── 5) 无 source 元数据（外部写入/老格式）：保守地用哨兵判 ───────────────────
{
  const h = harness()
  h.emit('turn/start', { turn: 1 })
  h.emit('user/message', userEvent('没有 source 的正常消息'))
  h.emit('user/message', userEvent('[TencentDB historical context] 旧格式注入'))
  await h.stopTurn(1)
  assert.deepEqual(h.written.map((m) => m.content), ['没有 source 的正常消息'])
}

// ── 6) 兜底判据的覆盖面：INJECTED_MARKERS 里的每个标记都必须真能被剥掉 ────────
//
// lib/capture.mjs 导出 INJECTED_MARKERS 是为了**文档化**"本插件会往对话里放哪些块"，
// 真正干活的剥离逻辑在 lib/text.mjs 的 stripInjectedBlocks。两者一旦脱节，
// 表现就是"清单上写了这个块、实际上剥不掉"——注入内容照样进 L0。
// 所以这里反向断言：清单里的每个标记，剥完都不该留下痕迹。
{
  const { INJECTED_MARKERS } = await import('../lib/capture.mjs')
  const { stripInjectedBlocks } = await import('../lib/text.mjs')
  assert.ok(INJECTED_MARKERS.length > 0, 'INJECTED_MARKERS 不应为空')
  for (const marker of INJECTED_MARKERS) {
    const block = marker.startsWith('<')
      ? `${marker}注入的内容${marker.replace('<', '</')}`
      : `${marker}（旧格式前缀标记）`
    const stripped = stripInjectedBlocks(`用户的问题\n${block}\n用户补充的一句`)
    assert.ok(!stripped.includes(marker), `INJECTED_MARKERS 里的 ${marker} 没有被剥掉`)
    assert.ok(stripped.startsWith('用户的问题'), `${marker} 之前的正文应保留`)
  }
}

console.log('capture filter tests passed: source 主判据 / 按块剥离 / 缺 source 降级 / 模型消息保留 / 标记清单全覆盖')
