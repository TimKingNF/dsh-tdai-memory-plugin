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
 * 子 agent 会话（DSH 派出去的子会话，session.header.origin === 'subagent'）默认降级：
 * 不注入 / 不召回 / 不注册知识 skill / 不预热资产 / 不回流（两个开关可改，见 config.mjs
 * 的 subagentInjectionEnabled / subagentCaptureEnabled 与 lib/subagent.mjs）。
 *
 * 身份与开关来源（优先级高→低）：
 *   1. Web 设置面板（「设置 → TDAI Memory」页）
 *   2. 组合层（本插件 cordis.patch.yml，值来自 TDAI_MEMORY_* env）
 *   3. schema 默认值（`export const Config`）
 *
 * ── DSH 0.1.7-rc.1 的配置模型 ────────────────────────────────────────────────
 *
 * 插件**导出 `Config`**（schemastery schema），由宿主 settings 服务负责表单、校验、
 * 层叠与写盘；写入后 Loader 会带着新 config **重新 apply 本插件**（`applies: 'live'`）。
 * 因此这里不再有"自己 merge 设置 + rebuild"的逻辑：每次 apply 拿到的就是当前生效配置，
 * `client` / `assets` 随之一起重建。详见 lib/settings.mjs 顶部。
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
import { buildSettingsSchema, applySettings, identitySourceOf, SETTINGS_NAMESPACE } from './lib/settings.mjs'
import { readSideAllowed, isSubagentSession } from './lib/subagent.mjs'

export const name = 'dsh-tdai-memory-plugin'
export const inject = ['tools', 'systemPrompt', 'sessions']

/**
 * 插件 Config：settings 服务据此校验 entry config 并生成表单。
 *
 * 命名空间 key 是 profile patch 的 entry id（`tdai-memory`，见 cordis.patch.yml），
 * 不是这里声明的任何字符串 —— `SETTINGS_NAMESPACE` 只用于在 describe() 里定位本 entry。
 */
export const Config = buildSettingsSchema()

export function apply(ctx, config = {}) {
  const log = (message) => {
    try { ctx.logger?.warn?.(`[tdai-memory] ${message}`) } catch {}
  }

  /**
   * 实时配置 + 派生对象的惰性重建。
   *
   * `config` 是**混合形态**：volatile 字段是 `{ get() }` 访问器（设置面板写入时由 loader 原地
   * 更新，**不会重新 apply 插件**），非 volatile 字段是部署期普通值。所以：
   *   - 每次都重新 `resolveConfig()` → 面板改完立刻生效（见 config.mjs 的 liveValue）；
   *   - `client` / `assets` 构造时抓的是**快照**，因此按配置签名比对，变了就整体重建
   *     （顺带丢弃会话资产缓存 —— 资产内容本身就依赖 skillsEnabled / knowledgeEnabled 这些开关，
   *     改动后本来就该失效）。
   */
  let built
  const live = () => {
    const cfg = resolveConfig(config)
    const sig = JSON.stringify(cfg)
    if (!built || built.sig !== sig) {
      const client = buildClient(cfg, log)
      built = { sig, cfg, client, assets: new SessionAssets(client, cfg, log) }
    }
    return built
  }

  /** settings 服务句柄（宿主没有该服务时恒为 undefined）。仅用于读用户层判断身份来源。 */
  let settings
  applySettings(ctx, log, (handle) => { settings = handle })

  const runtime = {
    get client() { return live().client },
    get assets() { return live().assets },
    get config() { return live().cfg },
    log,
    readEnabled() { const cfg = live().cfg; return cfg.enabled && identityComplete(cfg) },
    /** 读侧对该会话是否生效（子 agent 会话默认降级，见 lib/subagent.mjs）。 */
    readSideAllowedFor(session) { return readSideAllowed(live().cfg, session) },
    /** 这个会话是不是 DSH 派出去的子 agent 会话（/tdai-status 用它解释"为什么没注入"）。 */
    isSubagent(session) { return isSubagentSession(session) },
    identityFor(session) {
      const sessionId = str(session?.id)
      const cfg = live().cfg
      if (!identityComplete(cfg) || !sessionId) return undefined
      return { ...baseIdentity(cfg), session_id: sessionId }
    },
    /**
     * 身份来自哪一层：组合层（env 派生的 patch config）返回 'env'，被设置面板覆盖返回 'settings'。
     *
     * 为什么需要它：绕开 proxy 之后（docs/prompt-injection-redesign.md §6.1 决定 A），
     * 身份完全来自本地配置，**一个 dsh 进程只对应一个 TDAI 身份**。用户必须能一眼
     * 看出"当前生效的身份是哪来的"，否则改了面板没生效时会误判成插件坏了。
     *
     * 判定方式（0.1.7-rc.1）：读 `settings.describe()` 里本 entry 的**用户层**——
     * 身份键出现在用户层才算面板改过。老实现比较"当前值 vs env 值"，用户把某个字段
     * 改回与 env 相同的值时会被误判成 env。
     */
    identitySource() {
      try {
        const descriptors = settings?.describe?.()
        if (descriptors) return identitySourceOf(descriptors, SETTINGS_NAMESPACE)
      } catch (error) {
        log(`settings.describe failed: ${error.message}`)
      }
      // 宿主没有 settings 服务（或 describe 不可用）：只剩组合层一条来源。
      return 'env'
    },
    /** 身份缺哪些字段（用于日志点名，而不是只说一句 "identity incomplete"）。 */
    missingIdentityFields() {
      const cfg = live().cfg
      return [
        ['TDAI_MEMORY_INSTANCE_ID', cfg.serviceId],
        ['TDAI_MEMORY_TEAM_ID', cfg.teamId],
        ['TDAI_MEMORY_AGENT_ID', cfg.agentId],
        ['TDAI_MEMORY_USER_ID', cfg.userId],
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

  // 会话建立后的资产预热。
  //
  // 0.1.7-rc.1 里 `agent/session-start` **已不存在**（全源码 grep 为 0），事件改为
  // `agent/created`（serial，payload `{ agent, source, signal? }`）。旧监听是静默死代码。
  ctx.on('agent/created', (payload) => {
    const session = payload?.agent?.session
    const sessionId = session?.id
    // 子 agent 会话按策略降级时**不预热**：整个读侧都不会用到这份资产，预热只是
    // 白白打一轮网关（并发扇出 N 个子 agent 就是 N 份）。见 lib/subagent.mjs。
    if (
      sessionId
      && runtime.readEnabled()
      && readSideAllowed(runtime.config, session)
      && (runtime.config.injectionEnabled || runtime.config.recallEnabled)
    ) {
      // 后台预热，不 await：会话刚建立时把整包资产拉起来，
      // 让第一次 pre-step / assemble 尽量命中缓存（加载本身有总预算与失败冷却）。
      live().assets.warm(sessionId)
    }
  })
  ctx.on('session/disposed', (session) => {
    live().assets.dispose(session?.id)
  })

  if (!runtime.readEnabled()) {
    if (identityComplete(live().cfg)) {
      log('disabled (TDAI_MEMORY_ENABLED=false 或设置面板已关闭); capture-only')
    } else {
      const missing = runtime.missingIdentityFields()
      log(`identity incomplete — 缺 ${missing.join(', ')}；读侧（召回 / 注入 / 工具）全部停用，写侧不受影响。`
        + '配置来源：TDAI_MEMORY_* 环境变量，或 Web「设置 → TDAI Memory」页。')
    }
  }
  const boot = live().cfg
  log(`enabled: endpoint=${boot.endpoint} instance=${boot.serviceId} team=${boot.teamId} agent=${boot.agentId} recall=${boot.recallEnabled} inject=${boot.injectionEnabled} capture=${boot.captureEnabled}`)
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
