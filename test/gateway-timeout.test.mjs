/**
 * 真 HTTP 集成护栏：网关**慢/挂**时，读侧必须仍然是"有界等待 + fail-open"。
 *
 * 这个文件用真实 `fetch`/`AbortSignal` 跑（不是打桩），复现线上那两个症状的成因：
 *   - `agent/pre-step` 里的 L1 检索：网关不响应时必须靠 `recallTimeoutMs` 放弃本轮召回，
 *     **不能**把这一步挂住（用户看到的是"发消息一直阻塞等待"）；
 *   - `SessionAssets.ensure` 的整包资产：网关不响应时必须靠 `assetLoadBudgetMs` 降级，
 *     且失败后进冷却期（否则每一步重付一次）。
 * 同时验证正常路径：网关慢但可用时，召回**照样注入**（不是一慢就啥都没有）。
 * 运行：node test/gateway-timeout.test.mjs
 */
import assert from 'node:assert'
import http from 'node:http'
import { GatewayClient } from '../client.mjs'
import { SessionAssets } from '../lib/assets.mjs'
import { wireRecall, SOURCE_KIND } from '../lib/recall.mjs'

/** 起一个假 MemoryCore：mode='hang' 时只挂住请求不回；mode='ok' 时延迟后回合法 envelope。 */
function gateway(mode, delayMs = 0) {
  const server = http.createServer((req, res) => {
    if (mode === 'hang') return // 故意不响应（真实网关卡死的样子）
    setTimeout(() => {
      let body = {}
      if (req.url === '/v3/atomic/search') {
        body = { code: 0, data: { items: [{ id: 'm1', type: 'rule', content: 'remember X', score: 0.9 }] } }
      } else if (req.url === '/v3/meta/agent/get') {
        body = { code: 0, data: { agent_id: 'a', name: 'A', description: '', prompt: '' } }
      } else {
        body = { code: 0, data: {} }
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }, delayMs)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, endpoint: `http://127.0.0.1:${port}` })
    })
  })
}

const identity = { teamId: 't', agentId: 'a', userId: 'u' }
const cfg = (over = {}) => ({
  enabled: true, recallEnabled: true, injectionEnabled: true,
  teamId: 't', agentId: 'a', userId: 'u', serviceId: 'default', userKey: '',
  taskId: undefined, recallLimit: 5, timeoutMs: 5000,
  recallTimeoutMs: 150, assetLoadBudgetMs: 300, assetRetryCooldownMs: 60000,
  ...over,
})

const userMessage = { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user', rpcId: 'r1' } }
const payload = { agent: { session: { id: 's1' } }, messages: [userMessage], turn: 1, step: 1 }
const enter = () => ({ kind: 'enter', messages: [userMessage] })

function runtimeWith(client, assets, config) {
  const logs = []
  return {
    logs,
    runtime: {
      readEnabled: () => true,
      config,
      client,
      assets,
      log: (m) => logs.push(m),
    },
  }
}

function harness(runtime) {
  const events = []
  wireRecall({ on: (ev, cb) => events.push([ev, cb]) }, runtime)
  return events[0][1]
}

// ── 1) 网关卡死：pre-step 必须在 recallTimeoutMs 附近返回，且不改动 decision ──────
{
  const { server, endpoint } = await gateway('hang')
  try {
    const config = cfg({ sessionContextEnabled: true })
    const clientLogs = []
    const client = new GatewayClient({ endpoint, serviceId: 'default', timeoutMs: 5000 }, (m) => clientLogs.push(m))
    const assets = new SessionAssets(client, config, () => {})
    const { runtime } = runtimeWith(client, assets, config)
    const handler = harness(runtime)

    const started = Date.now()
    const result = await handler(payload, async () => enter())
    const elapsed = Date.now() - started

    assert.ok(elapsed < 1500, `pre-step 必须靠硬超时收敛，实际 ${elapsed}ms`)
    assert.deepEqual(result, enter(), '网关不可用时 fail-open：原样返回 decision')
    assert.ok(
      clientLogs.some((l) => l.includes('/v3/atomic/search')),
      `应记录一次检索失败，实际日志：${clientLogs.join(' | ')}`,
    )
  } finally {
    server.closeAllConnections?.()
    server.close()
  }
}

// ── 2) 网关卡死：资产加载受总预算封顶，且冷却期内不再打网关 ─────────────────────
{
  const { server, endpoint } = await gateway('hang')
  try {
    const config = cfg({ sessionContextEnabled: true })
    const client = new GatewayClient({ endpoint, serviceId: 'default', timeoutMs: 5000 }, () => {})
    const assets = new SessionAssets(client, config, () => {})

    const started = Date.now()
    assert.equal(await assets.ensure('s1'), null, '超预算应降级为 null')
    const first = Date.now() - started
    assert.ok(first < 1500, `整包加载必须受预算封顶，实际 ${first}ms`)

    const again = Date.now()
    assert.equal(await assets.ensure('s1'), null)
    assert.ok(Date.now() - again < 50, '冷却期内必须立刻返回（不再打网关）')
  } finally {
    server.closeAllConnections?.()
    server.close()
  }
}

// ── 3) 网关"慢但活着"：召回照样注入（超时只是下限保护，不是常态放弃）──────────
{
  const { server, endpoint } = await gateway('ok', 20)
  try {
    const config = cfg({ assetLoadBudgetMs: 2000, sessionContextEnabled: true })
    const client = new GatewayClient({ endpoint, serviceId: 'default', timeoutMs: 5000 }, () => {})
    const assets = new SessionAssets(client, config, () => {})
    const { runtime } = runtimeWith(client, assets, config)
    const handler = harness(runtime)

    // 先让资产加载完成（模拟 session-start 预热），再走 pre-step
    await assets.ensure('s1')
    assert.ok(assets.peek('s1'), '预热后缓存应有值')

    const result = await handler(payload, async () => enter())
    assert.equal(result.messages.length, 2, '应注入一条召回消息')
    assert.deepEqual(result.messages[0], userMessage, '真人消息必须原样保留')
    const injected = result.messages[1]
    assert.equal(injected.source.kind, SOURCE_KIND, 'v4 要求生产者自己的 kind（不能是 plugin）')
    assert.equal(injected.source.form, 'notice')
    assert.ok(injected.content[0].text.includes('remember X'), '真实 HTTP 命中的内容应进块')
  } finally {
    server.closeAllConnections?.()
    server.close()
  }
}

console.log('gateway timeout tests passed: 卡死时 pre-step 有界返回 / 资产预算+冷却 / 慢但可用时照常召回')
