/**
 * 工具输出契约测试（模型可见内容的护栏）。
 *
 * DSH 的 `ToolOutputDefinition.render` 签名是 **`(args, value)`**：第一个形参是参数，
 * 第二个才是 `execute()` 的规范值（dsh-tools/lib/types/index.d.ts）。
 * 插件早先写成 `render(value)`，于是**模型看到的是自己的参数**——实测
 * `tdai_memory_query {limit:3}` 的返回是 `{"limit":3}`，真实检索结果被静默丢弃。
 * 这种 bug 不报错、不断链，只是"结果看起来像回显"，所以必须由测试锁住。
 *
 * 运行：node test/tools-render.test.mjs
 */
import assert from 'node:assert'
import { registerTools } from '../lib/tools.mjs'

const HOST_ARGS = { query: '我叫什么', limit: 5 }

function harness({ readEnabled = true, searchL1 } = {}) {
  const tools = new Map()
  const ctx = {
    tools: { register: (def) => { tools.set(def.name, def); return () => {} } },
    agent: { session: { id: 's1' } },
    sessions: { list: () => [] },
  }
  registerTools(ctx, {
    config: { enabled: readEnabled },
    readEnabled: () => readEnabled,
    identityFor: () => ({ session_id: 's1', team_id: 't', agent_id: 'a', user_id: 'u' }),
    log: () => {},
    client: { searchL1: searchL1 ?? (async () => 'L1-SENTINEL-RESULT') },
  })
  return tools
}

// ── 1) 模型看到的是**结果**，不是参数 ───────────────────────────────────────
{
  const tool = harness().get('tdai_memory_search')
  const value = await tool.execute(HOST_ARGS)

  // 宿主按契约调用：render(args, value)
  const content = tool.output.render(HOST_ARGS, value)
  assert.equal(content[0].text, value, 'render 必须投影 value')
  assert.ok(!content[0].text.includes('"limit"'),
    `模型可见内容不得是参数回显，实际：${content[0].text}`)
}

// ── 2) 未启用时的拒绝文案同样要能到达模型 ──────────────────────────────────
{
  const tool = harness({ readEnabled: false }).get('tdai_memory_query')
  const value = await tool.execute({ limit: 3 })
  const content = tool.output.render({ limit: 3 }, value)
  assert.ok(content[0].text.includes('未启用'),
    `读侧关闭时必须把拒绝文案交给模型，实际：${content[0].text}`)
}

// ── 3) 规范值必须满足声明的 output.schema（string）────────────────────────
{
  const tool = harness().get('tdai_memory_search')
  assert.equal(tool.output.schema.type, 'string')
  const value = await tool.execute(HOST_ARGS)
  assert.equal(typeof value, 'string', 'execute 的返回值必须是字符串，否则会被输出校验拒绝')
}

console.log('tools render tests passed: render(args, value) 契约 / 拒绝文案可达 / 输出 schema 一致')
