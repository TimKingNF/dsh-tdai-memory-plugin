/**
 * 读侧工具失败转达测试（候选 1，P0）。
 *
 * 背景：0.6.1 事故——知识工具把 4xx 说成"不可达"，模型连试 4 种参数写法后断定
 * "库里没有"并自己拼文档（CHANGELOG.md:77-120）。同样的事故在**普通读侧工具**上
 * 有两个叠加的吞口：
 *   1. `client.mjs` 的 `safe()` 把真实原因吞进日志、回落 `{}` / `[]` / `null`；
 *   2. `lib/tools.mjs` 把 `null` / `[]` / `{}` 一律说成「（无结果）」。
 * 于是 HTTP 4xx、超时、非 JSON 响应全部长得像"记忆里没有"（QA 2026-10-20 实测：
 * 网关卡死 / 200+HTML / 200+空 body 三种形态下 8 个只读工具全部回「（无结果）」）。
 *
 * 验收矩阵（Architect 修订后的判据）：
 *   - **8 个只读工具 × 3 种失败形态 = 24 格**，每格断言「不等于（无结果）」且带分类词；
 *   - 合法空 3 例严格等于「（无结果）」：`200+items:[]`、`read_scene` 200 无 data、
 *     `skill_view` 200 无 data；
 *   - 4 个写侧工具失败时不得出现「暂时不可用」；
 *   - 脱敏：用 endpoint 解析出的 host/port 做显式断言，正则做第二道。
 *
 * 范围说明：知识 2 个工具（`tdai_knowledge_tools` / `tdai_knowledge_call`）走的是既有
 * `{ok, error}` 通道，**不在本轮矩阵内**（算进去就是扩范围）；`#exchange` 的统一脱敏
 * 会顺带改善它们的网络层文案，属于副作用，不在本文件断言。
 *
 * 运行：node test/tools-failure.test.mjs
 */
import assert from 'node:assert'
import { GatewayClient } from '../client.mjs'
import { registerTools, registerTaskTools, registerKnowledgeTools } from '../lib/tools.mjs'

const ENDPOINT = 'http://127.0.0.1:8420'
// 假密钥运行时拼接：`scripts/check-secrets.mjs` 的「凭据赋值」规则匹配静态字面量，
// 直接写成 'sk-...' 会让本文件成为提交前的扫描命中项（值本身是假的，但扫描器不认）。
const API_KEY = ['sk', 'API', 'SECRET', 'should', 'never', 'leak'].join('-')
const realFetch = globalThis.fetch

const jsonResponse = (status, body, { ok = status >= 200 && status < 300 } = {}) => ({
  ok,
  status,
  async json() { return body },
})
const htmlResponse = (status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { throw new SyntaxError("Unexpected token '<', \"<html>\" is not valid JSON") },
})
const emptyBodyResponse = (status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { throw new SyntaxError('Unexpected end of JSON input') },
})
const timeoutError = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError')
const abortError = () => new DOMException('This operation was aborted', 'AbortError')
const networkError = () => {
  const error = new TypeError('fetch failed')
  error.cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8420'), { code: 'ECONNREFUSED' })
  return error
}

/** 挂一个默认返回合法空 envelope 的桩；真正行为由 handler 决定。 */
function stubFetch(handler = async () => jsonResponse(200, { code: 0, data: {} })) {
  globalThis.fetch = handler
}

const identity = { session_id: 's1', team_id: 't', agent_id: 'a', user_id: 'u' }
const asset = {
  knowledge: [{
    knowledge_id: 'k1', type: 'code-graph', service_url: 'http://kb.internal',
    name: 'kb', repo_slug: 'acme/repo', branch: 'main',
  }],
  loadedAt: Date.now(),
}

/**
 * 注册全部 14 个工具（三个注册器都跑），同时**单独保留 registerTools 的 8 个只读**。
 * 为什么要分开：`registerTools` 只注册 8 个只读工具，14 = 8 + `registerTaskTools` 4 写侧
 * + `registerKnowledgeTools` 2 知识；只拿一个映射会数错（QA 2026-10-20 纠正过这一点）。
 */
function harness(over = {}) {
  const all = new Map()
  const readTools = new Map()
  const logs = []
  const ctxFor = (map) => ({
    tools: {
      register(def) {
        map.set(def.name, def)
        all.set(def.name, def)
        return () => {}
      },
    },
    agent: { session: { id: 's1' } },
    sessions: { list: () => [] },
  })
  const client = new GatewayClient(
    { endpoint: ENDPOINT, serviceId: 'default', apiKey: API_KEY, timeoutMs: 5000 },
    (m) => logs.push(m),
  )
  const runtime = {
    config: { enabled: true, taskWriteEnabled: true, knowledgeEnabled: true },
    readEnabled: () => true,
    hasUserKey: () => true,
    identityFor: () => ({ ...identity }),
    readPolicyFor: () => ({ memory: true, skills: true, knowledge: true }),
    log: (m) => logs.push(m),
    client: over.client ?? client,
    assets: {
      peek: () => asset,
      ensure: async () => asset,
      refresh: async () => asset,
      warm: () => {},
    },
  }
  registerTools(ctxFor(readTools), runtime)
  registerTaskTools(ctxFor(new Map()), runtime)
  registerKnowledgeTools(ctxFor(new Map()), runtime)
  return { tools: all, readTools, logs, client, runtime }
}

/** 8 个只读工具 + 各一个最小合法参数。 */
const READ_CALLS = [
  ['tdai_memory_search', { query: '我叫什么' }],
  ['tdai_memory_query', { limit: 3 }],
  ['tdai_conversation_search', { query: '上次方案' }],
  ['tdai_conversation_query', { limit: 3 }],
  ['tdai_skill_search', { query: 'tdai' }],
  ['tdai_read_scene', { path: '个人背景-职业轨迹.md' }],
  ['tdai_scenario_ls', { prefix: '个人' }],
  ['tdai_skill_view', { skill_name: 'some-skill' }],
]

/** 3 种失败形态 + 各自必须在文案里出现的分类词。 */
const FAILURE_FORMS = [
  ['网关卡死（AbortSignal.timeout → TimeoutError）', async () => { throw timeoutError() }, '请求超时'],
  ['HTTP 200 + HTML 错误页（非 JSON）', async () => htmlResponse(200), '响应无法解析'],
  ['HTTP 200 + 空 body（非 JSON）', async () => emptyBodyResponse(200), '响应无法解析'],
]

const WRITE_CALLS = [
  ['tdai_task_add', { title: '记一条' }],
  ['tdai_task_list', {}],
  ['tdai_task_update', { task_id: 'task-1', status: 'completed' }],
  ['tdai_task_delete', { task_id: 'task-1' }],
]

// ── 0) 注册基线：registerTools 只 8 个只读，三个注册器合计 14 ────────────────────
{
  const { readTools, tools } = harness()
  assert.equal(readTools.size, 8, `registerTools 应只注册 8 个只读工具，实际 ${readTools.size}`)
  assert.equal(tools.size, 14, `三个注册器合计应为 14 个工具，实际 ${tools.size}`)
  for (const [name] of [...READ_CALLS, ...WRITE_CALLS]) {
    assert.ok(tools.has(name), `缺少工具 ${name}`)
  }
}

// ── 1) 验收矩阵：8 个只读工具 × 3 种失败形态 = 24 格 ──────────────────────────
// 每格：不等于「（无结果）」+ 带分类词。这是完备性证据，替代"每个 op 声明空值语义"的表。
{
  const cells = []
  for (const [formLabel, handler, keyword] of FAILURE_FORMS) {
    stubFetch(handler)
    try {
      const { readTools } = harness()
      for (const [name, args] of READ_CALLS) {
        const text = await readTools.get(name).execute(args)
        cells.push([formLabel, name, text])
        assert.notEqual(text, '（无结果）', `[${formLabel}] ${name} 把失败说成了空结果`)
        assert.ok(!text.includes('（无结果）'), `[${formLabel}] ${name} 文案里仍出现「（无结果）」：${text}`)
        assert.ok(text.includes(keyword),
          `[${formLabel}] ${name} 文案缺分类词「${keyword}」，实际：${text}`)
      }
    } finally { globalThis.fetch = realFetch }
  }
  assert.equal(cells.length, 24, `矩阵应有 24 格，实际 ${cells.length}`)
}

// ── 2) HTTP 4xx + 服务端 message：状态码与原因都要到模型眼前 ────────────────────
{
  stubFetch(async () => jsonResponse(400, { code: 'missing_user_key', message: 'missing user key' }))
  try {
    const { readTools } = harness()
    const text = await readTools.get('tdai_memory_search').execute({ query: '我叫什么' })
    assert.ok(text.includes('HTTP 400'), `失败文案必须带状态码，实际：${text}`)
    assert.ok(text.includes('missing user key'), `服务端 message 必须转达，实际：${text}`)
    assert.ok(!text.includes('（无结果）'), `4xx 不得伪装成空结果，实际：${text}`)
    assert.ok(text.includes('不等于记忆里没有相关内容'), `必须堵住"失败=没有"的误读，实际：${text}`)
  } finally { globalThis.fetch = realFetch }
}

// ── 3) HTTP 5xx（空 body）：只说状态码也不能塌成空结果 ─────────────────────────
{
  stubFetch(async () => jsonResponse(503, {}))
  try {
    const text = await harness().readTools.get('tdai_memory_query').execute({ limit: 3 })
    assert.ok(text.includes('HTTP 503'), `实际：${text}`)
    assert.ok(!text.includes('（无结果）'), `实际：${text}`)
  } finally { globalThis.fetch = realFetch }
}

// ── 4) 超时预算：文案里的 ms 必须是实际生效值 ─────────────────────────────────
{
  stubFetch(async () => { throw timeoutError() })
  try {
    const { readTools, logs } = harness()
    const text = await readTools.get('tdai_memory_search').execute({ query: 'q' })
    assert.ok(text.includes('请求超时'), `实际：${text}`)
    assert.ok(text.includes('5000ms'), `要写明实际生效的超时预算，实际：${text}`)
    assert.ok(logs.some((l) => l.includes('/v3/atomic/search failed:')), `失败必须留日志，实际：${logs.join(' | ')}`)
  } finally { globalThis.fetch = realFetch }
}

// ── 5) 调用方取消（AbortError）：与超时分开，不能都叫"超时" ────────────────────
{
  stubFetch(async () => { throw abortError() })
  try {
    const text = await harness().readTools.get('tdai_memory_search').execute({ query: 'q' })
    assert.ok(text.includes('请求已取消'), `实际：${text}`)
    assert.ok(!text.includes('请求超时'), `取消不能报成超时，实际：${text}`)
  } finally { globalThis.fetch = realFetch }
}

// ── 6) 网络层：只带 cause.code，绝不带 host/port ───────────────────────────────
{
  stubFetch(async () => { throw networkError() })
  try {
    const text = await harness().readTools.get('tdai_memory_search').execute({ query: 'q' })
    assert.ok(text.includes('ECONNREFUSED'), `网络层要给 cause.code，实际：${text}`)
    assert.ok(!text.includes('127.0.0.1'), `不得泄露 host，实际：${text}`)
    assert.ok(!text.includes('8420'), `不得泄露 port，实际：${text}`)
  } finally { globalThis.fetch = realFetch }
}

// ── 7) 合法空结果 3 例：必须严格等于「（无结果）」──────────────────────────────
{
  stubFetch(async () => jsonResponse(200, { code: 0, data: { items: [] } }))
  try {
    const text = await harness().readTools.get('tdai_memory_search').execute({ query: 'q' })
    assert.equal(text, '（无结果）', `200+items:[] 必须严格等于「（无结果）」，实际：${text}`)
  } finally { globalThis.fetch = realFetch }

  stubFetch(async () => jsonResponse(200, { code: 0, data: {} }))
  try {
    const { readTools } = harness()
    // read_scene / skill_view 的 null 双语义：200 无内容 = 合法空；失败由 ok:false 分开。
    for (const [name, args] of [
      ['tdai_read_scene', { path: '不存在的场景.md' }],
      ['tdai_skill_view', { skill_name: 'nope' }],
    ]) {
      const text = await readTools.get(name).execute(args)
      assert.equal(text, '（无结果）', `${name}：200 无内容应是合法空结果，实际：${text}`)
    }
  } finally { globalThis.fetch = realFetch }

  stubFetch(async () => jsonResponse(404, { code: 404, message: 'not found' }))
  try {
    const { readTools } = harness()
    for (const [name, args] of [
      ['tdai_read_scene', { path: '不存在的场景.md' }],
      ['tdai_skill_view', { skill_name: 'nope' }],
    ]) {
      const text = await readTools.get(name).execute(args)
      assert.ok(text.includes('HTTP 404'), `${name}：失败必须报状态码，实际：${text}`)
      assert.ok(!text.includes('（无结果）'), `${name}：失败不能塌成空结果，实际：${text}`)
    }
  } finally { globalThis.fetch = realFetch }
}

// ── 7b) 成功输出形状不变：read_scene 仍返回**纯正文**，不是严格通道的信封 JSON ──────
// Architect 2026-10-20 评审抓到过这个回归：改走 attemptReadL2 后直接把 {path,content,updatedAt}
// 序列化给模型，属于范围外的模型可见变更。这条用例是那次回归的唯一护栏。
{
  stubFetch(async () => jsonResponse(200, {
    code: 0,
    data: { content: '场景正文', updated_at: '2026-10-20' },
  }))
  try {
    const text = await harness().readTools.get('tdai_read_scene').execute({ path: 'p.md' })
    assert.equal(text, '场景正文', `read_scene 成功输出必须是纯正文（旧行为），实际：${text}`)
    assert.ok(!text.includes('"path"') && !text.includes('updatedAt'),
      `read_scene 不得把内部信封暴露给模型，实际：${text}`)
  } finally { globalThis.fetch = realFetch }
}

// ── 7c) 4xx 只有业务码、没有 message 时：业务码不能被丢掉（最可操作的线索）──────────
{
  stubFetch(async () => jsonResponse(401, { code: 'missing_user_key' }))
  try {
    const text = await harness().readTools.get('tdai_memory_search').execute({ query: 'q' })
    assert.ok(text.includes('HTTP 401'), `实际：${text}`)
    assert.ok(text.includes('code=missing_user_key'), `只有业务码时也要转达，实际：${text}`)
    assert.ok(!text.includes('（无结果）'), `实际：${text}`)
  } finally { globalThis.fetch = realFetch }
}

// ── 8) 业务码 code != 0：带业务码与服务端 message ──────────────────────────────
{
  stubFetch(async () => jsonResponse(200, { code: 40001, message: 'query too long' }))
  try {
    const text = await harness().readTools.get('tdai_memory_search').execute({ query: 'q' })
    assert.ok(text.includes('code=40001'), `实际：${text}`)
    assert.ok(text.includes('query too long'), `实际：${text}`)
  } finally { globalThis.fetch = realFetch }
}

// ── 9) 注入/召回链路不变：`searchL1`（无严格通道）失败仍 fail-open 返回 [] ────────
{
  stubFetch(async () => jsonResponse(500, { code: 500 }))
  try {
    const { client, logs } = harness()
    const items = await client.searchL1({ teamId: 't', agentId: 'a', userId: 'u' }, 'q', {})
    assert.deepEqual(items, [], '注入链路仍必须 fail-open 返回空命中（不抛、不阻断主链路）')
    assert.ok(logs.some((l) => l.includes('/v3/atomic/search failed:')), `旧日志格式必须保留，实际：${logs.join(' | ')}`)
  } finally { globalThis.fetch = realFetch }
}

// ── 10) 写侧：`post()` 抛出的 message 与旧格式逐字一致（taskWriteFailure 依赖）──────
{
  stubFetch(async () => jsonResponse(403, { code: 'denied', message: 'permission_denied' }))
  try {
    const { client } = harness()
    await assert.rejects(
      () => client.metaCreateTask({ title: 'x' }),
      (error) => {
        assert.equal(
          error.message,
          '[tdai-memory] /v3/meta/task/create HTTP 403 code=denied permission_denied',
          `写侧错误格式不能被改（taskWriteFailure 正则依赖它），实际：${error.message}`,
        )
        return true
      },
    )
  } finally { globalThis.fetch = realFetch }
}

// ── 11) 写侧 12 格：4 个写工具 × 3 种失败形态，全部必须出「待办写入失败」──────────
//
// 为什么单独测写侧：`protocol` 缺陷在写侧会**假成功**——旧 `post()` 把 200+HTML 洗成
// `{}`，`resp.ok` 为真、`code` 为 undefined，直接 `return {}`，写工具拿到空对象照样拼
// "已记 / 已更新 / 已删除 / 没有…的 task"（QA 2026-10-20 在 0.7.0 上实测到 4/4 全中）。
// 所以判据不是"不出现暂时不可用"，而是"必须说写入失败，且不许出现任何成功/空结果文案"。
{
  const WRITE_FORMS = [
    ['网关卡死（TimeoutError）', async () => { throw timeoutError() }, null],
    ['HTTP 503', async () => jsonResponse(503, {}), 'HTTP 503'],
    // 关键四格：HTTP 200 + 非 JSON（反代错误页）
    ['HTTP 200 + HTML（非 JSON）', async () => htmlResponse(200), 'HTTP 200'],
  ]
  const SUCCESS_PHRASES = [/已记/, /已更新/, /已删除/, /没有.*的 task/]
  let cells = 0
  for (const [formLabel, handler, statusWord] of WRITE_FORMS) {
    stubFetch(handler)
    try {
      const { tools } = harness()
      for (const [name, args] of WRITE_CALLS) {
        const text = await tools.get(name).execute(args)
        cells += 1
        assert.ok(text.includes('待办写入失败'),
          `[${formLabel}] ${name}：写侧失败必须明说写入失败，实际：${text}`)
        assert.ok(!text.includes('暂时不可用'),
          `[${formLabel}] ${name}：写侧不得用读侧兜底文案，实际：${text}`)
        if (statusWord) {
          assert.ok(text.includes(statusWord),
            `[${formLabel}] ${name}：protocol/HTTP 失败文案必须带状态码，实际：${text}`)
        }
        for (const phrase of SUCCESS_PHRASES) {
          assert.ok(!phrase.test(text),
            `[${formLabel}] ${name}：失败不得出现成功/空结果文案（${phrase}），实际：${text}`)
        }
      }
    } finally { globalThis.fetch = realFetch }
  }
  assert.equal(cells, 12, `写侧矩阵应有 12 格，实际 ${cells}`)
}

// ── 12) 脱敏（显式 host/port 断言 + 正则第二道，兼容 IPv6）─────────────────────
// Node 的 ECONNREFUSED 文案是 `connect ECONNREFUSED 127.0.0.1:8420`，`:\d{4}` 那类正则
// 挡不住 host，所以必须从 endpoint 解析出 host/port 做显式断言。
{
  const seen = []
  const { client } = harness()
  const url = new URL(client.endpoint)
  const host = url.hostname
  const port = url.port
  assert.ok(host && port, 'fixture 前提：endpoint 必须带 host 与 port')
  const cases = [
    ...FAILURE_FORMS.map(([, handler]) => handler),
    async () => { throw networkError() },
    async () => jsonResponse(400, { code: 'missing_user_key', message: 'missing user key' }),
  ]
  for (const handler of cases) {
    stubFetch(handler)
    try {
      const { readTools } = harness()
      for (const [name, args] of READ_CALLS) {
        seen.push([name, await readTools.get(name).execute(args)])
      }
    } finally { globalThis.fetch = realFetch }
  }
  for (const [name, text] of seen) {
    assert.ok(!text.includes(host), `${name}：文案泄露 host ${host}，实际：${text}`)
    assert.ok(!text.includes(`:${port}`), `${name}：文案泄露 port ${port}，实际：${text}`)
    assert.ok(!/\b(?:https?|wss?):\/\//.test(text), `${name}：文案泄露 URL，实际：${text}`)
    assert.ok(!/:\d{4,5}/.test(text), `${name}：文案里出现端口形态，实际：${text}`)
    assert.ok(!text.includes('Bearer'), `${name}：文案泄露 Authorization scheme，实际：${text}`)
    assert.ok(!text.includes('sk-'), `${name}：文案泄露凭据，实际：${text}`)
    assert.ok(!text.includes('x-tdai-'), `${name}：文案泄露请求头，实际：${text}`)
  }
}

console.log('tools failure tests passed: 只读 24 格（8×3）可区分且脱敏；写侧 12 格（4×3，含 200+非 JSON 不得假成功）；'
  + '合法空 3 例严格「（无结果）」；注入链路 fail-open 与写侧 HTTP 错误格式逐字未变')
