/**
 * 对话回流（写侧）。
 *
 * 两条路径，按会话类型分流（判定见 lib/dsbot.mjs，策略只在 `sessionPolicy()` 里算）：
 *
 *  1. **普通会话**：维持原逻辑 —— 每轮真人对话结束时把切片旁路写回 MemoryCore。
 *     - 消息分片：单条 >8192 code units 切分（surrogate 安全），100 条/批
 *     - 过滤插件自己注入的块，避免回流污染记忆
 *     - 归一化成两种投影（见 lib/normalize.mjs）：skill 端点收 5-role，L0 端点只收
 *       user/assistant；内部思考（reasoning）与图片一律丢弃
 *     - 双写 L0 + Skill 归档
 *
 *  2. **ds-bot 会话（bot 私聊 / room 群聊）**：按**人锚点写回合**（方案
 *     docs/proposals/ds-bot-tdai-integration/minimal.md §3.2）。relay、注入块、工具调用、
 *     纯 Bot 互投轮一条不写；群成员隐藏会话永不写。
 *
 * ── 为什么普通会话那套不能直接用在 Bot 会话上 ──────────────────────────────
 *
 * 1. **钩子只有一条**：`agent/turn-stopping` 在成功路径派发、且在 `turn/end` 之前
 *    （`dsh-agent-loop/lib/index.js:997-1004`）；异常轮走 `catch → turn/end` 不经过它。
 *    实测 269 轮里失败轮 4/269 ≈ 1.5%，这些轮的人话按老逻辑会被整轮丢弃。
 * 2. **真人消息不带 turn**：22/22 的 `user/message` 里 `data.turn === undefined`，
 *    只能按 `currentTurn` 归属。
 * 3. **群聊房间会话没有终稿**：实测 129/129 个 completed 轮的收尾步没有文本
 *    （每轮都是一次 `group_relay` 工具调用）——群聊只能自蒸前文摘要。
 * 4. **锚点可能晚于轮末进 log**：13 条里 3 条晚 22–23 秒，所以定位失败不是异常，
 *    要挂 pending 重试（两阶段），超限才放弃。
 *
 * ── 写侧底线：宁可少写，不写错 ────────────────────────────────────────────
 *
 * 蒸馏超时、报错、空输出、窗口不可用、锚点始终定位不到 —— 一律**只写人话**，并记一条
 * typed skip。任何情况下都不写「兜底原文」：那是 Bot 的措辞，进 L0 只会被后台抽取
 * 当成"用户的证据"。
 *
 * ── 台账是去重的唯一依据 ──────────────────────────────────────────────────
 *
 * L0 写入只有 `role / content / timestamp`，Core 不返回客户端记录 id，也没有 actor 字段。
 * 所以：
 *   - 私聊幂等位 `(botId, lastMessageId)`；
 *   - 群聊断点 `(roomId, humanSeq)` + `contentHash` + 阶段机 `summary/human`；
 *   - 崩溃恢复：`stage.anchor` 留着上一条锚点原文，`summary=written` 时只补人话。
 *
 * 状态全在 lib/dsbot-ledger.mjs 里，本文件不做任何自己的持久化。
 */

import { safeText, stripInjectedBlocks, chunkConversationMessages, CONVERSATION_BATCH_SIZE } from './text.mjs'
import {
  dropNoiseParts,
  normalizeAssistantContent,
  normalizeToolResult,
  toL0Records,
  toSkillMessages,
} from './normalize.mjs'
import { captureAllowed } from './subagent.mjs'
import { ANCHOR_RETRY_LIMIT, ANCHOR_RETRY_WINDOW_MS, parseModelRef, shortHash, stripUiFences } from './dsbot.mjs'
import { buildWindow, distillRoom, expandAnchorLine, readMemoryEntries, renderSummaryBlock } from './dsbot-context.mjs'

/**
 * 插件自己注入的上下文标记。
 *
 * 注意：真正生效的剔除逻辑在 `stripInjectedBlocks()`（lib/text.mjs）—— 它按**块**
 * 剥离，而不是按"消息里出现过某个标记就整条丢弃"。这里保留清单是为了：
 *   1. 文档化本插件会往对话里放哪些块；
 *   2. `test/capture-filter.test.mjs` 用例 6 据此**反向断言**：清单里的每个标记
 *      都必须能被 `stripInjectedBlocks()` 剥掉（清单与实现脱节就会红）。
 */
export const INJECTED_MARKERS = [
  '<tdai_recalled_l1_memories>',
  '<tdai_recalled_skills>',
  '[TencentDB historical context]',
  '<tdai_profile_memory>',
  '<memory-tools-guide>',
  '<session_context>',
]

/** 单轮最多缓存多少条条目（条目比消息细：一次 tool-call 就是一条）。 */
const MAX_ENTRIES_PER_TURN = 200

/** L0 单条内容上限（schema 是 8192，留 192 的余量给后续拼接/后缀）。 */
const RECORD_MAX_CHARS = 8000

/** 卡片归一化后的上限（方案 §3.2：1,200 字符）。 */
const CARD_MAX_CHARS = 1200

/**
 * 事件体在事件里的位置因事件类型而异（以真实会话日志为准）：
 *
 *   user/message      → { content, source, role, id }（旧格式把 content 直接放在 data 上）
 *   assistant/message → { turn, step, message:{ role, content, source } }
 *   tool/result       → { turn, step, message:{ source:{kind:'tool',callId}, content:[{type:'tool-result'}] } }
 *
 * `source` 跟着消息体走，所以判定 source 时必须先定位到消息体，而不是只看 data 顶层。
 */
function messageBody(data) {
  const inner = data?.message
  return inner && typeof inner === 'object' ? inner : (data ?? {})
}

/** 取消息的 source.kind（见上：source 挂在消息体上）。 */
function sourceKindOf(body) {
  const kind = body?.source?.kind
  return typeof kind === 'string' ? kind : undefined
}

/** 真人发言：剥掉注入块后仍非空才回流。 */
function userEntry(text, recordKey) {
  const content = stripInjectedBlocks(text)
  if (!content) return []
  return [{ role: 'user', content, recordKey }]
}

/** 只取 text 块（reasoning / 工具块一律不进终稿）。 */
function textBlocks(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim()
}

function clamp(text, max) {
  const value = String(text ?? '')
  return value.length > max ? value.slice(0, max) : value
}

/** 事件时间（ms）→ Core 要的 ISO 字符串（`conversationItemSchema.timestamp` 是 `z.iso.datetime()`）。 */
function isoTime(ms) {
  const value = Number.isFinite(ms) ? ms : Date.now()
  try {
    return new Date(value).toISOString()
  } catch {
    return new Date().toISOString()
  }
}

/**
 * 卡片答案归一化：`user-question-reply` 的 content 是一段 JSON
 * （`{ kind:'answer_to_pending_question', questions:[{question,detail,options}], answers:[{selected,custom}] }`，
 * 见 ds-bot `src/host/parts.js` 的 `questionReply()`）。
 *
 * 为什么要解包：不解包它就是一段 JSON 噪音；解包后一问一答自带上下文，
 * 离开卡片也能读懂（这是真人明确做出的选择，属于最该写进记忆的那类）。
 */
export function formatCardReply(raw, max = CARD_MAX_CHARS) {
  const text = String(raw ?? '').trim()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return clamp(`[卡片] ${text}`, max)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return clamp(`[卡片] ${text}`, max)

  const questions = Array.isArray(parsed.questions) ? parsed.questions : []
  const answers = Array.isArray(parsed.answers) ? parsed.answers : []
  const lines = []
  questions.forEach((question, index) => {
    const answer = answers[index] ?? answers[0] ?? {}
    const title = String(question?.question ?? question?.title ?? '').trim()
    const options = (Array.isArray(question?.options) ? question.options : [])
      .map((option) => (typeof option === 'string' ? option : option?.label))
      .filter((label) => typeof label === 'string' && label.trim())
    lines.push(`[卡片] 问：${title || '（未提供问题）'}`)
    if (options.length > 0) lines.push(`可选：${options.join(' / ')}`)
    const picked = (Array.isArray(answer?.selected) ? answer.selected : [])
      .filter((item) => typeof item === 'string' && item.trim())
    const custom = typeof answer?.custom === 'string' ? answer.custom.trim() : ''
    const given = [...picked, ...(custom ? [custom] : [])].join('、')
    lines.push(`答：${given || '（未作答）'}`)
  })
  if (lines.length === 0) return clamp(`[卡片] ${text}`, max)
  return clamp(lines.join('\n'), max)
}

export function wireCapture(ctx, runtime) {
  const pending = new Map()
  const turns = new Map()
  const currentTurn = new Map()
  const currentStep = new Map()
  const toolNames = new Map()
  /** ds-bot 会话专用缓冲：sessionId → turn → { human, maxStep, final }。 */
  const botTurns = new Map()
  const warned = new Set()
  /** 真人发言的递增序号，保证同 turn 内多条真人发言各自成条。 */
  let userRecords = 0

  const log = (message) => {
    try {
      runtime.log?.(message)
    } catch {}
  }
  const cfg = () => runtime.config ?? {}
  const dsbot = () => runtime.dsbot
  const ledger = () => runtime.ledger
  /**
   * 会话四态。**总闸关掉时一律按 ordinary**：那不只是读侧策略的事 —— 事件缓冲也要
   * 走普通路径，否则 `turns` 里没有条目，回写会静默变成 0 条（"关掉总闸"必须逐字节
   * 回到改动前，不是"少写一点"）。
   */
  const lookup = (sessionId) => {
    if (cfg().dsbotAwarenessEnabled === false) return { kind: 'ordinary' }
    return dsbot()?.lookup?.(sessionId) ?? { kind: 'ordinary' }
  }
  const isBotKind = (kind) => kind === 'bot' || kind === 'room'

  /**
   * 索引就绪保护。
   *
   * 索引是异步加载的，而 `session/event` 是同步派发：加载完成前，Bot 会话会被当成
   * 普通会话 —— 那意味着**全量回流**（最坏的一种污染）。两道防线：
   *   1. 接线时先踢一脚 `refresh()`（fire-and-forget，不阻塞插件加载）；
   *   2. `turn-stopping` 里若发现索引一次都没成功加载（`sessions === 0`），补一次。
   */
  const ensureIndex = async () => {
    const index = dsbot()
    if (!index || typeof index.refresh !== 'function') return
    // 每轮一次 `refresh()`：5 秒 mtime 缓存自带，多数轮次只做一次内存判断；
    // 缓存过期才 stat + 重读。这样 Bot 换会话（rollover 后旧 id 消失）能在下一轮
    // 被看见，走 signal → 停写 + 告警，而不是继续按旧索引写。
    try {
      await index.refresh()
    } catch (error) {
      log(`[dsbot] 索引加载失败：${error?.message ?? error}`)
    }
  }
  void ensureIndex()

  const dropTurn = (sessionId, turn) => {
    const byTurn = turns.get(sessionId)
    const dropped = byTurn?.get(turn)?.length ?? 0
    byTurn?.delete(turn)
    return dropped
  }

  // ── ds-bot 缓冲 ────────────────────────────────────────────────────────────

  const botTurn = (sessionId, turn) => {
    let byTurn = botTurns.get(sessionId)
    if (!byTurn) {
      byTurn = new Map()
      botTurns.set(sessionId, byTurn)
    }
    let buf = byTurn.get(turn)
    if (!buf) {
      buf = { human: [], maxStep: -1, final: null }
      byTurn.set(turn, buf)
    }
    return buf
  }

  /** 取走整轮缓冲（`turn-stopping` / 失败轮两处共用，取完即清）。 */
  const takeBotTurn = (sessionId, turn) => {
    const byTurn = botTurns.get(sessionId)
    const buf = byTurn?.get(turn)
    byTurn?.delete(turn)
    return buf
  }

  /**
   * 缓冲一条事件到 ds-bot 轮次。
   *
   * 只缓冲两样东西：**人锚点**（`kind ∈ {user, user-question-reply}`）与本轮
   * **最高 step 的 text 块**。工具调用、reasoning、relay 一律不进缓冲 —— 它们在
   * 写侧本来就要丢，早丢早省内存。
   */
  const bufferBotEvent = (sessionId, event) => {
    const data = event?.data ?? {}
    const turn = data.turn ?? currentTurn.get(sessionId) ?? 0
    const body = messageBody(data)
    const time = Number.isFinite(event?.time)
      ? event.time
      : (Number.isFinite(data.time) ? data.time : Date.now())

    if (event?.type === 'user/message') {
      const kind = sourceKindOf(body)
      if (kind !== 'user' && kind !== 'user-question-reply') return
      const raw = safeText(dropNoiseParts(body.content ?? data.content ?? ''))
      if (!raw) return
      botTurn(sessionId, turn).human.push({
        text: raw,
        card: kind === 'user-question-reply',
        time,
        id: String(data.id ?? body.id ?? ''),
      })
      return
    }

    if (event?.type === 'assistant/message') {
      const step = Number.isFinite(data.step) ? data.step : (currentStep.get(sessionId) ?? 0)
      const text = textBlocks(body.content)
      const buf = botTurn(sessionId, turn)
      if (step > buf.maxStep) {
        buf.maxStep = step
        buf.final = null
      }
      if (!text || step < buf.maxStep) return
      // 同一步里多段 assistant 文本按出现顺序拼接（多段分别来自不同 message）。
      buf.final = buf.final && buf.final.step === step
        ? { step, text: `${buf.final.text}\n${text}`, time, id: String(body.id ?? data.id ?? '') }
        : { step, text, time, id: String(body.id ?? data.id ?? '') }
    }
  }

  // ── 写 L0 ──────────────────────────────────────────────────────────────────

  /**
   * 写一批 L0 记录。顺序即数组顺序（Core 的 `v2-router.ts` 按数组批量插入、不排序），
   * 每条都带 ISO `timestamp`，所以"摘要先于人话"这件事由我们控制，不受服务端影响。
   */
  const writeL0 = async (identity, items) => {
    const messages = items
      .map((item) => ({
        role: item.role === 'user' ? 'user' : 'assistant',
        content: clamp(item.content, RECORD_MAX_CHARS),
        time: item.time,
      }))
      .filter((item) => item.content.trim())
      .map((item) => ({ role: item.role, content: item.content, timestamp: isoTime(item.time) }))
    if (messages.length === 0) return 0
    const chunks = chunkConversationMessages(messages)
    for (let offset = 0; offset < chunks.length; offset += CONVERSATION_BATCH_SIZE) {
      await runtime.client.addConversation(identity, chunks.slice(offset, offset + CONVERSATION_BATCH_SIZE))
    }
    return messages.length
  }

  /** 人锚点 → 一条 user 记录的内容（卡片先归一化，再剥注入块，最后截断）。 */
  const humanContent = (anchor) => {
    const stripped = stripInjectedBlocks(anchor.text) || anchor.text
    const text = anchor.card ? formatCardReply(stripped) : stripped
    return clamp(text.trim(), RECORD_MAX_CHARS)
  }

  // ── 私聊（bot）─────────────────────────────────────────────────────────────

  const writeDirect = async ({ sessionId, info, identity, turn, buf }) => {
    if (!buf || buf.human.length === 0) return 0
    const botKey = info.botId || sessionId
    const lastHuman = buf.human[buf.human.length - 1]
    const already = ledger()?.direct?.(botKey)?.lastMessageId
    if (lastHuman?.id && already === lastHuman.id) {
      log(`[dsbot] 私聊第 ${turn} 轮重复投递（messageId=${lastHuman.id}），跳过`)
      return 0
    }
    const items = buf.human.map((anchor) => ({ role: 'user', content: humanContent(anchor), time: anchor.time }))
    // 终稿只在本轮最高 step 有 text 时写；没有就只写人话（实测 5% 的 DM 轮如此）。
    // 终稿里可能嵌 `dsh-ui` 卡片：剥掉（换一行标记），否则 JSON 会吃掉 8,000 字符预算、
    // 并让 L1 把 "type":"table" 这类键名当对话内容。
    const finalText = stripUiFences(buf.final?.text ?? '')
    if (finalText) items.push({ role: 'assistant', content: finalText, time: buf.final.time })
    const written = await writeL0(identity, items)
    if (lastHuman?.id) ledger()?.setDirect?.(botKey, { lastMessageId: lastHuman.id })
    log(`[dsbot] 私聊写回 ${written} 条（bot=${botKey} turn=${turn}）`)
    return written
  }

  // ── 群聊（room）────────────────────────────────────────────────────────────

  const roomState = (roomId) => ledger()?.room?.(roomId) ?? {}
  const patchRoom = (roomId, patch) => ledger()?.patchRoom?.(roomId, patch)

  /** 窗口行 → 蒸馏输入（被截断的长贴从 group-lines 取全文）。 */
  const windowTextOf = async (roomId, lines) => {
    const entries = []
    for (const line of lines) {
      let text = line.text
      if (line.truncated) {
        try {
          const full = await expandAnchorLine(dsbot(), roomId, line)
          if (full) text = full
        } catch (error) {
          log(`[dsbot] group-lines 取全文失败：${error?.message ?? error}`)
        }
      }
      entries.push({ who: line.who || '?', text })
    }
    return buildWindow(entries)
  }

  /**
   * 蒸一次前文摘要。任何失败都返回空串 —— 调用方据此只写人话。
   * 失败原因写进日志（typed skip 由调用方记进台账）。
   */
  const distillSummary = async ({ roomId, roomName, slice }) => {
    // 模型优先级：显式覆盖（`botContextModel`）> 主持 Bot 的模型。
    // 覆盖存在的理由是"主持 Bot 的模型可能是个只会思考的模型"，见 config.mjs 同名注释。
    const override = cfg().botContextModel
    const model = override ? parseModelRef(override) : dsbot()?.modelForRoom?.(roomId)
    if (!model) {
      log(override
        ? `[dsbot] 蒸馏模型配置无法解析（botContextModel=${JSON.stringify(override)}），跳过蒸馏`
        : `[dsbot] 房间 ${roomId} 找不到主持 Bot 的模型，跳过蒸馏`)
      return { text: '', reason: 'no-model' }
    }
    const windowText = await windowTextOf(roomId, slice)
    const memoryEntries = cfg().botContextReuseMemory
      ? await readMemoryEntries(dsbot(), { roomId, limit: 6 })
      : []
    let result
    try {
      result = await distillRoom({
        llm: runtime.llm?.(),
        model,
        roomName,
        windowText,
        memoryEntries,
        maxTokens: cfg().botContextMaxTokens,
        timeoutMs: cfg().botContextTimeoutMs,
        // ⚠️ 必须是**合成 id**，不能直接传房间会话 id：ds-bot 自己注册了 `llm/stream`
        // 监听器（`ds-bot/src/host/groups.js` 的 relayOrPass），只要 sessionId 命中一个
        // 房间且没带 `purpose`，它就把这次调用当成"群聊 relay 轮"接管 —— 要么合成
        // `group_relay` 工具调用，要么直接吐一个空的 `{type:'finish',reason:{kind:'stop'}}`，
        // 我们的请求根本到不了模型（2026-10-23 现场：三种调用形态全部只回一个 finish）。
        // 用 `tdai-distill:<roomId>` 既让 ds-bot 的 roomOf() 查不到，又给 opencode-go 一个
        // 稳定的 x-opencode-session 值（按房间固定，缓存亲和性也更好）。
        sessionId: `tdai-distill:${roomId}`,
      })
    } catch (error) {
      log(`[dsbot] 蒸馏抛出异常（不应发生）：${error?.message ?? error}`)
      result = { ok: false, reason: 'error' }
    }
    if (!result?.ok) return { text: '', reason: result?.reason ?? 'error', detail: result?.detail }
    const fromSeq = slice[0]?.seq
    const toSeq = slice[slice.length - 1]?.seq
    return {
      text: renderSummaryBlock({ roomName, fromSeq, toSeq, body: result.text }),
      reason: 'ok',
    }
  }

  /**
   * 处理一条群聊人锚点，返回推进后的断点。
   *
   * 两阶段：定位失败挂 pending（不写、不推进）；超限才放弃 —— 只写人话 + typed skip，
   * 并把断点推到日志末尾（否则下一个窗口会跨过多轮，错归因）。
   */
  const processAnchor = async ({ roomId, roomName, roomLog, identity, anchor, checkpoint, retry, summaryAllowed }) => {
    const located = dsbot()?.locateAnchor?.(roomId, anchor.text, { afterSeq: checkpoint })
    if (!located?.hit) {
      const prev = roomState(roomId).pending
      const attempts = retry ? (Number(prev?.attempts) || 0) + 1 : 1
      // 重试窗口按**墙钟**算：锚点的 `time` 是消息发生时间（可能很早），拿它算 10 分钟窗口
      // 会一上来就判过期。
      const firstSeenAt = Number(prev?.firstSeenAt) || Date.now()
      const expired = attempts > ANCHOR_RETRY_LIMIT || (Date.now() - firstSeenAt) > ANCHOR_RETRY_WINDOW_MS
      if (!expired) {
        patchRoom(roomId, {
          pending: {
            text: anchor.text,
            time: anchor.time,
            hash: shortHash(anchor.text),
            attempts,
            firstSeenAt,
          },
        })
        log(`[dsbot] 锚点尚未进 room log，挂 pending（room=${roomId} attempts=${attempts}）`)
        return checkpoint
      }
      const content = humanContent(anchor)
      if (content) await writeL0(identity, [{ role: 'user', content, time: anchor.time }])
      const end = Number.isFinite(roomLog?.lastSeq) ? roomLog.lastSeq : checkpoint
      patchRoom(roomId, {
        pending: undefined,
        skip: { reason: 'anchor-timeout', at: Date.now() },
        lastHuman: { seq: end, hash: '' },
        stage: undefined,
      })
      log(`[dsbot] 锚点重试超限，只写人话并跳过前文（room=${roomId} attempts=${attempts}）`)
      return end
    }

    const line = located.line
    const windowLines = (roomLog?.lines ?? []).filter((item) => item.seq > checkpoint && item.seq < line.seq)
    const limit = Math.max(0, Number(cfg().botContextMessages) || 0)
    const slice = limit > 0 ? windowLines.slice(-limit) : []
    const hasBotLine = slice.some((item) => item.botId)
    const wantSummary = summaryAllowed && cfg().botContextDistillEnabled && slice.length > 0 && hasBotLine

    let summary = ''
    let reason = 'window-empty'
    let detail
    if (wantSummary) {
      const result = await distillSummary({ roomId, roomName, slice })
      summary = result.text
      reason = result.reason
      detail = result.detail
    }

    // 阶段机：先落 stage（含锚点原文，崩溃后只补人话）→ 写摘要 → 写人话 → 推进断点。
    const stage = {
      summary: summary ? 'pending' : 'none',
      human: 'pending',
      anchor: { text: anchor.text, time: anchor.time },
      seq: line.seq,
    }
    patchRoom(roomId, { stage })
    if (summary) {
      await writeL0(identity, [{ role: 'assistant', content: summary, time: anchor.time }])
      patchRoom(roomId, { stage: { ...stage, summary: 'written' } })
    } else if (wantSummary) {
      // detail 是诊断的关键：`empty` 到底是"思考吃光 maxTokens"还是"适配器不发 text-delta"，
      // 看 reasoningChars / outputTokens / blockEndChars 一眼就能分清。
      log(`[dsbot] 蒸馏失败（${reason}${detail ? ` ${JSON.stringify(detail)}` : ''}），只写人话（room=${roomId} seq=${line.seq}）`)
    }
    const content = humanContent(anchor)
    if (content) await writeL0(identity, [{ role: 'user', content, time: anchor.time }])
    patchRoom(roomId, {
      stage: undefined,
      pending: undefined,
      lastHuman: { seq: line.seq, hash: shortHash(anchor.text) },
      // detail 一起落台账：下次不用翻日志就能看出是"思考吃光预算"还是"供应商报错"。
      skip: wantSummary && !summary ? { reason: `distill-${reason}`, detail, at: Date.now() } : undefined,
    })
    log(`[dsbot] 群聊写回（room=${roomId} seq=${line.seq} 摘要=${summary ? '有' : '无'}）`)
    return line.seq
  }

  /** 群聊两阶段主流程。`buf` 可能是本轮缓冲，也可能是失败轮只写人话（summaryAllowed=false）。 */
  const writeRoom = async ({ sessionId: roomId, identity, buf, summaryAllowed }) => {
    await dsbot()?.refresh?.({ force: true })
    const roomLog = dsbot()?.roomLog?.(roomId)
    if (!roomLog) {
      log(`[dsbot] 房间 ${roomId} 不在 state.json 里，本轮不写`)
      return
    }
    const roomName = roomLog.name || roomId
    let checkpoint = Number(roomState(roomId).lastHuman?.seq)
    if (!Number.isFinite(checkpoint)) checkpoint = 0

    // 环覆盖：断点已滑出 60 行环 → 重置并告警，窗口从 log[0] 起。
    if (Number.isFinite(roomLog.firstSeq) && checkpoint + 1 < roomLog.firstSeq) {
      log(`[dsbot] checkpoint-lost room=${roomId} checkpoint=${checkpoint} first=${roomLog.firstSeq}`)
      checkpoint = roomLog.firstSeq - 1
      patchRoom(roomId, { lastHuman: { seq: checkpoint, hash: '' } })
    }

    // 崩溃恢复：stage 留着上一条锚点，summary 已写就只补人话。
    const stage = roomState(roomId).stage
    if (stage?.anchor && stage.human !== 'written') {
      const content = humanContent(stage.anchor)
      if (content) await writeL0(identity, [{ role: 'user', content, time: stage.anchor.time }])
      const seq = Number(stage.seq)
      if (Number.isFinite(seq) && seq > checkpoint) checkpoint = seq
      patchRoom(roomId, {
        stage: undefined,
        lastHuman: { seq: checkpoint, hash: shortHash(stage.anchor.text ?? '') },
      })
      log(`[dsbot] 崩溃恢复：补写人话 1 条（room=${roomId} seq=${stage.seq}）`)
    }

    // pending 重试（本轮可能一句话都没有，也要重试 —— 这是两阶段的全部意义）。
    const pendingNow = roomState(roomId).pending
    if (pendingNow?.text) {
      checkpoint = await processAnchor({
        roomId,
        roomName,
        roomLog,
        identity,
        anchor: { text: pendingNow.text, time: pendingNow.time },
        checkpoint,
        retry: true,
        summaryAllowed,
      })
    }

    for (const anchor of buf?.human ?? []) {
      checkpoint = await processAnchor({
        roomId,
        roomName,
        roomLog,
        identity,
        anchor,
        checkpoint,
        retry: false,
        summaryAllowed,
      })
    }
  }

  // ── 事件入口 ──────────────────────────────────────────────────────────────

  /**
   * 把一条会话事件翻成规范化条目（0..n 条）——**普通会话**用。
   *
   * ⚠️ **必须按 `role` 分流，不能只按 `source.kind` 一刀切。** assistant 消息的
   * `source.kind` 是 `'model'`，只按 kind 判会把它和"插件注入"一起丢掉，结果是 L0
   * 里只剩用户单边发言、模型回复全丢（`test/capture-filter.test.mjs` 用例 1 就是
   * 为这条回归设的护栏）。
   *
   * 分流规则：
   *
   * | role | source.kind | 处理 |
   * | --- | --- | --- |
   * | assistant | `model` | 归一化回流：text 段 → assistant；每个 tool-call → tool_call；reasoning 丢弃 |
   * | user | `user` | **按块剥离**注入块后回流；剥完为空则丢弃 |
   * | user | 无（老格式/外部写入） | 同上，保守处理 |
   * | user | 其他（plugin / skill-catalog / tool） | 整条丢弃，这是宿主或插件造的注入消息 |
   * | tool/result | `tool` | 归一化成 tool_result（工具名靠 tool_call_id 回填） |
   */
  const entriesFor = (sessionId, event) => {
    const data = event.data ?? {}
    const turn = data.turn ?? currentTurn.get(sessionId) ?? 0
    const step = data.step ?? currentStep.get(sessionId)
    const assistantKey = `a:${turn}:${step ?? '?'}`
    const body = messageBody(data)

    switch (event.type) {
      case 'user/message': {
        const kind = sourceKindOf(body)
        if (kind !== undefined && kind !== 'user') return []
        const text = safeText(dropNoiseParts(body.content ?? data.content ?? ''))
        // 真人发言各自成条：用递增计数而不是 seq（live hook 的 event 不一定带 seq，
        // 同 turn 内两条真人发言不能因为 key 相同被并成一条）。
        userRecords += 1
        return userEntry(text, `u:${turn}:${userRecords}`)
      }
      case 'assistant/message': {
        const entries = normalizeAssistantContent(body.content, assistantKey)
        for (const entry of entries) {
          if (entry.role === 'tool_call' && entry.toolCallId && entry.toolName) {
            toolNames.set(entry.toolCallId, entry.toolName)
          }
        }
        return entries
      }
      case 'tool/result': {
        const kind = sourceKindOf(body)
        if (kind !== undefined && kind !== 'tool') return []
        const entry = normalizeToolResult(body, assistantKey, toolNames)
        return entry ? [entry] : []
      }
      default:
        return []
    }
  }

  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id
    if (!sessionId) return

    // 轮/步游标是所有路径共用的（真人消息不带 turn，只能靠 currentTurn 归属）。
    switch (event?.type) {
      case 'turn/start':
        currentTurn.set(sessionId, event.data?.turn)
        currentStep.delete(sessionId)
        return
      case 'step/start':
        currentStep.set(sessionId, event.data?.step)
        return
    }

    const info = lookup(sessionId)
    const botLike = isBotKind(info.kind) || info.kind === 'room-member'

    // ds-bot 会话：只缓冲人锚点与最高 step 文本，**不进普通回流缓冲**。
    //
    // `room-member`（群成员的隐藏会话）也算在内：它的内容与房间里的那一轮是同一份，
    // 永不写（`sessionPolicy().writeback` 恒 false）。不在这里截住的话，它会落进普通
    // 回流的 `turns` 缓冲，然后在 `turn/end` 里被当成"未经过 turn-stopping"记一条噪音日志 ——
    // 而且缓冲会一直堆到会话销毁。
    if (botLike) {
      if (isBotKind(info.kind)) bufferBotEvent(sessionId, event)
      // 失败/中止轮在这里兜底：`turn/end` 非 completed 时只写本轮人话。
      if (event?.type === 'turn/end') {
        const turn = event.data?.turn
        const reason = event.data?.reason?.kind ?? 'unknown'
        if (reason !== 'completed' && isBotKind(info.kind)) {
          void handleBotFailure({ sessionId, session, info, turn, reason })
        } else {
          takeBotTurn(sessionId, turn)
        }
        if (currentTurn.get(sessionId) === turn) currentTurn.delete(sessionId)
      }
      return
    }

    // 普通会话（原逻辑，逐字节不变）。
    // 子 agent 会话按策略降级（默认不回流，见 lib/subagent.mjs）：**连缓冲都不建**。
    if (!captureAllowed(runtime.config, session)) {
      if (turns.has(sessionId)) turns.delete(sessionId)
      return
    }

    if (event?.type === 'turn/end') {
      const turn = event.data?.turn
      const dropped = dropTurn(sessionId, turn)
      if (currentTurn.get(sessionId) === turn) currentTurn.delete(sessionId)
      if (dropped > 0) {
        const kind = event.data?.reason?.kind ?? 'unknown'
        log(`第 ${turn} 轮以 ${kind} 结束（未经过 turn-stopping）→ ${dropped} 条不回流，已丢弃`)
      }
      return
    }

    const entries = entriesFor(sessionId, event)
    if (entries.length === 0) return
    const turn = event.data?.turn ?? currentTurn.get(sessionId) ?? 0
    const byTurn = turns.get(sessionId) || new Map()
    const list = byTurn.get(turn) || []
    list.push(...entries)
    byTurn.set(turn, list.slice(-MAX_ENTRIES_PER_TURN))
    turns.set(sessionId, byTurn)
  })

  /**
   * 失败轮（`agent/error` / `turn/end` 非 completed）在 ds-bot 会话上的处置：**只写人话**。
   *
   * 已决（minimal.md §7）：不写终稿、不做摘要。理由——半轮对话里模型可能是错的，
   * 但真人说的话是真的；把真人那句丢掉，等于这一轮完全没发生过。
   */
  const handleBotFailure = async ({ sessionId, session, info, turn, reason }) => {
    const buf = takeBotTurn(sessionId, turn)
    if (!buf || buf.human.length === 0) return
    if (ledger()?.blocked) return
    if (!dsbot()?.writebackAllowed?.(cfg(), session)) return
    const identity = runtime.identityFor?.(session)
    if (!identity) return
    const key = `failure:${sessionId}:${turn}`
    if (pending.has(key)) return pending.get(key)
    const task = (async () => {
      try {
        if (info.kind === 'room') {
          await writeRoom({ sessionId: info.roomId || sessionId, identity, buf, summaryAllowed: false })
        } else {
          // 私聊失败轮：只写人话（终稿可能是半截，宁可不写）。
          const items = buf.human.map((anchor) => ({ role: 'user', content: humanContent(anchor), time: anchor.time }))
          await writeL0(identity, items)
          const lastHuman = buf.human[buf.human.length - 1]
          if (lastHuman?.id) ledger()?.setDirect?.(info.botId || sessionId, { lastMessageId: lastHuman.id })
        }
        log(`[dsbot] 第 ${turn} 轮以 ${reason} 结束 → 只写人话 ${buf.human.length} 条`)
      } catch (error) {
        log(`[dsbot] 失败轮写人话出错（第 ${turn} 轮）：${error?.message ?? error}`)
      } finally {
        pending.delete(key)
      }
    })()
    pending.set(key, task)
    return task
  }

  ctx.on('agent/error', (payload) => {
    const session = payload?.agent?.session
    const sessionId = session?.id
    if (!sessionId) return
    const info = lookup(sessionId)
    const reason = payload?.error?.message ?? String(payload?.error ?? '')
    // 群成员隐藏会话同样跳过：它的轮次由房间会话统一处理，这里没有可写的东西。
    if (info.kind === 'room-member') return
    if (isBotKind(info.kind)) {
      void handleBotFailure({ sessionId, session, info, turn: payload.turn, reason: reason || 'error' })
      return
    }
    if (!captureAllowed(runtime.config, session)) return
    const dropped = dropTurn(sessionId, payload.turn)
    // `throwError()` 先 emit 再 throw（dsh-agent-loop/lib/index.js:472），所以这里
    // 一定是"本轮终止"的失败，丢缓冲不会截断一个还在继续的轮次。
    log(
      `第 ${payload.turn} 轮第 ${payload.step} 步执行失败（${reason || '未知错误'}）`
      + (dropped > 0 ? `→ ${dropped} 条不回流，已丢弃` : ''),
    )
  })

  ctx.on('agent/turn-stopping', async (payload) => {
    const session = payload?.agent?.session
    const sessionId = session?.id
    if (!sessionId) return

    await ensureIndex()
    const info = lookup(sessionId)
    const policy = dsbot()?.sessionPolicy?.(cfg(), session)
    const kind = policy?.kind ?? info.kind

    if (isBotKind(kind) || kind === 'room-member') {
      const buf = takeBotTurn(sessionId, payload.turn)
      try {
        // 见过 kind=bot 但索引里已经没有这个会话：**停写 + 告警**，不猜它是普通会话。
        if (info.source === 'signal') {
          if (!warned.has(sessionId)) {
            warned.add(sessionId)
            log(`[dsbot] 会话 ${sessionId} 曾判定为 Bot 会话但已不在 state.json 里 → 停写并告警`)
          }
          return
        }
        if (kind === 'room-member') return
        // 台账损坏/不可写时**停写**（§3.6）：去重与断点全靠它，没有台账就会重复写。
        if (ledger()?.blocked) {
          if (!warned.has(`ledger:${sessionId}`)) {
            warned.add(`ledger:${sessionId}`)
            log(`[dsbot] 台账不可用（${ledger().blockReason ?? 'unknown'}）→ Bot 会话停写`)
          }
          return
        }
        if (!policy?.writeback) return
        const identity = runtime.identityFor?.(session)
        if (!identity) return
        if (kind === 'room') {
          await writeRoom({ sessionId: info.roomId || sessionId, identity, buf, summaryAllowed: true })
        } else {
          await writeDirect({ sessionId, info, identity, turn: payload.turn, buf })
        }
      } finally {
        if (currentTurn.get(sessionId) === payload.turn) currentTurn.delete(sessionId)
        try {
          await ledger()?.flush?.()
        } catch {}
      }
      return
    }

    // ── 普通会话：原逻辑 ────────────────────────────────────────────────────
    if (!runtime.config.captureEnabled) return
    if (!captureAllowed(runtime.config, payload.agent?.session)) return
    const identity = runtime.identityFor(payload.agent?.session)
    const byTurn = turns.get(sessionId) || new Map()
    // 注入过滤已在 session/event 阶段按 `source` + 文本哨兵完成，这里拿到的已经是
    // 「该回流」的条目，只差按端点 schema 投影。
    const entries = byTurn.get(payload.turn) || []
    if (!identity || entries.length === 0) return
    const key = `${identity.session_id}:${payload.turn}`
    if (pending.has(key)) return pending.get(key)
    const l0 = chunkConversationMessages(toL0Records(entries))
    const skill = toSkillMessages(entries)
    const task = (async () => {
      for (let offset = 0; offset < l0.length; offset += CONVERSATION_BATCH_SIZE) {
        await runtime.client.addConversation(identity, l0.slice(offset, offset + CONVERSATION_BATCH_SIZE))
      }
      await runtime.client.addSkillConversation(identity, skill)
    })().finally(() => pending.delete(key))
    pending.set(key, task)
    await task
    byTurn.delete(payload.turn)
  })

  ctx.on('session/flush', async (session) => {
    const writes = [...pending.entries()]
      .filter(([key]) => key.endsWith(`:${session.id}`) || key.includes(`:${session.id}:`))
      .map(([, promise]) => promise)
    await Promise.allSettled(writes)
    try {
      await ledger()?.flush?.()
    } catch {}
  })

  ctx.on('session/disposed', (session) => {
    turns.delete(session.id)
    botTurns.delete(session.id)
    currentTurn.delete(session.id)
    currentStep.delete(session.id)
  })
}
