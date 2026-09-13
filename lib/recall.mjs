/**
 * L1 召回（agent/pre-step waterfall）。
 *
 * 移植自 MemoryProxy tdai-l1-recall-injector.ts：
 *   1. 取本轮进入 step 的最后一条 user 消息，清洗后作 query
 *   2. 自有 + 借入（≤2）agent 并发 /v3/atomic/search
 *   3. 合并命中按 score 降序取 top recallLimit
 *   4. 渲染 <tdai_recalled_l1_memories> 作为额外 user 消息随本 step 进入
 *
 * 健壮性（作为 `agent/pre-step` 最外层守卫 { prepend: true }）：
 *   - 先 await next() 落定整条链，再做事后召回；绝不在 next() 前 await HTTP
 *   - next() 抛异常 / 返回 undefined / 缺 messages 时统一兜底，绝不向链上
 *     再传播，避免其它不设防的 pre-step listener 读 `d.kind` 崩溃
 *   - 资产懒加载放在 next() 之后；L2/L3/Skill 首轮注入已由
 *     `system-prompt/assemble` 兜底（见 sections.mjs），此处只做 L1 缓存兜底
 *
 * 单用户静态身份场景不实现 ACL 过滤（proxy 的 acl/check 是给多用户借入场景用的）。
 */
import { cleanUserQuery, safeText } from './text.mjs'
import { renderRecalledL1 } from './prompts.mjs'

function lastUserText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = safeText(messages[i]?.content)
    if (text) return text
  }
  return ''
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

    const sessionId = payload.agent?.session?.id
    if (!sessionId) return decision
    const query = cleanUserQuery(lastUserText(payload.messages))
    if (!query) return decision

    // 4) 资产懒加载兜底（失败不阻塞）。
    if (runtime.config.injectionEnabled || runtime.config.recallEnabled) {
      try { await runtime.assets.ensure(sessionId) } catch {}
    }

    const asset = runtime.assets.peek(sessionId)
    const ctxs = asset?.ctxs?.length
      ? asset.ctxs
      : [{ teamId: runtime.config.teamId, userId: runtime.config.userId, agentId: runtime.config.agentId, agentName: runtime.config.agentId, isSelf: true }]

    try {
      const groups = await Promise.all(ctxs.map(async (c) => {
        const items = await runtime.client.searchL1(c, query, {
          sessionId,
          taskId: runtime.config.taskId,
          limit: runtime.config.recallLimit,
        })
        return items.map((m) => ({ ...m, fromAgentId: c.agentId, fromAgentName: c.agentName }))
      }))
      const merged = groups
        .flat()
        .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity))
        .slice(0, runtime.config.recallLimit)
      if (merged.length === 0) return decision
      return {
        kind: 'enter',
        messages: [...decision.messages, { role: 'user', content: renderRecalledL1(merged, runtime.config.agentId) }],
      }
    } catch (error) {
      runtime.log(`recall failed: ${error.message}`)
      return decision
    }
  }, { prepend: true })
}
