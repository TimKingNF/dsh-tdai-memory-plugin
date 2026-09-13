/**
 * sections 注入测试：验证 system-prompt/assemble 兜底逻辑。
 * 运行：node test/sections.test.mjs
 */
import assert from 'node:assert'
import { registerSections } from '../lib/sections.mjs'

function harness(cfgOverrides = {}, assetOverrides = {}) {
  const cfg = {
    enabled: true, recallEnabled: true, injectionEnabled: true,
    sessionContextEnabled: true, profileMemoryEnabled: true,
    skillsEnabled: true, knowledgeEnabled: false,
    serviceId: 'svc', teamId: 't', agentId: 'a', userId: 'u', taskId: undefined,
    ...cfgOverrides,
  }
  const listeners = {}
  const ctx = {
    systemPrompt: { section: (s) => { listeners[`section:${s.name}`] = s } },
    on: (ev, cb) => { listeners[ev] = cb },
  }
  const asset = {
    identity: { session_id: 's1' },
    agentDetail: { id: 'a', name: 'Coder', description: 'd', prompt: 'p' },
    taskDetail: null,
    profiles: [{ ctx: { agentId: 'a', agentName: 'Coder', isSelf: true }, l3: { content: 'persona' }, l2Entries: [] }],
    skills: { listing: '- sk1: one\n- sk2: two' },
    knowledge: [],
    ...assetOverrides,
  }
  const runtime = {
    readEnabled: () => cfg.enabled,
    config: cfg,
    assets: { ensure: async () => null, peek: () => asset },
    log: () => {},
  }
  registerSections(ctx, runtime)
  return { ctx, listeners, runtime, cfg, asset }
}

async function runAssemble(listeners, sessionId = 's1') {
  const handler = listeners['system-prompt/assemble']
  assert.ok(handler, '应注册 system-prompt/assemble listener')
  const assembly = {
    sections: [
      { name: 'harness:identity', text: 'You are an AI agent.' },
      { name: 'tdai:session-context', text: '' },
      { name: 'tdai:profile-memory', text: '' },
      { name: 'tdai:available-skills', text: '' },
      { name: 'tdai:knowledge-tools', text: '' },
    ],
    contexts: [],
    tools: [],
    variables: {},
  }
  const context = { agent: { session: { id: sessionId } }, scope: {}, signal: undefined }
  return handler(assembly, context, async () => assembly)
}

// 1) assemble 兜底：把动态 section 空 text 覆盖为注入内容
{
  const { listeners } = harness()
  const result = await runAssemble(listeners)
  const sessionCtx = result.sections.find((s) => s.name === 'tdai:session-context')
  assert.ok(sessionCtx.text.includes('<session_context>'), 'session_context 应被注入')
  const profile = result.sections.find((s) => s.name === 'tdai:profile-memory')
  assert.ok(profile.text.includes('<tdai_profile_memory>'), 'profile_memory 应被注入')
  const skills = result.sections.find((s) => s.name === 'tdai:available-skills')
  assert.ok(skills.text.includes('tdai_skill_view'), 'skills 应被注入')
  const identity = result.sections.find((s) => s.name === 'harness:identity')
  assert.equal(identity.text, 'You are an AI agent.', '非本插件 section 不应被改动')
}

// 2) injectionEnabled=false：不注入，动态 section 保持空
{
  const { listeners } = harness({ injectionEnabled: false })
  const result = await runAssemble(listeners)
  const sessionCtx = result.sections.find((s) => s.name === 'tdai:session-context')
  assert.equal(sessionCtx.text, '', 'injection 关闭时应保持空')
}

// 3) 无 sessionId：原样透传，不崩溃
{
  const { listeners } = harness()
  const handler = listeners['system-prompt/assemble']
  const assembly = { sections: [{ name: 'tdai:session-context', text: '' }] }
  const result = await handler(assembly, { agent: { session: {} } }, async () => assembly)
  assert.deepEqual(result, assembly, '无 session 时原样返回')
}

// 4) assets.peek 返回空（加载失败）：不崩溃，保持空
{
  const { listeners, runtime } = harness()
  runtime.assets.peek = () => undefined
  const result = await runAssemble(listeners)
  const sessionCtx = result.sections.find((s) => s.name === 'tdai:session-context')
  assert.equal(sessionCtx.text, '', '资产不可用时保持空且不崩')
}

console.log('sections injection tests passed')
