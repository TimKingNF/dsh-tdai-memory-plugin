/**
 * dsh-tdai-memory-plugin — DSH 进程内的 TencentDB Agent Memory 插件。
 *
 * 读侧（enabled 总开关）：
 *   - system prompt 注入：<session_context>（agent/task 详情）、<tdai_profile_memory>
 *     （L3 persona + L2 场景索引，自有+借入）、<available_skills>、<knowledge_tools>
 *   - L1 自动召回：agent/pre-step 按本轮用户输入做自有+借入合并 top-K 检索
 *   - 只读工具（10 个）：tdai_memory_search / tdai_conversation_search / tdai_skill_search /
 *     tdai_read_scene / tdai_skill_view / tdai_memory_query / tdai_conversation_query / tdai_scenario_ls
 *     + 知识工具 tdai_knowledge_tools / tdai_knowledge_call
 *   - slash 命令：/tdai-sync /tdai-status /tdai-archive /tdai-help
 *
 * 写侧（captureEnabled，独立开关）：
 *   - 每轮结束旁路回流 /v3/conversation/add（L0）+ /v3/skill/conversation/add（Skill 归档）
 *
 * 写侧（taskWriteEnabled，独立开关，**默认关**）：
 *   - 对话内待办写入 TDAI task（4 个工具）：tdai_task_add / tdai_task_list /
 *     tdai_task_update / tdai_task_delete；走 meta 面，另需 userKey。
 *     只在用户明确说"记一下"时写，失败原样回给模型（不 fail-open）。
 *     口径与设计见 docs/task-capture-design.zh-CN.md。
 *
 * 子 agent 会话（DSH 派出去的子会话，session.header.origin === 'subagent'）默认
 * **只保留知识库与工具**：不注入身份（`tdai:session-context`）与记忆（`tdai:profile-memory`
 * / L1 召回 / `tdai:state` 快照）、不预热这些资产、不回流；但知识资产、`tdai:knowledge-tools`
 * 路由、`tdai-team-knowledge` skill 与全部 10 个只读工具照常可用。`subagentInjectionEnabled=true`
 * 恢复"全量继承"（连身份与记忆一起给子会话）。能力面定义见 lib/subagent.mjs。
 *
 * 身份与开关来源（优先级高→低）：
 *   1. Web 设置面板（「设置 → TDAI Memory」页）
 *   2. 组合层（本插件 cordis.patch.yml，值来自 TDAI_MEMORY_* env）
 *   3. schema 默认值（`export const Config`）
 *
 * ── DSH 0.1.7-rc.1 的配置模型 ────────────────────────────────────────────────
 *
 * 插件**导出 `Config`**（schemastery schema），由宿主 settings 服务负责表单、校验、
 * 层叠与写盘。写入后分两种：
 *   - **非 volatile** 字段变化 → Loader 带着新 config **重新 apply** 本插件（`applies: 'live'`）；
 *   - **volatile** 字段（= 面板上的字段）变化 → 只原地更新 `{ get() }` 访问器，**不重新 apply**，
 *     插件靠 `config.mjs` 的 `liveValue()` 与下面的 `live()` 惰性重建派生对象。
 * 两种情况下"当前生效配置"都从 `live()` 取，不再有"自己 merge 设置 + rebuild"的逻辑。
 * 详见 lib/settings.mjs 顶部。
 *
 * 所有远端调用 fail-open，不阻断 DSH。
 */
import { resolveConfig, identityComplete, baseIdentity, str } from './config.mjs'
import { GatewayClient } from './client.mjs'
import { SessionAssets } from './lib/assets.mjs'
import { registerSections } from './lib/sections.mjs'
import { wireRecall } from './lib/recall.mjs'
import { wireCapture } from './lib/capture.mjs'
import { registerTools, registerKnowledgeTools, registerTaskTools } from './lib/tools.mjs'
import { registerCommands } from './lib/commands.mjs'
import { buildSettingsSchema, applySettings, identitySourceOf, SETTINGS_NAMESPACE } from './lib/settings.mjs'
import { isSubagentSession } from './lib/subagent.mjs'
import { DsbotIndex, resolveDshHome } from './lib/dsbot.mjs'
import { DsbotLedger } from './lib/dsbot-ledger.mjs'

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
   *     （顺带丢弃会话资产缓存 —— 资产内容本身就依赖 sessionContextEnabled / knowledgeEnabled 这些开关，
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

  /**
   * ds-bot 索引层（`DsbotLedger` + `DsbotIndex`），按「DSH_HOME + 台账路径」惰性重建。
   *
   * 为什么不跟着上面 `built` 的配置签名整体重建：索引层的构造只取决于磁盘位置
   *（读哪份 `state.json`、台账落哪），识别总闸 / skill 注入 / 回写这些 volatile 开关
   * 都是**读时判定**（每次调用都把当前 cfg 传进 `sessionPolicy()` /
   * `writebackAllowedFor()`，见 lib/dsbot.mjs）。反过来，若跟着任意开关重建，就会为一次
   * 无关的面板改动 new 一份台账，把还没落盘的群聊 pending / 断点丢掉 —— 那是写侧状态，
   * 不该被读侧开关影响。
   *
   * 首次构建即异步预热（`load()` → `refresh()`），**不 await**：插件加载不能被一次
   * 磁盘读阻塞。预热完成前 `lookup()` 返回 ordinary（fail-open），普通会话不受影响；
   * Bot 会话的首个 `assemble` / `pre-step` 会经 `dsbotReady()` 等它一次。
   */
  let dsbotLayer
  const layerFor = (cfg) => {
    const dshHome = resolveDshHome(process.env.DSH_HOME)
    const key = `${dshHome}\u0000${cfg.dsbotLedgerPath ?? ''}`
    if (!dsbotLayer || dsbotLayer.key !== key) {
      const ledger = new DsbotLedger({ path: cfg.dsbotLedgerPath, dshHome, log })
      const dsbot = new DsbotIndex({ dshHome, ledger, log })
      dsbotLayer = { key, ledger, dsbot }
      // 先读台账、再刷索引：`DsbotIndex` 构造时会从台账恢复上一次成功的索引，
      // 供 `state.json` 读不到时兜底（stale）。两步内部都已 fail-open，这里再兜一层，
      // 避免异步链上的拒绝变成 unhandledRejection。
      void Promise.resolve()
        .then(() => ledger.load())
        .then(() => dsbot.refresh())
        .catch((error) => log(`[dsbot] 索引初始化失败：${error?.message ?? error}`))
    }
    return dsbotLayer
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
    /**
     * 有没有配 user key（meta 面鉴权）。
     *
     * 为什么单独暴露：`identityComplete` 只覆盖四元组，user key 是**另一个维度**——
     * 缺它时读侧（召回 / 注入）照常工作，只有 meta 面（agent/task 详情、借入资产、
     * task 写入）会 401。写侧工具必须先判它，否则模型会拿到一句"HTTP 401"去猜。
     */
    hasUserKey() { return Boolean(str(live().cfg.userKey)) },
    /** 待办写入开关（独立写侧；不在 readEnabled 之下）。 */
    taskWriteEnabled() { return Boolean(live().cfg.taskWriteEnabled) },
    /**
     * 该会话的读侧能力面（身份 / 记忆 / 云端 skill 召回 / 知识）。
     *
     * 单一计算点是 `DsbotIndex.sessionPolicy()`（lib/dsbot.mjs）：
     *   - 普通会话：返回 `subagentReadPolicy()` 的超集（多 bot/kind/botId/roomId/sessionId/
     *     skillInject/writeback 几个只读字段），四个能力面的取值与原逻辑逐项相同；
     *   - Bot / 房间 / 群成员隐藏会话：lean（identity=false、memory=false），
     *     skills 受 `botSkillInjectEnabled` 约束、knowledge 恒 true。
     * 调用方**只读四个面**（以及 Bot 分支的 `skillInject`），不要在这里另做 AND。
     */
    readPolicyFor(session) {
      const cfg = live().cfg
      return layerFor(cfg).dsbot.sessionPolicy(cfg, session)
    },
    /**
     * ds-bot 索引（只读 `state.json`；四态判定、room log、主持 Bot 模型都从这里取）。
     *
     * ⚠️ 每次调用都取当前层：调用点不要把这个对象缓存进长生命周期结构（配置里改
     * DSH_HOME / 台账路径时会整体重建）。读侧只用它算策略；写侧另有台账。
     */
    get dsbot() { return layerFor(live().cfg).dsbot },
    /** ds-bot 台账（写侧断点 / pending / 幂等位；读侧不依赖它，见文件头）。 */
    get ledger() { return layerFor(live().cfg).ledger },
    /**
     * 宿主的 llm 服务（群聊前文蒸馏用主持 Bot 的模型）。
     *
     * 为什么是 `ctx.get` + try/catch 而不是写进 `inject`：llm 是**可选**服务，
     * 宿主没挂 llm 插件时本插件也必须能加载（写侧按"没有 llm"降级为只写人话）。
     * cordis 的 ctx 是 Proxy，读一个没声明的服务名**取值动作本身就会抛**，
     * 所以这里必须兜住；取不到 = undefined，不向上抛。
     */
    llm() {
      try { return ctx.get('llm') } catch { return undefined }
    },
    /**
     * 确保 ds-bot 索引已经尝试刷新过（`agent/pre-step` / `system-prompt/assemble`
     * 在算策略前 await 一次）。
     *
     * 幂等：`refresh()` 自带 5 秒 mtime 缓存，只做本地 stat/读，不碰网络。
     * 判定为什么必须等它：索引是 apply 时异步预热的，Bot 会话的首个回合很容易
     * 赶在它前面 —— 那一刻会话会被当成 ordinary，白注入身份与画像。
     */
    dsbotReady() { return layerFor(live().cfg).dsbot.refresh() },
    /**
     * `/tdai-status` 的 `dsbot=` 行数据。
     *
     * `skillInject` / `writeback` 是**有效值**（已在 `sessionPolicy()` 里与全局
     * enabled / skillsEnabled / captureEnabled 做过 AND），不是配置值：用户问的
     * 往往是"开关明明开着，为什么没注入 / 还在写"，打印配置值只会误导。
     */
    dsbotStatus(session) {
      const cfg = live().cfg
      const layer = layerFor(cfg)
      const policy = layer.dsbot.sessionPolicy(cfg, session)
      return {
        kind: policy.kind,
        bot: policy.bot,
        skillInject: policy.skillInject,
        writeback: policy.writeback,
        botId: policy.botId,
        roomId: policy.roomId,
        ledgerPath: layer.ledger.path,
        index: layer.dsbot.status(),
      }
    },
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
  registerTaskTools(ctx, runtime)
  // commands 服务可选（缺省时优雅降级，不影响其它能力）；用注入后的 ctx 而非外层 ctx
  ctx.inject(['commands'], (commandsCtx) => registerCommands(commandsCtx, runtime))

  // 会话建立后的资产预热。
  //
  // 0.1.7-rc.1 里 `agent/session-start` **已不存在**（全源码 grep 为 0），事件改为
  // `agent/created`（serial，payload `{ agent, source, signal? }`）。旧监听是静默死代码。
  ctx.on('agent/created', async (payload) => {
    const session = payload?.agent?.session
    const sessionId = session?.id
    if (!sessionId || !runtime.readEnabled()) return
    // 策略依赖 ds-bot 索引（Bot / 房间会话只预热知识面）。索引是 apply 时异步预热的，
    // 首个会话很可能赶在它前面 —— 先等一次，否则 Bot 会话会白拉一整包画像资产。
    // refresh 自带 mtime 缓存，命中时只是一个同步返回。
    try { await runtime.dsbotReady() } catch {}
    // 只预热它真会用到的那几面：子会话默认只有知识面；Bot 会话只有 skill 面
    // （云端 skill 不占资产）与知识面，都不该为一份用不到的画像打网关。
    // 能力面定义见 lib/subagent.mjs 与 lib/dsbot.mjs。
    //
    // 云端 skill 召回**不在预热范围内**：它每轮直接查 core，不依赖会话资产（2026-10 改版）。
    const cfg = runtime.config
    const policy = runtime.readPolicyFor(session)
    const needsAssets = (policy.identity && cfg.injectionEnabled && cfg.sessionContextEnabled)
      || (policy.memory && ((cfg.injectionEnabled && cfg.profileMemoryEnabled) || cfg.recallEnabled))
      || (policy.knowledge && cfg.knowledgeEnabled)
    if (!needsAssets) return
    // 后台预热，不 await：会话刚建立时把整包资产拉起来，
    // 让第一次 pre-step / assemble 尽量命中缓存（加载本身有总预算与失败冷却）。
    live().assets.warm(sessionId, policy)
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
  // ds-bot 索引预热：首次 apply 就把台账读起来、`state.json` 刷一次（**不 await**，
  // 别阻塞插件加载）。构造时即触发 load → refresh，见上面的 layerFor()。
  layerFor(boot)
  log(`enabled: endpoint=${boot.endpoint} instance=${boot.serviceId} team=${boot.teamId} agent=${boot.agentId} recall=${boot.recallEnabled} inject=${boot.injectionEnabled} capture=${boot.captureEnabled} taskWrite=${boot.taskWriteEnabled}`)
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
