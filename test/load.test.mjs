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
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.mjs'
import { resolveConfig } from '../config.mjs'
import { SCHEMA_KEYS } from '../lib/settings.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

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

assert.equal(registered.tools.length, 10, '应注册 10 个工具（8 个记忆工具 + 2 个团队知识工具）')
for (const t of registered.tools) {
  assert.ok(t.name.startsWith('tdai_'), `工具名 ${t.name} 应以 tdai_ 开头`)
  assert.equal(t.parameters.type, 'object', `工具 ${t.name} 的 parameters 必须是 object 根`)
  assert.ok(t.parameters.properties && typeof t.parameters.properties === 'object', `工具 ${t.name} 缺 properties`)
  // **execute 必须声明第二个形参**：DSH 的 scheduler 调 `tool.execute(args, exec)`，
  // 当前 agent（含 session）只在 exec 上。少写这个参数 → 取不到会话 → 静默用错会话。
  assert.ok(t.execute.length >= 2, `工具 ${t.name} 的 execute 必须接收 (args, exec) 两个参数`)
  // 每个 property 必须是 JSON Schema 节点（有 type）
  for (const [key, node] of Object.entries(t.parameters.properties)) {
    assert.ok(node && typeof node.type === 'string', `工具 ${t.name} 参数 ${key} 缺 type`)
  }
}

// 必填字段进 required 数组
const searchTool = registered.tools.find((t) => t.name === 'tdai_memory_search')
assert.ok(searchTool.parameters.required.includes('query'), 'tdai_memory_search 的 query 应必填')

// 知识工具：两个（发现 + 执行），且执行工具的参数是 JSON Schema 对象
for (const n of ['tdai_knowledge_tools', 'tdai_knowledge_call']) {
  assert.ok(registered.tools.some((t) => t.name === n), `应注册知识工具 ${n}`)
}
const kCall = registered.tools.find((t) => t.name === 'tdai_knowledge_call')
assert.deepEqual(kCall.parameters.required, ['knowledge_id', 'tool_name'], '知识执行工具的必填参数')
assert.equal(kCall.parameters.properties.params.type, 'object', 'params 应是 JSON 对象')

// settings 命名空间注册
assert.ok(registered.settings, '应注册 settings 命名空间')
assert.equal(registered.settings.ns, 'tdai-memory')

// 设置面板字段必须真的能落到 config：漏一个 → 面板改了不生效（静默）
{
  const { applySettings } = await import('../lib/settings.mjs')
  const { identityComplete } = await import('../config.mjs')
  let pushed
  const settingsCtx = {
    inject(deps, cb) { if (deps.includes('settings')) cb(settingsCtx) },
    settings: {
      register(ns, schema, opts) {
        assert.equal(ns, 'tdai-memory')
        return {
          // 模拟用户层：面板里填了知识服务地址改写
          get() { return { ...opts.base, knowledgeEndpoint: 'http://127.0.0.1:8424' } },
          watch(push) { pushed = push },
        }
      },
    },
  }
  const envCfg = { enabled: true, serviceId: 'default', teamId: 't', agentId: 'a', userId: 'u', knowledgeEnabled: true }
  applySettings(settingsCtx, envCfg, () => {}, (cfg) => { pushed = cfg })
  assert.ok(pushed, 'settings 就绪时应推一次当前值')
  assert.equal(pushed.knowledgeEndpoint, 'http://127.0.0.1:8424', '面板里的知识服务地址改写必须落到 config')
  assert.equal(pushed.knowledgeEnabled, true, '布尔开关不能被面板层丢掉')
  assert.ok(identityComplete(pushed), '身份字段应完整传递')
}

// systemPrompt sections
const sectionNames = registered.sections.map((s) => s.name)
for (const n of ['tdai:session-context', 'tdai:profile-memory', 'tdai:available-skills', 'tdai:knowledge-tools']) {
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

// ── 配置键 ↔ env 透传（回归护栏）─────────────────────────────────────────────
//
// 插件拿到的 config 是 cordis.patch.yml **透传进来的对象**，不是 process.env。
// 于是"新增一个配置键忘了在 patch 里加一行"= env 里配它**静默无效**，而且默认值
// 常常正好等于文档里写的值，所以现象是"看起来配对了"。2026-09-16 就踩过一次：
// recallTimeoutMs / assetLoadBudgetMs / assetRetryCooldownMs / knowledgeEndpoint
// 四个键 README 已经写进 env 表，patch 里却一个都没有。
{
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  const keys = new Set(Object.keys(resolveConfig({})))
  for (const k of SCHEMA_KEYS) {
    assert.ok(keys.has(k), `设置面板字段 ${k} 不在 resolveConfig 的输出里（面板值落不进 config）`)
  }
  const missing = [...keys].filter((k) => !new RegExp(`^\\s+${k}:`, 'm').test(patch))
  assert.deepEqual(missing, [], `这些配置键没有在 cordis.patch.yml 里透传 env：${missing.join(', ')}`)

  // 0 是 assetRetryCooldownMs 的合法值（不冷却、每次失败都允许重试）：
  // 用 numOpt 解析会被判成非法值而换成默认值，env 配 =0 等于没配。
  assert.equal(resolveConfig({ assetRetryCooldownMs: 0 }).assetRetryCooldownMs, 0, 'env 配 0 应表示"不冷却"')
  assert.equal(resolveConfig({ assetRetryCooldownMs: '0' }).assetRetryCooldownMs, 0, '字符串 "0" 同样有效')
  assert.equal(resolveConfig({ assetRetryCooldownMs: '' }).assetRetryCooldownMs, 15000, '留空回落到默认值')
}

console.log(`load test passed: ${registered.tools.length} tools, settings ns, ${registered.sections.length} sections, ${registered.commands.length} commands, lifecycle listeners`)
