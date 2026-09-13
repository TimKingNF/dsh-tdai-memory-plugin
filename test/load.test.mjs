/**
 * Headless 加载测试：用 mock cordis ctx 跑 index.mjs 的 apply()，
 * 在不启动真实 dsh 进程的前提下验证：
 *   - 模块树可正常 import（含 schemastery）
 *   - apply() 不抛异常
 *   - 工具 schema 是合法的 JSON Schema（parameters.type === 'object'）
 *   - settings 命名空间注册成功（host 侧）
 *   - systemPrompt sections 注册成功
 *   - slash 命令注册成功
 *
 * 运行：node test/load.test.mjs
 */
import assert from 'node:assert'
import { apply } from '../index.mjs'

const registered = {
  tools: [],
  sections: [],
  commands: [],
  listeners: [],
  settings: null,
}

const scope = {
  get() {
    return {
      enabled: true, captureEnabled: true, recallEnabled: true, injectionEnabled: true,
      sessionContextEnabled: true, profileMemoryEnabled: true, skillsEnabled: true, knowledgeEnabled: false,
      endpoint: '', serviceId: 'mem-demo', teamId: 'team-x', agentId: 'agt-x', userId: 'usr-x',
      userKey: '', taskId: '', recallLimit: 5, l2Limit: 3, timeoutMs: 5000,
    }
  },
  watch() { return () => {} },
}

const mockSettingsCtx = {
  settings: {
    register(ns, schema, opts) {
      registered.settings = { ns, schema, opts }
      return scope
    },
  },
}

const mockCommandsCtx = {
  commands: {
    register(def) { registered.commands.push(def) },
  },
}

const ctx = {
  logger: { warn() {} },
  inject(deps, cb) {
    if (Array.isArray(deps)) {
      if (deps.includes('settings')) cb(mockSettingsCtx)
      if (deps.includes('commands')) cb(mockCommandsCtx)
    }
  },
  tools: { register(def) { registered.tools.push(def) } },
  systemPrompt: { section(s) { registered.sections.push(s) } },
  sessions: { list() { return [] } },
  on(ev, cb) { registered.listeners.push([ev, cb]) },
  get() { return undefined },
}

// 用完整身份跑 apply（否则读侧被跳过、工具不注册）
apply(ctx, {})

assert.equal(registered.tools.length, 8, '应注册 8 个工具')
for (const t of registered.tools) {
  assert.ok(t.name.startsWith('tdai_'), `工具名 ${t.name} 应以 tdai_ 开头`)
  assert.equal(t.parameters.type, 'object', `工具 ${t.name} 的 parameters 必须是 object 根`)
  assert.ok(t.parameters.properties && typeof t.parameters.properties === 'object', `工具 ${t.name} 缺 properties`)
  // 每个 property 必须是 JSON Schema 节点（有 type）
  for (const [key, node] of Object.entries(t.parameters.properties)) {
    assert.ok(node && typeof node.type === 'string', `工具 ${t.name} 参数 ${key} 缺 type`)
  }
}

// 必填字段进 required 数组
const searchTool = registered.tools.find((t) => t.name === 'tdai_memory_search')
assert.ok(searchTool.parameters.required.includes('query'), 'tdai_memory_search 的 query 应必填')

// settings 命名空间注册
assert.ok(registered.settings, '应注册 settings 命名空间')
assert.equal(registered.settings.ns, 'tdai-memory')

// systemPrompt sections
const sectionNames = registered.sections.map((s) => s.name)
for (const n of ['tdai:overview', 'tdai:session-context', 'tdai:profile-memory', 'tdai:available-skills', 'tdai:knowledge-tools']) {
  assert.ok(sectionNames.includes(n), `应注册 section ${n}`)
}

// slash 命令
const commandNames = registered.commands.map((c) => c.name)
for (const n of ['tdai-sync', 'tdai-status', 'tdai-archive', 'tdai-help']) {
  assert.ok(commandNames.includes(n), `应注册命令 ${n}`)
}

// 生命周期监听
const events = registered.listeners.map(([ev]) => ev)
assert.ok(events.includes('agent/pre-step'), '应监听 agent/pre-step')
assert.ok(events.includes('session/event'), '应监听 session/event')

console.log('load test passed: 8 tools, settings ns, 5 sections, 4 commands, lifecycle listeners')
