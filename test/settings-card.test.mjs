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
import { buildSettingsSchema, SCHEMA_KEYS } from '../lib/settings.mjs'

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
const PANEL_LESS_BY_DESIGN = ['l2Limit', 'timeoutMs', 'recallTimeoutMs', 'assetLoadBudgetMs', 'assetRetryCooldownMs']
for (const key of SCHEMA_KEYS) {
  if (PANEL_LESS_BY_DESIGN.includes(key)) continue
  assert.ok(cardKeys.includes(key), `schema 字段 "${key}" 在面板里没有入口，也不在 PANEL_LESS_BY_DESIGN 白名单里`)
}

// ── 3) 召回条数上限：卡片的收敛区间必须与 schema 校验区间一致 ────────────────
const schema = buildSettingsSchema()
const limit = numeric.recallLimit
assert.ok(limit, '卡片应声明 recallLimit 数值字段')
assert.equal(schema({ recallLimit: limit.min }).recallLimit, limit.min, 'schema 应接受卡片下限')
assert.equal(schema({ recallLimit: limit.max }).recallLimit, limit.max, 'schema 应接受卡片上限')
assert.throws(() => schema({ recallLimit: limit.min - 1 }), 'schema 应拒绝低于卡片下限的值')
assert.throws(() => schema({ recallLimit: limit.max + 1 }), 'schema 应拒绝高于卡片上限的值')
assert.throws(() => schema({ recallLimit: String(limit.min) }), 'schema 拒绝字符串 → 卡片必须转 number')

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
}

console.log('settings card tests passed: 字段↔schema 一致 / 数值归一化 / 身份判定 / client.js 与 tsx 同源')
