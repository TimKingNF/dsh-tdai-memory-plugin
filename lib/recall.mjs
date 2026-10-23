/**
 * 每轮注入（agent/pre-step waterfall）：L1 记忆召回 + 云端 skill 按需召回。
 *
 * ── 两段召回，一条消息 ──────────────────────────────────────────────────────
 *
 *   L1 记忆   （移植自 MemoryProxy tdai-l1-recall-injector.ts）
 *     1. 取本轮进入 step 的最后一条真人 user 消息，清洗后作 query
 *     2. 自有 + 借入（≤2）agent 并发 /v3/atomic/search
 *     3. 合并命中按 score 降序取 top recallLimit → `<tdai_recalled_l1_memories>`
 *
 *   云端 skill（2026-10 改版，替代原来的常驻目录）
 *     1. 取**最近几条真人消息**拼成滚动窗口作 query（截 SKILL_QUERY_CHARS）
 *     2. /v3/skill/search（FTS5：name + description + 正文，中文走 jieba 分词）
 *     3. 命中按分数过滤取前 N 条 → `<tdai_recalled_skills>`（名字 + **完整描述**，正文按需取）
 *
 * 两段都是"这一问的背景材料"，所以**共用一条 plugin 消息**（插在真人消息之后）：
 * 分开两条只会让客户端的折叠行变多，而它们本来就是同一件事的两半。
 *
 * 为什么要按需召回而不是常驻目录：常驻目录（`/v3/skill/listing` 的 top-20 全描述）
 * 本机实测 15,300 B 常驻 system，却只覆盖 77 个自有 skill 里的 20 个，且排序依据是
 * agent prompt、与当前这一轮说的话无关 —— 贵、不全、不准；而且它依赖的 query 有
 * 2048 字符上限，历史上因为没截断而永久 40001（见 client.mjs 的 searchSkills 注释）。
 * 按需召回：零命中零成本，命中时约 0.3–0.5 KB，直接跟着用户说的话走。
 *
 * ── 健壮性（作为 `agent/pre-step` 最外层守卫 { prepend: true }）───────────────
 *   - 先 await next() 落定整条链，再做事后召回；绝不在 next() 前 await HTTP
 *   - next() 抛异常 / 返回 undefined / 缺 messages 时统一兜底，绝不向链上
 *     再传播，避免其它不设防的 pre-step listener 读 `d.kind` 崩溃
 *   - 资产**不等待**（只读缓存 + 后台预热）：见 ctxsFor()，冷启动时退回自有 agent
 *   - 两段召回共用同一个硬超时（recallTimeoutMs），超时即放弃本轮注入，
 *     绝不让一步卡住
 *
 * 单用户静态身份场景不实现 ACL 过滤（proxy 的 acl/check 是给多用户借入场景用的）。
 */
import { randomUUID } from 'node:crypto'
import { cleanUserQuery, safeText } from './text.mjs'
import { renderRecalledL1, renderRecalledSkills } from './prompts.mjs'
import { subagentReadPolicy } from './subagent.mjs'
import { buildBotSkillQuery } from './dsbot.mjs'

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
 * 快照（`source.kind === 'runtime-context'`，dsh-agent-loop 的 `SOURCE`）、工具结果
 * （`source.kind === 'tool'`）。召回块
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

/** 这个会话里"真人发过的话"，新的在前（跳过宿主/插件注入的 user 消息）。 */
function humanUserTexts(messages, max) {
  const out = []
  if (!Array.isArray(messages)) return out
  for (let i = messages.length - 1; i >= 0 && out.length < max; i--) {
    const message = messages[i]
    if (message?.role !== 'user') continue
    const kind = message?.source?.kind
    if (kind !== undefined && kind !== 'user') continue
    const text = safeText(message.content)
    if (text) out.push(text)
  }
  return out
}

/** skill 召回 query 的字符上限与回看轮数（见 buildSkillQuery 注释）。 */
export const SKILL_QUERY_CHARS = 512
export const SKILL_QUERY_MESSAGES = 3

/**
 * 用"最近几条真人消息"拼 skill 检索 query。
 *
 * 为什么不是只取最后一条（那是 L1 召回的取法）：真实对话里大量轮次本身没有信息量 ——
 * "继续"、"按你说的做"、"这个报错怎么修"。单条 query 在这些轮次上必然零命中，
 * 而它们的**上下文**（前一两轮）往往是明确的。所以这里拼一个滚动窗口，新的在最前，
 * 拼接后统一截断到 SKILL_QUERY_CHARS（**截断天然偏向最新一条**）。
 *
 * 不做的事：不掺 agent prompt / 任务描述（那是旧 listing 路径的做法，会把 query 冲淡成
 * 7000 字符的宏观文本，正是"贵而不准"的来源）。
 */
export function buildSkillQuery(messages, { chars = SKILL_QUERY_CHARS, window = SKILL_QUERY_MESSAGES } = {}) {
  const texts = humanUserTexts(messages, window)
    .map((t) => cleanUserQuery(t))
    .filter(Boolean)
  if (texts.length === 0) return ''
  return texts.join(' ').trim().slice(0, chars)
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

/** 命中过滤：去重（同 skill_id 只留分数最高的一条）→ 分数闸门 → 条数上限。 */
export function pickSkillHits(items, { limit = 3, minScore = 0 } = {}) {
  const seen = new Set()
  const rows = []
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue
    const name = String(item.name ?? '').trim()
    if (!name) continue
    const key = String(item.skill_id ?? name)
    if (seen.has(key)) continue
    if (minScore > 0) {
      const score = Number(item.score)
      if (!Number.isFinite(score) || score < minScore) continue
    }
    seen.add(key)
    rows.push(item)
  }
  rows.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
  return rows.slice(0, Math.max(0, limit))
}

/**
 * 召回块自己的消息形态（`source` 声明 `form: 'notice'`）。
 *
 * 客户端把这条消息渲染成**一行折叠的"上下文注入"**（`ContextInjectionRow`），
 * 而不是塞进用户气泡 —— 这正是"前端只展示用户发的那句话"的实现方式。
 *
 * `summary` 是折叠行的那一行说明（`CONTEXT_SUMMARY_MAX_CHARS = 120`，宿主会截断，
 * 这里自己先截）。**只放条数与分数，不放正文**：折叠状态下不该泄露内容。
 *
 * ── source.kind：必须是"生产者自己的 kind"，不能用 `'plugin'` ─────────────────
 *
 * `'plugin'` 是 **v3 会话格式的万能包装**，v4 已废弃，而且入库时是**硬拒绝**：
 *
 *   - `dsh-session-format-v3-to-v4/lib/index.js:126` 的 `source()`：
 *     `... || value["kind"] === "plugin"` → 抛
 *     `format v4 message requires a producer-owned source kind`。
 *     真机表现（2026-09-25）：开关一开、发消息即
 *     `本轮运行失败 format v4 message requires a producer-owned source kind`。
 *     ⚠️ 注意：`dsh-session` 的 `assertMessageEventShape` 只要求 kind 是非空字符串，
 *     **拦不住** `'plugin'` —— 审计时只看了那一道校验，漏了这道，才让 bug 上到真机。
 *   - 同一包的 `producerKind(plugin, role)` 给出旧日志的规范映射：未知第三方插件 →
 *     `` `plugin:${plugin}` ``，并且 `rewritePluginSource` 会丢掉旧的 `plugin` 字段。
 *
 * 所以新消息直接用"迁移后本应得到"的同一个 kind —— 老会话（v3 迁移过来）与新消息的 kind
 * 一致，客户端渲染/分组不会出现两套。宿主自己注入 runtime context 用的也是生产者身份
 * （`dsh-agent-loop` 的 `SOURCE = "runtime-context"`）。
 */
export const SOURCE_KIND = `plugin:${PLUGIN_NAME}`

function topScore(rows) {
  let top
  for (const row of rows) {
    if (typeof row.score === 'number' && (top === undefined || row.score > top)) top = row.score
  }
  return top
}

function injectedNotice(blocks, { l1Count = 0, l1Top, skillCount = 0 }) {
  const parts = []
  if (l1Count > 0) parts.push(`TDAI L1 召回 ${l1Count} 条${l1Top === undefined ? '' : `（最高分 ${l1Top.toFixed(3)}）`}`)
  if (skillCount > 0) parts.push(`skill 命中 ${skillCount} 条`)
  const head = parts.join(' · ') || 'TDAI 上下文注入'
  return {
    id: randomUUID(),
    role: 'user',
    // ⚠️ content 必须是**块数组**：DSH 的消息契约恒为 ContentBlock[]
    //（dsh-llm/lib/types/message.d.ts:126）。写成裸字符串会在发请求时
    //（serializeMessages 里 content.filter）与持久化边界（assertMessageEventShape）
    // 同时炸掉 —— 早先的 prepend 实现踩过这个坑。
    content: [{ type: 'text', text: blocks.join('\n\n') }],
    // 不带 `plugin` 字段：那是 v3 的包装，v4 只认 kind（producerKind 映射时也会丢掉它）
    source: { kind: SOURCE_KIND, form: 'notice', summary: head.slice(0, 120) },
  }
}

/**
 * 本轮的召回上下文用哪些 agent 身份检索。
 *
 * **只读缓存，绝不等待**。历史上这里 `await assets.ensure()`，于是"第一步"被整包资产
 * 加载（meta 面 + 自有/借入 agent 的 L3/L2 + 知识资源，逐个 5s 超时）挡在模型请求之前；
 * 网关慢或某个端点一直失败时（失败不留缓存 → 每一步重试），表现就是"一开召回，
 * 发消息就一直阻塞等待"。现在：
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
  //
  // 同一个会话里"上一次注入过哪些 skill"：命中集与它完全相同就跳过注入，
  // 避免同一个块在历史里反复堆积。按 session 记，session/disposed 时清理
  //（清理监听器注册在 pre-step **之后**：本 handler 必须保持"第一个注册"，
  //  单测夹具按注册顺序取它当最外层守卫）。
  const lastSkillSignature = new Map()

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

    // 先让 ds-bot 索引到位再算策略（Bot / 房间 / 群成员隐藏会话的判定依赖 state.json）。
    // 索引是 apply 时异步预热的，首个回合可能赶在它前面；refresh 自带 5 秒 mtime 缓存，
    // 幂等且只做本地 stat/读。读侧关着时不必为它读盘。
    if (runtime.readEnabled()) {
      try { await runtime.dsbotReady?.() } catch {}
    }
    const cfg = runtime.config
    // 策略单一计算点：index.mjs 已换成 DsbotIndex.sessionPolicy（普通会话是
    // subagentReadPolicy 的超集，四个能力面取值不变）；老夹具没有该钩子时退回原函数。
    //   记忆面关（默认就是子 agent 会话）→ 不召回 L1；
    //   skill 面关 → 不召回云端 skill。两段都不做时连预热都不必。
    const policy = runtime.readPolicyFor?.(payload.agent?.session)
      ?? subagentReadPolicy(cfg, payload.agent?.session)
    const wantL1 = policy.memory && cfg.recallEnabled
    // skill 面走**有效值**：Bot 会话还要 AND 识别总闸与 botSkillInjectEnabled
    // （见 lib/dsbot.mjs 的 sessionPolicy）。老夹具没有 skillInject 时退回四 facet 口径。
    const wantSkills = policy.skillInject ?? (policy.skills && cfg.skillsEnabled)

    // 3) 读侧关闭 / 两段都关 / 非 enter：原样透传（守卫职责到此为止）。
    if (!runtime.readEnabled() || (!wantL1 && !wantSkills)) return decision
    if (decision.kind !== 'enter') return decision

    const sessionId = payload.agent?.session?.id
    if (!sessionId) return decision
    // 本轮已被取消（abort/steer 打断）：不做网络检索，也不注入。
    if (payload.signal?.aborted) return decision

    const l1Query = wantL1 ? cleanUserQuery(lastUserText(payload.messages)) : ''
    // Bot 会话的 query 不能用普通口径：会话里没有"真人最近几条"，每轮进来的是
    // ds-bot 的 relay 包，`buildSkillQuery([relay])` 实测返回空串（skill 召回形同关闭）。
    // buildBotSkillQuery 取最后一条 kind='bot' 消息并剥信封 / 抽群聊本轮正文。
    const skillQuery = wantSkills
      ? (policy.bot ? buildBotSkillQuery(payload.messages) : buildSkillQuery(payload.messages))
      : ''
    // Bot 会话的可观测性：这两行是"到底有没有尝试召回"的唯一现场证据。
    // 之前查一次真实会话只能靠 core 的 `/v3/skill/search` 请求时间去猜，太费劲。
    if (policy.bot && wantSkills && !skillQuery) {
      runtime.log('[dsbot] skill 召回跳过：query 为空（messages 里没有可用的 user/bot 消息）')
    }
    if (!l1Query && !skillQuery) return decision

    // 4) 资产只读缓存 + 后台预热：**不 await**（见 ctxsFor 注释）。
    if (wantL1) {
      try { runtime.assets.warm?.(sessionId, policy) } catch {}
    }
    const ctxs = ctxsFor(runtime.assets.peek(sessionId), cfg)

    // 5) 检索必须有硬超时：否则网关不响应时，这一步会一直挂着（"发消息一直阻塞等待"）。
    //    超时/失败都 fail-open —— 少一次召回，不影响本轮回答。
    const timeoutMs = Number(cfg.recallTimeoutMs) > 0 ? Number(cfg.recallTimeoutMs) : 3000

    try {
      // 超时信号与宿主本轮的取消信号取交集；任一失效即放弃本轮召回（safe() 记为失败）。
      const signal = payload.signal
        ? AbortSignal.any([payload.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs)

      const [groups, skillItems] = await Promise.all([
        // L1：自有 + 借入（≤2）agent 并发检索
        wantL1
          ? Promise.all(ctxs.map(async (c) => {
            const items = await runtime.client.searchL1(c, l1Query, {
              sessionId,
              taskId: cfg.taskId,
              limit: cfg.recallLimit,
              signal,
            })
            return items.map((m) => ({ ...m, fromAgentId: c.agentId, fromAgentName: c.agentName }))
          }))
          : Promise.resolve([]),
        // skill：跨 agent 共享库检索（自有 skill 也在检索池里，见 core 的 search 实现）。
        // **单独 catch**：两段召回各自 fail-open —— skill 检索炸了不该把同一条消息里的
        // L1 块一起带走（client 内部已 fail-open，这里是防御性兜底，也覆盖测试替身）。
        wantSkills
          ? runtime.client.searchSkills(
            { team_id: cfg.teamId, agent_id: cfg.agentId, user_id: cfg.userId },
            skillQuery,
            cfg.skillRecallLimit,
            signal,
          ).catch((error) => {
            runtime.log(`skill recall failed: ${error?.message ?? error}`)
            return null
          })
          : Promise.resolve(null),
      ])

      const merged = groups
        .flat()
        .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity))
        .slice(0, cfg.recallLimit)
      const l1Block = merged.length > 0 ? budgetedRecalledL1(merged, cfg.agentId) : ''

      const hits = pickSkillHits(skillItems?.items ?? skillItems?.hits ?? [], {
        limit: cfg.skillRecallLimit,
        minScore: Number(cfg.skillRecallMinScore) || 0,
      })
      // 与上一次注入完全相同（同会话）→ 跳过：历史里已有的块不必再来一遍。
      // 只比"上一次注入"，不同则照常注入，所以集合变化时会立即重新给。
      const signature = hits.map((h) => String(h.skill_id ?? h.name)).join('|')
      const duplicated = signature !== '' && lastSkillSignature.get(sessionId) === signature
      const skillBlock = hits.length > 0 && !duplicated ? renderRecalledSkills(hits) : ''
      if (signature && !duplicated) lastSkillSignature.set(sessionId, signature)

      if (policy.bot) {
        runtime.log(`[dsbot] skill 召回：query=${skillQuery.length} 字符 / 命中=${hits.length}`
          + ` / 注入=${skillBlock ? 'yes' : 'no'}${duplicated ? '（与上轮相同，跳过）' : ''}`)
      }

      const blocks = [l1Block, skillBlock].filter(Boolean)
      if (blocks.length === 0) return decision

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
      messages.splice(index >= 0 ? index + 1 : messages.length, 0, injectedNotice(blocks, {
        // 条数按**真正注入的块**算：预算可能把记忆全丢掉（l1Block 为空），
        // 那时摘要不该还报"L1 召回 N 条"。
        l1Count: l1Block ? merged.length : 0,
        l1Top: l1Block ? topScore(merged) : undefined,
        skillCount: skillBlock ? hits.length : 0,
      }))
      // ⚠️ **必须 spread decision**，不能新建 `{ kind: 'enter', messages }`。
      // 0.1.7-rc.1 的 `PreStepDecision.enter` 除 messages 外还有可选 `startsRequestSeries`
      // （"在本步准入的消息之前开一段新的 model 消息序列"），未来还可能再加字段。
      // 官方 practices 明确要求不拥有决策的 waterfall listener 用 `{ ...decision, messages }`
      // 改消息，否则会把内层 listener 设的字段静默吞掉。
      return { ...decision, messages }
    } catch (error) {
      runtime.log(`recall failed: ${error?.message ?? error}`)
      return decision
    }
  }, { prepend: true })

  // 会话结束：清掉 skill 去重记录，避免长跑进程里 Map 无限增长。
  ctx.on?.('session/disposed', (session) => {
    const id = session?.id
    if (id) lastSkillSignature.delete(id)
  })
}
