/**
 * ds-bot 索引层与台账层测试。
 *
 * 为什么必须有它：这两层决定"哪些会话被当成 Bot 会话"。判错的代价是不对称的——
 *   - **漏判**（把 Bot 会话当普通会话）：群聊 relay 会被全量写进 L0，后台抽取把
 *     Bot 措辞当成真人记忆，污染是永久的；
 *   - **误判**（把普通会话当 Bot 会话）：真人自己的会话不再回流，记忆静默缺失。
 * 两个方向都不报错，只能靠夹具钉住。
 *
 * 覆盖：四态判定（含 rollover 旧段与 `segments` 缺失）、lean 策略、写侧许可矩阵、
 * 锚点定位（规范化 / 截断前缀 / 歧义 / 断点）、台账（空 / 原子写 / 损坏 / 版本 /
 * 路径拒绝 / stale 索引）。
 *
 * 运行：node test/dsbot.test.mjs
 */
import assert from 'node:assert'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DsbotIndex,
  buildBotSkillQuery,
  normalizeAnchorText,
  parseModelRef,
  stripBotEnvelopes,
  stripUiFences,
  writebackAllowedFor,
} from '../lib/dsbot.mjs'
import { DsbotLedger, defaultLedgerPath, resolveLedgerPath } from '../lib/dsbot-ledger.mjs'

const quiet = () => {}

/** 造一个临时 DSH_HOME，写入与真实 state.json 同形的夹具。 */
async function makeHome({ bots = {}, rooms = {}, raw } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsbot-index-'))
  await mkdir(join(home, 'bot'), { recursive: true })
  const statePath = join(home, 'bot', 'state.json')
  await writeFile(statePath, raw ?? JSON.stringify({ version: 1, bots, rooms }), 'utf8')
  return { home, statePath }
}

/** 与真实 state.json 同形的夹具：1 个带 sessionId + 旧段的 Bot、1 个房间（含成员会话与旧段）。 */
const BOTS = {
  'session-b1': {
    id: 'session-b1',
    name: 'ARK',
    model: 'opencode-go/deepseek-v4.1-flash',
    workDir: '/mnt/d/workspace',
    sessionId: 'session-b1-live',
    segments: [{ sessionId: 'session-b1-old' }],
  },
  'session-b2': { id: 'session-b2', name: 'PM', model: 'x/y', segments: [] },
}
const ROOMS = {
  'session-r1': {
    id: 'session-r1',
    name: '测试群',
    admin: 'session-b1',
    members: ['session-b1', 'session-b2'],
    seq: 5,
    sessions: { 'session-b1': 'session-r1-m1' },
    segments: { 'session-b1': [{ sessionId: 'session-r1-m1-old' }] },
    log: [
      { who: 'Dev', botId: 'session-b2', text: '开始改', seq: 1 },
      { who: 'User', text: '先暂停一下', seq: 2 },
      { who: 'ARK', botId: 'session-b1', text: '收到', seq: 3 },
      { who: 'User', text: '继续', seq: 4 },
      { who: 'User', text: '继续', seq: 5 },
    ],
  },
  // 真实数据里 3 个房间有 1 个完全没有 `segments` 键 —— 必须容忍。
  'session-r2': {
    id: 'session-r2',
    name: '无 segments 群',
    admin: 'missing-bot',
    members: ['session-b2'],
    seq: 1,
    sessions: {},
    log: [{ who: 'User', text: 'hi', seq: 1 }],
  },
}

const CFG = {
  enabled: true,
  captureEnabled: true,
  skillsEnabled: true,
  knowledgeEnabled: true,
  dsbotAwarenessEnabled: true,
  botSkillInjectEnabled: true,
  botWritebackEnabled: false,
  botContextDistillEnabled: true,
  botContextMessages: 5,
  botContextReuseMemory: false,
  subagentInjectionEnabled: false,
  subagentCaptureEnabled: false,
}

// ── 1) 纯函数 ───────────────────────────────────────────────────────────────
{
  assert.equal(normalizeAnchorText('  先暂停\u3000一下\n\n'), '先暂停 一下', '空白折叠 + 全角空格归一')
  assert.equal(normalizeAnchorText('a\u200Bb'), 'ab', '零宽字符去掉')

  assert.deepEqual(parseModelRef('opencode-go/deepseek-v4.1-flash'), {
    provider: 'opencode-go',
    model: 'deepseek-v4.1-flash',
  }, 'provider/model 拆分')
  assert.equal(parseModelRef('nope'), undefined, '没有斜杠 → 拆不出')
  assert.equal(parseModelRef('/x'), undefined, 'provider 为空 → 拆不出')

  assert.equal(stripBotEnvelopes('[Group post from PM]\n正文内容'), '正文内容', '剥单层信封')
  assert.equal(
    stripBotEnvelopes('[Group chat "测试群" · your turn]\n[Checkpoint 3]\n正文'),
    '正文',
    '剥多层信封',
  )
  assert.equal(stripBotEnvelopes('普通消息'), '普通消息', '没有信封时原样')

  const relay = (text) => ({ role: 'user', source: { kind: 'bot' }, content: [{ type: 'text', text }] })
  assert.equal(buildBotSkillQuery([relay('[Bot team setup]\n帮我做 X')]), '帮我做 X', '取最后一条 kind=bot 的正文')
  assert.equal(
    buildBotSkillQuery([relay('[Group chat "群" · your turn]\nThis round so far\nPM: 做完了\nSpeaking order: ARK\n')]),
    'PM: 做完了',
    '群聊取 This round so far 到 Speaking order 之间',
  )
  // DM：真人消息以 kind='user' 直接进来（现场实测形态），必须能当 query 用。
  // 这条曾经写错过：只认 kind='bot' 导致 DM 轮 query 恒空 → 自动 skill 召回一次都不发生。
  assert.equal(
    buildBotSkillQuery([{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '测试是否有注入云端 skill' }] }]),
    '测试是否有注入云端 skill',
    'DM 真人消息（kind=user）就是 query',
  )
  assert.equal(
    buildBotSkillQuery([
      { role: 'user', source: { kind: 'bot' }, content: [{ type: 'text', text: '[Handoff · part 2]\n旧的交接包' }] },
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '最近这句' }] },
      { role: 'user', source: { kind: 'time-context' }, content: [{ type: 'text', text: 'Time sampled...' }] },
    ]),
    '最近这句',
    '取最近一条可用 user 消息，不被 time-context 顶掉',
  )
  assert.equal(
    buildBotSkillQuery([{ role: 'user', source: { kind: 'time-context' }, content: [{ type: 'text', text: 'Time sampled...' }] }]),
    '',
    '只有宿主注入块 → 空（不发检索）',
  )
  assert.equal(buildBotSkillQuery([]), '', '空数组 → 空')
}

// ── 2) 四态判定 ─────────────────────────────────────────────────────────────
{
  const { home } = await makeHome({ bots: BOTS, rooms: ROOMS })
  const ledger = new DsbotLedger({ dshHome: home, log: quiet })
  await ledger.load()
  const index = new DsbotIndex({ dshHome: home, ledger, log: quiet })
  const status = await index.refresh()
  assert.equal(status.ok, true, 'state.json 可读 → ok')
  assert.equal(status.bots, 2, '2 个 Bot')
  assert.equal(status.rooms, 2, '2 个房间')

  const kind = (id) => index.lookup(id).kind
  assert.equal(kind('session-b1'), 'bot', 'bots 键名是 Bot 会话')
  assert.equal(kind('session-b1-live'), 'bot', 'bots[*].sessionId 是 Bot 当前会话')
  assert.equal(kind('session-b1-old'), 'bot', 'bots[*].segments 是 Bot 的 rollover 旧段')
  assert.equal(kind('session-r1'), 'room', 'rooms 键名是房间会话')
  assert.equal(kind('session-r1-m1'), 'room-member', 'rooms[*].sessions 是群成员隐藏会话')
  assert.equal(kind('session-r1-m1-old'), 'room-member', 'rooms[*].segments 是成员 rollover 旧段')
  assert.equal(kind('session-r2'), 'room', '没有 segments 键的房间照样识别')
  assert.equal(kind('session-unknown'), 'ordinary', '索引里没有 → 普通会话')
  assert.equal(kind(''), 'ordinary', '空 id → 普通会话')

  assert.equal(index.modelForRoom('session-r1').provider, 'opencode-go', '主持 Bot 的模型可拆')
  assert.equal(index.modelForRoom('session-r2').botId, 'session-b2', 'admin 缺失时取 members 里第一个存在的 Bot')
  assert.equal(index.modelForRoom('session-unknown'), undefined, '未知房间 → 无模型')

  const log = index.roomLog('session-r1')
  assert.equal(log.name, '测试群', '房间名')
  assert.equal(log.firstSeq, 1, '窗口起点')
  assert.equal(log.lastSeq, 5, '窗口终点')
  assert.equal(log.lines.length, 5, '5 行')
  assert.equal(log.lines[0].truncated, false, '无 length 字段 → 未截断')
}

// ── 3) lean 策略与写侧许可矩阵 ───────────────────────────────────────────────
{
  const { home } = await makeHome({ bots: BOTS, rooms: ROOMS })
  const ledger = new DsbotLedger({ dshHome: home, log: quiet })
  await ledger.load()
  const index = new DsbotIndex({ dshHome: home, ledger, log: quiet })
  await index.refresh()

  const policy = (session, cfg = CFG) => index.sessionPolicy(cfg, session)

  for (const sessionId of ['session-b1', 'session-r1', 'session-r1-m1']) {
    const p = policy({ id: sessionId })
    assert.equal(p.identity, false, `${sessionId}：身份恒不注入`)
    assert.equal(p.memory, false, `${sessionId}：记忆恒不注入`)
    assert.equal(p.skills, true, `${sessionId}：skill 面开`)
    assert.equal(p.knowledge, true, `${sessionId}：知识面开`)
    assert.equal(p.bot, true, `${sessionId}：bot 标记`)
    assert.equal(p.skillInject, true, `${sessionId}：有效 skill 注入 = 开`)
  }
  assert.equal(policy({ id: 'session-r1-m1' }).writeback, false, '群成员隐藏会话永不写')
  assert.equal(policy({ id: 'session-b1' }).writeback, false, 'botWriteback 默认关 → 不写')

  // 普通会话：四个面与旧策略逐项相等（子会话降级照旧）。
  const ordinary = policy({ id: 'session-unknown' })
  assert.equal(ordinary.kind, 'ordinary')
  assert.deepEqual(
    { identity: ordinary.identity, memory: ordinary.memory, skills: ordinary.skills, knowledge: ordinary.knowledge },
    { identity: true, memory: true, skills: true, knowledge: true },
    '普通顶层会话：四面全开',
  )
  const child = policy({ id: 'session-unknown', header: { origin: 'subagent', delegationDepth: 1 } })
  assert.equal(child.identity, false, '普通子会话：身份关闭（旧策略不变）')
  assert.equal(child.knowledge, true, '普通子会话：知识面保留')

  // 总闸关闭：Bot 会话回到普通会话策略（唯一能回到改动前的开关）。
  const off = policy({ id: 'session-b1' }, { ...CFG, dsbotAwarenessEnabled: false })
  assert.equal(off.kind, 'ordinary', '总闸关闭 → Bot 会话按普通会话处理')
  assert.equal(off.identity, true, '总闸关闭 → 身份恢复注入')
  assert.equal(off.writeback, true, '总闸关闭 → 回流恢复原逻辑')

  // 写侧许可矩阵。
  assert.equal(writebackAllowedFor(CFG, { id: 'session-b1' }, { kind: 'bot' }), false, '默认关')
  assert.equal(
    writebackAllowedFor({ ...CFG, botWritebackEnabled: true }, { id: 'session-b1' }, { kind: 'bot' }),
    true,
    '子开关 + 全局 capture 都开 → 写',
  )
  assert.equal(
    writebackAllowedFor({ ...CFG, botWritebackEnabled: true, captureEnabled: false }, { id: 'session-b1' }, { kind: 'bot' }),
    false,
    '全局 capture 关 → 子开关无效（全局优先）',
  )
  assert.equal(
    writebackAllowedFor({ ...CFG, botWritebackEnabled: true }, { id: 'x' }, { kind: 'room-member' }),
    false,
    '群成员会话即使开关全开也不写',
  )

  // skill 注入的三重 AND：总闸 / 子开关 / 全局 skills。
  const noSkill = policy({ id: 'session-b1' }, { ...CFG, botSkillInjectEnabled: false })
  assert.equal(noSkill.skills, false, '子开关关 → skill 面关')
  assert.equal(noSkill.skillInject, false, '有效值同步为关')
  const noGlobal = policy({ id: 'session-b1' }, { ...CFG, skillsEnabled: false })
  assert.equal(noGlobal.skills, true, '面本身仍开')
  assert.equal(noGlobal.skillInject, false, '但全局 skills 关 → 有效值关')
}

// ── 4) 锚点定位 ─────────────────────────────────────────────────────────────
{
  const { home } = await makeHome({ bots: BOTS, rooms: ROOMS })
  const index = new DsbotIndex({ dshHome: home, log: quiet })
  await index.refresh()

  const hit = index.locateAnchor('session-r1', '先暂停一下', { afterSeq: 0 })
  assert.equal(hit.hit, true, '精确命中')
  assert.equal(hit.line.seq, 2, '命中最小 seq')

  const spaced = index.locateAnchor('session-r1', '\n 先暂停一下\t', { afterSeq: 0 })
  assert.equal(spaced.hit, true, '首尾空白与制表符被规范化吃掉')

  const dup = index.locateAnchor('session-r1', '继续', { afterSeq: 0 })
  assert.equal(dup.hit, false, '两条同文（seq 4/5）→ 歧义')
  assert.equal(dup.reason, 'ambiguous', '歧义有独立 reason，不混成 not-found')
  assert.deepEqual(dup.candidates, [4, 5], '候选 seq 可用于诊断')

  const behind = index.locateAnchor('session-r1', '先暂停一下', { afterSeq: 2 })
  assert.equal(behind.hit, false, '断点之后没有这条 → 未命中')

  const botText = index.locateAnchor('session-r1', '收到', { afterSeq: 0 })
  assert.equal(botText.hit, false, 'Bot 行（有 botId）不是真人锚点')

  assert.equal(index.locateAnchor('session-unknown', 'x').reason, 'no-room', '未知房间有独立 reason')
}

// ── 5) 截断长贴：日志只存前 2000 字符，按前缀匹配 ────────────────────────────
{
  const long = '很长的真人发言'.repeat(500)
  const kept = long.slice(0, 2000)
  const { home } = await makeHome({
    bots: {},
    rooms: {
      'session-r1': {
        id: 'session-r1', name: '截断群', admin: '', members: [], seq: 1, sessions: {},
        log: [{ who: 'User', text: kept, seq: 1, length: long.length }],
      },
    },
  })
  const index = new DsbotIndex({ dshHome: home, log: quiet })
  await index.refresh()
  const log = index.roomLog('session-r1')
  assert.equal(log.lines[0].truncated, true, '带 length 字段 → 截断行')
  const located = index.locateAnchor('session-r1', long, { afterSeq: 0 })
  assert.equal(located.hit, true, '超长锚点按前缀命中')
}

// ── 6) 台账：空 / 原子写 / 重载 ──────────────────────────────────────────────
{
  const { home } = await makeHome({ bots: BOTS, rooms: ROOMS })
  const path = defaultLedgerPath(home)
  const ledger = new DsbotLedger({ dshHome: home, log: quiet })
  await ledger.load()
  assert.equal(ledger.blocked, false, 'ENOENT → 正常首启，不算损坏')
  ledger.patchRoom('session-r1', {
    lastHuman: { seq: 2, hash: 'abc' },
    pending: { text: '继续', time: 1, hash: 'h', attempts: 1, firstSeenAt: 1 },
    stage: { summary: 'written', human: 'pending', anchor: { text: 'x', time: 1 }, seq: 5 },
  })
  ledger.setDirect('session-b1', { lastMessageId: 'm-1' })
  ledger.recordIndex({ stateMtimeMs: 1, sessions: { s1: { kind: 'bot', botId: 'b', roomId: '' } }, signals: ['s1'] })
  await ledger.flush()

  assert.equal(path, join(home, 'storages', 'tdai-memory-plugin', 'dsbot-state.json'), '默认路径在插件自己的 storages 下')
  const dir = await readdir(join(home, 'storages', 'tdai-memory-plugin'))
  assert.deepEqual(dir, ['dsbot-state.json'], '原子写不留 .tmp 残file')

  const reloaded = new DsbotLedger({ dshHome: home, log: quiet })
  await reloaded.load()
  assert.deepEqual(reloaded.room('session-r1').lastHuman, { seq: 2, hash: 'abc' }, '断点可重载')
  assert.equal(reloaded.room('session-r1').stage.summary, 'written', '阶段机可重载')
  assert.equal(reloaded.direct('session-b1').lastMessageId, 'm-1', '幂等位可重载')
  assert.equal(reloaded.getIndex().sessions.s1.kind, 'bot', '索引快照可重载')

  // 副本语义：改返回值不影响台账。
  const copy = reloaded.room('session-r1')
  copy.lastHuman.seq = 999
  assert.equal(reloaded.room('session-r1').lastHuman.seq, 2, 'room() 返回副本')
}

// ── 7) 台账损坏：停写 + 告警，不推断成"没有台账" ─────────────────────────────
{
  const cases = [
    ['坏 JSON', '{not json', /解析失败/],
    ['版本不符', JSON.stringify({ version: 2, rooms: {}, direct: {} }), /版本不匹配/],
    ['顶层不是对象', JSON.stringify([1, 2, 3]), /顶层不是对象/],
  ]
  for (const [name, raw, pattern] of cases) {
    const { home } = await makeHome({ bots: {}, rooms: {} })
    const path = defaultLedgerPath(home)
    await mkdir(join(home, 'storages', 'tdai-memory-plugin'), { recursive: true })
    await writeFile(path, raw, 'utf8')
    const logs = []
    const ledger = new DsbotLedger({ dshHome: home, log: (message) => logs.push(message) })
    await ledger.load()
    assert.equal(ledger.blocked, true, `${name} → 停写`)
    assert.match(logs.join('\n'), pattern, `${name} → 告警点名原因`)
    assert.ok(logs.join('\n').includes(path), `${name} → 告警点名路径`)
    assert.equal(ledger.patchRoom('r', { lastHuman: { seq: 1, hash: '' } }), false, `${name} → 写被拒绝`)
    assert.equal(ledger.getIndex(), undefined, `${name} → 不返回索引（不冒充"没有台账"）`)
  }
}

// ── 8) 台账路径落在 ds-bot 目录下：拒绝 + 回退默认 ───────────────────────────
{
  const { home } = await makeHome({ bots: {}, rooms: {} })
  const bad = join(home, 'bot', 'state-ledger.json')
  const resolved = resolveLedgerPath({ configured: bad, dshHome: home })
  assert.equal(resolved.rejected, bad, '拒绝记录原路径')
  assert.equal(resolved.path, defaultLedgerPath(home), '回退到默认路径')

  const logs = []
  const ledger = new DsbotLedger({ path: bad, dshHome: home, log: (message) => logs.push(message) })
  await ledger.load()
  assert.equal(ledger.path, defaultLedgerPath(home), '实际使用默认路径')
  assert.match(logs.join('\n'), /已拒绝/, '告警说明拒绝了哪条路径')
  assert.ok(!logs.join('\n').includes('blocked'), '路径拒绝不等于台账损坏，不应停写')
}

// ── 9) state.json 读不到：用台账里的 stale 索引（读侧 lean、写侧停写）─────────
{
  const { home, statePath } = await makeHome({ bots: BOTS, rooms: ROOMS })
  const ledger = new DsbotLedger({ dshHome: home, log: quiet })
  await ledger.load()
  const first = new DsbotIndex({ dshHome: home, ledger, log: quiet })
  await first.refresh()
  await ledger.flush()

  // 把 state.json 写坏（模拟半写/损坏）。
  await writeFile(statePath, '{bad', 'utf8')
  const logs = []
  const second = new DsbotIndex({ dshHome: home, ledger, log: (message) => logs.push(message) })
  const status = await second.refresh()
  assert.equal(status.ok, false, '读不到 → ok=false')
  assert.equal(status.stale, true, '但索引来自台账 → stale')
  assert.equal(second.lookup('session-b1').kind, 'bot', 'stale 索引仍能识别 Bot 会话')
  assert.equal(second.lookup('session-b1').source, 'stale', '标注来源是 stale')
  assert.match(logs.join('\n'), /解析失败/, '告警点名解析失败')

  const policy = second.sessionPolicy({ ...CFG, botWritebackEnabled: true }, { id: 'session-b1' })
  assert.equal(policy.identity, false, 'stale 下读侧仍然 lean')
  assert.equal(policy.writeback, false, 'state.json 不可读 → 写侧停写（不按 stale 硬写）')
}

// ── 10) 见过 kind=bot 的会话从索引消失：按 Bot 处理但停写（signal）──────────
{
  const { home, statePath } = await makeHome({ bots: BOTS, rooms: ROOMS })
  const ledger = new DsbotLedger({ dshHome: home, log: quiet })
  await ledger.load()
  const index = new DsbotIndex({ dshHome: home, ledger, log: quiet })
  await index.refresh()
  await ledger.flush()

  // Bot 换了会话，并把旧会话从 state.json 里删掉（rollover 后没有 segments）。
  const next = JSON.parse(await readFile(statePath, 'utf8'))
  next.bots['session-b1'].sessionId = 'session-b1-new'
  delete next.bots['session-b1'].segments
  await writeFile(statePath, JSON.stringify(next), 'utf8')

  const fresh = new DsbotIndex({ dshHome: home, ledger, log: quiet })
  await fresh.refresh()
  const info = fresh.lookup('session-b1-live')
  assert.equal(info.kind, 'bot', '曾见过 kind=bot 的 id 仍按 Bot 处理')
  assert.equal(info.source, 'signal', '来源标为目标 signal（capture 据此停写并告警）')
}

// ── 10e) stripUiFences：剥 dsh-ui 卡片，保留正文与标记 ───────────────────
{
  const raw = [
    '结论先说。',
    '',
    '```dsh-ui',
    '{"title":"表","items":[{"type":"table","columns":["a"],"rows":[["1"]]}]}',
    '```',
    '',
    '然后是细节。',
  ].join('\n')
  const out = stripUiFences(raw)
  assert.equal(out.includes('"type":"table"'), false, 'UI spec 的 JSON 必须消失')
  assert.equal(out.includes('[结构化卡片]'), true, '留一行标记，避免上下文莫名断层')
  assert.equal(out.includes('结论先说。') && out.includes('然后是细节。'), true, '正文不受影响')
  assert.equal(/\n{3,}/.test(out), false, '多余空行压平')

  // 未闭合的尾巴（流式截断）
  const cut = '正文\n```dsh-ui\n{"items":['
  const cutOut = stripUiFences(cut)
  assert.equal(cutOut.includes('{"items"'), false, '未闭合的 UI 块也要剥掉')
  assert.equal(cutOut.includes('正文'), true, '未闭合时正文仍在')

  assert.equal(stripUiFences(''), '', '空串安全')
  assert.equal(stripUiFences('没有卡片的一段话'), '没有卡片的一段话', '无卡片时原样返回')
}

// ── 11) 收尾：清临时目录 ────────────────────────────────────────────────────
{
  const tmp = await mkdtemp(join(tmpdir(), 'dsbot-cleanup-'))
  await rm(tmp, { recursive: true, force: true })
}

console.log('dsbot index/ledger tests: OK')
