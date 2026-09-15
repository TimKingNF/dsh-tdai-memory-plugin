/**
 * 设置命名空间注册：把本插件的开关与身份字段暴露到 dsh Web 设置面板。
 *
 * 依赖宿主存在 settings provider（dsh-settings-file 在 dsh web profile 下默认挂载）。
 * 注册后 scope.get() 返回「schema 默认 ← base(env) ← 用户层」的合并值；
 * 用户层非空字符串覆盖 env，留空回落到 env。
 */
import z from '@deepseek-ai/schemastery'

export const SETTINGS_NAMESPACE = 'tdai-memory'

/** 与 client.card.tsx 的字段一一对应。 */
export function buildSettingsSchema() {
  return z.object({
    enabled: z.boolean().default(true),
    captureEnabled: z.boolean().default(true),
    recallEnabled: z.boolean().default(true),
    injectionEnabled: z.boolean().default(true),
    sessionContextEnabled: z.boolean().default(true),
    profileMemoryEnabled: z.boolean().default(true),
    skillsEnabled: z.boolean().default(true),
    knowledgeEnabled: z.boolean().default(false),
    endpoint: z.string().default(''),
    serviceId: z.string().default(''),
    teamId: z.string().default(''),
    agentId: z.string().default(''),
    userId: z.string().default(''),
    userKey: z.string().role('secret').default(''),
    knowledgeEndpoint: z.string().default(''),
    taskId: z.string().default(''),
    recallLimit: z.natural().min(1).max(20).default(5),
    l2Limit: z.natural().min(1).max(20).default(3),
    timeoutMs: z.natural().min(100).max(60000).default(5000),
    recallTimeoutMs: z.natural().min(100).max(60000).default(3000),
    assetLoadBudgetMs: z.natural().min(100).max(60000).default(5000),
    assetRetryCooldownMs: z.natural().min(0).max(600000).default(15000),
  })
}

function mergeConfig(env, user) {
  const out = { ...env }
  for (const [k, v] of Object.entries(user ?? {})) {
    if (typeof v === 'string' && v === '') continue
    if (v === undefined || v === null) continue
    out[k] = v
  }
  return out
}

/**
 * 只取 schema 覆盖的字段作 base，避免把 env 里的 apiKeyEnv 等非 schema 键带进去。
 *
 * 导出给 test/settings-card.test.mjs：面板上出现的每个字段都必须在这里，
 * 否则用户改了面板值也落不进 config（静默失效）。
 */
export const SCHEMA_KEYS = [
  'enabled', 'captureEnabled', 'recallEnabled', 'injectionEnabled',
  'sessionContextEnabled', 'profileMemoryEnabled', 'skillsEnabled', 'knowledgeEnabled',
  'endpoint', 'serviceId', 'teamId', 'agentId', 'userId', 'userKey', 'knowledgeEndpoint', 'taskId',
  'recallLimit', 'l2Limit', 'timeoutMs',
  'recallTimeoutMs', 'assetLoadBudgetMs', 'assetRetryCooldownMs',
]

function pickBase(env) {
  const base = {}
  for (const k of SCHEMA_KEYS) {
    const v = env[k]
    if (v !== undefined && v !== null) base[k] = v
  }
  return base
}

/**
 * 注册命名空间并接线变更回调。
 * @param ctx      插件 cordis 上下文
 * @param envConfig env 层配置（作 base）
 * @param log      日志
 * @param onChange 设置就绪时先推一次当前值，此后每次提交再推
 */
export function applySettings(ctx, envConfig, log, onChange) {
  ctx.inject(['settings'], (settingsCtx) => {
    let scope
    try {
      scope = settingsCtx.settings.register(SETTINGS_NAMESPACE, buildSettingsSchema(), {
        base: pickBase(envConfig),
        applies: 'live',
      })
    } catch (error) {
      log(`settings unavailable: ${error.message}`)
      return
    }
    const push = (resolved) => onChange(mergeConfig(envConfig, resolved))
    scope.watch(push)
    push(scope.get())
  })
}
