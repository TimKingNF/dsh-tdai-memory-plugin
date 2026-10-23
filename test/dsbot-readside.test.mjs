/**
 * ds-bot 集成的**读侧接线**测试（index.mjs / lib/sections.mjs / lib/recall.mjs）。
 *
 * 为什么单独一组：读侧策略的计算点从 `subagentReadPolicy()` 换成了
 * `DsbotIndex.sessionPolicy()`（lib/dsbot.mjs），返回的是它的**超集**。这条链路上
 * 任何一处漏改都不会报错，只会静默地：
 *   1. **Bot 会话白背身份与画像**：实测多注入 7,339 字符 `<session_context>` +
 *      3,158 字符 `<tdai_profile_memory>`，而且 Bot 之间的讨论会被抽成"关于人"的证据；
 *   2. **普通会话被误伤**：策略来源换错/多算一次 AND，用户只会觉得"插件坏了"；
 *   3. **skill 召回形同关闭**：Bot 会话里没有真人消息，普通 query 口径恒为空串，
 *      必须走 `buildBotSkillQuery()`（取最后一条 `kind='bot'` 的消息剥信封）。
 *
 * 所以这里按验收清单逐条钉：
 *   ① Bot 会话 assemble 后没有 `<session_context>` / `<tdai_profile_memory>` /
 *      `<tdai_recalled_l1_memories>`（身份与记忆恒关，不是开关）；
 *   ② `knowledgeEnabled=true` 时有 `<knowledge_tools>`，false 时没有；
 *   ③ `botSkillInjectEnabled=false` 无 `<tdai_recalled_skills>`，true 且全局
 *      `skillsEnabled` 开时有；且 query 走的是 relay 正文（不是空串）；
 *   ④ 普通会话与改动前**逐字节一致**（策略形状 = `subagentReadPolicy` 的四个面，
 *      渲染文本与"没有 readPolicyFor 的老接线"逐段 deepEqual）；
 *   ⑤ `dsbotAwarenessEnabled=false` → Bot 会话回到普通会话策略（identity/memory 恢复）；
 *   ⑥ `/tdai-status` 的 `dsbot=` 行打的是**有效值**（skill/write 已与全局闸 AND）。
 *
 * 全部用假 ctx / 假 client / 临时 DSH_HOME 驱动，不依赖真实 DSH 网络服务。
 * fixture 的 `state.json` 与真实 ds-bot 同形（version/mainBotIds/bots/rooms/
 * rooms[*].sessions/rooms[*].log），见 docs/proposals/ds-bot-tdai-integration/timing-probe.md。
 *
 * 运行：node test/dsbot-readside.test.mjs
 */
import assert from 'node:assert'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.mjs'
import { DsbotIndex } from '../lib/dsbot.mjs'
import { DsbotLedger } from '../lib/dsbot-ledger.mjs'
import { registerSections } from '../lib/sections.mjs'
import { wireRecall } from '../lib/recall.mjs'
import { subagentReadPolicy } from '../lib/subagent.mjs'

// ── fixture：与真实 state.json 同形（只截到测试要用的字段）────────────────────
//
// 真实形态的两个关键点（不能想当然）：
//   - `bots` 的**键名**就是 Bot 的会话 id；`bots[*].sessionId` 是它当前的会话
//     （可能因 workDir 落在别的 session 目录，实测 ARK-Alpha 就是这样）；
//   - `rooms[*].sessions` 是群成员的隐藏会话，`segments` 可以缺失。
const STATE_FIXTURE = {
  version: 1,
  mainBotIds: ['bot-chief'],
  bots: {
    'bot-chief': { id: 'bot-chief', name: 'Chief', role: 'Chief of Staff', instructions: '……' },
    'bot-coder': {
      id: 'bot-coder',
      name: 'Coder',
      model: 'deepseek/deepseek-v4.1-flash',
      sessionId: 'sess-bot-coder-current',
      segments: [{ sessionId: 'sess-bot-coder-old' }],
    },
  },
  rooms: {
    'room-alpha': {
      id: 'room-alpha',
      name: 'TDAI 集成',
      admin: 'bot-chief',
      members: ['bot-chief', 'bot-coder'],
      seq: 12,
      sessions: { 'bot-chief': 'sess-room-member-chief', 'bot-coder': 'sess-room-member-coder' },
      segments: { 'bot-coder': [{ sessionId: 'sess-room-member-old' }] },
      log: [
        { seq: 10, who: 'User', text: '帮我看看读侧接线' },
        { seq: 11, who: 'Chief', botId: 'bot-chief', text: '我先看下文档' },
        { seq: 12, who: 'User', text: '继续' },
      ],
    },
  },
}

// 会话四态各一份（id 全部来自上面的 fixture）：
const BOT = { id: 'bot-chief' }                                       // bots 键名
const BOT_CURRENT = { id: 'sess-bot-coder-current' }                  // bots[*].sessionId
const ROOM = { id: 'room-alpha' }                                     // rooms 键名
const ROOM_MEMBER = { id: 'sess-room-member-chief' }                  // rooms[*].sessions 的值
const ORDINARY = { id: 'sess-ordinary' }                              // 谁都不命中的普通会话

const BASE = {
  enabled: true, captureEnabled: true, recallEnabled: true, injectionEnabled: true,
  sessionContextEnabled: true, profileMemoryEnabled: true, skillsEnabled: true,
  knowledgeEnabled: false,
  subagentInjectionEnabled: false, subagentCaptureEnabled: false,
  // ds-bot 七个字段（与 lib/settings.mjs 的默认值一致）：
  dsbotAwarenessEnabled: true, botSkillInjectEnabled: true, botWritebackEnabled: false,
  botContextDistillEnabled: true, botContextMessages: 5, botContextReuseMemory: false,
  dsbotLedgerPath: '',
  serviceId: 'svc', teamId: 't', agentId: 'a', userId: 'u', taskId: undefined,
  recallLimit: 5, recallTimeoutMs: 3000, skillRecallLimit: 3, skillRecallMinScore: 0,
}

const tempDirs = []
const originalDshHome = process.env.DSH_HOME

/** 写一份临时 DSH_HOME（含 bot/state.json），返回目录。 */
async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), 'tdai-dsbot-readside-'))
  tempDirs.push(home)
  await mkdir(join(home, 'bot'), { recursive: true })
  await writeFile(join(home, 'bot', 'state.json'), JSON.stringify(STATE_FIXTURE, null, 2), 'utf8')
  return home
}

/**
 * 假 fetch：只回本插件真正会打的几个只读端点，其余回 `{}`。
 *
 * 为什么不连真服务：这组测的是"接线"——策略、开关、渲染，全部本地可判定；
 * 网络只会让断言变成"看网关今天心情"。
 */
function withFetch({ knowledge = [] } = {}) {
  const real = globalThis.fetch
  const calls = { total: 0, searchL1: 0, searchSkills: 0, knowledgeList: 0, skillQueries: [] }
  const reply = (data) => ({ ok: true, status: 200, json: async () => ({ code: 0, data }) })
  globalThis.fetch = async (url, init = {}) => {
    calls.total += 1
    const path = new URL(String(url)).pathname
    let body = {}
    try { body = init?.body ? JSON.parse(init.body) : {} } catch {}
    if (path.endsWith('/v3/skill/search')) {
      calls.searchSkills += 1
      calls.skillQueries.push(String(body.query ?? ''))
      return reply({
        items: [{
          skill_id: 'skill-1', name: 'tdai-team-knowledge', score: 9.5,
          description: '团队知识库检索：code-graph 与 wiki',
        }],
      })
    }
    if (path.endsWith('/v3/atomic/search')) {
      calls.searchL1 += 1
      return reply({ items: [{ id: 'm1', type: 'rule', content: '用户偏好：先读文档再动手', score: 0.91 }] })
    }
    if (path.endsWith('/v3/knowledge/list')) {
      calls.knowledgeList += 1
      return reply({ items: knowledge })
    }
    // 资产面：给一份"非空"画像，让普通会话的 <tdai_profile_memory> 真的出现
    //（空资产时 renderProfileMemory 只输出总述、不带标签，测不出"是否恢复记忆面"）。
    if (path.endsWith('/v3/core/read')) return reply({ content: '# 用户画像\n\n- 偏好：先看文档，再动代码。' })
    if (path.endsWith('/v3/scenario/ls')) return reply({ entries: [{ path: 'scenes/dsbot.md', summary: 'ds-bot 集成讨论' }] })
    if (path.endsWith('/v3/meta/agent/get')) {
      return reply({ agent_id: 'a', team_id: 't', name: 'TDAI memory', description: '记忆插件' })
    }
    return reply({})
  }
  return {
    calls,
    restore() { globalThis.fetch = real },
  }
}

/** 按 subagent.test.mjs 的假宿主写法：只提供本插件用到的服务面。 */
function makeHarness() {
  const listeners = new Map()
  const sections = new Map()
  const contexts = new Map()
  const tools = []
  const commands = []
  const skills = []
  const ctx = {
    logger: { warn() {} },
    fiber: { id: 'tdai-memory' },
    /**
     * 假 cordis：`get` 不抛（宿主没有 llm 服务时 index.mjs 的 llm() 必须退回 undefined），
     * `inject` 只回调本测试真的会用到的服务（settings 不提供 —— 读侧不依赖它）。
     */
    get() { return undefined },
    inject(deps, cb) {
      if (!Array.isArray(deps)) return
      if (deps.includes('settings')) return
      if (deps.includes('commands')) return cb({ commands: { register: (def) => commands.push(def) } })
      if (deps.includes('skills')) return cb({ skills: { register: (def) => { skills.push(def); return () => {} } } })
    },
    on(ev, cb) {
      if (!listeners.has(ev)) listeners.set(ev, [])
      listeners.get(ev).push(cb)
    },
    tools: { register: (def) => tools.push(def) },
    systemPrompt: {
      section: (s) => sections.set(s.name, s),
      context: (c) => contexts.set(c.name, c),
    },
    sessions: { list() { return [] } },
  }
  return { ctx, listeners, sections, contexts, tools, commands, skills }
}

/**
 * 起一个真实插件实例（apply），DSH_HOME 指向本用例自己的临时目录。
 *
 * 返回 `config` 引用：面板上的 volatile 字段在真实宿主里是 `{ get() }` 访问器，
 * 这里用"改同一个普通对象"模拟同一件事 —— `live()` 每次都重新 `resolveConfig()`
 *（见 index.mjs 顶部），所以改完下一次 assemble / pre-step 立即生效。
 */
async function bootFixture(overrides = {}) {
  const home = await makeHome()
  process.env.DSH_HOME = home
  const harness = makeHarness()
  const config = { ...BASE, ...overrides }
  apply(harness.ctx, config)
  return { ...harness, home, config }
}

/** 驱动 `system-prompt/assemble`（与 DSH 的 waterfall 形状一致）。 */
async function assemble(harness, session) {
  const assembly = {
    sections: [
      { name: 'harness:identity', text: 'You are an AI agent.' },
      { name: 'tdai:session-context', text: '' },
      { name: 'tdai:profile-memory', text: '' },
      { name: 'tdai:knowledge-tools', text: '' },
      { name: 'deployment:persona-prefix', text: 'base persona' },
    ],
    contexts: [], tools: [], variables: {},
  }
  let result = assembly
  for (const cb of harness.listeners.get('system-prompt/assemble') || []) {
    result = await cb(result, { agent: { session } }, async () => result)
  }
  return result
}

const textOf = (result, name) => result.sections.find((s) => s.name === name)?.text ?? ''

/** `tdai:state` 是 context 通道（同步 text 求值，热路径只读缓存）。 */
const stateTextOf = (harness, session) => harness.contexts.get('tdai:state')?.text({ agent: { session } }) ?? ''

/** 驱动 `agent/pre-step`（本插件那一条是 prepend 的最外层守卫）。 */
async function preStep(harness, session, messages) {
  const handler = harness.listeners.get('agent/pre-step')?.[0]
  assert.ok(handler, '应注册 agent/pre-step')
  const payload = { agent: { session }, messages: [...messages], turn: 1, step: 1 }
  return handler(payload, async () => ({ kind: 'enter', messages: payload.messages }))
}

/** 本轮消息里所有文本（断言"整个上下文里都没有某标签"用）。 */
const messagesText = (decision) => (decision.messages ?? [])
  .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
  .map((b) => (typeof b?.text === 'string' ? b.text : ''))
  .join('\n')

/**
 * ds-bot 投递给 Bot 的群聊信封（形状见 lib/dsbot.mjs 的 stripBotEnvelopes /
 * extractRoomRoundBody）。普通 query 口径会把它当"非真人消息"整条跳过 → 空串。
 */
/** 私聊里真人的消息：`source.kind='user'`（现场实测形态，见 lib/dsbot.mjs 的 buildBotSkillQuery 注释）。 */
const BOT_DM = {
  role: 'user',
  source: { kind: 'user' },
  content: [{ type: 'text', text: '和你的对话，测试是否有注入云端 skill' }],
}

const BOT_RELAY = {
  role: 'user',
  source: { kind: 'bot' },
  content: [{
    type: 'text',
    text: '[Group chat "TDAI 集成" · your turn]\n'
      + 'This round so far\n'
      + '[User] 帮我看看读侧接线\n'
      + '[Chief] 我先看下文档\n'
      + 'Speaking order: Chief',
  }],
}

const HUMAN_MESSAGE = {
  role: 'user',
  id: 'm-human',
  source: { kind: 'user' },
  content: [{ type: 'text', text: '帮我看看读侧接线' }],
}

try {
  // ── 0) 索引四态 + 策略形状（纯函数层，策略的唯一计算点）───────────────────
  {
    const fixtureHome = await makeHome()
    const fixtureLedger = new DsbotLedger({ dshHome: fixtureHome })
    await fixtureLedger.load()
    const index = new DsbotIndex({ dshHome: fixtureHome, ledger: fixtureLedger })
    await index.refresh()
    const cfg = { ...BASE }

    const status = index.status()
    assert.equal(status.ok, true, `fixture 的 state.json 应读成功：${status.reason}`)
    assert.equal(status.bots, 2, '应识别 2 个 Bot')
    assert.equal(status.rooms, 1, '应识别 1 个房间')
    assert.equal(status.sessions, 8, '索引应有 8 条会话（bots 键名/sessionId/segments + rooms 键名/sessions/segments）')

    assert.equal(index.lookup(BOT.id).kind, 'bot', 'bots 键名应判为 bot')
    assert.equal(index.lookup(BOT_CURRENT.id).kind, 'bot', 'bots[*].sessionId 应判为 bot')
    assert.equal(index.lookup('sess-bot-coder-old').kind, 'bot', 'bots[*].segments 应判为 bot')
    assert.equal(index.lookup(ROOM.id).kind, 'room', 'rooms 键名应判为 room')
    assert.equal(index.lookup(ROOM_MEMBER.id).kind, 'room-member', 'rooms[*].sessions 应判为 room-member')
    assert.equal(index.lookup('sess-room-member-old').kind, 'room-member', 'rooms[*].segments 应判为 room-member')
    assert.equal(index.lookup(ORDINARY.id).kind, 'ordinary', '其余会话应判为 ordinary')

    // Bot / 房间 / 群成员的 lean 形状：identity/memory 恒 false（不是开关），
    // skills 只受 botSkillInjectEnabled 约束，knowledge 恒 true。
    assert.deepEqual(index.sessionPolicy(cfg, BOT), {
      subagent: false, inherit: false, bot: true, kind: 'bot', botId: 'bot-chief', roomId: '',
      sessionId: 'bot-chief', identity: false, memory: false, skills: true, knowledge: true,
      skillInject: true, writeback: false,
    }, 'Bot 会话应为 lean 策略（身份与记忆恒关）')
    assert.deepEqual(index.sessionPolicy(cfg, ROOM), {
      subagent: false, inherit: false, bot: true, kind: 'room', botId: '', roomId: 'room-alpha',
      sessionId: 'room-alpha', identity: false, memory: false, skills: true, knowledge: true,
      skillInject: true, writeback: false,
    }, '房间会话应为 lean 策略')
    assert.deepEqual(index.sessionPolicy(cfg, ROOM_MEMBER), {
      subagent: false, inherit: false, bot: true, kind: 'room-member', botId: '', roomId: 'room-alpha',
      sessionId: 'sess-room-member-chief', identity: false, memory: false, skills: true, knowledge: true,
      skillInject: true, writeback: false,
    }, '群成员隐藏会话应为 lean 策略（写侧永不写）')

    // 有效值：skill 注入受 botSkillInjectEnabled / skillsEnabled 约束，write 受回写开关约束。
    const skillOff = index.sessionPolicy({ ...cfg, botSkillInjectEnabled: false }, BOT)
    assert.equal(skillOff.skillInject, false, 'botSkillInjectEnabled=false → 有效 skill 注入必须为 false')
    assert.equal(skillOff.skills, false, 'skill 能力面跟着 botSkillInjectEnabled 走')
    assert.equal(index.sessionPolicy({ ...cfg, skillsEnabled: false }, BOT).skillInject, false,
      '全局 skillsEnabled=false → Bot 会话也不注 skill')
    assert.equal(index.sessionPolicy({ ...cfg, botWritebackEnabled: true }, BOT).writeback, true,
      '回写开关打开时有效 write 应为 true（还须 captureEnabled=true）')
    assert.equal(index.sessionPolicy({ ...cfg, botWritebackEnabled: true, captureEnabled: false }, BOT).writeback, false,
      '全局 captureEnabled=false 时 Bot 回写必须为 false')

    // ④ 普通会话：策略是 subagentReadPolicy 的超集，**四个面逐项相同**，
    // 多出来的只是给 /tdai-status 与写侧用的只读字段（bot/kind/id/skillInject/writeback）。
    const basePolicy = subagentReadPolicy(cfg, ORDINARY)
    const ordinaryPolicy = index.sessionPolicy(cfg, ORDINARY)
    assert.deepEqual(
      { identity: ordinaryPolicy.identity, memory: ordinaryPolicy.memory, skills: ordinaryPolicy.skills, knowledge: ordinaryPolicy.knowledge },
      { identity: basePolicy.identity, memory: basePolicy.memory, skills: basePolicy.skills, knowledge: basePolicy.knowledge },
      '普通会话的四个能力面必须与原策略逐项相同',
    )
    assert.deepEqual(Object.keys(ordinaryPolicy).sort(),
      [...Object.keys(basePolicy), 'bot', 'kind', 'botId', 'roomId', 'sessionId', 'skillInject', 'writeback'].sort(),
      '普通会话策略应恰好是原策略 + 只读超集字段')
    assert.equal(ordinaryPolicy.kind, 'ordinary')
    assert.equal(ordinaryPolicy.bot, false)

    // ⑤ 总闸关闭：Bot 会话必须回到**普通会话策略**（identity/memory 恢复）。
    const offCfg = { ...cfg, dsbotAwarenessEnabled: false }
    const offBot = index.sessionPolicy(offCfg, BOT)
    const offBase = subagentReadPolicy(offCfg, BOT)
    assert.equal(offBot.kind, 'ordinary', '总闸关闭后 Bot 会话应判为 ordinary')
    assert.equal(offBot.bot, false, '总闸关闭后 bot 标记应为 false')
    assert.deepEqual(
      { identity: offBot.identity, memory: offBot.memory, skills: offBot.skills, knowledge: offBot.knowledge },
      { identity: offBase.identity, memory: offBase.memory, skills: offBase.skills, knowledge: offBase.knowledge },
      '总闸关闭后身份与记忆必须恢复（这是唯一的回滚开关）',
    )

    // ── 4) 普通会话渲染与"老接线"（没有 readPolicyFor）逐字节一致 ───────────
    //
    // 这是"普通会话零 diff"的最直接证据：同一份 cfg / 同一份资产，一边喂新策略
    //（sessionPolicy 超集），一边走 subagentReadPolicy 兜底，两边渲染结果 deepEqual。
    const parityCfg = { ...BASE, knowledgeEnabled: false }
    const parityAsset = {
      identity: {},
      agentDetail: {
        id: 'a', name: 'TDAI memory', description: '记忆插件',
        rolePrompt: '你是记忆助手', rulesPrompt: '先查再答', agentPrompt: '你是记忆助手\n\n先查再答',
      },
      taskDetail: null,
      profiles: [{
        ctx: { agentId: 'a', agentName: 'TDAI memory', isSelf: true },
        l3: { content: '# 用户画像\n\n- 偏好：先看文档，再动代码。' },
        l2Entries: [{ path: 'scenes/dsbot.md', summary: 'ds-bot 集成讨论' }],
      }],
      skills: {},
      knowledge: [],
      loadedAt: 123,
    }
    const sectionHarness = (policy) => {
      const listeners = {}
      const contexts = {}
      const ctx = {
        systemPrompt: {
          section: (s) => { listeners[`section:${s.name}`] = s },
          context: (c) => { contexts[c.name] = c },
        },
        on: (ev, cb) => { listeners[ev] = cb },
        inject: () => {},
      }
      const runtime = {
        readEnabled: () => true,
        config: parityCfg,
        assets: { ensure: async () => parityAsset, peek: () => parityAsset },
        log: () => {},
        ...(policy ? { readPolicyFor: () => policy, dsbotReady: async () => {} } : {}),
      }
      registerSections(ctx, runtime)
      return { listeners, contexts }
    }
    const runAssemble = async (h) => {
      const assembly = {
        sections: [
          { name: 'harness:identity', text: 'You are an AI agent.' },
          { name: 'tdai:session-context', text: '' },
          { name: 'tdai:profile-memory', text: '' },
          { name: 'tdai:knowledge-tools', text: '' },
          { name: 'deployment:persona-prefix', text: 'base persona' },
        ],
        contexts: [], tools: [], variables: {},
      }
      return h.listeners['system-prompt/assemble'](assembly, { agent: { session: ORDINARY } }, async () => assembly)
    }
    const newSections = sectionHarness(index.sessionPolicy(parityCfg, ORDINARY))
    const oldSections = sectionHarness(undefined)
    const newResult = await runAssemble(newSections)
    const oldResult = await runAssemble(oldSections)
    assert.deepEqual(newResult, oldResult, '普通会话的 system-prompt/assemble 结果必须与改动前逐字节一致')
    assert.deepEqual(
      newSections.contexts['tdai:state'].text({ agent: { session: ORDINARY } }),
      oldSections.contexts['tdai:state'].text({ agent: { session: ORDINARY } }),
      '普通会话的 tdai:state 快照必须与改动前逐字节一致',
    )
    assert.ok(textOf(newResult, 'tdai:session-context').includes('<session_context>'), '普通会话仍应注入身份')
    assert.ok(textOf(newResult, 'tdai:profile-memory').includes('<tdai_profile_memory>'), '普通会话仍应注入画像')

    // 普通会话的召回也逐字一致（新策略多了 skillInject 字段，不能改变 query 口径）。
    const recallHarness = (policy) => {
      const events = []
      const runtime = {
        readEnabled: () => true,
        config: { ...parityCfg, skillRecallMinScore: 0 },
        assets: { warm: () => Promise.resolve(null), peek: () => ({ ctxs: [] }) },
        client: {
          searchL1: async () => [{ id: 'm1', type: 'rule', content: '用户偏好：先读文档再动手', score: 0.91 }],
          searchSkills: async () => ({ items: [{ skill_id: 's1', name: 'tdai-team-knowledge', score: 9, description: '团队知识库检索' }] }),
        },
        log: () => {},
        ...(policy ? { readPolicyFor: () => policy, dsbotReady: async () => {} } : {}),
      }
      wireRecall({ on: (ev, cb) => events.push([ev, cb]) }, runtime)
      return events[0][1]
    }
    const runRecall = async (handler) => {
      const payload = { agent: { session: ORDINARY }, messages: [{ ...HUMAN_MESSAGE }], turn: 1, step: 1 }
      return handler(payload, async () => ({ kind: 'enter', messages: payload.messages }))
    }
    const newDecision = await runRecall(recallHarness(index.sessionPolicy(parityCfg, ORDINARY)))
    const oldDecision = await runRecall(recallHarness(undefined))
    const normalize = (decision) => decision.messages.map((m) => ({ role: m.role, source: m.source, content: m.content }))
    assert.deepEqual(normalize(newDecision), normalize(oldDecision), '普通会话的召回注入必须与改动前逐字节一致')
    assert.ok(messagesText(newDecision).includes('<tdai_recalled_l1_memories>'), '普通会话仍应有 L1 召回')
    assert.ok(messagesText(newDecision).includes('<tdai_recalled_skills>'), '普通会话仍应有 skill 召回')
  }

  // ── 1) Bot 会话：身份 / 记忆恒关（assemble 不注入、pre-step 不召回 L1）──────
  {
    const fetch = withFetch()
    try {
      const h = await bootFixture({ knowledgeEnabled: false })
      const result = await assemble(h, BOT)
      assert.equal(textOf(result, 'tdai:session-context'), '', 'Bot 会话不应注入 <session_context>')
      assert.equal(textOf(result, 'tdai:profile-memory'), '', 'Bot 会话不应注入 <tdai_profile_memory>')
      assert.equal(stateTextOf(h, BOT), '', 'Bot 会话不应有 tdai:state 快照（记忆面）')

      // pre-step：身份/记忆恒关 + skill 面开着 → 只注 skill，不注 L1。
      const before = { l1: fetch.calls.searchL1, skills: fetch.calls.searchSkills }
      const decision = await preStep(h, BOT, [BOT_RELAY])
      assert.equal(fetch.calls.searchL1, before.l1, 'Bot 会话不应做 L1 召回（记忆面恒关）')
      assert.equal(fetch.calls.searchSkills, before.skills + 1, 'Bot 会话应做 skill 召回（skill 面默认开）')
      assert.ok(!messagesText(decision).includes('<tdai_recalled_l1_memories>'), 'Bot 会话不应出现 <tdai_recalled_l1_memories>')
      assert.ok(messagesText(decision).includes('<tdai_recalled_skills>'), 'Bot 会话应出现 <tdai_recalled_skills>')
      // ③ skill query 必须走 buildBotSkillQuery：从 relay 信封里抽正文，而不是普通口径的空串。
      const query = fetch.calls.skillQueries.at(-1)
      assert.ok(query.includes('帮我看看读侧接线'), `Bot 会话的 skill query 应来自 relay 正文，实际：${JSON.stringify(query)}`)
      assert.ok(!query.includes('Group chat'), 'Bot 会话的 skill query 不应带着信封前缀')

      // ③b DM 形态：真人消息是 kind='user'，query 必须是它 —— 这条曾经写成"只认 kind=bot"，
      // 结果 DM 轮 query 恒空、自动 skill 召回一次都不发生（现场 2026-10-22 23:55 实证）。
      // 用另一个 Bot 会话（BOT_CURRENT）跑 DM：同一会话的 skill 签名去重是另一条既定行为，
      // 混在一起会让"注入了没有"取决于上一条用例。
      const beforeDm = fetch.calls.searchSkills
      const dmDecision = await preStep(h, BOT_CURRENT, [BOT_RELAY, BOT_DM])
      assert.equal(fetch.calls.searchSkills, beforeDm + 1, 'DM 轮应做自动 skill 召回')
      assert.equal(
        fetch.calls.skillQueries.at(-1),
        '和你的对话，测试是否有注入云端 skill',
        'DM 轮的 query 应是最近一条真人消息，而不是更早的握手包',
      )
      assert.ok(messagesText(dmDecision).includes('<tdai_recalled_skills>'), 'DM 轮应注入 skill 块')

      // agent/created 预热：只按新策略的面走 —— Bot 会话这里一个资产请求都不该发，
      // 普通会话（记忆面）照常预热。
      const countBefore = fetch.calls.total
      for (const cb of h.listeners.get('agent/created') || []) await cb({ agent: { session: BOT } })
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert.equal(fetch.calls.total, countBefore, 'Bot 会话（知识面关）预热不应打网关')
      for (const cb of h.listeners.get('agent/created') || []) await cb({ agent: { session: ORDINARY } })
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert.ok(fetch.calls.total > countBefore, '普通会话预热应照常打网关')
    } finally {
      fetch.restore()
    }
  }

  // ── 2) knowledge 面：Bot 会话只受全局 knowledgeEnabled 约束 ─────────────────
  {
    const fetch = withFetch({
      knowledge: [{ knowledge_id: 'k-wiki', type: 'wiki', name: '团队 wiki', service_url: 'http://kb.invalid/v3' }],
    })
    try {
      const h = await bootFixture({ knowledgeEnabled: true })
      const withKnowledge = await assemble(h, BOT)
      assert.ok(textOf(withKnowledge, 'tdai:knowledge-tools').includes('<knowledge_tools>'),
        'knowledgeEnabled=true 时 Bot 会话应有 <knowledge_tools>')
      assert.ok(fetch.calls.knowledgeList >= 1, 'Bot 会话的知识面应真的打到 /v3/knowledge/list')
      assert.equal(textOf(withKnowledge, 'tdai:session-context'), '', '知识面开着也不该连带注入身份')
      assert.equal(textOf(withKnowledge, 'tdai:profile-memory'), '', '知识面开着也不该连带注入画像')

      // 面板关掉知识总开关（volatile）：同一条 Bot 会话立即没有该段。
      h.config.knowledgeEnabled = false
      const withoutKnowledge = await assemble(h, BOT)
      assert.equal(textOf(withoutKnowledge, 'tdai:knowledge-tools'), '',
        'knowledgeEnabled=false 时 Bot 会话不应有 <knowledge_tools>')
    } finally {
      fetch.restore()
    }
  }

  // ── 3) skill 注入开关：有效值与 query 分流 ──────────────────────────────────
  {
    const fetch = withFetch()
    try {
      const h = await bootFixture({ knowledgeEnabled: false })

      // (a) botSkillInjectEnabled=false → 不检索、不注入；身份/记忆照样不注入。
      h.config.botSkillInjectEnabled = false
      const offDecision = await preStep(h, BOT, [BOT_RELAY])
      assert.equal(fetch.calls.searchSkills, 0, 'botSkillInjectEnabled=false 时不应做 skill 检索')
      assert.ok(!messagesText(offDecision).includes('<tdai_recalled_skills>'), 'botSkillInjectEnabled=false 时不应有 <tdai_recalled_skills>')
      const offAssemble = await assemble(h, BOT)
      assert.equal(textOf(offAssemble, 'tdai:session-context'), '', 'skill 关掉时 Bot 会话仍无身份')
      assert.equal(textOf(offAssemble, 'tdai:profile-memory'), '', 'skill 关掉时 Bot 会话仍无画像')

      // (b) 面板打开（volatile 原地生效）→ 检索 + 注入。
      h.config.botSkillInjectEnabled = true
      const onDecision = await preStep(h, BOT, [BOT_RELAY])
      assert.equal(fetch.calls.searchSkills, 1, '打开后应做一次 skill 检索')
      assert.ok(messagesText(onDecision).includes('<tdai_recalled_skills>'), '打开后应注入 <tdai_recalled_skills>')

      // (c) 全局 skillsEnabled=false → 有效值仍是关（串联语义）。
      h.config.skillsEnabled = false
      const gateDecision = await preStep(h, BOT, [BOT_RELAY])
      assert.equal(fetch.calls.searchSkills, 1, '全局 skill 闸关闭后不应再检索')
      assert.ok(!messagesText(gateDecision).includes('<tdai_recalled_skills>'), '全局 skill 闸关闭后不应注入')
    } finally {
      fetch.restore()
    }
  }

  // ── 5) dsbotAwarenessEnabled=false → Bot 会话回到普通会话策略 ────────────────
  {
    const fetch = withFetch()
    try {
      const h = await bootFixture({ knowledgeEnabled: false })

      const lean = await assemble(h, BOT)
      assert.equal(textOf(lean, 'tdai:session-context'), '', '总闸打开时 Bot 会话是 lean')
      assert.equal(stateTextOf(h, BOT), '', '总闸打开时 Bot 会话没有状态快照')

      h.config.dsbotAwarenessEnabled = false
      const restored = await assemble(h, BOT)
      assert.ok(textOf(restored, 'tdai:session-context').includes('<session_context>'),
        '总闸关闭后身份必须恢复（Bot 会话按普通会话处理）')
      assert.ok(textOf(restored, 'tdai:profile-memory').includes('<tdai_profile_memory>'),
        '总闸关闭后画像必须恢复（记忆面）')
      assert.ok(stateTextOf(h, BOT).includes('TDAI memory 状态'), '总闸关闭后状态快照必须恢复（记忆面）')

      const decision = await preStep(h, BOT, [BOT_RELAY])
      assert.ok(fetch.calls.searchL1 > 0, '总闸关闭后 Bot 会话应恢复 L1 召回')
      assert.ok(messagesText(decision).includes('<tdai_recalled_l1_memories>'),
        '总闸关闭后 Bot 会话应出现 <tdai_recalled_l1_memories>')
    } finally {
      fetch.restore()
    }
  }

  // ── 6) /tdai-status 的 dsbot= 行（有效值，不是配置值）───────────────────────
  {
    const fetch = withFetch()
    try {
      const h = await bootFixture({ knowledgeEnabled: false })
      // 先 assemble 一次：dsbot 索引是 apply 时异步预热的，策略行要读它。
      await assemble(h, BOT)

      const statusCommand = () => h.commands.find((c) => c.name === 'tdai-status')
      assert.ok(statusCommand(), '应注册 /tdai-status')
      const runStatus = async (session) => {
        const result = await statusCommand().handler({ agent: { session }, rawInput: '/tdai-status' })
        assert.equal(result.kind, 'success', `状态命令应成功，实际：${result.text}`)
        return result.text.split('\n').find((line) => line.startsWith('dsbot='))
      }

      const ledgerPath = join(h.home, 'storages', 'tdai-memory-plugin', 'dsbot-state.json')
      assert.equal(await runStatus(BOT),
        `dsbot=bot skill=on write=off bot=bot-chief room=- ledger=${ledgerPath}`,
        'Bot 会话状态行应打印四态、有效值与台账路径')

      // 面板关掉 skill 注入：skill= 立刻变成 off（有效值，不是配置值）。
      h.config.botSkillInjectEnabled = false
      assert.equal(await runStatus(BOT),
        `dsbot=bot skill=off write=off bot=bot-chief room=- ledger=${ledgerPath}`,
        'skill= 必须打有效值')

      // 房间 / 群成员隐藏会话：bot 为空（打 '-'），room 有值。
      assert.equal(await runStatus(ROOM),
        `dsbot=room skill=off write=off bot=- room=room-alpha ledger=${ledgerPath}`,
        '房间会话状态行应对应 room/roomId')
      assert.equal(await runStatus(ROOM_MEMBER),
        `dsbot=room-member skill=off write=off bot=- room=room-alpha ledger=${ledgerPath}`,
        '群成员隐藏会话状态行应对应 room-member（写侧永不写）')

      // 总闸关闭：回到 ordinary，bot/room 都是 '-'；write 回到普通会话的 captureAllowed。
      h.config.dsbotAwarenessEnabled = false
      assert.equal(await runStatus(BOT),
        `dsbot=ordinary skill=on write=on bot=- room=- ledger=${ledgerPath}`,
        '总闸关闭后状态行应显示 ordinary（写侧回到普通会话的 captureAllowed）')
    } finally {
      fetch.restore()
    }
  }

  console.log('dsbot-readside tests passed: 四态判定 / lean 注入 / knowledge 面 / skill 开关与 query 分流 / 普通会话零 diff / 总闸回滚 / 状态行有效值')
} finally {
  // 环境与临时目录收尾：DSH_HOME 是进程级 env，测试之间不能泄漏。
  if (originalDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalDshHome
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true })
}
