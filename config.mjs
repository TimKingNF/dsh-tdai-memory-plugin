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
 *
 *   subagentInjectionEnabled  子 agent 会话是否继承读侧。**默认关**：子会话不注入、
 *                             不召回、不注册知识 skill、不预热资产（只读工具仍在）。
 *   subagentCaptureEnabled    子 agent 会话是否回流。**默认关**：子 agent 的执行过程
 *                             不进 L0，避免后台抽取把工作噪音当成用户记忆。
 *                             两者判定见 lib/subagent.mjs（按 session.header.origin）。
 */
const FALSEY = /^(0|false|no|off)$/i

/**
 * 取"实时值"。
 *
 * DSH 0.1.7-rc.1 起，`Config` 里标了 `.volatile()` 的字段经 cordis 校验后会变成
 * **`{ get() }` 访问器**（`{a: z.boolean().volatile()}` → `config.a.get()`），在面板写入时
 * **原地更新**（loader 的 `_commitVolatile` 改的是这个访问器，不会重新 apply 插件）。
 * 没标 volatile 的字段仍是普通值（部署期配置，如 `apiKeyEnv`）。这里统一拆掉这层，
 * 让下面的归一化逻辑对两种形态都成立。见 lib/settings.mjs 顶部对 volatile 约定的说明。
 */
export function liveValue(value) {
  return value && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
}

function boolOpt(value, dflt) {
  const v = liveValue(value)
  if (v === undefined || v === null || v === '') return dflt
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  return !FALSEY.test(String(v).trim())
}

function numOpt(value, dflt) {
  const n = Number(liveValue(value))
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
  const raw = liveValue(value)
  if (raw === undefined || raw === null || raw === '') return dflt
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt
}

export function str(value) {
  const raw = liveValue(value)
  const text = typeof raw === 'string' ? raw.trim() : ''
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

    /**
     * 子 agent 会话的降级开关（见 lib/subagent.mjs 顶部注释）。
     * 默认都是 false = "子会话不继承注入 / 不回流"——子 agent 的任务通常范围明确，
     * 父 agent 的画像与召回是干扰；它的中间过程也不该进长期记忆。
     */
    subagentInjectionEnabled: boolOpt(config.subagentInjectionEnabled, false),
    subagentCaptureEnabled: boolOpt(config.subagentCaptureEnabled, false),

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
