/**
 * 对话回流（写侧）：每轮真人对话结束时把切片旁路写回 MemoryCore。
 *
 * 在 adapter 基础上对齐 MemoryProxy：
 *   - 消息分片：单条 >8192 code units 切分（surrogate 安全），100 条/批
 *   - 同 session 串行：core 侧 conversation buffer 的前提
 *   - 过滤插件自己注入的块，避免回流污染记忆
 *   - **归一化成两种投影**（见 lib/normalize.mjs）：skill 端点收 5-role（含
 *     tool_call/tool_result），L0 端点只收 user/assistant（工具折叠成文本标记）；
 *     内部思考（reasoning）与图片一律丢弃
 *
 * 双写：/v3/conversation/add（L0 短期记忆）+ /v3/skill/conversation/add（Skill 归档）。
 * L1/L2/L3 提取由 MemoryCore 后台异步完成，插件不做。
 *
 * ── 注入过滤：两条判据是"并集"，不是二选一 ──────────────────────────────────
 *
 * 1. **主判据 · `source`（结构判据）**：DSH 给每条消息带 `source` 元数据，
 *    `source.kind` 表示谁产的（`dsh-llm/lib/types/message.d.ts:94-104`）：
 *    `'user'` 真人 / `'plugin'` 插件 / `'model'` 模型 / `'tool'` 工具
 *    （宿主还会用 `'skill-catalog'` 这类形式）。**只回流 `source.kind === 'user'`
 *    与模型产出的消息**，其余一律丢弃 —— 这比"看文本里有没有某个标签"可靠，
 *    因为它不随文案改动而失效。
 *
 * 2. **兜底判据 · 文本哨兵**：给**存量**消息与丢失 `source` 的文本兜底。
 *    L1 召回块现在是独立一条 plugin 消息（被判据 1 整条丢弃），但 prepend 时代
 *    写进历史会话的正文里还混着哨兵块，那些消息的 `source` 仍是 `{ kind: 'user' }`，
 *    结构判据认不出，只能按块剥离（`stripInjectedBlocks`）。
 *
 * 两条一起用：哨兵文案改了有 `source` 兜着；`source` 缺失（老会话、外部写入的
 * 种子消息）有哨兵兜着。`test/capture-filter.test.mjs` 把这两条都锁住了。
 *
 * ── 失败轮（agent/error / turn/end ≠ completed）：捕获异常，但**不回流** ──────
 *
 * 宿主只在成功路径派发 `agent/turn-stopping`（`dsh-agent-loop/lib/index.js:570`），
 * 模型请求失败（LlmError）、被 abort、被 pre-step reject 的轮次都走不到那里。
 * 这类轮次不做记忆——半轮对话进 L0 只会给 L1/L2 抽取喂脏数据——但必须有人
 * **接住异常并清掉缓冲**，否则该轮消息会一直挂在内存里：
 *   - `agent/error`：宿主显式上报（`{agent,turn,step,error}`），在这里记日志 + 丢弃；
 *   - `turn/end`：兜底（blocked/aborted 不一定触发 agent/error），按 turn 清缓冲。
 * 成功轮次里 turn-stopping 已经清过缓冲，所以 `turn/end` 不会误报。
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
  '[TencentDB historical context]',
  '<tdai_profile_memory>',
  '<memory-tools-guide>',
  '<session_context>',
]

/** 单轮最多缓存多少条条目（条目比消息细：一次 tool-call 就是一条）。 */
const MAX_ENTRIES_PER_TURN = 200

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

export function wireCapture(ctx, runtime) {
  const pending = new Map()
  const turns = new Map()
  const currentTurn = new Map()
  const currentStep = new Map()
  /** tool_call_id → tool_name：tool/result 事件本身不带工具名，用它回填。 */
  const toolNames = new Map()
  /** 真人发言的递增序号，保证同 turn 内多条真人发言各自成条。 */
  let userRecords = 0

  const dropTurn = (sessionId, turn) => {
    const byTurn = turns.get(sessionId)
    const dropped = byTurn?.get(turn)?.length ?? 0
    byTurn?.delete(turn)
    return dropped
  }

  /**
   * 把一条会话事件翻成规范化条目（0..n 条）。
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
   *
   * 「按块剥离」只对**存量**消息还有意义：prepend 时代召回块被插进真人那条 user
   * 消息内部，那条消息的 source 仍是 `kind:'user'`，结构判据认不出来，只能把哨兵块
   * 从正文里剪掉、保留用户在块外说的话。现在的召回块走独立 plugin 消息，整条被上面
   * 那张表的第三行丢掉。
   *
   * `recordKey` 决定 L0 里的记录边界：真人发言各自成条；assistant 的文本与
   * 同一步的工具调用/结果合成一条。
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

    // 子 agent 会话按策略降级（默认不回流，见 lib/subagent.mjs）：**连缓冲都不建**。
    // 这里顺手清掉可能存在的残留，这样"会话中途把开关打开"也不会让旧缓冲漏写出去。
    if (!captureAllowed(runtime.config, session)) {
      if (turns.has(sessionId)) turns.delete(sessionId)
      return
    }

    switch (event?.type) {
      case 'turn/start':
        currentTurn.set(sessionId, event.data?.turn)
        currentStep.delete(sessionId)
        if (!turns.has(sessionId)) turns.set(sessionId, new Map())
        return
      case 'step/start':
        currentStep.set(sessionId, event.data?.step)
        return
      // 轮次收尾：清缓冲。成功轮次已在 turn-stopping 里清过，只有失败/中止轮会有残留。
      case 'turn/end': {
        const turn = event.data?.turn
        const dropped = dropTurn(sessionId, turn)
        if (currentTurn.get(sessionId) === turn) currentTurn.delete(sessionId)
        if (dropped > 0) {
          const kind = event.data?.reason?.kind ?? 'unknown'
          runtime.log(`第 ${turn} 轮以 ${kind} 结束（未经过 turn-stopping）→ ${dropped} 条不回流，已丢弃`)
        }
        return
      }
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
   * 失败轮兜底：接住宿主上报的异常并丢弃本轮缓冲，**不回流**。
   * 不回流是有意的——半轮对话（比如模型 400 后只剩用户一句话）进了 L0 只会
   * 被后台抽取当成"完整的一轮"消费，污染 L1/L2。
   */
  ctx.on('agent/error', (payload) => {
    const sessionId = payload?.agent?.session?.id
    if (!sessionId) return
    // 子 agent 会话不回流 → 也没有缓冲要丢，不产生日志噪音。
    if (!captureAllowed(runtime.config, payload?.agent?.session)) return
    const dropped = dropTurn(sessionId, payload.turn)
    const reason = payload?.error?.message ?? String(payload?.error ?? '')
    // `throwError()` 先 emit 再 throw（dsh-agent-loop/lib/index.js:472），所以这里
    // 一定是"本轮终止"的失败，丢缓冲不会截断一个还在继续的轮次。
    runtime.log(
      `第 ${payload.turn} 轮第 ${payload.step} 步执行失败（${reason || '未知错误'}）`
      + (dropped > 0 ? `→ ${dropped} 条不回流，已丢弃` : ''),
    )
  })

  ctx.on('agent/turn-stopping', async (payload) => {
    if (!runtime.config.captureEnabled) return
    // 子 agent 会话按策略降级：整段执行过程（任务 prompt + 工具 dump + 结论）不写回。
    // 子 agent 的结论在父会话里有 subagent-settled / relay 消息留痕，不必再存一份；
    // 详见 lib/subagent.mjs 顶部注释。
    if (!captureAllowed(runtime.config, payload.agent?.session)) return
    const identity = runtime.identityFor(payload.agent?.session)
    const sessionId = payload.agent?.session?.id
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
      .filter(([key]) => key.startsWith(`${session.id}:`))
      .map(([, promise]) => promise)
    await Promise.allSettled(writes)
  })

  ctx.on('session/disposed', (session) => {
    turns.delete(session.id)
    currentTurn.delete(session.id)
    currentStep.delete(session.id)
  })
}
