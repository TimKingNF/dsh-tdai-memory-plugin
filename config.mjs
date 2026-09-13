/**
 * 配置解析：cordis.patch.yml 把 env 原样透传进来，这里统一做默认值与类型归一。
 *
 * 开关语义：
 *   enabled            总开关，控制「上下文召回 + 注入 + 只读工具」；false 时这三类全部关闭
 *   captureEnabled     回流（写侧）独立开关，不受 enabled 影响，默认开
 *   recallEnabled      L1 自动召回（agent/pre-step 注入 <tdai_recalled_l1_memories>）
 *   injectionEnabled   system prompt 注入总闸（session_context / L2L3 / skills / knowledge）
 *   sessionContextEnabled / profileMemoryEnabled / skillsEnabled / knowledgeEnabled  注入子开关
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
    /** 可选：session_context 的 [Task] 段 + 回流/召回的 task_id 归属。 */
    taskId: str(config.taskId),

    recallLimit: numOpt(config.recallLimit, 5),
    l2Limit: numOpt(config.l2Limit, 3),
    timeoutMs: numOpt(config.timeoutMs, 5000),
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
