/**
 * dsh-tdai-memory-plugin — DSH 进程内的 TencentDB Agent Memory 插件。
 *
 * 读侧（enabled 总开关）：
 *   - system prompt 注入：<session_context>（agent/task 详情）、<tdai_profile_memory>
 *     （L3 persona + L2 场景索引，自有+借入）、<available_skills>、<knowledge_tools>
 *   - L1 自动召回：agent/pre-step 按本轮用户输入做自有+借入合并 top-K 检索
 *   - 只读工具：tdai_memory_search / tdai_conversation_search / tdai_skill_search /
 *     tdai_read_scene / tdai_skill_view / tdai_memory_query / tdai_conversation_query / tdai_scenario_ls
 *   - slash 命令：/tdai-sync /tdai-status /tdai-archive /tdai-help
 *
 * 写侧（captureEnabled，独立开关）：
 *   - 每轮结束旁路回流 /v3/conversation/add（L0）+ /v3/skill/conversation/add（Skill 归档）
 *
 * 身份与开关来源（优先级高→低）：
 *   1. Web 设置面板（「设置 → 插件 → TDAI Memory」卡片）
 *   2. env（TDAI_MEMORY_*）
 *   3. 内置默认值
 *
 * 所有远端调用 fail-open，不阻断 DSH。
 */
import { resolveConfig, identityComplete, baseIdentity, str } from './config.mjs'
import { GatewayClient } from './client.mjs'
import { SessionAssets } from './lib/assets.mjs'
import { registerSections } from './lib/sections.mjs'
import { wireRecall } from './lib/recall.mjs'
import { wireCapture } from './lib/capture.mjs'
import { registerTools, registerKnowledgeTools } from './lib/tools.mjs'
import { registerCommands } from './lib/commands.mjs'
import { applySettings } from './lib/settings.mjs'

export const name = 'dsh-tdai-memory-plugin'
export const inject = ['tools', 'systemPrompt', 'sessions']

export function apply(ctx, config = {}) {
  const envCfg = resolveConfig(config)
  const log = (message) => {
    try { ctx.logger?.warn?.(`[tdai-memory] ${message}`) } catch {}
  }

  // 当前生效配置（env 为底，Web 设置覆盖）；变更时整体重建 client/assets
  let activeCfg = envCfg
  let client = buildClient(activeCfg, log)
  let assets = new SessionAssets(client, activeCfg, log)

  const rebuild = (nextCfg) => {
    activeCfg = nextCfg
    client = buildClient(nextCfg, log)
    assets = new SessionAssets(client, nextCfg, log)
    log(`config reloaded: endpoint=${nextCfg.endpoint} instance=${nextCfg.serviceId} team=${nextCfg.teamId} agent=${nextCfg.agentId}`)
  }

  // 注册 Web 设置命名空间（settings provider 存在时生效；缺省仅用 env）
  applySettings(ctx, envCfg, log, rebuild)

  const runtime = {
    get client() { return client },
    get assets() { return assets },
    get config() { return activeCfg },
    log,
    readEnabled() { return activeCfg.enabled && identityComplete(activeCfg) },
    identityFor(session) {
      const sessionId = str(session?.id)
      if (!identityComplete(activeCfg) || !sessionId) return undefined
      return { ...baseIdentity(activeCfg), session_id: sessionId }
    },
    /**
     * 身份来自哪一层：缺省回落到 env 时返回 'env'，被 Web 设置面板覆盖时返回 'settings'。
     *
     * 为什么需要它：绕开 proxy 之后（docs/prompt-injection-redesign.md §6.1 决定 A），
     * 身份完全来自本地配置，**一个 dsh 进程只对应一个 TDAI 身份**。用户必须能一眼
     * 看出"当前生效的身份是哪来的"，否则改了面板没生效时会误判成插件坏了。
     * 判定方式是"当前生效值是否与 env 层不同"——只要有一项被设置面板改过就算 settings。
     */
    identitySource() {
      const keys = ['serviceId', 'teamId', 'agentId', 'userId', 'taskId', 'userKey']
      return keys.some((k) => String(activeCfg[k] ?? '') !== String(envCfg[k] ?? '')) ? 'settings' : 'env'
    },
    /** 身份缺哪些字段（用于日志点名，而不是只说一句 "identity incomplete"）。 */
    missingIdentityFields() {
      return [
        ['TDAI_MEMORY_INSTANCE_ID', activeCfg.serviceId],
        ['TDAI_MEMORY_TEAM_ID', activeCfg.teamId],
        ['TDAI_MEMORY_AGENT_ID', activeCfg.agentId],
        ['TDAI_MEMORY_USER_ID', activeCfg.userId],
      ].filter(([, v]) => !str(v)).map(([name]) => name)
    },
  }

  wireCapture(ctx, runtime)
  registerSections(ctx, runtime)
  wireRecall(ctx, runtime)
  registerTools(ctx, runtime)
  registerKnowledgeTools(ctx, runtime)
  // commands 服务可选（缺省时优雅降级，不影响其它能力）；用注入后的 ctx 而非外层 ctx
  ctx.inject(['commands'], (commandsCtx) => registerCommands(commandsCtx, runtime))

  ctx.on('agent/session-start', (payload) => {
    const sessionId = payload?.agent?.session?.id
    if (sessionId && runtime.readEnabled() && (runtime.config.injectionEnabled || runtime.config.recallEnabled)) {
      // 后台预热，不 await：会话刚建立时把整包资产拉起来，
      // 让第一次 pre-step / assemble 尽量命中缓存（加载本身有总预算与失败冷却）。
      assets.warm(sessionId)
    }
  })
  ctx.on('session/disposed', (session) => {
    assets.dispose(session?.id)
  })

  if (!runtime.readEnabled()) {
    if (identityComplete(envCfg)) {
      log('disabled (TDAI_MEMORY_ENABLED=false 或设置面板已关闭); capture-only')
    } else {
      const missing = runtime.missingIdentityFields()
      log(`identity incomplete — 缺 ${missing.join(', ')}；读侧（召回 / 注入 / 工具）全部停用，写侧不受影响。`
        + '配置来源：TDAI_MEMORY_* 环境变量，或 Web「设置 → 插件 → TDAI Memory」面板。')
    }
  }
  log(`enabled: endpoint=${activeCfg.endpoint} instance=${activeCfg.serviceId} team=${activeCfg.teamId} agent=${activeCfg.agentId} recall=${activeCfg.recallEnabled} inject=${activeCfg.injectionEnabled} capture=${activeCfg.captureEnabled}`)
}

function buildClient(cfg, log) {
  const apiKey = process.env[cfg.apiKeyEnv] || ''
  return new GatewayClient({
    endpoint: cfg.endpoint,
    apiKey,
    serviceId: cfg.serviceId,
    userKey: cfg.userKey,
    timeoutMs: cfg.timeoutMs,
  }, log)
}
