/**
 * 工作区覆盖的注入级验证：不同 cwd 的会话是否真的拿到**不同的 system 注入**。
 *
 * 前面的测试分别验证了解析（workspace-agents）与资产缓存（assets-budget 的身份切换）。
 * 这里把两者接起来，跑真实的 `SessionAssets` + `registerSections` 装配链路：
 *
 *   session cwd → identityForWorkspace → 有效 team/agent
 *     → SessionAssets 按该身份拉 agent 详情 / L3
 *     → assemble 渲染 <session_context> / <tdai_profile_memory>
 *
 * fake client 只替代网络；资产的加载与渲染都走插件真实代码。断言两个工作区的 session
 * 注入文本互不相同、且未命中规则的第三个工作区回落到默认身份。
 *
 * 运行：node test/workspace-injection.test.mjs
 */
import assert from 'node:assert'
import { registerSections } from '../lib/sections.mjs'
import { SessionAssets } from '../lib/assets.mjs'
import { resolveConfig, identityForWorkspace, identityComplete } from '../config.mjs'

const globalCfg = resolveConfig({
  serviceId: 'svc',
  teamId: 'team-default',
  agentId: 'agt-default',
  userId: 'usr',
  enabled: true,
  injectionEnabled: true,
  sessionContextEnabled: true,
  agentPromptEnabled: true,
  profileMemoryEnabled: true,
  recallEnabled: false,
  knowledgeEnabled: false,
  workspaceAgentsEnabled: true,
  workspaceAgents: [
    { workspace: '/repo/a', title: 'Repo A', teamId: 'team-a', agentId: 'agt-a' },
    { workspace: '/repo/b', title: 'Repo B', teamId: 'team-b', agentId: 'agt-b' },
  ],
})

/** 只替代网络的假 client：返回的内容都带 agent id，便于断言"到底用了谁"。 */
const client = {
  async metaGetAgent(agentId) {
    return {
      agent_id: agentId,
      name: `Agent ${agentId}`,
      description: `description ${agentId}`,
      metadata_json: JSON.stringify({ ui: { role_prompt: `ROLE-${agentId}`, rules_prompt: `RULES-${agentId}` } }),
    }
  },
  async metaGetTask() { return null },
  async metaAgentFixedAssets() { return null },
  async readL3(ctx) { return { content: `L3-${ctx.agentId}` } },
  async listL2() { return [] },
  async knowledgeList() { return [] },
}

const assets = new SessionAssets(client, globalCfg)
const listeners = {}
const ctx = {
  systemPrompt: { section(section) { listeners[`section:${section.name}`] = section } },
  on(event, callback) { listeners[event] = callback },
  // 宿主没有 skills 服务：knowledge skill 的 inject 回调不执行（与真实可选依赖一致）。
  inject() { return () => {} },
}

const runtime = {
  readEnabled: () => true,
  readEnabledFor(session) {
    const cfg = identityForWorkspace(globalCfg, session?.header?.cwd).cfg
    return cfg.enabled && identityComplete(cfg)
  },
  configFor(session) { return identityForWorkspace(globalCfg, session?.header?.cwd).cfg },
  config: globalCfg,
  readPolicyFor: () => ({ subagent: false, inherit: true, identity: true, memory: true, skills: true, knowledge: true, skillInject: true }),
  dsbotReady: async () => {},
  assets,
  log: () => {},
}

registerSections(ctx, runtime)
const assemble = listeners['system-prompt/assemble']
assert.ok(assemble, '应注册 system-prompt/assemble')

/** 跑一次 assemble，返回三个关键段的文本。 */
async function injectFor(sessionId, cwd) {
  const assembly = {
    sections: [
      { name: 'deployment:persona-prefix', text: 'BASE PERSONA' },
      { name: 'tdai:session-context', text: '' },
      { name: 'tdai:profile-memory', text: '' },
      { name: 'tdai:knowledge-tools', text: '' },
    ],
    contexts: [],
    tools: [],
    variables: {},
  }
  const session = { id: sessionId, header: { cwd } }
  const result = await assemble(assembly, { agent: { session }, scope: {}, signal: undefined }, async () => assembly)
  const text = (name) => result.sections.find((s) => s.name === name)?.text ?? ''
  return { sessionContext: text('tdai:session-context'), profileMemory: text('tdai:profile-memory') }
}

// ── 1) 两个工作区各自命中不同的 team/agent → 注入文本必须不同 ────────────────
{
  const a = await injectFor('s-a', '/repo/a')
  const b = await injectFor('s-b', '/repo/b')

  // session_context：身份块里是各自 agent 的 id / role / rules
  assert.ok(a.sessionContext.includes('id: agt-a'), `A 应注入 agt-a：${a.sessionContext}`)
  assert.ok(a.sessionContext.includes('ROLE-agt-a') && a.sessionContext.includes('RULES-agt-a'), 'A 的角色 / 规则应来自 agt-a')
  assert.ok(!a.sessionContext.includes('agt-b'), 'A 不应出现 agt-b')

  assert.ok(b.sessionContext.includes('id: agt-b'), `B 应注入 agt-b：${b.sessionContext}`)
  assert.ok(b.sessionContext.includes('ROLE-agt-b') && b.sessionContext.includes('RULES-agt-b'), 'B 的角色 / 规则应来自 agt-b')
  assert.ok(!b.sessionContext.includes('agt-a'), 'B 不应出现 agt-a')

  // profile_memory：L3 画像按有效身份加载
  assert.ok(a.profileMemory.includes('L3-agt-a'), 'A 应注入 agt-a 的 L3')
  assert.ok(!a.profileMemory.includes('L3-agt-b'), 'A 不应注入 agt-b 的 L3')
  assert.ok(b.profileMemory.includes('L3-agt-b'), 'B 应注入 agt-b 的 L3')
  assert.ok(!b.profileMemory.includes('L3-agt-a'), 'B 不应注入 agt-a 的 L3')

  // 两个会话的注入正文不能一样（这是本测试的核心断言）
  assert.notEqual(a.sessionContext, b.sessionContext)
  assert.notEqual(a.profileMemory, b.profileMemory)
}

// ── 2) 资产缓存按会话隔离：peek 到的 identity 是各自的有效身份 ────────────────
{
  const aAsset = assets.peek('s-a')
  const bAsset = assets.peek('s-b')
  assert.equal(aAsset?.identity?.team_id, 'team-a')
  assert.equal(aAsset?.identity?.agent_id, 'agt-a')
  assert.equal(bAsset?.identity?.team_id, 'team-b')
  assert.equal(bAsset?.identity?.agent_id, 'agt-b')
  assert.equal(aAsset?.agentDetail?.id, 'agt-a')
  assert.equal(bAsset?.agentDetail?.id, 'agt-b')
}

// ── 3) 未命中规则的第三个工作区：回落默认身份，且不串用 A/B 的资产 ───────────
{
  const c = await injectFor('s-c', '/repo/other')
  assert.ok(c.sessionContext.includes('id: agt-default'), `未命中应回落默认 agent：${c.sessionContext}`)
  assert.ok(c.sessionContext.includes('ROLE-agt-default'))
  assert.ok(c.profileMemory.includes('L3-agt-default'))
  assert.ok(!c.profileMemory.includes('L3-agt-a') && !c.profileMemory.includes('L3-agt-b'))
  assert.equal(assets.peek('s-c')?.identity?.agent_id, 'agt-default')
}

// ── 4) 开关关闭：所有会话都注入默认身份（不是"A/B 的规则被静默忽略一半"）──────
{
  const offCfg = { ...globalCfg, workspaceAgentsEnabled: false }
  const offAssets = new SessionAssets(client, offCfg)
  const offRuntime = {
    ...runtime,
    readEnabledFor: (session) => {
      const cfg = identityForWorkspace(offCfg, session?.header?.cwd).cfg
      return cfg.enabled && identityComplete(cfg)
    },
    configFor: (session) => identityForWorkspace(offCfg, session?.header?.cwd).cfg,
    config: offCfg,
    assets: offAssets,
  }
  const offListeners = {}
  const offCtx = {
    systemPrompt: { section(section) { offListeners[`section:${section.name}`] = section } },
    on(event, callback) { offListeners[event] = callback },
    inject() { return () => {} },
  }
  registerSections(offCtx, offRuntime)
  const offAssemble = offListeners['system-prompt/assemble']
  const assembly = {
    sections: [
      { name: 'deployment:persona-prefix', text: 'BASE PERSONA' },
      { name: 'tdai:session-context', text: '' },
      { name: 'tdai:profile-memory', text: '' },
      { name: 'tdai:knowledge-tools', text: '' },
    ],
    contexts: [], tools: [], variables: {},
  }
  const session = { id: 's-a-off', header: { cwd: '/repo/a' } }
  const result = await offAssemble(assembly, { agent: { session }, scope: {}, signal: undefined }, async () => assembly)
  const sessionContext = result.sections.find((s) => s.name === 'tdai:session-context')?.text ?? ''
  assert.ok(sessionContext.includes('id: agt-default'), '总开关关闭时 /repo/a 也应用默认 agent')
  assert.ok(!sessionContext.includes('agt-a'), '总开关关闭时不该出现覆盖值')
}

console.log('workspace injection tests passed: 不同工作区注入不同身份/角色/L3；未命中回落默认；总开关关闭全默认')
