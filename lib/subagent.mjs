/**
 * 子 agent（delegated child session）会话判定与读/写侧策略。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * DSH 派子 agent 时，子会话与父会话是**两个独立 session**，但：
 *   - 本插件注册的 system section 是**全局层**的，子 agent 一并继承；
 *   - `agent/pre-step` 与 `session/event` 监听是进程级的，子会话同样触发。
 * 不设策略的后果有两类：
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
 * ── 读侧策略：按「能力面」拆分，不再一刀切（2026-10-05 修正）───────────────
 *
 * 初版策略是"子会话读侧整体降级"，落地后暴露了一个真实事故：一个四人调查团队
 * 全部被策略闸门挡在知识库之外，wiki / code-graph 都读不到，只能由父会话逐页
 * 投喂原文（`lib/tools.mjs` 当时回的是裸的拒绝文案）。根因是把「身份与记忆」
 * 和「知识库与工具」**混在同一个闸门**里 —— 前者对范围明确的子任务是噪音，
 * 后者恰恰是子任务干活要用的能力。
 *
 * 所以读侧现在按四个能力面独立判定：
 *
 *   | facet       | 它管什么                                                             |
 *   |-------------|----------------------------------------------------------------------|
 *   | `identity`  | `tdai:session-context`（agent / task 身份）                          |
 *   | `memory`    | `tdai:profile-memory`（L3 画像 + L2 索引）、L1 召回、`tdai:state` 快照 |
 *   | `skills`    | `tdai:available-skills`（云端 skill 目录，由记忆服务的 skill 库派生） |
 *   | `knowledge` | 知识资产、`tdai:knowledge-tools` 路由、`tdai-team-knowledge` skill、知识工具 |
 *
 * 子会话默认：`identity` / `memory` / `skills` = **false**，`knowledge` = **true**。
 * 也就是说：**子 agent 拿得到知识库与工具，但不会被注入身份与记忆**。
 * `subagentInjectionEnabled=true` 是"全量继承"逃生门，恢复旧语义（连身份与记忆
 * 一起给子会话）。
 *
 * 三个刻意的取舍，改之前先想清楚：
 *   - `skills` 归在记忆侧（关）：它由记忆服务的 skill 库派生，子 agent 要用云端
 *     skill 仍可主动调 `tdai_skill_search` / `tdai_skill_view` 两个只读工具，
 *     缺的只是"目录被预先塞进 prompt"这件事。
 *   - 只读工具（10 个）**从不按会话摘掉**：子 agent 真需要记忆时可以自己调，
 *     能力不丢；要连工具一起收紧用 DSH 原生的 `dsh-tool-subagent` 的 `toolFilter`
 *     （`tools.restrict()`），那属于部署级选择。
 *   - `knowledge` 面与全局 `knowledgeEnabled` 是**与**关系：总开关关掉时，父子会话
 *     都没有知识能力（见 config.mjs 的开关树）。
 *
 * ── 缓存视角（改默认值前先读）───────────────────────────────────────────────
 * 下面这组数字测于**初版全量降级**（连知识侧一起关）的子会话，作为上界参考：
 *
 *   子会话第一步请求：system prompt 13020 → 6925 字节；总 token 13748 → 10594（−23%）；
 *   缓存命中 11264 → 9728；**全价 token 2214 → 797**。
 *
 * 现在的默认策略会多注入 `<knowledge_tools>` 路由块（实测约 400 字节），其余不变；
 * 也就是说"关掉身份与记忆"省下的是那 6093 字节里的绝大部分，代价方向没有变：
 *
 * 原因：大额缓存命中来自请求**最前面的工具数组**（38 个 schema，位置没动），
 * 而被删掉的段字节**根本不再计价**（删掉的东西不会被"未命中"收费）；
 * 唯一失去父缓存的是 DSH 自己的尾部段（约 500–800 tokens，位置前移导致）。
 * 另外，若部署给子 agent 配了 `dsh-tool-subagent` 的 `persona` 或 `toolFilter`
 * （DSH 原生的两个子 agent 定制入口），子会话前缀本来就在**最前面**分叉。
 * 完整账与修正留痕见 docs/prompt-design.zh-CN.md §3.4。
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
 * 读侧能力面：这个会话能拿到哪些注入 / 资产。
 *
 * 顶层会话恒为全开；子会话默认只开 `knowledge`（见文件头的能力面表）。
 * `subagentInjectionEnabled` 只影响**子会话**，顶层会话不受它约束。
 *
 * @returns {{ subagent: boolean, inherit: boolean, identity: boolean, memory: boolean, skills: boolean, knowledge: boolean }}
 */
export function subagentReadPolicy(config, session) {
  const subagent = isSubagentSession(session)
  // 顶层会话：inherit 恒 true（该开关是"子会话是否继承"，不是全局开关）
  const inherit = subagent ? Boolean(config?.subagentInjectionEnabled) : true
  return {
    subagent,
    inherit,
    identity: inherit,
    memory: inherit,
    skills: inherit,
    // 知识侧：子会话默认也有（只受全局 knowledgeEnabled 约束，见 config.mjs）
    knowledge: true,
  }
}

/**
 * 「全量继承读侧」是否生效（= 身份 + 记忆，二者同源）。
 *
 * 保留它是为了给 `/tdai-status`、旧调用点与测试一个好读的布尔；**新代码请直接
 * 用 `subagentReadPolicy()` 的分面**，不要再拿这一个布尔去挡知识侧。
 */
export function readSideAllowed(config, session) {
  const policy = subagentReadPolicy(config, session)
  return policy.identity && policy.memory
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
