/**
 * 子 agent（delegated child session）会话判定与降级策略。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * DSH 派子 agent 时，子会话与父会话是**两个独立 session**，但：
 *   - 本插件注册的 system section 是**全局层**的，子 agent 一并继承；
 *   - `agent/pre-step` 与 `session/event` 监听是进程级的，子会话同样触发。
 * 实测（DSH 0.1.2-rc.1 本机数据）后果有两类：
 *   1. **提示词噪音**：子会话 system prompt 与父会话逐字节相同（13020 字节），
 *      其中本插件的 4 个段占 6093 字节（47%）；子会话还会各自做一轮 L1 召回
 *      （实测 2 条、共约 4.4KB）。子 agent 的任务通常是"分析这段 diff"这类
 *      范围明确的工作，画像与召回多半是干扰。
 *   2. **记忆污染**：`agent/turn-stopping` 对任何会话都生效，子 agent 的整段执行
 *      （任务 prompt + 工具 dump + 结论）会作为 L0 语料回流，进而被后台抽取
 *      当成"关于用户的记忆"——实测一个 23 步的调查子 agent 写入了 37 条 L0。
 *
 * ── 判定依据 ────────────────────────────────────────────────────────────────
 * DSH 给子会话打的 **durable** 标记（`dsh-session` 的 `SessionHeader`）：
 *   - `origin: 'subagent'` —— 子 agent 的粗粒度分类（spawn 与 fork 两种都由
 *     `dsh-subagent` 的 `childSessionMeta()` 写入，见该函数注释）；
 *   - `delegationDepth` —— 委派深度，顶层会话缺省（=0），子会话为父深度 +1。
 * `origin` 是主判据，`delegationDepth > 0` 是兜底（万一未来某个 provider 漏打 origin）。
 *
 * **缺 header 一律按父会话处理**（fail-open 到"维持现状"）：单测夹具、老宿主、
 * 极端裁剪场景都不该因为读不到 header 就静默失去记忆能力。
 *
 * ── 缓存视角（改默认值前先读）───────────────────────────────────────────────
 * 关掉子会话的注入**会**让子会话的 system prompt 与父会话在第一个 TDAI 段处（实测字节
 * 1557）分叉，其后的 11463 字节（我们的 6093 + DSH 自己的 5370）在**子会话第一次请求**
 * 里按未命中计价，之后命中子会话自己的缓存。换算量级约 3.3K tokens 的差价 / 子会话，
 * 一次性。反过来，若部署给子 agent 配了 `dsh-tool-subagent` 的 `persona` 或
 * `toolFilter`（DSH 原生的两个子 agent 定制入口），子会话前缀本来就在**最前面**分叉，
 * 那时本降级是**零缓存代价**。完整账见 docs/prompt-design.zh-CN.md §3.4。
 */

/**
 * 这个会话是不是 DSH 派出去的子 agent 会话。
 *
 * @param session - DSH 的 Session（`agent.session`）；缺 header 时返回 false。
 */
export function isSubagentSession(session) {
  const header = session?.header
  if (!header || typeof header !== 'object') return false
  if (header.origin === 'subagent') return true
  const depth = header.delegationDepth
  return typeof depth === 'number' && depth > 0
}

/**
 * 读侧（system 注入 / L1 召回 / 知识 skill / 运行时状态快照）对该会话是否生效。
 *
 * `subagentInjectionEnabled=false`（默认）时子会话整体降级：不注入、不召回、
 * 不注册知识 skill、不预热资产。**只读工具仍然注册**——子 agent 真需要记忆时
 * 可以主动调用，能力不丢；要连工具一起摘掉，用 DSH 原生的
 * `dsh-tool-subagent` 的 `toolFilter`（`tools.restrict()`），那属于部署级选择。
 */
export function readSideAllowed(config, session) {
  if (config?.subagentInjectionEnabled) return true
  return !isSubagentSession(session)
}

/**
 * 写侧（对话回流 MemoryCore）对该会话是否生效。
 *
 * `subagentCaptureEnabled=false`（默认）时子会话不回流：子 agent 的中间过程是
 * 工作噪音而非"关于用户的记忆"，写进 L0 就会被后台抽取当成长期记忆语料。
 * 子 agent 的结论在父会话里有 `subagent-settled` / relay 消息留痕，不必再存一份。
 */
export function captureAllowed(config, session) {
  if (config?.subagentCaptureEnabled) return true
  return !isSubagentSession(session)
}
