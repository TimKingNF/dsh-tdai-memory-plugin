/**
 * 知识端点重试与日志护栏（真 HTTP，不打桩 fetch）。
 *
 * 背景：实测出现过"同一 host:port，直连 curl 每次成功、插件进程偶发失败"的形态，
 * 而 `#postTo` 当时是**单次尝试 + 立刻 fail-open** —— 模型只拿到一句"知识服务不可达"
 * 就放弃整条取证链路。现在加 1 次重试，但**只重试可重试的失败**：网络/超时/5xx/429
 * 重试，HTTP 4xx 与业务 `code != 0` 直接返回（重试只是把同一个答案再要一遍）。
 *
 * 同时锁住日志形态：每次尝试分开打、带失败原因（含 cause 的 code）与耗时，
 * 因为"知识服务不可达"这句话在排查时提供不了任何信息量。
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
    assert.deepEqual(out, { ok: false, text: '知识服务不可达。' }, '两次都失败仍是 fail-open')
    assert.ok(logs.some((l) => l.includes('重试后仍失败（共 2 次）')), `应写明尝试次数，实际：${logs.join(' | ')}`)
  })
}

// ── 3) HTTP 4xx 是确定性失败：**不重试**（重试只会白等一个 timeout）────────────
{
  for (const status of [400, 404, 422]) {
    let calls = 0
    await withServer((req, res) => { calls += 1; json(res, status, { code: status }) }, async (base) => {
      const logs = []
      const out = await makeClient(logs).knowledgeToolsCall(base, 'k1', 'search', {})
      assert.equal(calls, 1, `HTTP ${status} 不该重试`)
      assert.deepEqual(out, { ok: false, text: '知识服务不可达。' })
      assert.ok(logs.some((l) => l.includes('确定性失败，不重试')), `应标明未重试，实际：${logs.join(' | ')}`)
    })
  }
}

// ── 4) 信封 code != 0（业务拒绝）同样不重试 ─────────────────────────────────────
{
  let calls = 0
  await withServer((req, res) => { calls += 1; json(res, 200, { code: 4001, message: 'resource busy' }) }, async (base) => {
    const logs = []
    const out = await makeClient(logs).knowledgeToolsCall(base, 'k1', 'search', {})
    assert.equal(calls, 1, '业务 code != 0 不该重试')
    assert.deepEqual(out, { ok: false, text: '知识服务不可达。' })
    assert.ok(logs.some((l) => l.includes('code=4001')), `日志应带上业务码，实际：${logs.join(' | ')}`)
    assert.ok(logs.some((l) => l.includes('确定性失败，不重试')))
  })
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
    const tools = await client.knowledgeToolsList(base, 'k1')
    assert.equal(calls, 2, 'tools/list 也应享受这次重试')
    assert.deepEqual(tools.map((t) => t.name), ['search'])
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

console.log('knowledge retry tests passed: 连接层重试 / 5xx 重试 / 4xx 与业务码不重试 / 日志带 cause 与尝试次数')
