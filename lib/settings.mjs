/**
 * 设置接入（DSH 0.1.7-rc.1 模型）。
 *
 * ── 为什么这里只剩「schema + 页面策略」两件事 ────────────────────────────────
 *
 * 0.1.2-rc.1 的模型是插件**运行时注册**一个设置命名空间：
 *
 *   settings.register(NS, schema, { base, applies: 'live' }) → scope.get()/watch()
 *
 * 0.1.7-rc.1 把这个 API 整个删掉了：live `settings` 服务只剩
 * `configure / prepareDocument / describe / update / replace / mutate`。新模型是
 * **声明式**的（见 @deepseek-ai/dsh-settings 的 JSDoc 与 dsh-agent-default-model 的写法）：
 *
 *   1. 插件导出 `Config`（schemastery schema）——settings 服务把它投影成表单；
 *      命名空间 key 就是 profile patch 的 **entry id**（本插件约定 `tdai-memory`）。
 *   2. 配置读写由宿主完成（`describe/update/mutate`），写入后 Loader 会**重新 apply**
 *      本插件（`applies: 'live'`），所以插件侧不再需要"自己 merge + rebuild"。
 *   3. 配置层叠顺序不变：schema 默认 ← 组合层（本插件的 cordis.patch.yml，env 派生）
 *      ← 用户层（profile patch）。`unset` 一个字段 = 回落到组合层，等价于旧模型的
 *      "面板留空 = 回落 env"。
 *   4. 自定义设置页要显式关掉自动生成页：`settings.configure({ auto: false }, fiber)`。
 *
 * ⚠️ **字段不要加 `.volatile()`**。cordis loader 只在"仅 volatile 字段变化"时原地更新
 * 引用（`_commitVolatile`）；普通字段变化会走 `_patchContext(['config'])` → 重新 apply
 * 本插件，正是我们要的语义（`runtime` 里的 client/assets 随之整体重建）。加了 volatile
 * 反而会让 `activeCfg` 快照过期。
 */
import z from '@deepseek-ai/schemastery'

/** 设置命名空间 = profile patch 的 entry id（必须与 cordis.patch.yml 的 `id` 一致）。 */
export const SETTINGS_NAMESPACE = 'tdai-memory'

/**
 * 布尔字段：**必须接受字符串**。
 *
 * 组合层（cordis.patch.yml）的值来自 `!!js process.env.X`，env 里只能是字符串
 * （`"false"`）；用户层来自设置面板，是真正的 JSON 布尔。裸 `z.boolean()` 遇到 `"false"`
 * 会直接抛 `expected boolean but got false`，**整个 entry 加载失败** —— 这是升级后
 * 最容易踩的坑（已实测）。归一化仍由 config.mjs 的 `boolOpt` 负责（它对布尔/字符串/数字
 * 都成立），schema 只做"值的形状"这一层。
 *
 * 为什么不用 `z.transform(...)`：schemastery 的 `toJSON()` 会把 transform 的**回调源码**
 * 序列化进 schema 包络，客户端 rehydrate 时重新求值；回调里只要引用外部常量（如 FALSEY）
 * 就会在浏览器侧抛 `FALSEY is not defined`（已实测）。union 没有这个问题。
 */
const boolField = (dflt) => z.union([z.boolean(), z.string()]).default(dflt)

/**
 * 数字字段：同理接受字符串（env 的 `"8"`），越界/非数字由 config.mjs 的 `numOpt`
 * /`numOptZero` 回落默认值；面板写入的是真数字，`z.natural().min().max()` 约束仍然生效。
 */
const numField = (min, max, dflt) => z.union([z.natural().min(min).max(max), z.string()]).default(dflt)

/**
 * ── `.volatile()` 是**设置页可见性开关**，不是性能选项 ──────────────────────
 *
 * 0.1.7-rc.1 的 settings 服务用 `volatileForm(schema)` 给每个 entry 算一份"表单"：
 * 对象节点只保留**标了 volatile 的子字段**，一个都没有就返回 `undefined`，
 * 而 `describe()` 对 `undefined` 的 entry 直接 `return []`（`dsh-settings/lib/index.js:426`）。
 *
 * 于是有两条硬规则（2026-09-25 实测踩过第二条）：
 *   1. **面板上的每个字段都必须 volatile**，否则用户在面板里看不到它（`projectForm` 也只投影
 *      volatile 字段）；
 *   2. **整个 entry 至少要有一个 volatile 字段**，否则命名空间根本不出现在 `describe()` 里 ——
 *      客户端 `configForms.get(ns)` 恒为 `unavailable`，卡片渲染"设置当前不可用"。
 *
 * vol 与"用户可编辑"是同一件事：**部署期配置（patch / env 专属）保持非 volatile**，
 * 既不出现在表单里，也不受面板写入影响（例如 `apiKeyEnv` 是"环境变量名"而不是凭据）。
 *
 * ⚠️ 代价：volatile 字段变更时 cordis **不会重新 apply 插件**，只原地更新 `{ get() }` 访问器
 * （loader `_commitVolatile`）。所以插件侧必须按"实时值"读配置（`config.mjs` 的 `liveValue`
 * + `index.mjs` 里的 lazy rebuild），不能再把配置快照进 client/assets 就不管了。
 */
const volBool = (dflt) => boolField(dflt).volatile()
const volNum = (min, max, dflt) => numField(min, max, dflt).volatile()
const volStr = (dflt = '') => z.string().default(dflt).volatile()

/**
 * 插件 Config。与 client.card.tsx 的字段一一对应（除 PATCH_ONLY_KEYS）。
 *
 * 为什么要显式声明 `apiKeyEnv`：schemastery 的 object 会**保留**未知键，但把它写进
 * schema 才能被 `describe()` 看到、也避免以后换校验实现时被静默剥掉 —— 丢掉它的后果是
 * `process.env[cfg.apiKeyEnv]` 变成 `process.env[undefined]`，凭据静默失效。
 *
 * `userKey` 用 `.role('secret')`：跨 wire 时宿主会把它从 value 里删掉，只留
 * `secrets[{ path, set }]` 侧信道（见 dsh-settings 的 redact 模块）。设置面板因此
 * 只能"写入/清空"，永远拿不到明文。
 */
export function buildSettingsSchema() {
  return z.object({
    // ── 面板可见（volatile）：与 client.card.tsx 的 CARD_FIELDS 一一对应 ──────
    enabled: volBool(true),
    captureEnabled: volBool(true),
    recallEnabled: volBool(true),
    injectionEnabled: volBool(true),
    sessionContextEnabled: volBool(true),
    profileMemoryEnabled: volBool(true),
    skillsEnabled: volBool(true),
    knowledgeEnabled: volBool(false),
    subagentInjectionEnabled: volBool(false),
    subagentCaptureEnabled: volBool(false),
    endpoint: volStr(''),
    serviceId: volStr(''),
    teamId: volStr(''),
    agentId: volStr(''),
    userId: volStr(''),
    userKey: z.string().role('secret').default('').volatile(),
    knowledgeEndpoint: volStr(''),
    taskId: volStr(''),
    recallLimit: volNum(1, 20, 5),

    // ── 仅部署期（非 volatile）：不进设置页，只由 patch / env 管理 ─────────────
    /** 密钥所在的环境变量名（面板里不该让用户填这个）。 */
    apiKeyEnv: z.string().default('TDAI_MEMORY_API_KEY'),
    l2Limit: numField(1, 20, 3),
    timeoutMs: numField(100, 60000, 5000),
    recallTimeoutMs: numField(100, 60000, 3000),
    assetLoadBudgetMs: numField(100, 60000, 5000),
    assetRetryCooldownMs: numField(0, 600000, 15000),
  })
}

/**
 * schema 覆盖的全部字段。
 *
 * 导出给 test/settings-card.test.mjs：面板上出现的每个字段都必须在这里，
 * 否则用户改了面板值也落不进 config（静默失效）。
 */
export const SCHEMA_KEYS = [
  'enabled', 'captureEnabled', 'recallEnabled', 'injectionEnabled',
  'sessionContextEnabled', 'profileMemoryEnabled', 'skillsEnabled', 'knowledgeEnabled',
  'subagentInjectionEnabled', 'subagentCaptureEnabled',
  'endpoint', 'apiKeyEnv', 'serviceId', 'teamId', 'agentId', 'userId', 'userKey',
  'knowledgeEndpoint', 'taskId',
  'recallLimit', 'l2Limit', 'timeoutMs',
  'recallTimeoutMs', 'assetLoadBudgetMs', 'assetRetryCooldownMs',
]

/**
 * 设置页**可见**的字段（= schema 里标了 `.volatile()` 的那些）。
 *
 * 数量必须 ≥1，否则整个 entry 不进 `describe()`（见上面的 volatile 说明）；
 * 且必须覆盖 client.card.tsx 面板上的每个字段。导出给测试断言这两条。
 */
export const VOLATILE_KEYS = [
  'enabled', 'captureEnabled', 'recallEnabled', 'injectionEnabled',
  'sessionContextEnabled', 'profileMemoryEnabled', 'skillsEnabled', 'knowledgeEnabled',
  'subagentInjectionEnabled', 'subagentCaptureEnabled',
  'endpoint', 'serviceId', 'teamId', 'agentId', 'userId', 'userKey',
  'knowledgeEndpoint', 'taskId', 'recallLimit',
]

/**
 * 只由 cordis.patch.yml / env 管理、**不出现在设置面板**的字段（= 非 volatile）。
 *
 * `apiKeyEnv` 是"环境变量名"而不是凭据本身，把它放进面板只会让用户把秘密的值
 * 误填进一个期望变量名的格子；它属于部署期配置。
 */
export const PATCH_ONLY_KEYS = ['apiKeyEnv', 'l2Limit', 'timeoutMs', 'recallTimeoutMs', 'assetLoadBudgetMs', 'assetRetryCooldownMs']

/** 身份字段：用户层里出现其中任意一个，就说明身份来自设置面板而不是 env。 */
export const IDENTITY_KEYS = ['serviceId', 'teamId', 'agentId', 'userId', 'userKey', 'taskId']

/**
 * 注册设置页面策略。
 *
 * 为什么必须 `ctx.inject(['settings'], …)` 而不是直接读 `ctx.settings`：cordis 的 ctx 是
 * Proxy，读一个没写进 inject 的服务名**取值动作本身就抛**（见 lib/sections.mjs 顶部对
 * `ctx.skills` 的同类说明）。宿主没有 settings 服务时回调永不执行 —— 天然的 fail-open。
 *
 * @param ctx     插件 cordis 上下文（`ctx.fiber` 即本插件实例）
 * @param log     日志
 * @param onReady 拿到 settings 服务时回调（供 identitySource 读用户层）
 */
export function applySettings(ctx, log, onReady) {
  ctx.inject(['settings'], (child) => {
    let service
    try {
      service = child.settings
      onReady?.(service)
    } catch (error) {
      log(`settings handle unavailable: ${error.message}`)
    }
    try {
      // auto:false —— 本插件自带设置页（client 侧注册到 settings.section），
      // 不要让宿主再生成一个。
      child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
    } catch (error) {
      log(`settings.configure unavailable: ${error.message}`)
    }

    // ── 开机自检：本 entry 到底有没有进 describe() ──────────────────────────────
    //
    // 这是"设置页显示不可用"的唯一根因所在（describe() 跳过没有 volatile 字段的 entry），
    // 而它**只能在宿主日志里看见**——客户端那侧只会表现为一个笼统的 unavailable。
    // 延后一拍再查：本 fiber 此刻可能还没落定（describe() 只收录 state === 2 的 entry），
    // 立刻查会得到假阴性。
    setTimeout(() => {
      try {
        const row = service?.describe?.().find((d) => d.ns === SETTINGS_NAMESPACE)
        if (row) {
          log(`settings: namespace "${SETTINGS_NAMESPACE}" served (autoGenerate=${row.autoGenerate}, revision=${row.revision})`)
        } else {
          log(`settings: namespace "${SETTINGS_NAMESPACE}" NOT served —— 设置页会显示"当前不可用"；`
            + '先检查 Config 里是否还有 volatile 字段（dsh-settings 只收录至少含一个 volatile 字段的 entry）')
        }
      } catch (error) {
        log(`settings self-check failed: ${error.message}`)
      }
    }, 0)
  })
}

/**
 * 身份来自哪一层（纯函数，导出给测试）。
 *
 * `describe()` 的每个描述符带 `user`（原始用户层）：**字段在 user 里存在**才算"面板改过"，
 * 而不是比较值 —— 用户把某字段改回与组合层相同的值时，它仍然是 override。
 * 老实现是"当前值与 env 值不同则算 settings"，在"改回 env 同值"时会误判成 env。
 *
 * @param descriptors settings.describe() 的结果
 * @param ns          本插件的 entry id
 * @returns 'settings' | 'env'
 */
export function identitySourceOf(descriptors, ns = SETTINGS_NAMESPACE) {
  const entry = (Array.isArray(descriptors) ? descriptors : []).find((d) => d?.ns === ns)
  const user = entry?.user
  if (!user || typeof user !== 'object') return 'env'
  return IDENTITY_KEYS.some((key) => key in user) ? 'settings' : 'env'
}
