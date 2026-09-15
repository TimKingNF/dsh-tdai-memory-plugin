/**
 * 知识原生工具测试（tdai_knowledge_tools / tdai_knowledge_call）。
 *
 * 为什么单独测这两个：它们把"越权防护"和"错误语义"两件事绑在了一起。
 *   - **越权**：知识服务的工具是按资源定义的，模型可能编一个 knowledge_id；
 *     工具必须只接受**当前会话已绑定**的资源，绝不拿编出来的 id 去请求服务端。
 *   - **错误语义**：知识服务在 code-graph 工具执行失败时仍回 code=0，把错误放在
 *     `data.isError`（MemoryKnowledge/v3-api-memoryknowledge-doc.md:573）。
 *     客户端必须显式判，否则失败会被当成成功结果喂给模型。
 *
 * 运行：node test/knowledge-tools.test.mjs
 */
import assert from 'node:assert'
import { registerKnowledgeTools } from '../lib/tools.mjs'

function harness({ cfg = {}, asset = null, client = {} } = {}) {
  const tools = new Map()
  const cfgAll = { enabled: true, knowledgeEnabled: true, ...cfg }
  const calls = []
  const ctx = {
    tools: { register: (def) => { tools.set(def.name, def); return () => {} } },
    agent: { session: { id: 's1' } },
    sessions: { list: () => [] },
  }
  registerKnowledgeTools(ctx, {
    config: cfgAll,
    readEnabled: () => cfgAll.enabled,
    assets: { peek: () => asset },
    log: () => {},
    client: {
      async knowledgeToolsList(url, id) { calls.push(['list', url, id]); return client.list ?? null },
      async knowledgeToolsCall(url, id, name, params) {
        calls.push(['call', url, id, name, params])
        return client.call ?? { ok: true, text: 'ok' }
      },
    },
  })
  // 第二个参数就是 DSH 的 ToolExec（当前 agent 在 exec.agent.session 上）
  const run = (name, args, exec) => tools.get(name).execute(args, exec)
  return { run, tools, calls }
}

const boundAsset = {
  identity: { session_id: 's1' },
  knowledge: [
    { knowledge_id: 'cg-1', type: 'code-graph', service_url: 'http://kb/v3', name: 'payments 索引' },
    { knowledge_id: 'wiki-1', type: 'wiki', service_url: 'http://kb/v3', name: '团队 wiki' },
  ],
}

// ── 1) 开关关闭 / 无绑定资源：给出可操作的提示，不发起请求 ────────────────────
{
  const h = harness({ cfg: { knowledgeEnabled: false }, asset: boundAsset })
  assert.ok((await h.run('tdai_knowledge_call', { knowledge_id: 'cg-1', tool_name: 'search' })).includes('未启用'))
  assert.equal(h.calls.length, 0, '开关关闭时不应发起任何请求')
}
{
  const h = harness({ asset: { identity: {}, knowledge: [] } })
  const out = await h.run('tdai_knowledge_call', { knowledge_id: 'cg-1', tool_name: 'search' })
  assert.ok(out.includes('没有绑定团队知识资源'), '无绑定时应提示刷新资产')
  assert.equal(h.calls.length, 0, '无绑定资源时不应发起请求')
}

// ── 2) 越权防护：未绑定的 knowledge_id 一律拒绝，且不请求服务端 ──────────────
{
  const h = harness({ asset: boundAsset })
  const out = await h.run('tdai_knowledge_call', { knowledge_id: 'cg-evil', tool_name: 'search' })
  assert.ok(out.includes('未绑定的知识资源'), `应拒绝未绑定资源，实际：${out}`)
  assert.ok(out.includes('cg-1'), '拒绝时应列出当前可用资源，便于模型改用正确的 id')
  assert.equal(h.calls.length, 0, '**不得**拿未绑定的 id 去请求服务端')
}
{
  const h = harness({ asset: boundAsset })
  const out = await h.run('tdai_knowledge_tools', { knowledge_id: 'wiki-evil' })
  assert.ok(out.includes('未绑定的知识资源'))
  assert.equal(h.calls.length, 0)
}

// ── 3) 正常执行：参数透传，返回正文 ─────────────────────────────────────────
{
  const h = harness({ asset: boundAsset, client: { call: { ok: true, text: 'EXPLORE-RESULT' } } })
  const out = await h.run('tdai_knowledge_call', {
    knowledge_id: 'cg-1', tool_name: 'explore', params: { query: 'SessionManager' },
  })
  assert.equal(out, 'EXPLORE-RESULT')
  assert.deepEqual(h.calls[0], ['call', 'http://kb/v3', 'cg-1', 'explore', { query: 'SessionManager' }])
}
{
  // params 缺省 → 传空对象（服务端要求 params 必填且为对象）
  const h = harness({ asset: boundAsset, client: { call: { ok: true, text: 'OK' } } })
  await h.run('tdai_knowledge_call', { knowledge_id: 'wiki-1', tool_name: 'list_pages' })
  assert.deepEqual(h.calls[0][4], {}, 'params 缺省时应传 {}')
}

// ── 4) 错误语义：isError / 不可达 / 缺 tool_name ─────────────────────────────
{
  const h = harness({ asset: boundAsset, client: { call: { ok: false, text: 'instance not loaded' } } })
  const out = await h.run('tdai_knowledge_call', { knowledge_id: 'cg-1', tool_name: 'explore' })
  assert.ok(out.includes('调用失败') && out.includes('instance not loaded'),
    'isError 结果必须显式标成失败，不能当成功结果返回')
}
{
  const h = harness({ asset: boundAsset })
  const out = await h.run('tdai_knowledge_call', { knowledge_id: 'cg-1', tool_name: '' })
  assert.ok(out.includes('缺少 tool_name'))
  assert.equal(h.calls.length, 0)
}

// ── 5) tdai_knowledge_tools：列出工具 / 服务不可达 ──────────────────────────
{
  const h = harness({
    asset: boundAsset,
    client: { list: [{ name: 'explore', description: '按文件分组返回源码' }, { name: 'search', description: '' }] },
  })
  const out = await h.run('tdai_knowledge_tools', { knowledge_id: 'cg-1' })
  assert.ok(out.includes('`explore`') && out.includes('按文件分组返回源码'))
  assert.ok(out.includes('`search`'))
}
{
  const h = harness({ asset: boundAsset, client: { list: null } })
  const out = await h.run('tdai_knowledge_tools', { knowledge_id: 'cg-1' })
  assert.ok(out.includes('不可达'), '取不到清单时应如实说明')
}

// ── 6) 两个工具都注册了，且 schema 是合法的 JSON Schema 对象 ─────────────────
{
  const h = harness({ asset: boundAsset })
  assert.deepEqual([...h.tools.keys()].sort(), ['tdai_knowledge_call', 'tdai_knowledge_tools'])
  for (const def of h.tools.values()) {
    assert.equal(def.parameters.type, 'object', `${def.name} 的 parameters 必须是 object 根`)
  }
  const call = h.tools.get('tdai_knowledge_call')
  assert.deepEqual(call.parameters.required, ['knowledge_id', 'tool_name'])
  assert.equal(call.parameters.properties.params.type, 'object', 'params 应是 JSON 对象（知识服务要求）')
}

// ── 7) 会话解析：必须用 exec.agent.session（DSH 把当前 agent 挂第二参数）────────
//
// 回归护栏（线上实测 bug）：回调只声明了 `execute(args)`，于是去读插件 ctx 上的
// `ctx.agent` / `ctx.sessions.list()[0]`。前者恒 undefined，后者是**进程里最早创建的
// session**。结果：资产按当前 session 缓存，工具却去老 session 查，`peek()` 恒空，
// 工具永远回"没有绑定团队知识资源"——而同一会话的注入显示"知识资源 1 个"。
{
  // 最小护栏：exec 里的会话查不到资产时，如实回"没有绑定"而不是抛
  const h = harness({ asset: { identity: {}, knowledge: [] } })
  const out = await h.run('tdai_knowledge_call', { knowledge_id: 'cg-1', tool_name: 'search' }, { agent: { session: { id: 's1' } } })
  assert.equal(out, '当前会话没有绑定团队知识资源。（可用 /tdai-sync 刷新资产，或确认 agent 是否绑定了知识资源。）')
}
{
  // 会话键不同的资产：只有当工具用了 exec.agent.session 时才命中
  const tools = new Map()
  const cfgAll = { enabled: true, knowledgeEnabled: true }
  const caught = { session: null }
  const ctx = {
    tools: { register: (def) => { tools.set(def.name, def); return () => {} } },
    // 插件 ctx 上故意放一个**错的**会话来复现旧行为
    sessions: { list: () => [{ id: 'stale-session' }] },
  }
  registerKnowledgeTools(ctx, {
    config: cfgAll,
    readEnabled: () => true,
    assets: { peek: (sessionId) => {
      caught.session = sessionId
      return sessionId === 'live-session' ? boundAsset : { identity: {}, knowledge: [] }
    } },
    log: () => {},
    client: {
      async knowledgeToolsList() { return [] },
      async knowledgeToolsCall() { return { ok: true, text: 'CALLED' } },
    },
  })
  const out = await tools.get('tdai_knowledge_call').execute(
    { knowledge_id: 'cg-1', tool_name: 'explore' },
    { agent: { session: { id: 'live-session' } } },
  )
  assert.equal(caught.session, 'live-session', '必须用 exec.agent.session 查资产，不能回落到 sessions.list()[0]')
  assert.equal(out, 'CALLED', '会话对上了就应该真的调用工具')
}
{
  // 宿主没给 exec（老宿主/内部调用）：回落 ctx.agent.session，而不是乱挑一个会话
  const tools = new Map()
  const ctx = {
    tools: { register: (def) => { tools.set(def.name, def); return () => {} } },
    agent: { session: { id: 'live-session' } },
    sessions: { list: () => [{ id: 'stale-session' }] },
  }
  const seen = []
  registerKnowledgeTools(ctx, {
    config: { enabled: true, knowledgeEnabled: true },
    readEnabled: () => true,
    assets: { peek: (sessionId) => { seen.push(sessionId); return boundAsset } },
    log: () => {},
    client: { async knowledgeToolsList() { return [] }, async knowledgeToolsCall() { return { ok: true, text: 'OK' } } },
  })
  await tools.get('tdai_knowledge_tools').execute({ knowledge_id: 'cg-1' })
  assert.deepEqual(seen, ['live-session'], '无 exec 时应回落 ctx.agent.session')
}

console.log('knowledge tools tests passed: 越权拒绝 / 参数透传 / isError 语义 / 缺参 / fail-open / schema / 会话解析')
