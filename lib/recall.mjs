/**
 * L1 召回（agent/pre-step waterfall）。
 *
 * 移植自 MemoryProxy tdai-l1-recall-injector.ts：
 *   1. 取本轮进入 step 的最后一条 user 消息，清洗后作 query
 *   2. 自有 + 借入（≤2）agent 并发 /v3/atomic/search
 *   3. 合并命中按 score 降序取 top recallLimit
 *   4. 渲染 <tdai_recalled_l1_memories>，作为一条**独立**的 plugin 消息插在
 *      本轮真人消息之后随本 step 进入
 *
 * 健壮性（作为 `agent/pre-step` 最外层守卫 { prepend: true }）：
 *   - 先 await next() 落定整条链，再做事后召回；绝不在 next() 前 await HTTP
 *   - next() 抛异常 / 返回 undefined / 缺 messages 时统一兜底，绝不向链上
 *     再传播，避免其它不设防的 pre-step listener 读 `d.kind` 崩溃
 *   - 资产**不等待**（只读缓存 + 后台预热）：见 ctxsFor()，冷启动时退回自有 agent
 *   - 召回检索有硬超时（recallTimeoutMs），超时即放弃本轮召回，绝不让一步卡住
 *
 * 单用户静态身份场景不实现 ACL 过滤（proxy 的 acl/check 是给多用户借入场景用的）。
 */
import { randomUUID } from 'node:crypto'
import { cleanUserQuery, safeText } from './text.mjs'
import { renderRecalledL1 } from './prompts.mjs'
import { readSideAllowed } from './subagent.mjs'

const PLUGIN_NAME = 'dsh-tdai-memory-plugin'

function lastUserText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = safeText(messages[i]?.content)
    if (text) return text
  }
  return ''
}

/**
 * 找到本轮"真人发的那条" user 消息。
 *
 * `decision.messages` 里排在最后的 user 消息往往是宿主自己注入的 —— runtime context
 * 快照（`source.kind === 'plugin'`）、工具结果（`source.kind === 'tool'`）。召回块
 * 要挂在**真人那条**之后，不能挂到这些消息后面：挂到快照后面会插进宿主的
 * "状态快照 → 本轮提问" 之间，挂到工具结果后面会插进 tool_call ↔ tool_result 的配对里。
 * 缺 `source` 的老格式/测试夹具按真人消息处理（`kind === undefined`）。
 */
function findUserMessageIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== 'user') continue
    const kind = message?.source?.kind
    if (kind === undefined || kind === 'user') return i
  }
  return -1
}

/**
 * 召回块的字符预算。
 *
 * 条数上限（`recallLimit`）只约束"几条"，不约束"多长" —— 单条记忆可能很长，
 * 5 条加起来仍可能吃掉大块上下文。这里再加一道字符闸门：超出预算时**按分数从低到高
 * 逐条丢弃**（merged 已按 score 降序），先保证最有价值的几条进得去。
 */
const RECALL_BUDGET_CHARS = 4000

function budgetedRecalledL1(merged, selfAgentId) {
  let kept = merged
  while (kept.length > 0 && renderRecalledL1(kept, selfAgentId).length > RECALL_BUDGET_CHARS) {
    kept = kept.slice(0, -1)
  }
  if (kept.length === 0) return ''
  return renderRecalledL1(kept, selfAgentId)
}

/**
 * 召回块自己的消息形态（`source` 声明 `form: 'notice'`）。
 *
 * 客户端把这条消息渲染成**一行折叠的"上下文注入"**（`ContextInjectionRow`，
 * 见 dsh-client-ui-chat/lib/client.js 的 contextProvenance/contextBody），
 * 而不是塞进用户气泡 —— 这正是"前端只展示用户发的那句话"的实现方式。
 *
 * `summary` 是折叠行的那一行说明（`CONTEXT_SUMMARY_MAX_CHARS = 120`，宿主会截断，
 * 这里自己先截）。**只放条数与分数，不放记忆正文**：折叠状态下不该泄露内容。
 */
function recalledNotice(block, merged) {
  let top
  for (const memory of merged) {
    if (typeof memory.score === 'number' && (top === undefined || memory.score > top)) top = memory.score
  }
  const head = `TDAI L1 召回 ${merged.length} 条`
  const summary = top === undefined ? head : `${head}（最高分 ${top.toFixed(3)}）`
  return {
    id: randomUUID(),
    role: 'user',
    // ⚠️ content 必须是**块数组**：DSH 的消息契约恒为 ContentBlock[]
    //（dsh-llm/lib/types/message.d.ts:126）。写成裸字符串会在发请求时
    //（serializeMessages 里 content.filter）与持久化边界（assertMessageEventShape）
    // 同时炸掉 —— 早先的 prepend 实现踩过这个坑。
    content: [{ type: 'text', text: block }],
    source: { kind: 'plugin', plugin: PLUGIN_NAME, form: 'notice', summary: summary.slice(0, 120) },
  }
}

/**
 * 本轮的召回上下文用哪些 agent 身份检索。
 *
 * **只读缓存，绝不等待**。历史上这里 `await assets.ensure()`，于是"第一步"被整包资产
 * 加载（meta 面 + 自有/借入 agent 的 L3/L2 + skill listing + 知识资源，逐个 5s 超时）
 * 挡在模型请求之前；网关慢或某个端点一直失败时（失败不留缓存 → 每一步重试），
 * 表现就是"一开召回，发消息就一直阻塞等待"。现在：
 *   - 缓存已就绪 → 用它（含借入 agent）；
 *   - 缓存没就绪 → 立刻退回**自有 agent** 先检索，同时后台预热（warm），
 *     下一轮自然就有借入 agent 了。首轮 L1 少几个借入来源，好过整轮卡住。
 */
function ctxsFor(asset, cfg) {
  if (asset?.ctxs?.length) return asset.ctxs
  return [{
    teamId: cfg.teamId,
    userId: cfg.userId,
    agentId: cfg.agentId,
    agentName: cfg.agentId,
    isSelf: true,
  }]
}

export function wireRecall(ctx, runtime) {
  // prepend:true 让本 handler 成为 `agent/pre-step` waterfall 的**最外层守卫**。
  //
  // 背景：DSH 内置（dsh-plan-mode / dsh-tool-cordis / dsh-time-context 等）及
  // 第三方插件（modlens / agent-teams 等）的 pre-step listener 普遍写成
  // `const d = await next(); if (d.kind === ...)`，**不防御 next() 返回 undefined**。
  // 一旦链上某个更内层的 listener 返回 undefined（首轮时序竞态、插件边界 bug），
  // 这些外层 listener 读 `d.kind` 就抛出
  // "Cannot read properties of undefined (reading 'kind')"，整轮直接 error。
  //
  // 我们插件「fail-open、不阻断 DSH」的承诺要求它站在链最外层：用 try/catch +
  // undefined 兜底吸收整条链的任何异常/undefined，保证 waterfall 永远返回一个
  // 合法的 decision，从而不再把错误甩给其它默认不设防的 handler。
  ctx.on('agent/pre-step', async (payload, next) => {
    // 1) 先落定整条链，同时兜住内层抛出的异常与返回的 undefined。
    let decision
    try {
      decision = await next()
    } catch (error) {
      runtime.log(`pre-step chain threw: ${error?.message ?? error}`)
      decision = { kind: 'enter', messages: Array.isArray(payload.messages) ? payload.messages : [] }
    }

    // 2) 防御：链上任何一环返回 undefined / 非对象都不崩溃、不向链上再传播。
    if (!decision || typeof decision !== 'object') {
      decision = { kind: 'enter', messages: Array.isArray(payload.messages) ? payload.messages : [] }
    }
    // 兜底后的 decision 仍可能缺 messages（例如 reject）；后续统一按 enter 处理。
    if (decision.kind === 'enter' && !Array.isArray(decision.messages)) {
      decision = { ...decision, messages: Array.isArray(payload.messages) ? payload.messages : [] }
    }

    // 3) 读侧关闭 / 召回关闭 / 非 enter：原样透传（守卫职责到此为止）。
    if (!runtime.readEnabled() || !runtime.config.recallEnabled) return decision
    if (decision.kind !== 'enter') return decision

    // 3b) 子 agent 会话按策略降级：不召回、不预热资产（见 lib/subagent.mjs）。
    //     放在这里而不是最前面：守卫（吸收内层异常与 undefined）是**无条件**职责，
    //     降级只影响"要不要检索注入"。
    if (!readSideAllowed(runtime.config, payload.agent?.session)) return decision

    const sessionId = payload.agent?.session?.id
    if (!sessionId) return decision
    // 本轮已被取消（abort/steer 打断）：不做网络检索，也不注入。
    if (payload.signal?.aborted) return decision
    const query = cleanUserQuery(lastUserText(payload.messages))
    if (!query) return decision

    // 4) 资产只读缓存 + 后台预热：**不 await**（见 ctxsFor 注释）。
    try { runtime.assets.warm?.(sessionId) } catch {}
    const ctxs = ctxsFor(runtime.assets.peek(sessionId), runtime.config)

    // 5) 检索必须有硬超时：否则网关不响应时，这一步会一直挂着（"发消息一直阻塞等待"）。
    //    超时/失败都 fail-open —— 少一次召回，不影响本轮回答。
    const timeoutMs = Number(runtime.config.recallTimeoutMs) > 0 ? Number(runtime.config.recallTimeoutMs) : 3000

    try {
      // 超时信号与宿主本轮的取消信号取交集；任一失效即放弃本轮召回（safe() 记为失败）。
      const signal = payload.signal
        ? AbortSignal.any([payload.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs)
      const groups = await Promise.all(ctxs.map(async (c) => {
        const items = await runtime.client.searchL1(c, query, {
          sessionId,
          taskId: runtime.config.taskId,
          limit: runtime.config.recallLimit,
          signal,
        })
        return items.map((m) => ({ ...m, fromAgentId: c.agentId, fromAgentName: c.agentName }))
      }))
      const merged = groups
        .flat()
        .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity))
        .slice(0, runtime.config.recallLimit)
      if (merged.length === 0) return decision
      const block = budgetedRecalledL1(merged, runtime.config.agentId)
      if (!block) return decision

      // ── 注入形态：**独立**一条 plugin 消息，插在本轮真人消息之后 ──────────────
      //
      // 为什么不再 prepend 进用户消息（历史实现，见 docs/prompt-injection-redesign.md §5.3）：
      //   宿主会把 decision.messages **原样持久化**（dsh-agent-loop/lib/index.js:557
      //   `session.append("user/message", message, { surfaceOp: "append" })`）。prepend 之后，
      //   用户那条消息的**正文里就永久带着召回块**，于是：
      //     1. 前端把整段当用户发言回显（用户看到的"回显里混着召回内容"就是这么来的）；
      //     2. 回写 L0 时只能靠文本哨兵把块剪掉（source 仍是 `user`，结构上认不出），
      //        用户的原文一旦被 safeText 截断就会漏；
      //     3. 任何按 `source.kind === 'user'` 判"真人发言"的宿主/插件都会把它当用户输入。
      //   独立消息把这三件事一次解决：正文干净、capture 按 `source.kind !== 'user'`
      //   整条丢弃、宿主所有"真人发言"判据都自动忽略它。
      //
      // 位置：紧跟真人消息之后（与 dsh-session-reference 的 additionalContext 一致），
      // 而不是追加到最末尾 —— 召回块是这一问的背景材料，贴着问题读最不容易串味。
      const messages = [...decision.messages]
      // messages 为空说明本轮没有进入任何消息（宿主要靠 `length === 0` 判定轮次结束，
      // dsh-agent-loop/lib/index.js:551）。此时绝不能塞东西进去，否则轮次永远不结束。
      if (messages.length === 0) return decision
      const index = findUserMessageIndex(messages)
      messages.splice(index >= 0 ? index + 1 : messages.length, 0, recalledNotice(block, merged))
      return { kind: 'enter', messages }
    } catch (error) {
      runtime.log(`recall failed: ${error?.message ?? error}`)
      return decision
    }
  }, { prepend: true })
}
