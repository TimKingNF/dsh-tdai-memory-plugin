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
import { registerTools } from './lib/tools.mjs'
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
  }

  wireCapture(ctx, runtime)
  registerSections(ctx, runtime)
  wireRecall(ctx, runtime)
  registerTools(ctx, runtime)
  // commands 服务可选（缺省时优雅降级，不影响其它能力）；用注入后的 ctx 而非外层 ctx
  ctx.inject(['commands'], (commandsCtx) => registerCommands(commandsCtx, runtime))

  ctx.on('agent/session-start', (payload) => {
    const sessionId = payload?.agent?.session?.id
    if (sessionId && runtime.readEnabled() && (runtime.config.injectionEnabled || runtime.config.recallEnabled)) {
      assets.ensure(sessionId).catch(() => {})
    }
  })
  ctx.on('session/disposed', (session) => {
    assets.dispose(session?.id)
  })

  if (!runtime.readEnabled()) {
    log(identityComplete(envCfg)
      ? 'disabled (TDAI_MEMORY_ENABLED=false 或设置面板已关闭); capture-only'
      : 'identity incomplete (need TDAI_MEMORY_INSTANCE_ID / TDAI_MEMORY_TEAM_ID / TDAI_MEMORY_AGENT_ID / TDAI_MEMORY_USER_ID); recall/injection/tools disabled')
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
