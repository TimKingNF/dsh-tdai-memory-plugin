/**
 * ds-bot 写侧夹具（方案 minimal.agents.md §4.2 的 1–12、15、16、18 号）。
 *
 * 为什么每个用例都要断言"写了几条 / role / 前缀 / 台账怎么变"：写侧的错误都是**沉默**的 ——
 * 多写一条是永久污染，少写一条是记忆静默缺失，两者都不报错。夹具是唯一能钉住的地方。
 *
 * 运行：node test/dsbot-capture.test.mjs
 */
import assert from 'node:assert'
import { mkdtemp, mkdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wireCapture } from '../lib/capture.mjs'
import { DsbotIndex } from '../lib/dsbot.mjs'
import { DsbotLedger } from '../lib/dsbot-ledger.mjs'

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const BASE = {
  enabled: true,
  captureEnabled: true,
  skillsEnabled: true,
  knowledgeEnabled: true,
  dsbotAwarenessEnabled: true,
  botSkillInjectEnabled: true,
  botWritebackEnabled: true,
  botContextDistillEnabled: true,
  botContextMessages: 5,
  botContextReuseMemory: false,
  subagentInjectionEnabled: false,
  subagentCaptureEnabled: false,
}

const BOT = { 'session-b1': { id: 'session-b1', name: 'ARK', model: 'opencode-go/deepseek-v4.1-flash' } }

async function makeHome({ bots = BOT, rooms = {} } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsbot-cap-'))
  await mkdir(join(home, 'bot'), { recursive: true })
  await writeState(home, { bots, rooms })
  return home
}

async function writeState(home, { bots = BOT, rooms = {} }) {
  await writeFile(join(home, 'bot', 'state.json'), JSON.stringify({ version: 1, bots, rooms }), 'utf8')
}

/** 与 capture 的接线同形的 harness（ctx.on / runtime 的全部依赖）。 */
async function harness({ home, config = {}, llm } = {}) {
  const logs = []
  const written = []
  const skills = []
  let skillCalls = 0
  const ledger = new DsbotLedger({ dshHome: home, log: (message) => logs.push(message) })
  await ledger.load()
  const index = new DsbotIndex({ dshHome: home, ledger, log: (message) => logs.push(message) })
  await index.refresh()
  const runtime = {
    config: { ...BASE, ...config },
    ledger,
    dsbot: index,
    log: (message) => logs.push(message),
    identityFor: (session) => (session?.id ? { session_id: session.id, team_id: 't', agent_id: 'a', user_id: 'u' } : undefined),
    client: {
      async addConversation(identity, messages) {
        for (const message of messages) written.push({ ...message, session_id: identity.session_id })
      },
      async addSkillConversation(_identity, messages) {
        skillCalls += 1
        skills.push(...messages)
      },
    },
    llm: () => llm,
  }
  const handlers = {}
  const ctx = { on: (event, callback) => { (handlers[event] ||= []).push(callback) } }
  wireCapture(ctx, runtime)
  await new Promise((resolve) => setTimeout(resolve, 0))

  const emit = (session, event) => {
    for (const cb of handlers['session/event'] || []) cb(session, event)
  }
  const stop = async (session, turn) => {
    for (const cb of handlers['agent/turn-stopping'] || []) await cb({ turn, agent: { session } })
  }
  const fail = async (session, turn, message = 'boom') => {
    for (const cb of handlers['agent/error'] || []) {
      await cb({ turn, step: 0, agent: { session }, error: new Error(message) })
    }
  }
  return { home, runtime, ledger, index, written, skills, skillCalls: () => skillCalls, logs, emit, stop, fail }
}

// ── 事件夹具（与真实会话日志同形）──────────────────────────────────────────
const turnStart = (turn) => ({ type: 'turn/start', data: { turn } })
const turnEnd = (turn, kind = 'completed') => ({ type: 'turn/end', data: { turn, reason: { kind } } })
const stepStart = (turn, step) => ({ type: 'step/start', data: { turn, step } })
let msgSeq = 0
const userMsg = (text, { kind = 'user', time = 1_000, id, ...rest } = {}) => {
  msgSeq += 1
  return {
    type: 'user/message',
    time,
    data: {
      message: { role: 'user', content: [{ type: 'text', text }], source: { kind }, id: id ?? `m-${msgSeq}` },
      ...rest,
    },
  }
}
const assistantMsg = (turn, step, text, time = 1_000) => ({
  type: 'assistant/message',
  time,
  data: {
    turn,
    step,
    message: {
      role: 'assistant',
      content: text ? [{ type: 'text', text }] : [{ type: 'tool-call', name: 'group_relay', id: 'c1', arguments: '{}' }],
      source: { kind: 'model' },
      id: `a-${turn}-${step}`,
    },
  },
})

/** 假 llm：`resolveModelInfo` 是方法、`stream` 返回 AsyncIterable。 */
function fakeLlm(chunks = ['- ARK 合并了分支', '\n结论：已收口']) {
  return {
    async resolveModelInfo() {
      return { reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } }
    },
    stream() {
      return (async function* stream() {
        for (const text of chunks) yield { type: 'text-delta', index: 0, text }
      })()
    },
  }
}
const emptyLlm = {
  async resolveModelInfo() { return { reasoning: { efforts: [] } } },
  stream() {
    return (async function* stream() {})()
  },
}

const room = (log, extra = {}) => ({
  id: 'session-r1',
  name: '测试群',
  admin: 'session-b1',
  members: ['session-b1'],
  seq: log.reduce((max, line) => Math.max(max, line.seq ?? 0), 0),
  sessions: {},
  log,
  ...extra,
})

// ── 1) DM 正常轮：2 条（user → assistant），都带 ISO timestamp ───────────────
{
  const home = await makeHome()
  const h = await harness({ home, llm: fakeLlm() })
  const session = { id: 'session-b1' }
  h.emit(session, turnStart(1))
  h.emit(session, stepStart(1, 1))
  h.emit(session, userMsg('帮我看下今天的日志', { time: 1000 }))
  h.emit(session, stepStart(1, 2))
  h.emit(session, assistantMsg(1, 2, '看完了：是磁盘写满，已经清掉。', 2000))
  await h.stop(session, 1)
  h.emit(session, turnEnd(1))

  assert.equal(h.written.length, 2, 'DM 正常轮写 2 条')
  assert.equal(h.written[0].role, 'user', '第一条是真人')
  assert.equal(h.written[0].content, '帮我看下今天的日志', '人话原样')
  assert.equal(h.written[1].role, 'assistant', '第二条是终稿')
  assert.match(h.written[1].content, /磁盘写满/, '终稿取最高 step 的 text')
  assert.match(h.written[0].timestamp, ISO, 'timestamp 是 ISO 字符串（Core schema 要求）')
  assert.match(h.written[1].timestamp, ISO, '终稿也带 timestamp')
  assert.equal(h.written[0].session_id, 'session-b1', 'session_id = Bot 会话 id')
  assert.equal(h.skillCalls(), 0, 'Bot 会话不调 skill 归档端点')
}

// ── 2) DM 纯 relay 轮：0 条 ─────────────────────────────────────────────────
{
  const home = await makeHome()
  const h = await harness({ home, llm: fakeLlm() })
  const session = { id: 'session-b1' }
  h.emit(session, turnStart(1))
  h.emit(session, userMsg('[Group post from PM] 你把 X 做一下', { kind: 'bot' }))
  h.emit(session, assistantMsg(1, 1, '收到'))
  await h.stop(session, 1)
  h.emit(session, turnEnd(1))
  assert.equal(h.written.length, 0, 'relay 驱动的轮次一条不写')
}

// ── 3) DM 收尾步无 text：1 条（仅人话）──────────────────────────────────────
{
  const home = await makeHome()
  const h = await harness({ home, llm: fakeLlm() })
  const session = { id: 'session-b1' }
  h.emit(session, turnStart(1))
  h.emit(session, stepStart(1, 1))
  h.emit(session, userMsg('继续'))
  h.emit(session, stepStart(1, 2))
  h.emit(session, assistantMsg(1, 2, '')) // 收尾步只有工具调用
  await h.stop(session, 1)
  h.emit(session, turnEnd(1))
  assert.equal(h.written.length, 1, '收尾步无 text → 只写人话')
  assert.equal(h.written[0].role, 'user')
}

// ── 4) 群聊轮末即命中：2 条（assistant 摘要 → user 人话）────────────────────
{
  const log = [
    { who: 'Dev', botId: 'session-b1', text: '开始改 client.mjs', seq: 1 },
    { who: 'User', text: '先暂停一下', seq: 2 },
  ]
  const home = await makeHome({ rooms: { 'session-r1': room(log) } })
  const h = await harness({ home, llm: fakeLlm() })
  const session = { id: 'session-r1' }
  h.emit(session, turnStart(1))
  h.emit(session, userMsg('先暂停一下', { time: 1500 }))
  await h.stop(session, 1)
  h.emit(session, turnEnd(1))

  assert.equal(h.written.length, 2, '摘要 + 人话')
  assert.equal(h.written[0].role, 'assistant', '摘要以 assistant 写入')
  assert.match(h.written[0].content, /^\[群聊「测试群」· 前文 seq 1–1\]/, '摘要固定前缀')
  assert.match(h.written[0].content, /结论：已收口/, '摘要带结论行')
  assert.equal(h.written[1].role, 'user', '人话在后')
  assert.equal(h.written[1].content, '先暂停一下')
  assert.equal(h.ledger.room('session-r1').lastHuman.seq, 2, '断点推进到锚点 seq')
  assert.equal(h.ledger.room('session-r1').pending, undefined, '命中后清掉 pending')
  await h.ledger.flush()
}

// ── 5) 群聊晚一轮命中：首轮 0 条 + pending；次轮 2 条 ────────────────────────
{
  const log = [{ who: 'Dev', botId: 'session-b1', text: '先做 A', seq: 1 }]
  const home = await makeHome({ rooms: { 'session-r1': room(log) } })
  const h = await harness({ home, llm: fakeLlm() })
  const session = { id: 'session-r1' }

  h.emit(session, turnStart(1))
  h.emit(session, userMsg('继续做完', { time: 1600 }))
  await h.stop(session, 1)
  h.emit(session, turnEnd(1))
  assert.equal(h.written.length, 0, '锚点还没进 log → 本轮 0 条')
  assert.equal(h.ledger.room('session-r1').pending.attempts, 1, '挂 pending（attempts=1）')
  assert.equal(h.ledger.room('session-r1').pending.text, '继续做完', 'pending 存原文')

  // 约 20 秒后 ds-bot 把这条写进 log。
  await writeState(home, {
    rooms: { 'session-r1': room([...log, { who: 'User', text: '继续做完', seq: 2 }]) },
  })
  await h.stop(session, 2)
  assert.equal(h.written.length, 2, '次轮重试命中 → 写 2 条')
  assert.equal(h.written[0].role, 'assistant')
  assert.equal(h.written[1].role, 'user')
  assert.equal(h.ledger.room('session-r1').lastHuman.seq, 2, '断点推进到 2')
  assert.equal(h.ledger.room('session-r1').pending, undefined, 'pending 清零')
}

// ── 6) 群聊永不命中：1 条 + typed skip + 断点推进到日志末尾 ─────────────────
{
  const log = [{ who: 'Dev', botId: 'session-b1', text: '收尾', seq: 7 }]
  const home = await makeHome({ rooms: { 'session-r1': room(log) } })
  const h = await harness({ home, llm: fakeLlm() })
  const session = { id: 'session-r1' }
  h.emit(session, turnStart(1))
  h.emit(session, userMsg('这条永远不会进 log', { time: 1700 }))
  await h.stop(session, 1)
  h.emit(session, turnEnd(1))
  assert.equal(h.written.length, 0, '第一次未命中不写')
  for (const turn of [2, 3, 4]) await h.stop(session, turn)

  assert.equal(h.written.length, 1, '超限后只写人话')
  assert.equal(h.written[0].role, 'user')
  assert.equal(h.written[0].content, '这条永远不会进 log')
  assert.equal(h.ledger.room('session-r1').skip.reason, 'anchor-timeout', 'typed skip 记录原因')
  assert.equal(h.ledger.room('session-r1').lastHuman.seq, 7, '断点推进到日志末尾')
  assert.equal(h.ledger.room('session-r1').pending, undefined, 'pending 清掉')
}

// ── 7/8) 台账坏 JSON / 版本不符：0 条 + 告警含路径与错误原文 ────────────────
{
  for (const [label, raw, pattern] of [
    ['坏 JSON', '{"version":1,"rooms":{', /解析失败/],
    ['版本不符', JSON.stringify({ version: 2, rooms: {}, direct: {} }), /版本不匹配/],
  ]) {
    const home = await makeHome()
    const dir = join(home, 'storages', 'tdai-memory-plugin')
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'dsbot-state.json')
    await writeFile(path, raw, 'utf8')

    const h = await harness({ home, llm: fakeLlm() })
    const session = { id: 'session-b1' }
    h.emit(session, turnStart(1))
    h.emit(session, userMsg('你好'))
    h.emit(session, assistantMsg(1, 1, '你好'))
    await h.stop(session, 1)
    h.emit(session, turnEnd(1))

    assert.equal(h.written.length, 0, `${label}：停写，0 条`)
    const text = h.logs.join('\n')
    assert.match(text, pattern, `${label}：告警点名原因`)
    assert.ok(text.includes(path), `${label}：告警点名台账路径`)
  }
}

// ── 9) 崩溃恢复：摘要已写、人话未写 → 只补人话，摘要不重复 ──────────────────
{
  const log = [
    { who: 'Dev', botId: 'session-b1', text: '完成 A', seq: 1 },
    { who: 'User', text: '先暂停一下', seq: 2 },
  ]
  const home = await makeHome({ rooms: { 'session-r1': room(log) } })
  const h = await harness({ home, llm: fakeLlm() })
  // 模拟上一次写到一半崩溃：stage 留着，summary 已写。
  h.ledger.patchRoom('session-r1', {
    stage: { summary: 'written', human: 'pending', anchor: { text: '先暂停一下', time: 1000 }, seq: 2 },
  })
  await h.ledger.flush()

  const session = { id: 'session-r1' }
  await h.stop(session, 1)
  assert.equal(h.written.length, 1, '只补人话 1 条')
  assert.equal(h.written[0].role, 'user', '补的是 user，不重复写摘要')
  assert.equal(h.written[0].content, '先暂停一下')
  assert.equal(h.ledger.room('session-r1').stage, undefined, 'stage 清空')
  assert.equal(h.ledger.room('session-r1').lastHuman.seq, 2, '断点推进')
}

// ── 10) 重复投递同一 messageId：仍为 2 条 ───────────────────────────────────
{
  const home = await makeHome()
  const h = await harness({ home, llm: fakeLlm() })
  const session = { id: 'session-b1' }
  const replay = async () => {
    h.emit(session, turnStart(1))
    h.emit(session, stepStart(1, 1))
    h.emit(session, userMsg('重复的一条', { id: 'dup-1' }))
    h.emit(session, assistantMsg(1, 1, '回复'))
    await h.stop(session, 1)
    h.emit(session, turnEnd(1))
  }
  await replay()
  assert.equal(h.written.length, 2, '首次写 2 条')
  await replay()
  assert.equal(h.written.length, 2, '重复投递后仍是 2 条（幂等位生效）')
}

// ── 11) 一轮多锚点：私聊 N 条 user + 1 条终稿；群聊每锚点各 2 条 ────────────
{
  const home = await makeHome()
  const h = await harness({ home, llm: fakeLlm() })
  const session = { id: 'session-b1' }
  h.emit(session, turnStart(1))
  h.emit(session, stepStart(1, 1))
  h.emit(session, userMsg('第一句', { time: 1000 }))
  h.emit(session, userMsg('第二句', { time: 1100 }))
  h.emit(session, stepStart(1, 2))
  h.emit(session, assistantMsg(1, 2, '结论', 1200))
  await h.stop(session, 1)
  h.emit(session, turnEnd(1))
  assert.equal(h.written.length, 3, '2 条 user + 1 条终稿')
  assert.deepEqual(h.written.map((item) => item.role), ['user', 'user', 'assistant'])
}
// ── 11b) 私聊终稿里的 dsh-ui 卡片必须剥掉（只留正文 + 标记）──────────────
{
  const home = await makeHome()
  const h = await harness({ home, llm: fakeLlm() })
  const session = { id: 'session-b1' }
  const answer = [
    '先说结论。',
    '',
    '```dsh-ui',
    '{"title":"流程","items":[{"type":"steps","steps":[{"title":"① 拆要素"}]}]}',
    '```',
    '',
    '细节在后。',
  ].join('\n')
  h.emit(session, turnStart(1))
  h.emit(session, stepStart(1, 1))
  h.emit(session, userMsg('你怎么建 bot 的', { time: 1000 }))
  h.emit(session, stepStart(1, 2))
  h.emit(session, assistantMsg(1, 2, answer, 1200))
  await h.stop(session, 1)
  h.emit(session, turnEnd(1))
  const assistant = h.written.find((item) => item.role === 'assistant')
  assert.ok(assistant, '终稿仍然写入')
  assert.equal(assistant.content.includes('"type":"steps"'), false, 'UI spec 的 JSON 不进 L0')
  assert.ok(assistant.content.includes('[结构化卡片]'), '留一行标记')
  assert.ok(assistant.content.includes('先说结论。') && assistant.content.includes('细节在后。'), '正文保留')
}

{
  const log = [
    { who: 'Dev', botId: 'session-b1', text: 'A 做完了', seq: 1 },
    { who: 'User', text: '第一个问题', seq: 2 },
    { who: 'Dev', botId: 'session-b1', text: '回答一', seq: 3 },
    { who: 'User', text: '第二个问题', seq: 4 },
  ]
  const home = await makeHome({ rooms: { 'session-r1': room(log) } })
  const h = await harness({ home, llm: fakeLlm() })
  const session = { id: 'session-r1' }
  h.emit(session, turnStart(1))
  h.emit(session, userMsg('第一个问题', { time: 1000 }))
  h.emit(session, userMsg('第二个问题', { time: 2000 }))
  await h.stop(session, 1)
  h.emit(session, turnEnd(1))
  assert.equal(h.written.length, 4, '每锚点各写摘要 + 人话')
  assert.deepEqual(h.written.map((item) => item.role), ['assistant', 'user', 'assistant', 'user'])
  assert.equal(h.ledger.room('session-r1').lastHuman.seq, 4, '断点推进到最后一个锚点')
}

// ── 12) state.json 不可读 + 台账有索引：lean + 停写 + 告警 ──────────────────
{
  const home = await makeHome()
  // 第一进程：正常读一次，把索引落进台账。
  const preLedger = new DsbotLedger({ dshHome: home, log: () => {} })
  await preLedger.load()
  const preIndex = new DsbotIndex({ dshHome: home, ledger: preLedger, log: () => {} })
  await preIndex.refresh()
  await preLedger.flush()
  // 把 state.json 写坏，模拟半写/损坏。
  await writeFile(join(home, 'bot', 'state.json'), '{broken', 'utf8')

  // 第二进程：索引只能来自台账（stale），写侧必须停写。
  const h = await harness({ home, llm: fakeLlm() })

  const session = { id: 'session-b1' }
  h.emit(session, turnStart(1))
  h.emit(session, userMsg('这条不该被写'))
  h.emit(session, assistantMsg(1, 1, '回复'))
  await h.stop(session, 1)
  h.emit(session, turnEnd(1))

  assert.equal(h.written.length, 0, 'state.json 不可读 → 写侧停写')
  assert.match(h.logs.join('\n'), /解析失败/, '告警点名原因')
}

// ── 15) 环覆盖：断点滑出 → checkpoint-lost + 窗口从 log[0] 起 ───────────────
{
  const lines = []
  for (let seq = 32; seq <= 91; seq += 1) {
    if (seq === 91) {
      lines.push({ who: 'User', text: '最新的一条', seq })
    } else {
      lines.push({ who: 'Dev', botId: 'session-b1', text: `第 ${seq} 行`, seq })
    }
  }
  const home = await makeHome({ rooms: { 'session-r1': room(lines) } })
  const h = await harness({ home, llm: fakeLlm() })
  h.ledger.patchRoom('session-r1', { lastHuman: { seq: 5, hash: '' } }) // 已滑出环
  await h.ledger.flush()

  const session = { id: 'session-r1' }
  h.emit(session, turnStart(1))
  h.emit(session, userMsg('最新的一条', { time: 3000 }))
  await h.stop(session, 1)
  h.emit(session, turnEnd(1))

  assert.match(h.logs.join('\n'), /checkpoint-lost/, '断点滑出要告警')
  assert.equal(h.written.length, 2, '仍能写出摘要 + 人话')
  assert.match(h.written[0].content, /seq 86–90/, '窗口取锚点前最后 5 行（seq 86–90）')
  assert.equal(h.ledger.room('session-r1').lastHuman.seq, 91, '断点推进到 91')
}

// ── 16) 蒸馏失败：1 条人话 + typed skip，不写任何兜底原文 ───────────────────
{
  const log = [
    { who: 'Dev', botId: 'session-b1', text: '讨论了一半', seq: 1 },
    { who: 'User', text: '先停一下', seq: 2 },
  ]
  const home = await makeHome({ rooms: { 'session-r1': room(log) } })
  const h = await harness({ home, llm: emptyLlm })
  const session = { id: 'session-r1' }
  h.emit(session, turnStart(1))
  h.emit(session, userMsg('先停一下', { time: 1000 }))
  await h.stop(session, 1)
  h.emit(session, turnEnd(1))

  assert.equal(h.written.length, 1, '只写人话')
  assert.equal(h.written[0].role, 'user')
  assert.ok(!h.written.some((item) => item.role === 'assistant'), '不写任何兜底原文')
  assert.match(h.ledger.room('session-r1').skip.reason, /^distill-/, 'typed skip 记 distill-failed')
}

// ── 18) 回写开关：总闸/子开关/全局 capture 三重 AND ─────────────────────────
{
  const mk = async (config) => {
    const home = await makeHome()
    const h = await harness({ home, config, llm: fakeLlm() })
    const session = { id: 'session-b1' }
    h.emit(session, turnStart(1))
    h.emit(session, userMsg('你好'))
    h.emit(session, assistantMsg(1, 1, '你好'))
    await h.stop(session, 1)
    h.emit(session, turnEnd(1))
    return h
  }
  assert.equal((await mk({ botWritebackEnabled: false })).written.length, 0, '回写默认关 → 0 条')
  assert.equal(
    (await mk({ botWritebackEnabled: true, captureEnabled: false })).written.length,
    0,
    '全局 capture 关 → 子开关无效',
  )
  assert.equal(
    (await mk({ botWritebackEnabled: true, captureEnabled: true })).written.length,
    2,
    '两个都开 → 2 条',
  )
  assert.equal(
    (await mk({ dsbotAwarenessEnabled: false })).written.length,
    2,
    '总闸关 → 回到普通会话全量回流（2 条，走原逻辑）',
  )
}

// ── 失败轮：只写人话 ────────────────────────────────────────────────────────
{
  const home = await makeHome()
  const h = await harness({ home, llm: fakeLlm() })
  const session = { id: 'session-b1' }
  h.emit(session, turnStart(1))
  h.emit(session, stepStart(1, 1))
  h.emit(session, userMsg('做一半就挂了', { time: 1000 }))
  h.emit(session, assistantMsg(1, 1, '我先看一下……', 1100))
  h.emit(session, turnEnd(1, 'aborted'))
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(h.written.length, 1, '失败轮只写人话')
  assert.equal(h.written[0].role, 'user')
  assert.equal(h.written[0].content, '做一半就挂了')
}
{
  // agent/error 同一条路径（LlmError 不经过 turn-stopping）。
  const home = await makeHome()
  const h = await harness({ home, llm: fakeLlm() })
  const session = { id: 'session-b1' }
  h.emit(session, turnStart(1))
  h.emit(session, userMsg('也做一半就挂了'))
  h.emit(session, assistantMsg(1, 1, '不该写'))
  await h.fail(session, 1, 'LLM 400')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(h.written.length, 1, 'agent/error 也只写人话')
  assert.equal(h.written[0].role, 'user')
}

// ── 群成员隐藏会话：永不写 ──────────────────────────────────────────────────
{
  const log = [{ who: 'User', text: 'hi', seq: 1 }]
  const home = await makeHome({
    rooms: { 'session-r1': room(log, { sessions: { 'session-b1': 'session-r1-m1' } }) },
  })
  const h = await harness({ home, llm: fakeLlm() })
  const session = { id: 'session-r1-m1' }
  h.emit(session, turnStart(1))
  h.emit(session, userMsg('hi'))
  h.emit(session, assistantMsg(1, 1, '成员会话的产出'))
  await h.stop(session, 1)
  h.emit(session, turnEnd(1))
  assert.equal(h.written.length, 0, '群成员隐藏会话永不写')
}

// ── 索引里已消失的 Bot 会话：停写 + 告警（signal）────────────────────────────
{
  const home = await makeHome({
    bots: { 'session-b1': { id: 'session-b1', name: 'ARK', model: 'p/m', sessionId: 'session-b1-live' } },
  })
  const h = await harness({ home, llm: fakeLlm() })
  await h.ledger.flush()
  // Bot 换了会话，旧会话 id 不再出现在 state.json 里（也没有 segments 兜底）。
  await writeState(home, { bots: { 'session-b1': { id: 'session-b1', name: 'ARK', model: 'p/m', sessionId: 'session-b1-new' } } })
  // 模拟"5 秒 mtime 缓存过期后的下一次刷新"：此刻旧 id 已不在 state.json 里。
  await h.index.refresh({ force: true })

  const session = { id: 'session-b1-live' }
  h.emit(session, turnStart(1))
  h.emit(session, userMsg('旧会话里的话'))
  h.emit(session, assistantMsg(1, 1, '回复'))
  await h.stop(session, 1)
  h.emit(session, turnEnd(1))

  assert.equal(h.written.length, 0, 'signal 会话停写')
  assert.match(h.logs.join('\n'), /停写并告警/, '并给出告警')
}

// ── 蒸馏模型覆盖：botContextModel 优先于主持 Bot 的模型 ──────────────────────
{
  const log = [
    { who: 'Dev', botId: 'session-b1', text: '讨论', seq: 1 },
    { who: 'User', text: '停一下', seq: 2 },
  ]
  const home = await makeHome({ rooms: { 'session-r1': room(log) } })
  const seen = []
  const llm = {
    async resolveModelInfo(provider, model) { return { reasoning: { efforts: [] } } },
    stream(options) {
      seen.push({ provider: options.provider, model: options.model, maxTokens: options.maxTokens, sessionId: options.sessionId })
      return (async function* stream() {
        yield { type: 'text-delta', text: '- 一条要点\n结论：好' }
      })()
    },
  }
  const h = await harness({
    home,
    llm,
    config: { botContextModel: 'deepseek-official/deepseek-flash', botContextMaxTokens: 4321 },
  })
  const session = { id: 'session-r1' }
  h.emit(session, turnStart(1))
  h.emit(session, userMsg('停一下', { time: 1000 }))
  await h.stop(session, 1)
  h.emit(session, turnEnd(1))

  assert.deepEqual(seen, [{
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    maxTokens: 4321,
    sessionId: 'tdai-distill:session-r1',
  }], '有覆盖时用覆盖的模型，并透传输出上限与合成 sessionId')
  assert.notEqual(seen[0].sessionId, 'session-r1',
    '不能直接传房间会话 id：ds-bot 会把它当成 relay 轮接管（现场踩过）')
  assert.equal(h.written.length, 2, '覆盖生效后仍写摘要 + 人话')
  assert.equal(h.written[0].role, 'assistant')
}

// ── 卡片答案归一化（纯函数）──────────────────────────────────────────────────
{
  const { formatCardReply } = await import('../lib/capture.mjs')
  const payload = JSON.stringify({
    kind: 'answer_to_pending_question',
    tool: 'ask_user',
    questions: [{ id: 'q1', question: '要不要合并？', options: [{ label: '合并' }, { label: '先不合并' }] }],
    answers: [{ id: 'q1', selected: ['合并'] }],
  })
  const text = formatCardReply(payload)
  assert.match(text, /^\[卡片\] 问：要不要合并？/, '卡片首行是问题')
  assert.match(text, /可选：合并 \/ 先不合并/, '选项列出')
  assert.match(text, /答：合并/, '答案是真人选择')
  assert.ok(text.length <= 1200, '上限 1,200 字符')

  const custom = formatCardReply(JSON.stringify({
    questions: [{ question: '补充说明？' }],
    answers: [{ selected: [], custom: '我自己写一句' }],
  }))
  assert.match(custom, /答：我自己写一句/, '自定义答案（custom）也要带上')

  const broken = formatCardReply('这不是 JSON')
  assert.equal(broken, '[卡片] 这不是 JSON', '解析失败保底为 [卡片] + 原文')
}

console.log('dsbot capture tests: OK')
