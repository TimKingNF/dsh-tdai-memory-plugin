/**
 * 知识端点重试、错误转达与日志护栏（真 HTTP，不打桩 fetch）。
 *
 * 背景一（重试）：实测出现过"同一 host:port，直连 curl 每次成功、插件进程偶发失败"的形态，
 * 而 `#postTo` 当时是**单次尝试 + 立刻 fail-open**。现在加 1 次重试，但**只重试可重试的失败**：
 * 网络/超时/5xx/429 重试，HTTP 4xx 与业务 `code != 0` 直接返回（重试只是把同一个答案再要一遍）。
 *
 * 背景二（错误转达，2026-10-14 事故回归护栏）：`#postTo` 早先失败一律返回 null，调用方只能
 * 回一句"知识服务不可达"。现场是模型把 `read_page` 的 `refs` 写成 `path`，服务端明确回了
 * `code=400 · refs is required (non-empty array)`，模型却拿到"服务挂了"的假诊断，连试四种
 * 参数写法后放弃知识库。**服务端说清楚的（HTTP / 业务码 / message）必须原样转达**。
 *
 * 背景三（静默空结果）：wiki 的 `read_page` 对取不到内容的引用照样回 `code=0` + 空 content，
 * 必须显式说明，否则"页面不存在"与"这页是空的"在模型眼里一模一样。
 *
 * 运行：node test/knowledge-retry.test.mjs
 */
import assert from 'node:assert'
import http from 'node:http'
import { GatewayClient } from '../client.mjs'

async function withServer(handler, fn) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    return await fn(`http://127.0.0.1:${port}/v3`)
  } finally {
    server.closeAllConnections?.()
    server.close()
  }
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function makeClient(logs) {
  return new GatewayClient({ serviceId: 'default', timeoutMs: 2000 }, (m) => logs.push(m))
}

// ── 1) 连接层失败（socket 被掐断）+ 第二次成功 → 应重试，并留痕两次尝试 ─────────
{
  let calls = 0
  await withServer((req, res) => {
    calls += 1
    if (calls === 1) { req.socket.destroy(); return }
    json(res, 200, { code: 0, data: { text: '第二次的结果' } })
  }, async (base) => {
    const logs = []
    const out = await makeClient(logs).knowledgeToolsCall(base, 'k1', 'explore', {})
    assert.equal(calls, 2, `连接层失败应重试一次，实际请求 ${calls} 次`)
    assert.deepEqual(out, { ok: true, text: '第二次的结果' }, '重试成功应返回第二次的数据')
    assert.ok(logs.some((l) => l.includes('第 1/2 次尝试失败')), `应有首次失败日志，实际：${logs.join(' | ')}`)
    assert.ok(logs.some((l) => l.includes('第 2 次尝试成功')), '应记下"重试才成功"，否则看不见这条链路是抖的')
    assert.ok(logs.some((l) => l.includes('cause:')), '网络层失败必须打出 cause（否则只有一句 fetch failed）')
  })
}

// ── 2) HTTP 5xx 可重试：两次都 500 → 共 2 次尝试后 fail-open ────────────────────
{
  let calls = 0
  await withServer((req, res) => { calls += 1; json(res, 500, { code: 500 }) }, async (base) => {
    const logs = []
    const out = await makeClient(logs).knowledgeToolsCall(base, 'k1', 'search', {})
    assert.equal(calls, 2, '5xx 应重试一次')
    assert.equal(out.ok, false, '两次都失败仍是 fail-open')
    assert.ok(out.text.includes('HTTP 500'), `5xx 也应带上状态码，实际：${out.text}`)
    assert.ok(!out.text.includes('不可达'), '不该再用"不可达"这种笼统说法盖住真实原因')
    assert.ok(logs.some((l) => l.includes('重试后仍失败（共 2 次）')), `应写明尝试次数，实际：${logs.join(' | ')}`)
  })
}

// ── 3) HTTP 4xx 是确定性失败：**不重试**，且把服务端的 message 转达出去 ─────────
{
  for (const status of [400, 404, 422]) {
    let calls = 0
    await withServer((req, res) => { calls += 1; json(res, status, { code: status }) }, async (base) => {
      const logs = []
      const out = await makeClient(logs).knowledgeToolsCall(base, 'k1', 'search', {})
      assert.equal(calls, 1, `HTTP ${status} 不该重试`)
      assert.equal(out.ok, false)
      assert.ok(out.text.includes(`HTTP ${status}`), `应带上状态码，实际：${out.text}`)
      assert.ok(logs.some((l) => l.includes('确定性失败，不重试')), `应标明未重试，实际：${logs.join(' | ')}`)
    })
  }
}

// ── 3b) 事故现场（2026-10-14）：4xx 带着服务端 message → 必须原样进工具输出 ────
// 当时模型把 read_page 的 refs 写成 path，服务端回得很清楚，模型却只看到"不可达"。
{
  await withServer((req, res) => json(res, 400, { code: 400, message: 'refs is required (non-empty array)' }), async (base) => {
    const out = await makeClient([]).knowledgeToolsCall(base, 'wiki-1fqn0olg', 'read_page', { path: 'wiki/concepts/国策树.md' })
    assert.equal(out.ok, false)
    assert.ok(out.text.includes('refs is required'), `服务端 message 必须转达，实际：${out.text}`)
    assert.equal(out.text, 'HTTP 400 · refs is required (non-empty array)', 'HTTP 状态与 message 都该在')
  })
}

// ── 4) 信封 code != 0（业务拒绝）同样不重试，并带上业务码与 message ────────────
{
  let calls = 0
  await withServer((req, res) => { calls += 1; json(res, 200, { code: 4001, message: 'resource busy' }) }, async (base) => {
    const logs = []
    const out = await makeClient(logs).knowledgeToolsCall(base, 'k1', 'search', {})
    assert.equal(calls, 1, '业务 code != 0 不该重试')
    assert.equal(out.ok, false)
    assert.equal(out.text, 'code=4001 · resource busy', `业务码与 message 都该转达，实际：${out.text}`)
    assert.ok(logs.some((l) => l.includes('code=4001')), `日志应带上业务码，实际：${logs.join(' | ')}`)
    assert.ok(logs.some((l) => l.includes('确定性失败，不重试')))
  })
}

// ── 4b) 纯网络层失败才说"请求失败"，并且带 cause ──────────────────────────────
{
  const server = http.createServer((req, res) => { req.socket.destroy() })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const out = await makeClient([]).knowledgeToolsCall(`http://127.0.0.1:${port}/v3`, 'k1', 'search', {})
    assert.equal(out.ok, false)
    assert.ok(out.text.startsWith('请求失败'), `网络层失败才说请求失败，实际：${out.text}`)
  } finally {
    server.closeAllConnections?.()
    server.close()
  }
}

// ── 5) tools/list 走同一条重试路径（首次 502 → 第二次拿到清单）────────────────
{
  let calls = 0
  await withServer((req, res) => {
    calls += 1
    if (calls === 1) { json(res, 502, { code: 502 }); return }
    json(res, 200, { code: 0, data: { tools: [{ name: 'search', description: 'd', params: {} }] } })
  }, async (base) => {
    const client = makeClient([])
    const result = await client.knowledgeToolsList(base, 'k1')
    assert.equal(calls, 2, 'tools/list 也应享受这次重试')
    assert.equal(result.ok, true)
    assert.deepEqual(result.tools.map((t) => t.name), ['search'])
  })
}

// ── 5b) tools/list 失败：`{ok:false,error}`（与"资源确实没有工具"分得开）──────
{
  await withServer((req, res) => json(res, 500, { code: 500, message: 'kb down' }), async (base) => {
    const result = await makeClient([]).knowledgeToolsList(base, 'k1')
    assert.equal(result.ok, false)
    assert.ok(result.error.includes('kb down'), `应带上服务端 message，实际：${result.error}`)
  })
  await withServer((req, res) => json(res, 200, { code: 0, data: {} }), async (base) => {
    const result = await makeClient([]).knowledgeToolsList(base, 'k1')
    assert.deepEqual(result, { ok: false, error: '服务未返回 tools 字段。' }, '响应形状不对也要说清楚')
  })
  await withServer((req, res) => json(res, 200, { code: 0, data: { tools: [] } }), async (base) => {
    const result = await makeClient([]).knowledgeToolsList(base, 'k1')
    assert.deepEqual(result, { ok: true, tools: [] }, '工具为空是成功，不是失败')
  })
}

// ── 7) wiki read_page 的空引用：必须显式说明（否则空结果被当结论）─────────────
{
  await withServer((req, res) => json(res, 200, {
    code: 0,
    data: { items: [{ ref: 'wiki/concepts/国策树.md', content: '# 国策树\n…' }, { ref: 'wiki/concepts/不存在的页.md', content: '' }] },
  }), async (base) => {
    const out = await makeClient([]).knowledgeToolsCall(base, 'wiki-1fqn0olg', 'read_page', { refs: ['wiki/concepts/国策树.md', 'wiki/concepts/不存在的页.md'] })
    assert.equal(out.ok, true, '服务端 code=0，所以整体仍是成功')
    assert.ok(out.text.includes('wiki/concepts/不存在的页.md'), '缺内容的引用路径要出现')
    assert.ok(out.text.includes('没取到内容'), `空 content 必须显式提示，实际：${out.text.slice(-160)}`)
  })
  await withServer((req, res) => json(res, 200, {
    code: 0,
    data: { items: [{ ref: 'wiki/a.md', content: '# A' }] },
  }), async (base) => {
    const out = await makeClient([]).knowledgeToolsCall(base, 'wiki-1fqn0olg', 'read_page', { refs: ['wiki/a.md'] })
    assert.ok(!out.text.includes('[tdai]'), '全部取到内容时不该加任何注解')
  })
}

// ── 6) 主网关路径的日志也带 cause（safe() 的失败不该只剩 "fetch failed"）────────
{
  const server = http.createServer((req, res) => { req.socket.destroy() })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const logs = []
    const client = new GatewayClient({ endpoint: `http://127.0.0.1:${port}`, serviceId: 'default', timeoutMs: 2000 }, (m) => logs.push(m))
    const items = await client.searchL1({ teamId: 't', agentId: 'a', userId: 'u' }, 'hi', {})
    assert.deepEqual(items, [], '主路径仍 fail-open 返回空命中')
    assert.ok(logs.some((l) => l.includes('/v3/atomic/search failed')), `应记录失败，实际：${logs.join(' | ')}`)
    assert.ok(logs.some((l) => l.includes('cause:')), '网络层失败日志应带 cause')
  } finally {
    server.closeAllConnections?.()
    server.close()
  }
}

console.log('knowledge retry tests passed: 连接层重试 / 5xx 重试 / 4xx 与业务码不重试 / 错误原样转达 / 空引用显式提示 / 日志带 cause 与尝试次数')
