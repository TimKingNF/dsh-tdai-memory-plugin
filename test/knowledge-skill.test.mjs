/**
 * 知识能力作为 DSH runtime skill 的注册测试。
 *
 * 背景（docs/prompt-injection-redesign.md §8 后续课题 1）：原来「判据 + 资源清单 + curl 用法」
 * 是常驻 system 的一大段（>4KB），每轮都付费，而多数轮次用不到。改成：
 *   - system 只留一行路由信息（`tdai:knowledge-tools`）；
 *   - 正文注册为 DSH 运行时 skill，进原生 skill 目录，模型用 `skill` 工具按需加载。
 *
 * 这个测试锁住八件事：
 *   1. 有知识资源 + 开关打开 → 注册 skill，名字/描述/正文都正确；
 *   2. 没有资源 / 开关关闭 → **不注册**（不要往目录里塞空 skill）；
 *   3. 正文没变 → **不重复注册**（幂等判据是正文指纹，不是 session）；
 *   4. 宿主没有 skills 服务 → 静默跳过，不崩（fail-open）；
 *   5. **宿主有 skills 服务、但插件没把它写进 inject** → 也不能崩；
 *   6. system 里只剩一行路由（正文不进常驻 prompt，块 ≤600 B）；
 *   7. **资产变了 → 正文热更新**（新绑定/新同步的知识资源，模型必须立刻拿得到 id）；
 *   8. **旧会话的旧快照不许把新正文刷回去**（loadedAt 单调闸门），且换新失败要能回滚。
 *
 * 第 5 条是线上事故的回归护栏：`skills` 由别的插件在自己的 fiber 里 provide，
 * cordis 的 ctx 是 Proxy，裸读一个没 inject 的服务名**取值本身就抛**
 * `cannot get property "skills" without inject`。所以这里的假宿主按 cordis 语义
 * 做成了 Proxy —— 见 `cordisLike()`。**不要把它改回普通对象**：普通对象读缺失属性
 * 只得到 undefined，会让 `ctx.skills?.register` 这种写法在单测里永远"通过"，
 * 而线上总开关一开就整轮报错（事故现场）。
 *
 * 第 7/8 条是**第二起**线上事故的回归护栏：同名 runtime skill 是**进程级 first-wins**
 * （dsh-skill/lib/index.js:193-200），重复注册被静默忽略 + 返回 no-op disposer。
 * 所以 `skillRegistry()` 必须忠实复刻这个语义（含 no-op disposer）。
 * **不要把它改回"每次 register 都生效"**：那样就复现不出事故，测试会退回"假通过"。
 * 事故现场（2026-10-14）：新绑的 wiki 进了 system 路由行，却没进 skill 正文，
 * 模型只能拿到名字、拿不到 knowledge_id，于是宣称"我把这三个知识资源都扫过了"。
 *
 * 运行：node test/knowledge-skill.test.mjs
 */
import assert from 'node:assert'
import { registerSections } from '../lib/sections.mjs'
import { KNOWLEDGE_SKILL_NAME } from '../lib/prompts.mjs'

/**
 * 按 cordis 的 Proxy 语义包一层假 ctx：
 * 只有**写进 inject**（或注入后子 ctx 拿到的）服务名才可读，其余一律抛
 * `cannot get property "<name>" without inject`（cordis/lib/index.js:675）。
 */
function cordisLike(base) {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol' || String(prop).startsWith('_') || prop in target) {
        return Reflect.get(target, prop, receiver)
      }
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
}

/**
 * 假宿主里的 runtime skill 注册表，按 dsh-skill 的语义实现：
 * 同名 **first-wins**，重复注册只记一条 warning 并返回 **no-op disposer**
 * （dsh-skill/lib/index.js:193-200）。`body()` = 模型加载 skill 时真正会读到的正文。
 */
function skillRegistry() {
  const layer = new Map()
  const attempts = []
  const warnings = []
  let shouldFail = false
  return {
    layer,
    attempts,
    warnings,
    /** 让下一次 register 抛错（测"换新失败要回滚"）。 */
    failNext(value = true) { shouldFail = value },
    register(skill) {
      if (shouldFail) { shouldFail = false; throw new Error('register failed (test)') }
      attempts.push(skill)
      if (layer.has(skill.name)) {
        warnings.push(`runtime skill "${skill.name}" ignored because it is already registered`)
        return () => {}
      }
      layer.set(skill.name, skill)
      return () => { layer.delete(skill.name) }
    },
    body() { return layer.get(KNOWLEDGE_SKILL_NAME)?.content },
  }
}

/** 极简假宿主：只需要 systemPrompt / on / inject 三个能力（与 index.mjs 的 inject 一致）。 */
function harness({ cfg = {}, asset = null, assets = {}, withSkills = true } = {}) {
  const registry = skillRegistry()
  const sections = new Map()
  let listener = null
  const runtimeCfg = {
    enabled: true, injectionEnabled: true, knowledgeEnabled: true,
    sessionContextEnabled: true, profileMemoryEnabled: true, skillsEnabled: true,
    recallEnabled: false, serviceId: 'default', teamId: 't', agentId: 'a', userId: 'u',
    ...cfg,
  }
  // 宿主（兄弟 fiber）提供的服务：插件不 inject 就读不到 —— 这正是线上场景。
  const rootServices = {}
  if (withSkills) rootServices.skills = { register: (skill) => registry.register(skill) }

  const base = {
    systemPrompt: {
      section: (s) => { sections.set(s.name, s); return () => {} },
      context: () => () => {},
    },
    on: (ev, cb) => {
      if (ev === 'system-prompt/assemble') listener = cb
      return () => {}
    },
    /** cordis 的 ctx.inject：等服务可用后在带依赖的子 ctx 上回调；服务缺失就不回调。 */
    inject: (deps, cb) => {
      const names = Array.isArray(deps) ? deps : [deps]
      if (!names.every((name) => name in rootServices)) return () => {}
      const child = { ...base }
      for (const name of names) child[name] = rootServices[name]
      cb(cordisLike(child))
      return () => {}
    },
  }
  const ctx = cordisLike(base)

  registerSections(ctx, {
    readEnabled: () => runtimeCfg.enabled,
    config: runtimeCfg,
    // 会话资产：每个 session 一份（`asset` 是所有会话的兜底），与 assets.mjs 的 peek 同形
    assets: { ensure: async () => null, peek: (sessionId) => assets[sessionId] ?? asset },
    log: () => {},
  })

  const assemble = async (sessionId = 's1') => {
    const context = { agent: { session: { id: sessionId } }, scope: {} }
    const assembly = {
      sections: [...sections.values()].map((s) => ({ name: s.name, text: typeof s.text === 'function' ? s.text(context) : s.text })),
      contexts: [],
      tools: [],
      variables: {},
    }
    return listener(assembly, context, async () => assembly)
  }
  return { assemble, registry, ctx }
}

const knowledgeAsset = {
  identity: { session_id: 's1' },
  agentDetail: null, taskDetail: null, profiles: [], skills: null,
  // SessionAssets 每次成功加载都会盖这个戳；单调闸门用它（见 lib/sections.mjs）
  loadedAt: 100,
  knowledge: [
    {
      knowledge_id: 'k-code', type: 'code-graph', service_url: 'http://kb.internal',
      repo_url: 'https://github.com/acme/payments.git', repo_slug: 'acme/payments',
      branch: 'main', name: 'payments 索引',
    },
    {
      knowledge_id: 'k-wiki', type: 'wiki', service_url: 'http://kb.internal',
      name: '团队 wiki', summary: '架构决策与踩坑记录',
    },
  ],
}

const extraWiki = {
  knowledge_id: 'k-self', type: 'wiki', service_url: 'http://kb.internal',
  name: '自制力', summary: '行为干预框架',
}

// ── 1) 有资源 + 开关开：注册 skill，内容正确 ─────────────────────────────────
{
  const { assemble, registry } = harness({ asset: knowledgeAsset })
  await assemble('s1')

  assert.equal(registry.attempts.length, 1, `应注册且只注册 1 个 skill，实际 ${registry.attempts.length}`)
  const skill = registry.attempts[0]

  // 名字必须符合 DSH 的校验规则 ^[a-z0-9]+(?:-[a-z0-9]+)*$（dsh-skill/lib/index.js:17）
  assert.equal(skill.name, KNOWLEDGE_SKILL_NAME)
  assert.match(skill.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'skill 名必须符合 DSH 的 kebab-case 规则')

  // 描述是目录里唯一可见的东西：要说清"何时加载"，但不该把正文塞进去
  assert.ok(skill.description.includes('code-graph') || skill.description.includes('知识库'), '描述应说明能力范围')
  assert.ok(skill.description.includes('加载本 skill') || skill.description.includes('加载'), '描述应给出加载时机')
  assert.ok(skill.description.length < 400, `目录描述应简短（实际 ${skill.description.length} 字符）`)
  assert.ok(skill.whenToUse && skill.whenToUse.length > 0, '应给出 whenToUse 路由提示')

  // 正文：判据 + 资源清单 + **工具清单** + 原生工具用法
  const body = registry.body()
  assert.equal(body, skill.content, '宿主里生效的正文应与注册内容一致')
  assert.ok(body.includes('已绑定资源'), '正文应含资源清单小节')
  assert.ok(body.includes('payments 索引') && body.includes('acme/payments'), '正文应含 code-graph 资源及其 match')
  assert.ok(body.includes('团队 wiki') && body.includes('架构决策与踩坑记录'), '正文应含 wiki 资源及其 about')
  assert.ok(body.includes('tdai_knowledge_call'), '正文应指向原生工具，而不是让模型敲 curl')
  assert.ok(!body.includes('<knowledge_tools>'), '正文不应再带 <knowledge_tools> 外层标签（那是 section 的形态）')

  // 调用方式已改由原生工具承担：正文里不该再出现 curl 与租户请求头
  assert.ok(!body.includes('curl -sSk'), '不应再教模型敲 curl（原生工具已处理端点与请求头）')
  assert.ok(!body.includes('x-tdai-service-id'), '不应再让模型自己拼租户请求头')
}


// ── 1b) 预取到工具清单：正文带上工具名与参数，模型不必再自发现 ───────────────
{
  const enriched = {
    ...knowledgeAsset,
    knowledge: [
      { ...knowledgeAsset.knowledge[0], tools: [
        { name: 'explore', description: '按文件分组返回相关符号完整源码', params: { query: { type: 'string', required: true }, maxFiles: { type: 'number' } } },
        { name: 'status', description: '索引状态', params: {} },
      ] },
      { ...knowledgeAsset.knowledge[1], tools: [
        { name: 'search', description: 'BM25 全文搜索', params: { query: { type: 'string', required: true } } },
      ] },
    ],
  }
  const { assemble, registry } = harness({ asset: enriched })
  await assemble('s1')
  const body = registry.body()
  assert.ok(body.includes('`explore`') && body.includes('参数：query, maxFiles'), '正文应列出工具名与参数名')
  assert.ok(body.includes('`status`') && body.includes('无参数'), '无参数工具应标注"无参数"')
  assert.ok(body.includes('`search`'), 'wiki 资源的工具也应列出')
  assert.ok(!body.includes('tdai_knowledge_tools 查一次'), '取到清单时不该再提示去自发现')
}

// ── 1c) 没取到工具清单：退回"先自发现"的指引 ────────────────────────────────
{
  const { assemble, registry } = harness({ asset: knowledgeAsset })   // 无 tools 字段
  await assemble('s1')
  const body = registry.body()
  assert.ok(body.includes('未取到') && body.includes('tdai_knowledge_tools'),
    '预取失败时应提示先用 tdai_knowledge_tools 查一次')
}

// ── 2) 没有知识资源：不注册（不要往目录里塞空 skill）──────────────────────────
{
  const { assemble, registry } = harness({ asset: { ...knowledgeAsset, knowledge: [] } })
  await assemble('s1')
  assert.equal(registry.attempts.length, 0, '无资源时不应注册 skill')
}

// ── 3) 开关关闭：不注册 ──────────────────────────────────────────────────────
{
  const { assemble, registry } = harness({ asset: knowledgeAsset, cfg: { knowledgeEnabled: false } })
  await assemble('s1')
  assert.equal(registry.attempts.length, 0, 'knowledgeEnabled=false 时不应注册 skill')
}

// ── 4) 幂等：正文没变就不重复注册（判据是正文指纹，不是 session）─────────────
{
  const { assemble, registry } = harness({ asset: knowledgeAsset })
  await assemble('s1')
  await assemble('s1')
  await assemble('s1')
  assert.equal(registry.attempts.length, 1, '同一 session 重复 assemble 只能注册一次')

  // 另一个 session、同样的资产：宿主里已经挂着同一份正文，不必再注册
  await assemble('s2')
  assert.equal(registry.attempts.length, 1, '不同 session 但正文相同 → 不该重复注册')
  assert.equal(registry.warnings.length, 0, '不该出现 first-wins 静默忽略的 warning')
}

// ── 5) 宿主没有 skills 服务：静默跳过，不崩 ──────────────────────────────────
{
  const { assemble, registry } = harness({ asset: knowledgeAsset, withSkills: false })
  const result = await assemble('s1')
  assert.equal(registry.attempts.length, 0)
  // 注入本身不受影响
  const knowledgeSection = result.sections.find((s) => s.name === 'tdai:knowledge-tools')
  assert.ok(knowledgeSection.text.includes('<knowledge_tools>'), 'skills 服务缺失时，路由块仍应注入')
}

// ── 5b) 假宿主必须保持 cordis 语义（否则 5/6 两个用例会退化成"假通过"）────────
// 线上事故：宿主**有** skills 服务（dsh-skill 在兄弟 fiber 里 provide），但插件没写进
// inject，于是 `ctx.skills` 取值即抛 → system-prompt/assemble 整条 rejected
// → 每轮 "本轮运行失败 cannot get property \"skills\" without inject"。
// 这一条锁住"裸读未 inject 的服务名必须崩"，确保上面的用例真能拦住回归。
{
  const { ctx } = harness({ asset: knowledgeAsset })
  let message = ''
  try { void ctx.skills } catch (error) { message = error.message }
  assert.match(message, /cannot get property "skills" without inject/,
    '假宿主必须按 cordis 语义抛错，否则这个测试拦不住"裸读未 inject 服务"的回归')
}

// ── 5c) 宿主提供 skills（经 inject 声明后才可达）：照常注册，不崩 ────────────
{
  const { assemble, registry } = harness({ asset: knowledgeAsset, withSkills: true })
  await assemble('s1')
  assert.equal(registry.attempts.length, 1, '经 ctx.inject 拿到 skills 后应正常注册')
  assert.equal(registry.attempts[0].name, KNOWLEDGE_SKILL_NAME)
}

// ── 6) system 侧只剩极短路由块（这是本次改造的收益所在）──────────────────────
{
  const { assemble } = harness({ asset: knowledgeAsset })
  const result = await assemble('s1')
  const route = result.sections.find((s) => s.name === 'tdai:knowledge-tools').text
  assert.ok(route.includes('payments 索引'), '路由块应列出资源名，让模型知道有什么可用')
  assert.ok(route.includes(KNOWLEDGE_SKILL_NAME), '路由块应告诉模型去加载哪个 skill')
  assert.ok(!route.includes('tools/list'), 'curl 配方不该再出现在 system 里')
  assert.ok(Buffer.byteLength(route, 'utf8') < 600,
    `路由块必须保持极短，实际 ${Buffer.byteLength(route, 'utf8')} 字节`)
}

// ── 7) 资产变了 → 正文热更新；旧会话不许刷回去（2026-10-14 事故回归护栏）──────
//
// 事故形态：会话 A 先注册了一份 2 资源的正文；之后用户新绑了一个 wiki，
// 会话 B（新资产）注册时被 first-wins 静默忽略 → 正文永远停在 2 个资源，
// 模型只有路由行里的名字、没有 knowledge_id，于是"找不到"那个概念。
{
  const before = { ...knowledgeAsset, loadedAt: 100 }
  const after = { ...knowledgeAsset, loadedAt: 200, knowledge: [...knowledgeAsset.knowledge, extraWiki] }
  const assets = { s1: before, s2: after }
  const { assemble, registry } = harness({ assets })

  await assemble('s1')
  assert.ok(!registry.body().includes('k-self'), '前置：旧正文里不含新资源')

  await assemble('s2')
  assert.equal(registry.layer.size, 1, '宿主里任何时刻都只应有一条同名 runtime skill')
  assert.ok(registry.body().includes('k-self') && registry.body().includes('自制力'),
    '资产变化后正文必须含新资源（旧实现这里被 first-wins 忽略 → 事故现场）')
  assert.equal(registry.warnings.length, 0, '换新应走 dispose + register，不该撞上 first-wins')

  // 旧会话（快照更旧）再 assemble：不许把正文刷回旧内容
  await assemble('s1')
  assert.ok(registry.body().includes('k-self'), '旧快照不得覆盖新正文（loadedAt 单调闸门）')
  assert.equal(registry.attempts.length, 2, '被闸门挡下时不应再发起注册（实际 2 次：旧、新）')

  // 同一个 session 自己刷新资产（/tdai-sync 的语义）：更新的快照照样能替换，内容变少也算
  assets.s1 = { ...knowledgeAsset, loadedAt: 300, knowledge: [knowledgeAsset.knowledge[0]] }
  await assemble('s1')
  assert.ok(!registry.body().includes('团队 wiki'), '更新的快照（含解绑）应成为新的正文')
  assert.ok(registry.body().includes('payments 索引'), '解绑后剩下的资源仍要在正文里')
  assert.equal(registry.attempts.length, 3, '刷新后的资产应正常触发一次更新')
}

// ── 8) 没有 loadedAt 的资产不许覆盖已有正文（保守：未知时间戳 ≠ 更新）────────
{
  const stamped = { ...knowledgeAsset, loadedAt: 200 }
  const unstamped = { ...knowledgeAsset, loadedAt: 0, knowledge: [...knowledgeAsset.knowledge, extraWiki] }
  const { assemble, registry } = harness({ assets: { s1: stamped, s2: unstamped } })
  await assemble('s1')
  await assemble('s2')
  assert.ok(!registry.body().includes('k-self'), '未知时间戳的资产不许覆盖已注册正文')
  assert.equal(registry.attempts.length, 1, '被闸门挡下时不应发起注册')
}

// ── 9) 换新失败：旧正文必须还在，下一轮要能重试（fail-open 的边界）───────────
{
  const first = { ...knowledgeAsset, loadedAt: 100 }
  const next = { ...knowledgeAsset, loadedAt: 300, knowledge: [...knowledgeAsset.knowledge, extraWiki] }
  const { assemble, registry } = harness({ assets: { s1: first, s2: next } })

  await assemble('s1')
  const good = registry.body()
  assert.ok(good, '前置：第一份正文已注册')

  registry.failNext(true)
  await assemble('s2')
  assert.equal(registry.body(), good, '注册失败时必须把旧正文挂回去，不能整段消失')

  await assemble('s2')
  assert.ok(registry.body().includes('k-self'), '故障恢复后下一轮 assemble 应换成新正文')
}

console.log('knowledge skill tests passed: 注册 / 描述路由 / 正文完整 / 幂等 / 热更新 / 单调闸门 / 回滚 / fail-open / inject 语义 / 路由块瘦身')
