/**
 * Headless 加载测试：用 mock cordis ctx 跑 index.mjs 的 apply()，
 * 在不启动真实 dsh 进程的前提下验证：
 *   - 模块树可正常 import（含 schemastery）
 *   - apply() 不抛异常
 *   - 工具 schema 是合法的 JSON Schema（parameters.type === 'object'）
 *   - 导出 Config 且关掉自动生成页（settings.configure）
 *   - systemPrompt sections 注册成功
 *   - slash 命令注册成功
 *
 * 运行：node test/load.test.mjs
 */
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, Config } from '../index.mjs'
import { resolveConfig } from '../config.mjs'
import { SCHEMA_KEYS, identitySourceOf } from '../lib/settings.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const registered = {
  tools: [],
  sections: [],
  commands: [],
  listeners: [],
  settings: null,
  effects: [],
}

/**
 * 假 settings 服务（DSH 0.1.7-rc.1 形状）。
 *
 * `register(ns, schema, opts)` 已在 0.1.7-rc.1 被删除，这里**故意不提供它**：
 * 一旦插件代码又退回去调用它，本测试会以 `is not a function` 直接红。
 */
const mockSettingsCtx = {
  // cordis 的 effect(fn) 会立即执行 fn 并登记它的清理函数
  effect(fn) {
    registered.effects.push(fn)
    const disposer = fn()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  settings: {
    configure(presentation, owner) {
      registered.settings = { presentation, owner }
    },
    describe() {
      return [{
        ns: 'tdai-memory',
        autoGenerate: false,
        schema: {},
        value: {},
        user: { serviceId: 'from-panel' },
        base: { serviceId: 'from-env' },
        revision: 1,
        applies: 'live',
      }]
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
  fiber: { id: 'tdai-memory' },
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

// ── settings（0.1.7-rc.1 模型）───────────────────────────────────────────────
// 插件只做两件事：导出 Config（schema），并关掉宿主的自动生成页。
assert.ok(registered.settings, '应调用 settings.configure')
assert.deepEqual(registered.settings.presentation, { auto: false }, '自带设置页 → 关掉自动生成页')
assert.ok(registered.settings.owner, 'configure 应绑定到本插件 fiber')

// identitySource：用户层出现身份键才算"来自设置面板"
assert.equal(
  identitySourceOf([{ ns: 'tdai-memory', user: { serviceId: 'x' } }]),
  'settings',
  '用户层有身份键 → settings',
)
assert.equal(
  identitySourceOf([{ ns: 'tdai-memory', user: {} }]),
  'env',
  '用户层为空 → env',
)
assert.equal(identitySourceOf([], 'tdai-memory'), 'env', 'entry 不存在 → env')
assert.equal(identitySourceOf(undefined), 'env', 'describe 不可用 → env')

// ── Config schema 必须能吃下 cordis.patch.yml 透传进来的 env 值（回归护栏）────
//
// 这是升级到 0.1.7-rc.1 最容易踩的坑：patch 的 `!!js process.env.X ?? ''` 在 env 未设置时
// 给的是**空字符串**。裸 `z.boolean()` / `z.natural()` 遇到 `''` 会抛
// `expected boolean but got`，**整个 entry 加载失败**（插件完全不挂载）。
// 所以布尔/数字字段用 union 接受字符串，归一化交给 config.mjs 的 boolOpt/numOpt。
{
  const blank = {}
  for (const key of SCHEMA_KEYS) blank[key] = ''
  const parsed = Config(blank) // 不能抛
  const cfg = resolveConfig(parsed)
  assert.equal(cfg.enabled, true, '空串布尔应回落默认 true')
  assert.equal(cfg.knowledgeEnabled, false, '空串布尔应回落默认 false')
  assert.equal(cfg.recallLimit, 5, '空串数字应回落默认 5')
  assert.equal(cfg.assetRetryCooldownMs, 15000, '空串数字应回落默认 15000')

  // env 里显式设成字符串（这是 patch 的真实形态）
  const fromEnv = resolveConfig(Config({ enabled: 'false', recallLimit: '8', assetRetryCooldownMs: '0' }))
  assert.equal(fromEnv.enabled, false, 'env "false" 必须生效')
  assert.equal(fromEnv.recallLimit, 8, 'env "8" 必须生效')
  assert.equal(fromEnv.assetRetryCooldownMs, 0, 'env "0" 必须生效（0 是合法值）')

  // 设置面板写的是真布尔 / 真数字
  const fromPanel = resolveConfig(Config({ enabled: false, recallLimit: 7 }))
  assert.equal(fromPanel.enabled, false, '面板布尔必须生效')
  assert.equal(fromPanel.recallLimit, 7, '面板数字必须生效')

  // secret 字段：schema 里声明了 role('secret')，宿主才能把它从 wire 值里剥掉
  const json = Config.toJSON()
  const refs = JSON.stringify(json)
  assert.ok(refs.includes('"role":"secret"'), 'userKey 必须声明 role(secret)')
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
// 0.1.7-rc.1 的 `agent/session-start` 已不存在（预热监听曾是静默死代码），改听 agent/created
assert.ok(events.includes('agent/created'), '应监听 agent/created 做会话预热')
assert.ok(!events.includes('agent/session-start'), '不应再监听已不存在的 agent/session-start')

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

console.log(`load test passed: ${registered.tools.length} tools, Config schema + settings.configure, ${registered.sections.length} sections, ${registered.commands.length} commands, lifecycle listeners`)
