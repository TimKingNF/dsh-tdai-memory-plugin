/**
 * 子 agent 会话策略测试（默认：**能力面拆分 —— 保留知识库与工具，关闭身份与记忆**）。
 *
 * 为什么必须有这个测试：这是一条"沉默的默认行为"——子 agent 会话拿不到父 agent 的
 * 身份与记忆注入，但**知识库（wiki / code-graph）与 10 个只读工具照常可用**。它失效的
 * 方向有三种，都不会报错：
 *   1. **降级没生效**：子会话又拿到父 agent 的画像 / 召回，任务被干扰，且整段执行过程
 *      作为 L0 语料回流（实测一个 23 步的调查子 agent 写入了 37 条）；
 *   2. **降级过度**：把**知识面**也一起关掉了 —— 这是真实事故：一个四人调查团队的
 *      `tdai_knowledge_call` 全部被策略拒绝，wiki 原文只能由父会话逐页投喂；
 *   3. **降级越界**：把**父会话**也一起降级了（判据写错、header 读不到就一律当子会话），
 *      结果是正常会话突然没有记忆——这类事故用户只会觉得"插件坏了"。
 * 所以每个用例都**成对**断言：子会话降级 + 父会话照旧。
 *
 * 判定依据是 DSH 的 durable 字段 `session.header.origin === 'subagent'`（`delegationDepth`
 * 兜底），spawn 与 fork 两种子会话都由 `dsh-subagent` 的 `childSessionMeta()` 写入。
 * 缺 header 一律按父会话处理（fail-open 到"维持现状"，老宿主与单测夹具都不该被误伤）。
 *
 * 运行：node test/subagent.test.mjs
 */
import assert from 'node:assert'
import { isSubagentSession, readSideAllowed, subagentReadPolicy, captureAllowed } from '../lib/subagent.mjs'
import { registerSections } from '../lib/sections.mjs'
import { wireRecall } from '../lib/recall.mjs'
import { wireCapture } from '../lib/capture.mjs'
import { registerKnowledgeTools } from '../lib/tools.mjs'
import { apply } from '../index.mjs'

/** 顶层会话：没有 header 里的子 agent 标记。 */
const PARENT = { id: 's-parent' }
/** spawn 子会话（实测 header 形态）。 */
const CHILD = {
  id: 's-child',
  header: { version: 0, id: 's-child', createdAt: 1, cwd: '/w', parentSession: 's-parent', isSeeded: false, origin: 'subagent', delegationDepth: 1, agentPreset: 'standard' },
}
/** fork 子会话：带 seed 前缀，但同样是子 agent。 */
const FORK_CHILD = { id: 's-fork', header: { id: 's-fork', parentSession: 's-parent', isSeeded: true, origin: 'subagent', delegationDepth: 1 } }
/** 只打了 delegationDepth 的（origin 缺失时的兜底判据）。 */
const DEPTH_ONLY = { id: 's-depth', header: { id: 's-depth', parentSession: 's-parent', delegationDepth: 2 } }
/** 缺 header（老宿主 / 单测夹具）：按父会话处理。 */
const NO_HEADER = { id: 's-bare' }

const BASE = {
  enabled: true, recallEnabled: true, injectionEnabled: true, captureEnabled: true,
  sessionContextEnabled: true, profileMemoryEnabled: true, skillsEnabled: true, knowledgeEnabled: true,
  subagentInjectionEnabled: false, subagentCaptureEnabled: false,
  serviceId: 'svc', teamId: 't', agentId: 'a', userId: 'u', taskId: undefined,
  recallLimit: 5, recallTimeoutMs: 3000,
}

const FULL_FACETS = { identity: true, memory: true, skills: true, knowledge: true }

// ── 1) 判定与策略（纯函数）──────────────────────────────────────────────────
{
  assert.equal(isSubagentSession(CHILD), true, 'origin=subagent 应判为子会话')
  assert.equal(isSubagentSession(FORK_CHILD), true, 'fork 子会话同样是子 agent')
  assert.equal(isSubagentSession(DEPTH_ONLY), true, 'origin 缺失时 delegationDepth>0 兜底')
  assert.equal(isSubagentSession(PARENT), false, '顶层会话没有 header → 不是子会话')
  assert.equal(isSubagentSession(NO_HEADER), false, '缺 header 一律按父会话（fail-open）')
  assert.equal(isSubagentSession(undefined), false, '空会话不崩')

  // 默认配置（两个开关都关）：
  //   子会话 —— 身份 / 记忆 / 云端 skill 目录关闭，**知识面打开**；
  //   父会话 —— 四个面全开，不受子 agent 开关影响。
  assert.deepEqual(subagentReadPolicy(BASE, CHILD), {
    subagent: true, inherit: false, identity: false, memory: false, skills: false, knowledge: true,
  }, '默认：子会话只保留知识面')
  assert.deepEqual(subagentReadPolicy(BASE, PARENT), {
    subagent: false, inherit: true, ...FULL_FACETS,
  }, '默认：父会话四个面全开')
  assert.deepEqual(subagentReadPolicy(BASE, NO_HEADER), {
    subagent: false, inherit: true, ...FULL_FACETS,
  }, '默认：缺 header 按父会话')
  // 旧口径（全量继承）在子会话上仍是 false —— 语义没被偷偷放宽
  assert.equal(readSideAllowed(BASE, CHILD), false, '默认：子会话不继承身份与记忆')
  assert.equal(readSideAllowed(BASE, PARENT), true, '默认：父会话照旧')
  assert.equal(readSideAllowed(BASE, NO_HEADER), true, '默认：缺 header 按父会话')
  assert.equal(captureAllowed(BASE, CHILD), false, '默认：子会话不回流')
  assert.equal(captureAllowed(BASE, PARENT), true, '默认：父会话照常回流')

  // 开关打开：子会话恢复"与父会话完全一致"
  const inheritAll = { ...BASE, subagentInjectionEnabled: true, subagentCaptureEnabled: true }
  assert.deepEqual(subagentReadPolicy(inheritAll, CHILD), {
    subagent: true, inherit: true, ...FULL_FACETS,
  }, '开了开关子会话应全量继承（含身份与记忆）')
  assert.equal(readSideAllowed(inheritAll, CHILD), true, '开了开关子会话应继承读侧')
  assert.equal(captureAllowed(inheritAll, CHILD), true, '开了开关子会话应回流')
}

// ── 2) 读侧 · system 注入：子会话只少身份 / 记忆 / 云端 skill 目录 ───────────
{
  const cfg = { ...BASE, enabled: true }
  const listeners = {}
  const skills = []
  const ensurePolicies = []
  let ensureCalls = 0
  const asset = {
    identity: {},
    agentDetail: { id: 'a', name: 'Coder', description: 'd', prompt: 'p' },
    taskDetail: null,
    profiles: [{ ctx: { agentId: 'a', agentName: 'Coder', isSelf: true }, l3: { content: 'persona' }, l2Entries: [{ path: 'p.md', summary: 's' }] }],
    skills: { listing: '- sk1: one' },
    knowledge: [{ knowledge_id: 'k1', type: 'code-graph', name: 'repo', service_url: 'http://kb' }],
  }
  const ctx = {
    systemPrompt: {
      section: (s) => { listeners[`section:${s.name}`] = s },
      context: (c) => { listeners[`context:${c.name}`] = c },
    },
    on: (ev, cb) => { listeners[ev] = cb },
    // 假宿主提供 skills 服务（cordis 语义：只经 inject 回调给出）
    inject: (deps, cb) => { if (deps.includes('skills')) cb({ skills: { register: (s) => skills.push(s) } }) },
  }
  const runtime = {
    readEnabled: () => cfg.enabled,
    config: cfg,
    assets: {
      ensure: async (_sessionId, policy) => { ensureCalls += 1; ensurePolicies.push(policy); return null },
      peek: () => asset,
    },
    log: () => {},
  }
  registerSections(ctx, runtime)

  const assemble = async (session) => {
    const assembly = {
      sections: [
        { name: 'harness:identity', text: 'You are an AI agent.' },
        { name: 'tdai:session-context', text: '' },
        { name: 'tdai:profile-memory', text: '' },
        { name: 'tdai:available-skills', text: '' },
        { name: 'tdai:knowledge-tools', text: '' },
      ],
      contexts: [], tools: [], variables: {},
    }
    return listeners['system-prompt/assemble'](assembly, { agent: { session } }, async () => assembly)
  }
  const text = (result, name) => result.sections.find((s) => s.name === name).text
  const stateText = (session) => listeners['context:tdai:state'].text({ agent: { session } })

  // (a) 父会话：4 段都注入、知识 skill 注册、状态快照有内容、资产照常加载
  const parentResult = await assemble(PARENT)
  for (const name of ['tdai:session-context', 'tdai:profile-memory', 'tdai:available-skills', 'tdai:knowledge-tools']) {
    assert.ok(text(parentResult, name).length > 0, `父会话应注入 ${name}`)
  }
  assert.equal(skills.length, 1, '父会话应注册知识 skill')
  assert.ok(stateText(PARENT).includes('TDAI memory 状态'), '父会话应有状态快照')
  const parentEnsure = ensureCalls
  assert.ok(parentEnsure > 0, '父会话 assemble 应触发资产加载')
  assert.deepEqual(ensurePolicies.at(-1), { subagent: false, inherit: true, ...FULL_FACETS },
    '父会话按全量面加载资产')

  // (b) 子会话（默认）：身份 / 记忆 / 云端 skill 目录三段为空（DSH 的 renderPrompt 会把
  //     空段整个丢掉），状态快照为空；但**知识路由在、知识 skill 注册了、资产按知识面加载**
  //     —— 子 agent 要能自己查 wiki / code-graph。
  ensureCalls = 0
  ensurePolicies.length = 0
  const childResult = await assemble(CHILD)
  for (const name of ['tdai:session-context', 'tdai:profile-memory', 'tdai:available-skills']) {
    assert.equal(text(childResult, name), '', `子会话不应注入 ${name}`)
  }
  assert.ok(text(childResult, 'tdai:knowledge-tools').includes('<knowledge_tools>'),
    '子会话应注入知识路由（知识库与工具对子 agent 可用）')
  assert.equal(text(childResult, 'harness:identity'), 'You are an AI agent.', '别人的段不许动')
  assert.equal(skills.length, 2, '子会话应注册知识 skill')
  assert.equal(stateText(CHILD), '', '子会话不应有状态快照')
  assert.ok(ensureCalls > 0, '子会话应按知识面加载资产（知识库要能用）')
  assert.deepEqual(ensurePolicies.at(-1), {
    subagent: true, inherit: false, identity: false, memory: false, skills: false, knowledge: true,
  }, '子会话的资产加载必须只带知识面（不为画像 / skill listing 打网关）')

  // (c) fork 子会话同样降级（它带着父会话的 seed 历史，更容易被误当父会话）
  assert.equal(stateText(FORK_CHILD), '', 'fork 子会话同样降级')

  // (d) 开关打开：子会话恢复继承（与父会话一致）
  cfg.subagentInjectionEnabled = true
  ensureCalls = 0
  const inherited = await assemble(CHILD)
  assert.ok(text(inherited, 'tdai:profile-memory').includes('<tdai_profile_memory>'), '开关打开后子会话应注入')
  assert.equal(skills.length, 2, '知识 skill 按 session 幂等：这个子会话在 (b) 已注册过，不再重复')
  assert.ok(stateText(CHILD).includes('TDAI memory 状态'), '开关打开后子会话应有状态快照')
  assert.ok(ensureCalls > 0, '开关打开后子会话照常加载资产')

  // (e) 缺 header：按父会话处理（fail-open，不能因为读不到 header 就静默失去记忆）
  cfg.subagentInjectionEnabled = false
  assert.ok(stateText(NO_HEADER).includes('TDAI memory 状态'), '缺 header 的会话应按父会话注入')
}

// ── 3) 读侧 · L1 召回：子会话不检索、不预热资产 ──────────────────────────────
{
  const make = (cfgOverrides) => {
    const cfg = { ...BASE, ...cfgOverrides }
    const calls = { search: 0, warm: 0, policy: null }
    const events = []
    const runtime = {
      readEnabled: () => cfg.enabled,
      config: cfg,
      assets: {
        warm: (_sessionId, policy) => { calls.warm += 1; calls.policy = policy; return Promise.resolve(null) },
        peek: () => ({ ctxs: [] }),
      },
      client: { searchL1: async () => { calls.search += 1; return [{ id: '1', type: 'rule', content: 'remember X', score: 0.9 }] } },
      log: () => {},
    }
    wireRecall({ on: (ev, cb) => events.push([ev, cb]) }, runtime)
    return { handler: events[0][1], calls }
  }
  const chain = (session) => {
    const messages = [{ role: 'user', content: 'hi', id: 'm1' }]
    return { payload: { agent: { session }, messages, turn: 1, step: 1 }, next: async () => ({ kind: 'enter', messages }) }
  }
  const hasRecall = (decision) => (decision.messages ?? []).some((m) => m?.source?.kind === 'plugin:dsh-tdai-memory-plugin')

  // (a) 父会话：检索 + 注入（确认这套夹具本身是会注入的）
  {
    const { handler, calls } = make({})
    const { payload, next } = chain(PARENT)
    const decision = await handler(payload, next)
    assert.equal(calls.search, 1, '父会话应做一次 L1 检索')
    assert.equal(calls.warm, 1, '父会话应预热资产')
    assert.equal(calls.policy?.memory, true, '父会话预热应带记忆面')
    assert.ok(hasRecall(decision), '父会话应注入召回块')
  }
  // (b) 子会话：一次都不检索、不预热、决策原样（L1 召回属记忆面）
  {
    const { handler, calls } = make({})
    const { payload, next } = chain(CHILD)
    const expected = await next()
    const decision = await handler(payload, () => Promise.resolve(expected))
    assert.equal(calls.search, 0, '子会话不应做 L1 检索')
    assert.equal(calls.warm, 0, '子会话不应在召回路径上预热资产')
    assert.deepEqual(decision, expected, '子会话的 decision 应原样透传（不加消息）')
  }
  // (c) 开关打开：恢复继承
  {
    const { handler, calls } = make({ subagentInjectionEnabled: true })
    const { payload, next } = chain(CHILD)
    const decision = await handler(payload, next)
    assert.equal(calls.search, 1, '开关打开后子会话应检索')
    assert.ok(hasRecall(decision), '开关打开后子会话应注入召回块')
  }
  // (d) 守卫职责不受降级影响：next() 返回 undefined 仍要兜底成 enter
  {
    const { handler } = make({})
    const { payload } = chain(CHILD)
    const decision = await handler(payload, async () => undefined)
    assert.equal(decision?.kind, 'enter', '降级路径上守卫仍须兜底 undefined')
  }
}

// ── 4) 写侧 · 回流：子 agent 的执行过程不进 L0 ───────────────────────────────
{
  const harness = (cfgOverrides = {}) => {
    const cfg = { ...BASE, ...cfgOverrides }
    const handlers = {}
    const written = []
    const archived = []
    const logs = []
    const ctx = { on(ev, cb) { (handlers[ev] ||= []).push(cb) } }
    const runtime = {
      config: cfg,
      identityFor: () => ({ session_id: 's-x', team_id: 't', agent_id: 'a', user_id: 'u' }),
      client: {
        async addConversation(_i, messages) { written.push(...messages) },
        async addSkillConversation(_i, messages) { archived.push(...messages) },
      },
      log: (m) => logs.push(m),
      readEnabled: () => true,
      assets: { ensure: async () => null, peek: () => undefined },
    }
    wireCapture(ctx, runtime)
    const emit = (session, type, data) => {
      for (const cb of handlers['session/event'] || []) cb(session, { type, seq: 1, data })
    }
    const stopTurn = async (session, turn = 1) => {
      for (const cb of handlers['agent/turn-stopping'] || []) await cb({ turn, agent: { session } })
    }
    return { emit, stopTurn, written, archived, logs }
  }
  const userEvent = (text) => ({ message: { role: 'user', content: [{ type: 'text', text }], id: 'msg-1', source: { kind: 'user', rpcId: 'r1' } }, surfaceOp: 'append' })
  const assistantEvent = (text) => ({ turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } } })
  const runTurn = async (h, session) => {
    h.emit(session, 'turn/start', { turn: 1 })
    h.emit(session, 'user/message', userEvent('分析这段 diff'))
    h.emit(session, 'assistant/message', assistantEvent('结论：……'))
    await h.stopTurn(session)
  }

  // (a) 父会话：照常回流
  {
    const h = harness()
    await runTurn(h, PARENT)
    assert.deepEqual(h.written.map((m) => m.content), ['分析这段 diff', '结论：……'], '父会话应回流真人 + 模型消息')
    assert.ok(h.archived.length > 0, '父会话应触发 Skill 归档')
  }
  // (b) 子会话：一条都不回流（含工具结果，整段执行过程都是工作噪音）
  {
    const h = harness()
    await runTurn(h, CHILD)
    h.emit(CHILD, 'tool/result', { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'diff 全文……' }] }] } })
    assert.equal(h.written.length, 0, '子会话不应回流任何消息')
    assert.equal(h.archived.length, 0, '子会话不应触发 Skill 归档')
    assert.equal(h.logs.filter((l) => l.includes('不回流')).length, 0, '不回流是策略不是失败，不该产生告警噪音')
  }
  // (c) fork 子会话：同样不回流
  {
    const h = harness()
    await runTurn(h, FORK_CHILD)
    assert.equal(h.written.length, 0, 'fork 子会话同样不回流')
  }
  // (d) 开关打开：恢复回流
  {
    const h = harness({ subagentCaptureEnabled: true })
    await runTurn(h, CHILD)
    assert.deepEqual(h.written.map((m) => m.content), ['分析这段 diff', '结论：……'], '开关打开后子会话应回流')
  }
  // (e) 缺 header：按父会话回流（fail-open）
  {
    const h = harness()
    await runTurn(h, NO_HEADER)
    assert.equal(h.written.length, 2, '缺 header 的会话应按父会话回流')
  }
}

// ── 5) 知识工具：子会话**照常可用**（这正是本次修正的动机）──────────────────
{
  const make = (cfgOverrides = {}, { asset, policy } = {}) => {
    const cfg = { ...BASE, knowledgeEnabled: true, ...cfgOverrides }
    const tools = []
    const calls = { ensure: 0, executed: 0 }
    const ctx = { tools: { register: (def) => { tools.push(def) } } }
    const runtime = {
      readEnabled: () => true,
      config: cfg,
      // 与 index.mjs 的接线一致：能力面按会话算
      readPolicyFor: (session) => policy ?? subagentReadPolicy(cfg, session),
      assets: {
        peek: () => asset,
        ensure: async () => { calls.ensure += 1; return asset },
      },
      client: {
        knowledgeToolsList: async () => [],
        knowledgeToolsCall: async () => { calls.executed += 1; return { ok: true, text: '结果原文' } },
      },
      log: () => {},
    }
    registerKnowledgeTools(ctx, runtime)
    const tool = tools.find((t) => t.name === 'tdai_knowledge_call')
    return { call: (session) => tool.execute({ knowledge_id: 'k1', tool_name: 'explore' }, { agent: { session } }), calls }
  }
  const resource = { knowledge_id: 'k1', type: 'code-graph', name: 'repo', service_url: 'http://kb' }

  // (a) 子会话 + 已装资产：**直接执行**，不再被策略拒绝
  {
    const h = make({}, { asset: { knowledge: [resource] } })
    assert.equal(await h.call(CHILD), '结果原文', '子会话应能直接调用知识工具')
    assert.equal(h.calls.executed, 1, '子会话的调用应真的打到知识服务')
  }
  // (b) 子会话 + 缓存未就绪：按知识面补一次 ensure，再执行
  {
    let resolved = null
    const h = make({}, { asset: undefined })
    // 用具名 ensure 覆盖默认值，模拟"assemble 还没跑"的冷启动
    h.calls.ensure = 0
    const tools = []
    const ctx = { tools: { register: (def) => tools.push(def) } }
    const cfg = { ...BASE, knowledgeEnabled: true }
    const runtime = {
      readEnabled: () => true,
      config: cfg,
      readPolicyFor: (session) => subagentReadPolicy(cfg, session),
      assets: {
        peek: () => resolved,
        ensure: async () => { h.calls.ensure += 1; resolved = { knowledge: [resource] }; return resolved },
      },
      client: { knowledgeToolsList: async () => [], knowledgeToolsCall: async () => ({ ok: true, text: '冷启动结果' }) },
      log: () => {},
    }
    registerKnowledgeTools(ctx, runtime)
    const tool = tools.find((t) => t.name === 'tdai_knowledge_call')
    const out = await tool.execute({ knowledge_id: 'k1', tool_name: 'explore' }, { agent: { session: CHILD } })
    assert.equal(out, '冷启动结果', '缓存未就绪时子会话应补加载后执行')
    assert.equal(h.calls.ensure, 1, '且只补一次')
  }
  // (c) 仍没有绑定资源：给的是"未绑定"而不是"子 agent 被拒"
  {
    const h = make({}, { asset: { knowledge: [] } })
    const childMsg = await h.call(CHILD)
    assert.ok(childMsg.includes('没有绑定团队知识资源'), `子会话应走正常路径，实际：${childMsg}`)
    assert.ok(!childMsg.includes('子 agent 会话'), '不该再出现"子会话已降级"的拒绝文案')
    const parentMsg = await h.call(PARENT)
    assert.ok(parentMsg.includes('没有绑定团队知识资源'), `父会话同上，实际：${parentMsg}`)
  }
  // (d) 防御路径：知识面被显式关掉时给可解释的文案
  {
    const off = { subagent: true, inherit: false, identity: false, memory: false, skills: false, knowledge: false }
    const h = make({}, { asset: { knowledge: [resource] }, policy: off })
    const msg = await h.call(CHILD)
    assert.ok(msg.includes('知识侧已被策略关闭'), `知识面关闭时应可解释，实际：${msg}`)
    assert.equal(h.calls.executed, 0, '知识面关闭时不该打知识服务')
  }
}

// ── 6) 端到端：会话建立（agent/created）按能力面预热 ─────────────────────────
{
  const realFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = async () => { fetchCalls += 1; return { ok: true, json: async () => ({ code: 0, data: {} }) } }
  try {
    const boot = (overrides) => {
      const registered = { listeners: {}, tools: [], sections: [] }
      const ctx = {
        logger: { warn() {} },
        inject() {},
        on(ev, cb) { (registered.listeners[ev] ||= []).push(cb) },
        get() { return undefined },
        tools: { register(def) { registered.tools.push(def) } },
        systemPrompt: { section(s) { registered.sections.push(s) }, context() {} },
        sessions: { list() { return [] } },
      }
      apply(ctx, {
        enabled: true, captureEnabled: true, recallEnabled: true, injectionEnabled: true,
        sessionContextEnabled: true, profileMemoryEnabled: true, skillsEnabled: true, knowledgeEnabled: false,
        serviceId: 'svc', teamId: 't', agentId: 'a', userId: 'u',
        ...overrides,
      })
      return registered
    }
    const start = async (registered, session) => {
      fetchCalls = 0
      for (const cb of registered.listeners['agent/created'] || []) cb({ agent: { session } })
      await new Promise((resolve) => setTimeout(resolve, 30))
      return fetchCalls
    }

    // (a) 知识总开关关（子会话无面可用）：预热不该触发任何资产请求
    {
      const registered = boot({ knowledgeEnabled: false })
      assert.equal(await start(registered, CHILD), 0, '子会话没有可用面时预热不该触发任何资产请求')
      assert.ok(await start(registered, PARENT) > 0, '父会话预热应照常打网关')
    }
    // (b) 知识总开关开：子会话**要**预热（它的知识面要用），父会话照旧
    {
      const registered = boot({ knowledgeEnabled: true })
      assert.ok(await start(registered, CHILD) > 0, '开着知识面的子会话应预热知识资源')
      assert.ok(await start(registered, PARENT) > 0, '父会话预热应照常打网关')
    }
  } finally {
    globalThis.fetch = realFetch
  }
}

console.log('subagent tests passed: 判定 / 知识面保留 / 身份与记忆不注入 / L1 不召回 / 按面预热 / 不回流 / 知识工具可用 / 父会话照旧')
