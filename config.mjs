/**
 * 配置解析：cordis.patch.yml 把 env 原样透传进来，这里统一做默认值与类型归一。
 *
 * 开关语义（与 Web 设置面板的分组一一对应，改文案前先看这里）：
 *
 *   enabled             读侧总开关：控制「L1 召回 + 上下文注入 + 只读工具」，
 *                       false 时这三类全部关闭（还要叠加 identityComplete）
 *     ├─ recallEnabled  L1 自动召回（agent/pre-step 注入 <tdai_recalled_l1_memories>）
 *     │    └─ recallLimit  自有 + 借入合并后的条数上限
 *     └─ injectionEnabled  system prompt 注入总闸，只管下面 4 个注入段，
 *                          不影响 L1 召回
 *          ├─ sessionContextEnabled
 *          ├─ profileMemoryEnabled
 *          ├─ skillsEnabled
 *          └─ knowledgeEnabled
 *
 *   captureEnabled     回流（写侧）**完全独立**：既不受 enabled 约束，也不受
 *                      injectionEnabled 约束（lib/capture.mjs 只判它自己），默认开
 */
const FALSEY = /^(0|false|no|off)$/i

function boolOpt(value, dflt) {
  if (value === undefined || value === null || value === '') return dflt
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  return !FALSEY.test(String(value).trim())
}

function numOpt(value, dflt) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt
}

/**
 * 同 numOpt，但**允许 0**（0 是有效语义，不是"没配"）。
 *
 * 目前只有 `assetRetryCooldownMs` 用它：0 = 不做冷却、每次失败都允许重试。
 * 用 numOpt 会把 0 判成非法值而悄悄换成默认值（15000），env 里配 `=0` 就完全无效 ——
 * 而设置面板（`z.natural().min(0)`）是允许 0 的，两侧语义必须一致。
 * 空串/缺省仍回落默认值（空串不能被 Number('') 的 0 骗过去）。
 */
function numOptZero(value, dflt) {
  if (value === undefined || value === null || value === '') return dflt
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt
}

export function str(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text || undefined
}

export function resolveConfig(config = {}) {
  return {
    enabled: boolOpt(config.enabled, true),
    captureEnabled: boolOpt(config.captureEnabled, true),
    recallEnabled: boolOpt(config.recallEnabled, true),
    injectionEnabled: boolOpt(config.injectionEnabled, true),
    sessionContextEnabled: boolOpt(config.sessionContextEnabled, true),
    profileMemoryEnabled: boolOpt(config.profileMemoryEnabled, true),
    skillsEnabled: boolOpt(config.skillsEnabled, true),
    knowledgeEnabled: boolOpt(config.knowledgeEnabled, false),

    endpoint: str(config.endpoint) || 'http://127.0.0.1:8420',
    apiKeyEnv: str(config.apiKeyEnv) || 'TDAI_MEMORY_API_KEY',
    /** memory 实例 id（x-tdai-service-id / space_id）。 */
    serviceId: str(config.serviceId),
    teamId: str(config.teamId),
    agentId: str(config.agentId),
    userId: str(config.userId),
    /** x-tdai-user-key：meta 面（agent/task 详情、借入资产解析）需要；缺省时这些能力降级。 */
    userKey: str(config.userKey),
    /**
     * 知识服务地址改写（可选，**只改 origin**）。
     *
     * 为什么需要：`/v3/knowledge/list` 返回的 `service_url` 是"服务端自己通得到"的地址，
     * 容器化部署里常见 `http://host.docker.internal:8424/v3` 这类**容器内地址**；本插件
     * 进程跑在宿主上时该地址不可达（实测 `fetch failed` → tools/list 全空 → skill 正文
     * 只剩"可用工具：未取到"）。配置本项后把 scheme/host/port 换成这里给的 origin，
     * **path 原样保留**，所以服务端换前缀也不用改配置。
     */
    knowledgeEndpoint: str(config.knowledgeEndpoint),
    /** 可选：session_context 的 [Task] 段 + 回流/召回的 task_id 归属。 */
    taskId: str(config.taskId),

    recallLimit: numOpt(config.recallLimit, 5),
    l2Limit: numOpt(config.l2Limit, 3),
    timeoutMs: numOpt(config.timeoutMs, 5000),

    /**
     * L1 检索的单次硬超时。pre-step 里必须能在有限时间内放弃召回 ——
     * 否则网关不响应时这一步会一直挂着（用户看到的是"发消息一直阻塞等待"）。
     */
    recallTimeoutMs: numOpt(config.recallTimeoutMs, 3000),
    /** 整包资产（meta + L3/L2 + skill + knowledge）加载的总预算，超预算按失败降级。 */
    assetLoadBudgetMs: numOpt(config.assetLoadBudgetMs, 5000),
    /**
     * 资产加载失败后的冷却期：期内不重试，避免每一步都重付一次失败的代价。
     * **允许 0**：0 = 不冷却（每次失败后下一步就会再试一次），用 numOptZero 解析。
     */
    assetRetryCooldownMs: numOptZero(config.assetRetryCooldownMs, 15000),
  }
}

/** 召回 / 注入 / 工具 / 回流 所需的最小身份是否齐全。 */
export function identityComplete(cfg) {
  return Boolean(cfg.serviceId && cfg.teamId && cfg.agentId && cfg.userId)
}

export function baseIdentity(cfg) {
  return {
    space_id: cfg.serviceId,
    team_id: cfg.teamId,
    agent_id: cfg.agentId,
    user_id: cfg.userId,
    task_id: cfg.taskId,
  }
}
