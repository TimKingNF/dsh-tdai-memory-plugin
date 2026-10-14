/**
 * 待办写入 task 的契约测试（lib/tools.mjs 的 registerTaskTools + commands.mjs 的撤销命令）。
 *
 * 为什么必须单测这一层：写侧与读侧的失败语义**故意相反** ——
 *   读侧 fail-open（失败返回 null / 一句"暂时不可用"，不阻断对话），
 *   写侧必须 fail-loud（把服务端的 401/403/404 原样交给模型）。
 * 这两条只要有一处串味，症状都是**静默的**：模型以为自己记下了，其实什么都没写进库，
 * 而用户要到几周后翻 task 列表时才发现。所以这里逐条钉：
 *   1) payload 形状（team_id / creator_user_id / source_type / metadata_json）；
 *   2) 去重走 update 而不是新建（精确 title 匹配，不用相似度）；
 *   3) 开关与 userKey 缺失时必须**明确拒绝**，且一次网络都不打；
 *   4) 失败文案必须带服务端原因，且**绝不能**出现读侧那句"暂时不可用"；
 *   5) render 的签名是 (args, value) —— 写错会静默回显参数（历史事故，见 lib/tools.mjs 顶部）。
 *
 * 运行：node test/task-write.test.mjs
 */
import assert from 'node:assert'
import { registerTaskTools, lastWrittenTasks, forgetWrittenTask } from '../lib/tools.mjs'
import { registerCommands } from '../lib/commands.mjs'

const IDENTITY = {
  space_id: 'default',
  team_id: 'team-test',
  agent_id: 'agt-test',
  user_id: 'usr-test',
  session_id: 'sess-1',
  task_id: '',
}

/** 收集注册出来的工具，并给一个可控的假 client。 */
function harness({ taskWriteEnabled = true, hasUserKey = true, client = {} } = {}) {
  const registered = new Map()
  const calls = []
  const logs = []
  const ctx = {
    tools: { register: (tool) => registered.set(tool.name, tool) },
    commands: { register: (cmd) => registered.set(`/${cmd.name}`, cmd) },
  }
  const record = (name) => (...args) => {
    calls.push([name, ...args])
    const impl = client[name]
    if (typeof impl === 'function') return impl(...args)
    if (impl instanceof Error) return Promise.reject(impl)
    return Promise.resolve(impl ?? {})
  }
  const runtime = {
    config: { taskWriteEnabled, enabled: false }, // enabled=false：证明写侧不受读侧总开关约束
    hasUserKey: () => hasUserKey,
    taskWriteEnabled: () => taskWriteEnabled,
    identityFor: (session) => ({ ...IDENTITY, session_id: session?.id ?? IDENTITY.session_id }),
    log: (m) => logs.push(m),
    client: {
      metaCreateTask: record('metaCreateTask'),
      metaListTasks: record('metaListTasks'),
      metaUpdateTask: record('metaUpdateTask'),
      metaDeleteTasks: record('metaDeleteTasks'),
    },
  }
  registerTaskTools(ctx, runtime)
  // 撤销命令住在 commands.mjs，这里一并挂上（它只依赖 runtime.client.metaDeleteTasks）
  runtime.assets = { peek: () => undefined, refresh: () => Promise.resolve() }
  registerCommands(ctx, runtime)
  const exec = { agent: { session: { id: IDENTITY.session_id } } }
  const call = (name, args) => registered.get(name).execute(args, exec)
  return { registered, calls, logs, call, runtime, ctx, exec, callsOf: (name) => calls.filter((c) => c[0] === name) }
}

const okCreate = (task_id = 'task-aaaaaaaaaa', title = '补插件文档') => ({
  task_id, team_id: IDENTITY.team_id, creator_user_id: IDENTITY.user_id,
  title, description: undefined, source_type: 'manual', status: 'running',
})

// ── 1) 注册形状：4 个工具，parameters 必须是 JSON Schema 对象根 ────────────────
{
  const h = harness()
  for (const name of ['tdai_task_add', 'tdai_task_list', 'tdai_task_update', 'tdai_task_delete']) {
    const tool = h.registered.get(name)
    assert.ok(tool, `应注册 ${name}`)
    // ctx.tools.register 的 parameters 必须是**已转换**的 JSON Schema：
    // 直接传扁平 spec 会被上游拒（"schema must be a JSON Schema of 'type: object'"）
    assert.equal(tool.parameters?.type, 'object', `${name} 的 parameters 应是 JSON Schema 对象根`)
    assert.equal(tool.output?.schema?.type, 'string', `${name} 的 output schema 应是 string`)
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 40, `${name} 的 description 要承载"何时该用/不该用"`)
  }
  // 触发口径是保守档：描述里必须写明"只在用户明确要求时写"
  const add = h.registered.get('tdai_task_add').description
  assert.ok(/EXPLICITLY asked/.test(add), 'tdai_task_add 的描述必须写清"只在用户明确要求时调用"')
  assert.ok(/Never write a todo you merely inferred/.test(add.replace(/\s+/g, ' ')),
    '必须显式排除"推测出的待办"（保守档口径的判据就这两条）')
}

// ── 2) render 签名是 (args, value)：写错了模型只会看到自己的参数 ───────────────
{
  const h = harness()
  const tool = h.registered.get('tdai_task_add')
  const out = tool.output.render({ title: '参数不该被回显' }, '真实结果')
  assert.deepEqual(out, [{ type: 'text', text: '真实结果' }], 'render 必须投影 value（第二个形参），不是 args')
}

// ── 3) 写入成功：payload 形状 + 回执带 task_id ────────────────────────────────
{
  const h = harness({ client: { metaListTasks: { items: [], total: 0 }, metaCreateTask: okCreate() } })
  const text = await h.call('tdai_task_add', { title: '  补插件文档  ', note: '把 task 写侧补上' })
  const [name, payload] = h.callsOf('metaCreateTask')[0] ?? []
  assert.equal(name, 'metaCreateTask', '未命中同名待办时应走 create')
  assert.equal(payload.team_id, IDENTITY.team_id)
  assert.equal(payload.creator_user_id, IDENTITY.user_id, 'creator_user_id 必须取当前身份（内核强制 == caller）')
  assert.equal(payload.title, '补插件文档', '标题应去首尾空白')
  assert.equal(payload.description, '把 task 写侧补上')
  assert.equal(payload.source_type, 'manual', 'source_type 枚举只有 manual/tapd/github/other')
  assert.equal(payload.status, 'running')
  const meta = JSON.parse(payload.metadata_json)
  assert.equal(meta.source, 'dsh')
  assert.equal(meta.session_id, IDENTITY.session_id)
  assert.equal(meta.agent_id, IDENTITY.agent_id)
  assert.equal(meta.quote, '把 task 写侧补上', 'metadata_json 要能回溯到原话')
  assert.ok(meta.captured_at, 'captured_at 必填')
  assert.ok(text.includes('task-aaaaaaaaaa'), `回执必须带 task_id（撤销的唯一把手），实际：${text}`)
  assert.ok(text.includes('已记：补插件文档'), `回执应回显标题，实际：${text}`)
  assert.ok(lastWrittenTasks(IDENTITY.session_id).some((t) => t.task_id === 'task-aaaaaaaaaa'), '写入后应记住 id 供撤销')
}

// ── 4) 去重：同名 running 待办 → 追加描述，不新建 ──────────────────────────────
{
  const h = harness({
    client: {
      metaListTasks: { items: [{ task_id: 'task-old000000', title: '补插件文档', description: '第一版' }], total: 1 },
      metaUpdateTask: { task_id: 'task-old000000', title: '补插件文档', status: 'running' },
    },
  })
  const text = await h.call('tdai_task_add', { title: '补插件文档', note: '再补一段' })
  assert.equal(h.callsOf('metaCreateTask').length, 0, '命中同名时不该新建')
  const patch = h.callsOf('metaUpdateTask')[0][1]
  assert.equal(patch.task_id, 'task-old000000')
  assert.ok(patch.description.startsWith('第一版'), '追加时不得丢掉原描述')
  assert.ok(patch.description.includes('再补一段'), '追加内容要在描述里')
  assert.ok(/\[\d{4}-\d{2}-\d{2}\]/.test(patch.description), '追加行应带本地日期戳')
  assert.ok(text.includes('已存在同名待办'), `应说明走了追加，实际：${text}`)
  // 查重口径：精确 title + running
  const query = h.callsOf('metaListTasks')[0][1]
  assert.equal(query.title, '补插件文档')
  assert.equal(query.status, 'running')
}

// ── 5) dedupe=false：用户/模型明确要求新建时不去重 ────────────────────────────
{
  const h = harness({
    client: {
      metaListTasks: { items: [{ task_id: 'task-old000000', title: '补插件文档' }] },
      metaCreateTask: okCreate('task-new0000000'),
    },
  })
  await h.call('tdai_task_add', { title: '补插件文档', dedupe: false })
  assert.equal(h.callsOf('metaListTasks').length, 0, 'dedupe=false 时连查重都不打')
  assert.equal(h.callsOf('metaCreateTask').length, 1)
}

// ── 6) 标题归一：压空白 + 40 字截断 ─────────────────────────────────────────
{
  const h = harness({ client: { metaListTasks: { items: [] }, metaCreateTask: okCreate('task-x00000000x') } })
  const long = '一'.repeat(60)
  await h.call('tdai_task_add', { title: `  第一行\n第二行   ${long}  ` })
  const { title } = h.callsOf('metaCreateTask')[0][1]
  assert.ok(!title.includes('\n'), '标题应把折行压成空格')
  assert.equal(title.length, 40, `标题应截断到 40 字，实际 ${title.length}`)
  assert.ok(title.endsWith('…'), '截断应留省略号（让人知道被截了）')
}

// ── 7) 缺 title / 缺 task_id：本地拦下，不打网络 ────────────────────────────
{
  const h = harness()
  assert.ok((await h.call('tdai_task_add', {})).includes('缺少 title'))
  assert.ok((await h.call('tdai_task_update', { note: 'x' })).includes('缺少 task_id'))
  assert.ok((await h.call('tdai_task_update', { task_id: 'task-1' })).includes('至少要给'))
  assert.ok((await h.call('tdai_task_delete', {})).includes('缺少 task_id'))
  assert.equal(h.calls.length, 0, '参数不全时一次网络都不该打')
}

// ── 8) status 枚举本地拦（省一次 400 往返）──────────────────────────────────
{
  const h = harness({ client: { metaListTasks: { items: [] } } })
  assert.ok((await h.call('tdai_task_list', { status: 'done' })).includes('running'))
  assert.ok((await h.call('tdai_task_update', { task_id: 'task-1', status: 'done' })).includes('running'))
  assert.equal(h.calls.length, 0)
}

// ── 9) 开关 / userKey 缺失：明确拒绝，零网络 ────────────────────────────────
{
  const off = harness({ taskWriteEnabled: false })
  const offText = await off.call('tdai_task_add', { title: 'x' })
  assert.ok(offText.includes('待办写入未启用') && offText.includes('设置'), `开关关时应指路，实际：${offText}`)
  assert.equal(off.calls.length, 0)

  const noKey = harness({ hasUserKey: false })
  const keyText = await noKey.call('tdai_task_add', { title: 'x' })
  assert.ok(keyText.includes('User Key'), `缺 userKey 应点名，实际：${keyText}`)
  assert.equal(noKey.calls.length, 0)
}

// ── 10) 失败必须 fail-loud：带服务端原因，且不得出现读侧那句"暂时不可用" ──────
{
  const h = harness({
    client: { metaCreateTask: new Error('[tdai-memory] /v3/meta/task/create HTTP 401 code=401 unauthorized: missing_user_key') },
  })
  const text = await h.call('tdai_task_add', { title: 'x', dedupe: false })
  assert.ok(text.includes('missing_user_key'), `应原样转达服务端原因，实际：${text}`)
  assert.ok(text.includes('401'), '应带 HTTP 状态')
  assert.ok(!text.includes('暂时不可用'), '写侧绝不能复用读侧那句兜底文案（会变成假成功）')
  assert.ok(h.logs.some((l) => l.includes('task/create')), '失败同时要落插件日志')
}
{
  // 403 / 404 各自的指路语
  const forbidden = harness({
    client: { metaDeleteTasks: new Error('[tdai-memory] /v3/meta/task/delete HTTP 403 code=403 permission_denied: caller is not resource owner') },
  })
  assert.ok((await forbidden.call('tdai_task_delete', { task_id: 'task-1' })).includes('只能改自己创建的'), '403 应解释权限口径')
  const missing = harness({
    client: { metaUpdateTask: new Error('[tdai-memory] /v3/meta/task/update HTTP 404 code=404 task_not_found: not found: task-1') },
  })
  assert.ok((await missing.call('tdai_task_update', { task_id: 'task-1', status: 'completed' })).includes('已被删除'), '404 应说明原因')
  // 网络层：fetch 的真实原因在 cause 里
  const down = harness({ client: { metaListTasks: Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) } })
  const downText = await down.call('tdai_task_list', {})
  assert.ok(downText.includes('ECONNREFUSED'), `网络失败应带 cause.code，实际：${downText}`)
}

// ── 11) delete：失败明细 / 成功后清记录 ─────────────────────────────────────
{
  const session = 'sess-delete'
  const h = harness({ client: { metaDeleteTasks: { deleted_ids: [], failed: [{ task_id: 'task-1', reason: 'not_found' }] } } })
  const failed = await h.call('tdai_task_delete', { task_id: 'task-1' })
  assert.ok(failed.includes('删除失败'), `failed 非空时要报错，实际：${failed}`)

  const ok = harness({ client: { metaDeleteTasks: { deleted_ids: ['task-1'], failed: [] } } })
  await ok.call('tdai_task_delete', { task_id: 'task-1' })
  assert.ok((await ok.call('tdai_task_delete', { task_id: 'task-1' })).includes('已删除'))
  forgetWrittenTask(session, 'task-1')
  assert.deepEqual(lastWrittenTasks(session), [], 'forget 后本会话记录应为空')
}

// ── 12) list：空结果与条目渲染 ─────────────────────────────────────────────
{
  const empty = harness({ client: { metaListTasks: { items: [], total: 0 } } })
  assert.ok((await empty.call('tdai_task_list', {})).includes('没有 status=running'), '空结果要说人话')

  const list = harness({
    client: {
      metaListTasks: {
        items: [{
          task_id: 'task-aaaaaaaaaa', title: '补插件文档', status: 'running',
          created_at: '2026-10-14T15:39:09.230Z', description: '第一行\n第二行',
        }],
        total: 1,
      },
    },
  })
  const text = await list.call('tdai_task_list', {})
  assert.ok(text.includes('task-aaaaaaaaaa') && text.includes('补插件文档'), `应列出 id 与标题，实际：${text}`)
  assert.ok(text.includes('2026-10-14'), '应带创建日期（便于人眼排序）')
  assert.ok(!text.includes('第二行'), '描述只取首行，避免列表被长文本淹没')
}

// ── 13) /tdai-task-undo：不依赖模型记住 id ──────────────────────────────────
{
  const h = harness({ client: { metaListTasks: { items: [] }, metaCreateTask: okCreate('task-undo00000') } })
  await h.call('tdai_task_add', { title: '待撤销的待办' })

  const undo = h.registered.get('/tdai-task-undo')
  assert.ok(undo, '应有 /tdai-task-undo 命令')
  const invocation = { rawInput: '/tdai-task-undo', agent: { session: { id: IDENTITY.session_id } } }
  const result = await undo.handler(invocation)
  assert.equal(result.kind, 'success')
  assert.ok(result.text.includes('task-undo00000'), `撤销应删最近一条，实际：${result.text}`)
  assert.deepEqual(h.callsOf('metaDeleteTasks')[0][1], ['task-undo00000'])
  assert.ok(!lastWrittenTasks(IDENTITY.session_id).some((t) => t.task_id === 'task-undo00000'), '撤销后应清记录')

  // 带显式 id：优先用它
  const h2 = harness({ client: { metaListTasks: { items: [] }, metaCreateTask: okCreate('task-explicit00') } })
  await h2.call('tdai_task_add', { title: '另一条' })
  const res2 = await h2.registered.get('/tdai-task-undo').handler({
    rawInput: '/tdai-task-undo task-oldtarget1', agent: { session: { id: IDENTITY.session_id } },
  })
  assert.deepEqual(h2.callsOf('metaDeleteTasks')[0][1], ['task-oldtarget1'], '显式 id 应优先于"最近一条"')

  // 没有记录可撤：明确说明，而不是静默
  const h3 = harness()
  const res3 = await h3.registered.get('/tdai-task-undo').handler({ rawInput: '', agent: { session: { id: 'sess-empty' } } })
  assert.equal(res3.kind, 'error')
  assert.ok(res3.text.includes('没有记录到'), `实际：${res3.text}`)

  // 开关关闭时命令也应拒绝
  const h4 = harness({ taskWriteEnabled: false })
  const res4 = await h4.registered.get('/tdai-task-undo').handler({ rawInput: '', agent: { session: { id: 's' } } })
  assert.equal(res4.kind, 'error')
  assert.ok(res4.text.includes('待办写入未启用'))
}

// ── 14) 与只读工具各自的开关互不牵连 ───────────────────────────────────────
{
  // runtime.config.enabled === false（读侧总开关关）+ taskWriteEnabled=true → 写侧照常工作
  const h = harness({ client: { metaListTasks: { items: [] }, metaCreateTask: okCreate() } })
  const text = await h.call('tdai_task_add', { title: '读侧关着也要能记' })
  assert.ok(text.includes('已记：'), `写侧不该受读侧总开关约束，实际：${text}`)
}

// ── 15) registerCommands 也要能在没有 settings/工具服务时挂上撤销命令 ─────────
{
  const registered = new Map()
  const ctx = { commands: { register: (cmd) => registered.set(cmd.name, cmd) } }
  const runtime = {
    config: {}, log: () => {}, identityFor: () => IDENTITY, assets: { peek: () => undefined },
    taskWriteEnabled: () => true, hasUserKey: () => true,
    client: { metaDeleteTasks: () => Promise.resolve({ deleted_ids: [], failed: [] }) },
  }
  registerCommands(ctx, runtime)
  assert.ok(registered.has('tdai-task-undo'), 'registerCommands 应注册 tdai-task-undo')
  assert.ok(registered.get('tdai-help').handler().text.includes('tdai_task_add'), '帮助文案应列出写侧工具')
}

console.log('task write tests passed: payload / 去重 / 开关 / fail-loud / 撤销')
