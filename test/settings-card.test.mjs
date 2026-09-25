/**
 * 设置卡片一致性测试（client.card.tsx ↔ settings schema ↔ 构建产物 client.js）。
 *
 * 卡片是唯一一个"改了不 rebuild 也不报错"的地方，历史上踩过两类静默坑：
 *   1. 面板里加的字段没进 settings schema / SCHEMA_KEYS → 用户改了面板，值落不进 config；
 *   2. 改了 client.card.tsx 忘了 `node build-card.mjs` → 浏览器里跑的还是旧卡片。
 * 这个测试把两条都钉死，另外覆盖新增的「L1 召回条数上限」归一化逻辑
 * （数值必须转成 number，越界收敛，空串回落）与身份缺失判定。
 *
 * 做法：用 esbuild 把 tsx 转成临时 ESM 再 import —— 不引 jsdom，也不为了可测性
 * 把卡片拆成两层组件；转换本身顺带充当 tsx 的语法检查。
 *
 * 运行：node test/settings-card.test.mjs
 */
import assert from 'node:assert'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { transform } from 'esbuild'
import { buildSettingsSchema, SCHEMA_KEYS, VOLATILE_KEYS, PATCH_ONLY_KEYS } from '../lib/settings.mjs'
import { liveValue } from '../config.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

// ── 1) 把卡片转成可 import 的 ESM（顺带做 tsx 语法检查）──────────────────────
const tsx = readFileSync(join(root, 'client.card.tsx'), 'utf8')
const { code } = await transform(tsx, { loader: 'tsx', format: 'esm', jsx: 'transform', target: 'esnext' })

const tmpDir = join(here, '.tmp')
mkdirSync(tmpDir, { recursive: true })
const tmpFile = join(tmpDir, 'card.mjs')
writeFileSync(tmpFile, code, 'utf8')
let card
try {
  card = await import(pathToFileURL(tmpFile).href)
} finally {
  // 模块已进缓存，文件可以立刻删掉（异常路径下也由 .gitignore 兜住）
  rmSync(tmpFile, { force: true })
}

assert.ok(card.CARD_FIELDS, '卡片应导出 CARD_FIELDS（面板字段的单一事实来源）')
const { toggles, numeric, identity } = card.CARD_FIELDS

// ── 2) 卡片字段 ⊆ settings schema：面板能改的，都能落进 config ───────────────
const cardKeys = [...toggles.map((t) => t.key), ...Object.keys(numeric), ...identity.map((f) => f.key)]
for (const key of cardKeys) {
  assert.ok(SCHEMA_KEYS.includes(key), `面板字段 "${key}" 不在 settings schema 里 → 用户改了不会生效`)
}
// 反向：schema 里剩下的字段是**有意只走 env** 的，列出来防止有人误删了面板入口
// （apiKeyEnv 是"密钥所在的环境变量名"，属于部署期配置，不该让用户往面板里填）
const PANEL_LESS_BY_DESIGN = ['apiKeyEnv', 'l2Limit', 'timeoutMs', 'recallTimeoutMs', 'assetLoadBudgetMs', 'assetRetryCooldownMs']
for (const key of SCHEMA_KEYS) {
  if (PANEL_LESS_BY_DESIGN.includes(key)) continue
  assert.ok(cardKeys.includes(key), `schema 字段 "${key}" 在面板里没有入口，也不在 PANEL_LESS_BY_DESIGN 白名单里`)
}
assert.deepEqual(PATCH_ONLY_KEYS, PANEL_LESS_BY_DESIGN, 'lib/settings.mjs 的 PATCH_ONLY_KEYS 与本测试的白名单必须一致')

// ── 2b) volatile 契约：它才是"面板可见性"的开关 ──────────────────────────────
//
// 2026-09-25 事故：schema 里一个 volatile 字段都没有 → `dsh-settings` 的
// `volatileForm()` 返回 undefined → `describe()` 直接跳过这个 entry →
// 客户端 `configForms.get(ns)` 恒为 unavailable，设置页显示"设置当前不可用"。
// 所以这两条是硬约束：① 至少一个 volatile；② 面板上每个字段都得 volatile。
const schema = buildSettingsSchema()
{
  // 复刻 dsh-settings/lib/index.js 的 volatileForm（对象只保留 volatile 子字段）
  const volatileForm = (node) => {
    if (node.meta?.volatile) return node
    if (node.type === 'object') {
      const dict = Object.fromEntries(Object.entries(node.dict ?? {}).flatMap(([key, child]) => {
        const field = volatileForm(child)
        return field === undefined ? [] : [[key, field]]
      }))
      return Object.keys(dict).length === 0 ? undefined : { dict }
    }
    return undefined
  }
  const projected = volatileForm(schema)
  assert.ok(projected, 'Config 至少要有一个 volatile 字段，否则整个 entry 不进 settings.describe()')
  const projectedKeys = Object.keys(projected.dict ?? {})
  assert.deepEqual(projectedKeys, VOLATILE_KEYS, 'VOLATILE_KEYS 必须与实际 volatile 投影一致')
  for (const key of cardKeys) {
    assert.ok(projectedKeys.includes(key), `面板字段 "${key}" 必须 volatile，否则用户在设置页看不到它`)
  }
  for (const key of PANEL_LESS_BY_DESIGN) {
    assert.ok(!projectedKeys.includes(key), `部署期字段 "${key}" 不该 volatile（会出现在设置页）`)
  }
  // volatile 字段校验后必须是 `{ get() }` 访问器：这是 loader 原地更新（不重新 apply）的协议。
  // 依赖 schemastery ≥3.18.4 —— 3.18.2 只认 meta 标记、不会生成访问器（实测）。
  const v = schema({ enabled: false })
  assert.equal(typeof liveValue(v.enabled), 'boolean', 'volatile 字段应可经 liveValue() 取值')
  assert.equal(typeof v.enabled, 'object', 'volatile 字段必须是 { get() } 访问器（schemastery ≥3.18.4）')
}

// ── 3) 召回条数上限：卡片的收敛区间必须与 schema 校验区间一致 ────────────────
const limit = numeric.recallLimit
assert.ok(limit, '卡片应声明 recallLimit 数值字段')
assert.equal(liveValue(schema({ recallLimit: limit.min }).recallLimit), limit.min, 'schema 应接受卡片下限')
assert.equal(liveValue(schema({ recallLimit: limit.max }).recallLimit), limit.max, 'schema 应接受卡片上限')
assert.throws(() => schema({ recallLimit: limit.min - 1 }), 'schema 应拒绝低于卡片下限的真数字')
assert.throws(() => schema({ recallLimit: limit.max + 1 }), 'schema 应拒绝高于卡片上限的真数字')
// 字符串必须被接受：组合层（cordis.patch.yml 的 env）只有字符串形态 `"8"`。
// 卡片保存时**仍然**转 number —— 用户层存数字，override 语义才干净。
assert.equal(
  liveValue(schema({ recallLimit: String(limit.min) }).recallLimit),
  String(limit.min),
  'schema 应接受 env 字符串（组合层形态）',
)

// ── 4) 保存归一化：空串回落 / 数值转 number / 越界收敛 / 非法值拦下 ──────────
{
  // (a) 正常数值：必须落成 number（z.natural() 对字符串直接抛）
  const a = card.buildSaveOps({ recallLimit: '7' }, ['recallLimit'])
  assert.equal(a.error, '', '合法数字不应报错')
  assert.deepEqual(a.ops, [{ op: 'set', path: ['recallLimit'], value: 7 }])
  assert.equal(typeof a.ops[0].value, 'number', '落库值必须是 number，不是字符串')
  assert.equal(a.patch.recallLimit, 7, '收敛后的值应回填草稿')

  // (b) 留空 = unset（回落到 env / schema 默认 5）
  const b = card.buildSaveOps({ recallLimit: '' }, ['recallLimit'])
  assert.deepEqual(b.ops, [{ op: 'unset', path: ['recallLimit'] }])

  // (c) 越界收敛：超上限/低于下限都收敛，并给出面向用户的说明
  const c = card.buildSaveOps({ recallLimit: '999' }, ['recallLimit'])
  assert.equal(c.ops[0].value, limit.max, `超上限应收敛到 ${limit.max}`)
  assert.ok(c.adjusted.length === 1 && c.adjusted[0].includes(String(limit.max)), '收敛应记一句提示')
  assert.equal(card.buildSaveOps({ recallLimit: '0' }, ['recallLimit']).ops[0].value, limit.min)

  // (d) 小数向下取整（schema 是 step(1)）
  assert.equal(card.buildSaveOps({ recallLimit: '3.7' }, ['recallLimit']).ops[0].value, 3)

  // (e) 非数字：不提交，直接提示
  const e = card.buildSaveOps({ recallLimit: 'abc' }, ['recallLimit'])
  assert.ok(e.error.includes('数字'), '非数字应给出可读提示')
  assert.equal(e.ops.length, 0, '校验失败时不应产生任何写操作')

  // (f) 文本字段：空串 unset、非空 set；**没碰过的字段一个都不提交**
  const f = card.buildSaveOps({ teamId: 'team-x', agentId: '', endpoint: 'http://h:1' }, ['teamId', 'agentId'])
  assert.deepEqual(f.ops, [
    { op: 'set', path: ['teamId'], value: 'team-x' },
    { op: 'unset', path: ['agentId'] },
  ], '只提交 touched 里的字段，且空串走 unset')

  // (g) 所有写路径都必须是 schema 认识的字段（漏接 = 静默失效）
  for (const op of [...a.ops, ...f.ops]) {
    assert.ok(SCHEMA_KEYS.includes(op.path[0]), `写操作指向未知字段 ${op.path[0]}`)
  }
}

// ── 5) 身份缺失判定：与 readEnabled() 的四个必需字段一致 ─────────────────────
assert.deepEqual(card.missingIdentity({ serviceId: 'default', teamId: 't', agentId: 'a', userId: 'u' }), [], '身份齐全应无缺失')
assert.deepEqual(card.missingIdentity({ serviceId: 'default', teamId: 't', userId: 'u' }), ['agentId'])
assert.deepEqual(card.missingIdentity({ serviceId: '  ', teamId: 't', agentId: 'a', userId: 'u' }), ['serviceId'], '空白串算未填')
assert.deepEqual(card.missingIdentity(undefined), ['serviceId', 'teamId', 'agentId', 'userId'], '快照未就绪时不崩')

// ── 6) 构建产物新鲜度：client.js 必须是当前 tsx 的产物 ───────────────────────
{
  const bundleRaw = readFileSync(join(root, 'client.js'), 'utf8')
  // esbuild 默认把非 ASCII 转义成 \uXXXX，比对前先还原
  const bundle = bundleRaw.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  assert.ok(bundle.includes('window.__ModuleLoader__.load'), 'client.js 应是 __ModuleLoader__ 注册格式')

  // 每个开关的 label / hint、数值项 label、身份字段 label 都必须出现在产物里；
  // 少一个就说明改了 tsx 没重建（浏览器里跑的是旧卡片）。
  const labels = [
    ...toggles.flatMap((t) => [t.label, t.hint]),
    numeric.recallLimit.label,
    ...identity.flatMap((f) => [f.label, f.hint]),
  ].filter((s) => typeof s === 'string' && s.length > 0)
  const missing = labels.filter((label) => !bundle.includes(label))
  assert.equal(missing.length, 0, `client.js 缺少 ${missing.length} 个面板文案（忘了 npm run build:client？）：${missing.join(' / ')}`)

  for (const key of cardKeys) {
    assert.ok(bundle.includes(key), `client.js 里找不到字段 "${key}"（忘了 npm run build:client？）`)
  }

  // ── DSH 0.1.7-rc.1 客户端契约（迁移护栏）────────────────────────────────────
  // settingsScope 服务与 settings.plugin.item 槽位都已从 DSH 删除；跑回旧名字的症状是
  // "卡片静默不挂载"（cordis 永远等不到依赖），所以必须在产物里钉死新契约。
  for (const dead of ['settingsScope', 'settings.plugin.item']) {
    assert.ok(!bundle.includes(dead), `client.js 仍引用已被 DSH 删除的 ${dead}`)
  }
  for (const live of ['configForms', 'settings.section']) {
    assert.ok(bundle.includes(live), `client.js 缺 0.1.7-rc.1 的新契约 ${live}`)
  }
  // 挂顶层设置导航（settings.section），不是「内置插件」里的二级 tab —— 后者在实测中
  // 会让人以为"没有设置项"。
  assert.ok(!bundle.includes('settings.plugins.tab'), 'client.js 不该再挂 settings.plugins.tab（藏得太深）')
}

console.log('settings card tests passed: 字段↔schema 一致 / 数值归一化 / 身份判定 / client.js 与 tsx 同源')
