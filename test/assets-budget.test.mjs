/**
 * SessionAssets 的"不许卡住主链路"护栏。
 *
 * 背景（线上现象）：开启召回后发消息会**一直阻塞等待 / 像死循环**。链路是
 * pre-step（召回）与 system-prompt/assemble 都会 await 整包资产加载：meta 面 +
 * 自有/借入 agent 的 L3/L2 + skill listing + 知识资源，逐个 5s 超时、分组串行。
 * 早先的实现"失败即删缓存"，于是网关慢/挂时**每一步都重付一次**这份代价。
 *
 * 这个文件锁住三条：
 *   1. 整包加载有总预算（assetLoadBudgetMs）—— 永不返回的客户端不会把 ensure 挂住；
 *   2. 失败后有冷却期（assetRetryCooldownMs）—— 冷却期内不再打网关；
 *   3. 显式 refresh（/tdai-sync）无视冷却期，仍能立刻重试。
 * 运行：node test/assets-budget.test.mjs
 */
import assert from 'node:assert'
import { SessionAssets, withKnowledgeOrigin } from '../lib/assets.mjs'

const baseCfg = {
  serviceId: 'default', teamId: 't', agentId: 'a', userId: 'u', userKey: '',
  sessionContextEnabled: false, skillsEnabled: false, profileMemoryEnabled: false,
  knowledgeEnabled: false, taskId: undefined, l2Limit: 3,
  timeoutMs: 5000, assetLoadBudgetMs: 5000, assetRetryCooldownMs: 15000,
}

/** 只走 metaGetAgent 一路的假客户端（userKey 为空 → 不会碰固定资产/画像/skill）。 */
function fakeClient(state = {}) {
  state.calls ??= { metaGetAgent: 0 }
  return {
    state,
    async metaGetAgent() {
      state.calls.metaGetAgent += 1
      if (state.hang) return new Promise(() => {})
      if (state.fail) throw new Error('gateway down')
      return { agent_id: 'a', name: 'A', description: '', prompt: '' }
    },
    metaGetTask: async () => null,
    metaAgentFixedAssets: async () => null,
    skillListing: async () => null,
    knowledgeList: async () => [],
  }
}

/** 只开 sessionContext 这一路，确保 #load 真的会打一次网关。 */
const ctxCfg = (over = {}) => ({ ...baseCfg, sessionContextEnabled: true, ...over })

// 1) 永不返回的网关：受总预算封顶，ensure 必须在预算附近落定为降级（null）
{
  const client = fakeClient({ hang: true })
  const assets = new SessionAssets(client, ctxCfg({ assetLoadBudgetMs: 80 }))
  // 预算计时器是 unref 的（不该为了它把进程吊住），所以这里自己保活，否则
  // 事件循环会先空掉、Node 直接以 "unsettled top-level await" 退出。
  const keepAlive = setInterval(() => {}, 10)
  const started = Date.now()
  let value
  try {
    value = await assets.ensure('s1')
  } finally {
    clearInterval(keepAlive)
  }
  const elapsed = Date.now() - started
  assert.equal(value, null, '超预算应降级为 null（fail-open）')
  assert.ok(elapsed < 2000, `必须在预算附近返回，实际 ${elapsed}ms`)
}

// 2) 失败后有冷却期：每一步都 ensure 也不会每步都打网关
{
  const client = fakeClient({ fail: true })
  const assets = new SessionAssets(client, ctxCfg({ assetRetryCooldownMs: 60000 }))
  assert.equal(await assets.ensure('s1'), null, '失败降级为 null')
  // 模拟"同一轮里连续 5 步"：每次 pre-step / assemble 都会 ensure 一次
  for (let i = 0; i < 5; i++) assert.equal(await assets.ensure('s1'), null)
  assert.equal(client.state.calls.metaGetAgent, 1, `冷却期内只应尝试一次，实际 ${client.state.calls.metaGetAgent} 次`)
  assert.equal(assets.peek('s1'), undefined, '失败后 peek 应为空（降级运行）')
}

// 3) 冷却期为 0（显式关闭）时保持"每次都可重试"的老行为
{
  const client = fakeClient({ fail: true })
  const assets = new SessionAssets(client, ctxCfg({ assetRetryCooldownMs: 0 }))
  await assets.ensure('s1')
  await assets.ensure('s1')
  assert.equal(client.state.calls.metaGetAgent, 2, '冷却期关闭时应每次重试')
}

// 4) refresh（/tdai-sync）无视冷却期：网关恢复后能立刻重新加载
{
  const state = { fail: true }
  const client = fakeClient(state)
  const assets = new SessionAssets(client, ctxCfg({ assetRetryCooldownMs: 60000 }))
  await assets.ensure('s1')
  assert.equal(assets.peek('s1'), undefined)
  state.fail = false // 网关恢复
  const value = await assets.refresh('s1')
  assert.equal(value?.agentDetail?.id, 'a', 'refresh 应无视冷却期重新加载成功')
  assert.equal(client.state.calls.metaGetAgent, 2, '冷却期内唯一一次重试来自 refresh')
  assert.ok(assets.peek('s1'), '刷新后 peek 立刻可见（同步读缓存）')
}

// 5) 并发 ensure / warm 只加载一次（幂等；warm 与 ensure 共享同一 promise）
{
  const client = fakeClient()
  const assets = new SessionAssets(client, ctxCfg())
  const [a, b, c] = await Promise.all([assets.ensure('s1'), assets.warm('s1'), assets.ensure('s1')])
  assert.equal(client.state.calls.metaGetAgent, 1, '并发只应加载一次')
  assert.deepEqual(a, b)
  assert.deepEqual(b, c)
  assert.ok(assets.peek('s1'), 'warm/ensure 完成后缓存可同步读')
}

// 6) dispose 清掉缓存与失败记录（会话结束不泄漏）
{
  const client = fakeClient({ fail: true })
  const assets = new SessionAssets(client, ctxCfg({ assetRetryCooldownMs: 60000 }))
  await assets.ensure('s1')
  assets.dispose('s1')
  await assets.ensure('s1')
  assert.equal(client.state.calls.metaGetAgent, 2, 'dispose 后应允许重新加载')
}

// 7) 知识服务地址改写：服务端返回容器内地址时，按 knowledgeEndpoint 换 origin（path 保留）
{
  const items = [{
    knowledge_id: 'cg-1', type: 'code-graph', name: 'repo',
    service_url: 'http://host.docker.internal:8424/v3',
  }]
  const client = {
    metaGetAgent: async () => null,
    metaGetTask: async () => null,
    metaAgentFixedAssets: async () => null,
    skillListing: async () => null,
    metaAgentKnowledgeIds: async () => ['cg-1'],
    knowledgeList: async () => items,
    knowledgeToolsList: async (url) => { calls.push(url); return [{ name: 'explore' }] },
  }
  const calls = []
  const assets = new SessionAssets(client, ctxCfg({ knowledgeEnabled: true, userKey: 'uk', knowledgeEndpoint: 'http://127.0.0.1:8424' }))
  const asset = await assets.ensure('s1')
  assert.equal(asset.knowledge[0].service_url, 'http://127.0.0.1:8424/v3', 'origin 应被换掉、/v3 保留')
  assert.deepEqual(calls, ['http://127.0.0.1:8424/v3'], '预取 tools/list 必须走改写后的地址')
}
{
  // 未配置改写：地址原样（不能把服务端返回的地址改坏）
  const client = {
    metaGetAgent: async () => null,
    metaGetTask: async () => null,
    metaAgentFixedAssets: async () => null,
    skillListing: async () => null,
    metaAgentKnowledgeIds: async () => ['cg-1'],
    knowledgeList: async () => [{ knowledge_id: 'cg-1', type: 'code-graph', name: 'r', service_url: 'http://kb.internal:9000/v3' }],
    knowledgeToolsList: async () => [],
  }
  const assets = new SessionAssets(client, ctxCfg({ knowledgeEnabled: true, userKey: 'uk' }))
  const asset = await assets.ensure('s1')
  assert.equal(asset.knowledge[0].service_url, 'http://kb.internal:9000/v3')
}
{
  // 非法改写值 → 回落原地址，不抛（fail-open）
  assert.equal(withKnowledgeOrigin('http://kb.internal/v3', '不是URL'), 'http://kb.internal/v3')
  assert.equal(withKnowledgeOrigin('http://kb.internal/v3', ''), 'http://kb.internal/v3')
}

console.log('assets budget tests passed: 总预算封顶 / 失败冷却 / refresh 破冷却 / 并发幂等 / dispose 清理 / 知识地址改写')
