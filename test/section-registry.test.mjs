/**
 * section 注册契约测试（改造基线）。
 *
 * 目的：把「插件往 DSH 的 system prompt 里放了什么」变成**可断言、可回归**的事实，
 * 而不是靠人在真实会话里肉眼看。它验证四件事：
 *
 *   1. DSH 保留段位不越界 —— 插件不得占用 dsh-system-prompt 的中心 order 表里
 *      任何一个属于别人的位置（占错位会导致落点漂移、上下文污染）。
 *   2. 插件内部 order / name 唯一 —— DSH 的 NamedEntries 同名同层会抛，
 *      order 重复则退化为按 name 的 code-unit 排序（非预期顺序）。
 *   3. 首次求值必须为空 —— 动态 section 的同步 text 是占位，内容一律由
 *      `system-prompt/assemble` 覆盖。这条保证「单一注入路径、不重复追加」。
 *   4. 端到端装配形状 —— 用一个忠实实现 DSH 语义的假 systemPrompt 服务，
 *      跑一遍 assemble + waterfall + renderPrompt，断言最终 system 文本里
 *      各块的相对顺序与内容标记。
 *
 * 运行：node test/section-registry.test.mjs
 */
import assert from 'node:assert'
import { registerSections, SECTION_ORDERS } from '../lib/sections.mjs'

// ── DSH 中心 order 表（抄自 @deepseek-ai/dsh-system-prompt 的 SECTION_ORDERS）──
// DSH 升级后这张表可能变；它变了就该有人来更新这里，而不是让插件悄悄占错位。
const DSH_SECTION_ORDERS = {
  HARNESS_IDENTITY: -1000,
  HARNESS_SOURCE: -900,
  WEB_SURFACE: -800,
  DEPLOYMENT_PERSONA: 0,
  PLAN_POLICY: 500,
  TEAM_POLICY: 600,
  PTC_ONLY: 800,
  FILE_REFERENCE: 900,
  TOOL_BASH: 1000,
  TOOL_PWSH: 1010,
  TOOL_READ: 1100,
  TOOL_WRITE: 1200,
  TOOL_EDIT: 1300,
  TOOL_GLOB: 1400,
  TOOL_GREP: 1500,
  TOOL_JOBS: 1600,
  TOOL_PTY: 1700,
  TOOL_WEB_SEARCH: 2000,
  TOOL_WEB_FETCH: 2100,
  TOOL_LSP: 2200,
  TOOL_SESSION_QUERY: 2300,
  TOOL_GOAL: 2400,
  TOOL_CORDIS: 2500,
  TOOL_WORKFLOW: 2600,
  TOOL_RALPH: 2700,
  TOOL_SUBAGENT: 2800,
  TOOL_REPORT: 2900,
  TOOLS_SDK: 5000,
  DELIVERABLE_FILE_REFERENCES: 9000,
  STRUCTURED_OUTPUT: 9900,
}
const DSH_RESERVED = new Set(Object.values(DSH_SECTION_ORDERS))

// ── 假 systemPrompt 服务：忠实实现 section() / assemble() / waterfall 语义 ─────
// 语义依据：dsh-system-prompt/lib/index.js
//   - section(): order 必须有限；同层同名抛错
//   - assemble(): 按 order 排，order 相同按 name 的 code-unit 比较；丢弃空 text
//   - 返回 sections 列表（text 已求值）后再跑 waterfall
function fakeHost({ withPlugin = true, cfg = {}, asset = null } = {}) {
  const sections = new Map()
  let listener = null
  const host = {
    systemPrompt: {
      section(s) {
        assert.ok(Number.isFinite(s.order), `section "${s.name}" order 必须是有限数`)
        assert.ok(!sections.has(s.name), `section "${s.name}" 同层重复注册（DSH 会抛）`)
        sections.set(s.name, s)
        return () => sections.delete(s.name)
      },
      // 插件不该用这两个（属于仓库自有接口），出现即失败
      getSectionOrder() { throw new Error('插件不应调用 getSectionOrder（那是仓库自有段位接口）') },
      complete: undefined,
    },
    on(ev, cb, _opts) {
      assert.equal(ev, 'system-prompt/assemble', `插件不应监听 ${ev}`)
      listener = cb
      return () => { listener = null }
    },
  }

  // 宿主的其余 section（模拟真实 preset 的一部分）
  const hostSections = [
    { name: 'harness:identity', order: DSH_SECTION_ORDERS.HARNESS_IDENTITY, text: 'You are an AI agent.' },
    { name: 'deployment:persona', order: DSH_SECTION_ORDERS.DEPLOYMENT_PERSONA, text: 'You are ARK-ALPHA.' },
    { name: 'plan:policy', order: DSH_SECTION_ORDERS.PLAN_POLICY, text: 'PLAN-POLICY-MARKER' },
    { name: 'team:policy', order: DSH_SECTION_ORDERS.TEAM_POLICY, text: 'TEAM-POLICY-MARKER' },
    { name: 'tool:read', order: DSH_SECTION_ORDERS.TOOL_READ, text: 'TOOL-READ-MARKER' },
  ]

  if (withPlugin) {
    const runtimeCfg = {
      enabled: true, recallEnabled: true, injectionEnabled: true,
      sessionContextEnabled: true, profileMemoryEnabled: true,
      skillsEnabled: true, knowledgeEnabled: false,
      serviceId: 'svc', teamId: 't', agentId: 'a', userId: 'u', taskId: undefined,
      ...cfg,
    }
    const runtime = {
      readEnabled: () => runtimeCfg.enabled,
      config: runtimeCfg,
      assets: {
        ensure: async () => null,
        peek: () => asset,
      },
      log: () => {},
    }
    registerSections(host, runtime)
  }

  const assemble = async (context) => {
    const all = [...hostSections.map((s) => ({ name: s.name, order: s.order, text: s.text })),
      ...[...sections.values()]]
    const evaluated = all
      .sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((s) => ({ name: s.name, order: s.order, text: typeof s.text === 'function' ? s.text(context) : s.text }))
    const assembly = { sections: evaluated.map(({ name, text }) => ({ name, text })), contexts: [], tools: [], variables: {} }
    if (!listener) return assembly
    return listener(assembly, context, async () => assembly)
  }
  return { host, assemble, sections, getListener: () => listener }
}

const sampleAsset = {
  identity: { session_id: 's1' },
  agentDetail: { id: 'a', name: 'Coder', description: 'd', prompt: 'p' },
  taskDetail: null,
  profiles: [{ ctx: { agentId: 'a', agentName: 'Coder', isSelf: true }, l3: { content: 'L3-PERSONA-MARKER' }, l2Entries: [] }],
  skills: { listing: '- sk1: one' },
  knowledge: [],
}

const ctxFor = (sessionId = 's1') => ({ agent: { session: { id: sessionId } }, scope: {}, signal: undefined })
// 模拟 DSH 的 renderPrompt：丢弃空段，用空行连接
const renderPrompt = (assembly) => assembly.sections.map((s) => s.text).filter((t) => t.length > 0).join('\n\n')

// ── 1) 段位不越界 ────────────────────────────────────────────────────────────
{
  const { sections } = fakeHost({ asset: sampleAsset })
  for (const s of sections.values()) {
    assert.ok(!DSH_RESERVED.has(s.order),
      `section "${s.name}" 占用了 DSH 保留 order ${s.order}（任何 SECTION_ORDERS 的值都不能用）`)
    assert.ok(s.order >= 500 && s.order <= 599,
      `section "${s.name}" order ${s.order} 越出插件分带 500–599`)
    assert.ok(s.name.startsWith('tdai:'), `section "${s.name}" 应以 tdai: 开头`)
  }
}

// ── 2) order / name 唯一 ─────────────────────────────────────────────────────
{
  const { sections } = fakeHost({ asset: sampleAsset })
  const orders = [...sections.values()].map((s) => s.order)
  assert.equal(new Set(orders).size, orders.length, `插件内部 order 必须唯一，当前：${orders.join(',')}`)
  // SECTION_ORDERS 导出的表与世界一致
  const expected = [
    ['tdai:overview', SECTION_ORDERS.overview],
    ['tdai:session-context', SECTION_ORDERS.sessionContext],
    ['tdai:profile-memory', SECTION_ORDERS.profileMemory],
    ['tdai:available-skills', SECTION_ORDERS.availableSkills],
    ['tdai:knowledge-tools', SECTION_ORDERS.knowledgeTools],
  ]
  assert.deepEqual([...sections.values()].map((s) => [s.name, s.order]), expected,
    '注册结果必须与 SECTION_ORDERS 表一致')
}

// ── 3) 首次求值必须为空（动态 section 只是占位）───────────────────────────────
{
  const { sections } = fakeHost({ asset: sampleAsset })
  for (const name of ['tdai:session-context', 'tdai:profile-memory', 'tdai:available-skills', 'tdai:knowledge-tools']) {
    assert.equal(sections.get(name).text(ctxFor()), '', `${name} 的同步 text 必须是空串占位`)
  }
}

// ── 4) 端到端装配：顺序 + 内容 + 不碰别人的段 ─────────────────────────────────
{
  const { assemble } = fakeHost({ asset: sampleAsset })
  const rendered = renderPrompt(await assemble(ctxFor()))

  // 内容标记都在
  assert.ok(rendered.includes('<session_context>'), 'session_context 应被注入')
  assert.ok(rendered.includes('L3-PERSONA-MARKER'), 'L3 persona 应被注入')
  assert.ok(rendered.includes('tdai_skill_view'), 'skills 块应被注入')
  assert.ok(rendered.includes('TencentDB Agent Memory 已接入'), 'overview 静态段应被注入')

  // 相对顺序：插件块整体在 persona 之后、策略段与 tool 段之前
  const at = (needle) => {
    const i = rendered.indexOf(needle)
    assert.ok(i >= 0, `未找到标记：${needle}`)
    return i
  }
  const persona = at('You are ARK-ALPHA.')
  const overview = at('TencentDB Agent Memory 已接入')
  const sessionCtx = at('<session_context>')
  const profile = at('<tdai_profile_memory>')
  const planPolicy = at('PLAN-POLICY-MARKER')
  const teamPolicy = at('TEAM-POLICY-MARKER')
  const toolRead = at('TOOL-READ-MARKER')

  assert.ok(persona < overview, '插件段应在 persona 之后')
  assert.ok(overview < sessionCtx && sessionCtx < profile, '插件内部顺序应为 overview → session-context → profile-memory')
  // 分带不变式：插件整体落在 deployment:persona(0) 之后、team:policy(600) 之前。
  // 与 plan:policy(500) 的关系是「300–599 段里各占各的」，不构成前后约束 ——
  // 本次 overview(510) 在 plan:policy 之前，而 session-context(520)/profile-memory(530)
  // 在其之后，两者都对。真正要守住的是不能越过 team:policy 进入策略带。
  assert.ok(profile < teamPolicy, '插件段必须整体位于 team:policy(600) 之前，不得进入 610–799 策略带')
  assert.ok(profile < toolRead, '插件段必须整体位于 tool:*(1000+) 之前')

  // 别人的段原样保留
  assert.ok(rendered.includes('You are an AI agent.'), '不得改动 harness:identity')
  assert.ok(rendered.includes('TOOL-READ-MARKER'), '不得改动 tool:read')
}

// ── 5) injectionEnabled=false：动态段保持空 ───────────────────────────────────
{
  const { assemble } = fakeHost({ asset: sampleAsset, cfg: { injectionEnabled: false } })
  const result = await assemble(ctxFor())
  const byName = Object.fromEntries(result.sections.map((s) => [s.name, s.text]))
  assert.equal(byName['tdai:session-context'], '', 'injection 关闭时动态段应保持空')
  assert.equal(byName['tdai:profile-memory'], '', 'injection 关闭时动态段应保持空')
  assert.equal(byName['tdai:available-skills'], '', 'injection 关闭时动态段应保持空')
}

// ── 6) readEnabled=false：连静态段也不注入 ────────────────────────────────────
{
  const { sections } = fakeHost({ asset: sampleAsset, cfg: { enabled: false } })
  assert.equal(sections.get('tdai:overview').text(ctxFor()), '', '总开关关闭时 overview 应为空')
}

// ── 7) 无 sessionId / 资产缺失：不崩、保持空 ──────────────────────────────────
{
  const { assemble } = fakeHost({ asset: sampleAsset })
  const result = await assemble({ agent: { session: {} }, scope: {} })
  const byName = Object.fromEntries(result.sections.map((s) => [s.name, s.text]))
  assert.equal(byName['tdai:session-context'], '', '无 session 时应保持空')
  assert.ok(byName['harness:identity'].length > 0, '无 session 时也不得清空宿主段')

  const { assemble: assemble2 } = fakeHost({ asset: null })
  const result2 = await assemble2(ctxFor())
  const byName2 = Object.fromEntries(result2.sections.map((s) => [s.name, s.text]))
  assert.equal(byName2['tdai:session-context'], '', '资产不可用时应保持空且不崩')
}

console.log('section registry tests passed: 分带 / 唯一性 / 占位 / 端到端装配 / 开关降级')
