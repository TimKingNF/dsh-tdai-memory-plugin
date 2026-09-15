/**
 * 知识能力作为 DSH runtime skill 的注册测试。
 *
 * 背景（docs/prompt-injection-redesign.md §8 后续课题 1）：原来「判据 + 资源清单 + curl 用法」
 * 是常驻 system 的一大段（>4KB），每轮都付费，而多数轮次用不到。改成：
 *   - system 只留一行路由信息（`tdai:knowledge-tools`）；
 *   - 正文注册为 DSH 运行时 skill，进原生 skill 目录，模型用 `skill` 工具按需加载。
 *
 * 这个测试锁住五件事：
 *   1. 有知识资源 + 开关打开 → 注册 skill，名字/描述/正文都正确；
 *   2. 没有资源 / 开关关闭 → **不注册**（不要往目录里塞空 skill）；
 *   3. 同一 session 重复 assemble → **只注册一次**（幂等）；
 *   4. 宿主没有 skills 服务 → 静默跳过，不崩（fail-open）；
 *   5. **宿主有 skills 服务、但插件没把它写进 inject** → 也不能崩。
 *
 * 第 5 条是线上事故的回归护栏：`skills` 由别的插件在自己的 fiber 里 provide，
 * cordis 的 ctx 是 Proxy，裸读一个没 inject 的服务名**取值本身就抛**
 * `cannot get property "skills" without inject`。所以这里的假宿主按 cordis 语义
 * 做成了 Proxy —— 见 `cordisLike()`。**不要把它改回普通对象**：普通对象读缺失属性
 * 只得到 undefined，会让 `ctx.skills?.register` 这种写法在单测里永远"通过"，
 * 而线上总开关一开就整轮报错（事故现场）。
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

/** 极简假宿主：只需要 systemPrompt / on / inject 三个能力（与 index.mjs 的 inject 一致）。 */
function harness({ cfg = {}, asset = null, withSkills = true } = {}) {
  const registered = []
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
  if (withSkills) rootServices.skills = { register: (skill) => { registered.push(skill); return () => {} } }

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
    assets: { ensure: async () => null, peek: () => asset },
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
  return { assemble, registered, ctx }
}

const knowledgeAsset = {
  identity: { session_id: 's1' },
  agentDetail: null, taskDetail: null, profiles: [], skills: null,
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

// ── 1) 有资源 + 开关开：注册 skill，内容正确 ─────────────────────────────────
{
  const { assemble, registered } = harness({ asset: knowledgeAsset })
  await assemble('s1')

  assert.equal(registered.length, 1, `应注册且只注册 1 个 skill，实际 ${registered.length}`)
  const skill = registered[0]

  // 名字必须符合 DSH 的校验规则 ^[a-z0-9]+(?:-[a-z0-9]+)*$（dsh-skill/lib/index.js:17）
  assert.equal(skill.name, KNOWLEDGE_SKILL_NAME)
  assert.match(skill.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'skill 名必须符合 DSH 的 kebab-case 规则')

  // 描述是目录里唯一可见的东西：要说清"何时加载"，但不该把正文塞进去
  assert.ok(skill.description.includes('code-graph') || skill.description.includes('知识库'), '描述应说明能力范围')
  assert.ok(skill.description.includes('加载本 skill') || skill.description.includes('加载'), '描述应给出加载时机')
  assert.ok(skill.description.length < 400, `目录描述应简短（实际 ${skill.description.length} 字符）`)
  assert.ok(skill.whenToUse && skill.whenToUse.length > 0, '应给出 whenToUse 路由提示')

  // 正文：判据 + 资源清单 + **工具清单** + 原生工具用法
  const body = skill.content
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
  const { assemble, registered } = harness({ asset: enriched })
  await assemble('s1')
  const body = registered[0].content
  assert.ok(body.includes('`explore`') && body.includes('参数：query, maxFiles'), '正文应列出工具名与参数名')
  assert.ok(body.includes('`status`') && body.includes('无参数'), '无参数工具应标注"无参数"')
  assert.ok(body.includes('`search`'), 'wiki 资源的工具也应列出')
  assert.ok(!body.includes('tdai_knowledge_tools 查一次'), '取到清单时不该再提示去自发现')
}

// ── 1c) 没取到工具清单：退回"先自发现"的指引 ────────────────────────────────
{
  const { assemble, registered } = harness({ asset: knowledgeAsset })   // 无 tools 字段
  await assemble('s1')
  const body = registered[0].content
  assert.ok(body.includes('未取到') && body.includes('tdai_knowledge_tools'),
    '预取失败时应提示先用 tdai_knowledge_tools 查一次')
}

// ── 2) 没有知识资源：不注册（不要往目录里塞空 skill）──────────────────────────
{
  const { assemble, registered } = harness({ asset: { ...knowledgeAsset, knowledge: [] } })
  await assemble('s1')
  assert.equal(registered.length, 0, '无资源时不应注册 skill')
}

// ── 3) 开关关闭：不注册 ──────────────────────────────────────────────────────
{
  const { assemble, registered } = harness({ asset: knowledgeAsset, cfg: { knowledgeEnabled: false } })
  await assemble('s1')
  assert.equal(registered.length, 0, 'knowledgeEnabled=false 时不应注册 skill')
}

// ── 4) 幂等：同一 session 多次 assemble 只注册一次 ───────────────────────────
{
  const { assemble, registered } = harness({ asset: knowledgeAsset })
  await assemble('s1')
  await assemble('s1')
  await assemble('s1')
  assert.equal(registered.length, 1, '同一 session 重复 assemble 只能注册一次')

  // 不同 session 各自注册（宿主按层合并，同名 runtime skill 是 first-wins + warn）
  await assemble('s2')
  assert.equal(registered.length, 2, '不同 session 应各注册一次（内容相同，由宿主按名去重）')
}

// ── 5) 宿主没有 skills 服务：静默跳过，不崩 ──────────────────────────────────
{
  const { assemble, registered } = harness({ asset: knowledgeAsset, withSkills: false })
  const result = await assemble('s1')
  assert.equal(registered.length, 0)
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
  const { assemble, registered } = harness({ asset: knowledgeAsset, withSkills: true })
  await assemble('s1')
  assert.equal(registered.length, 1, '经 ctx.inject 拿到 skills 后应正常注册')
  assert.equal(registered[0].name, KNOWLEDGE_SKILL_NAME)
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

console.log('knowledge skill tests passed: 注册 / 描述路由 / 正文完整 / 幂等 / fail-open / inject 语义 / 路由块瘦身')
