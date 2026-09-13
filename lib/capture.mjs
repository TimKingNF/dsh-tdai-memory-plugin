/**
 * 对话回流（写侧）：每轮真人对话结束时把切片旁路写回 MemoryCore。
 *
 * 在 adapter 基础上对齐 MemoryProxy：
 *   - 消息分片：单条 >8192 code units 切分（surrogate 安全），100 条/批
 *   - 同 session 串行：core 侧 conversation buffer 的前提
 *   - 过滤插件自己注入的召回块，避免回流污染记忆
 *
 * 双写：/v3/conversation/add（L0 短期记忆）+ /v3/skill/conversation/add（Skill 归档）。
 * L1/L2/L3 提取由 MemoryCore 后台异步完成，插件不做。
 */
import { safeText, chunkConversationMessages, CONVERSATION_BATCH_SIZE } from './text.mjs'

/** 插件自己注入的上下文标记，回流时剔除。 */
const INJECTED_MARKERS = ['<tdai_recalled_l1_memories>', '[TencentDB historical context]']

function isInjectedContext(text) {
  return INJECTED_MARKERS.some((m) => text.includes(m))
}

function extractMessage(event) {
  if (event?.type === 'user/message') {
    const data = event.data ?? {}
    return { role: 'user', content: safeText(data.content ?? data.message?.content ?? '') }
  }
  if (event?.type === 'assistant/message') {
    const data = event.data ?? {}
    const message = data.message ?? data
    return { role: 'assistant', content: safeText(message.content ?? '') }
  }
  return undefined
}

export function wireCapture(ctx, runtime) {
  const pending = new Map()
  const turns = new Map()
  const currentTurn = new Map()

  ctx.on('session/event', (session, event) => {
    if (event?.type === 'turn/start') {
      currentTurn.set(session.id, event.data?.turn)
      if (!turns.has(session.id)) turns.set(session.id, new Map())
      return
    }
    const message = extractMessage(event)
    if (!message?.content) return
    const turn = event.data?.turn ?? currentTurn.get(session.id) ?? 0
    const byTurn = turns.get(session.id) || new Map()
    const list = byTurn.get(turn) || []
    list.push(message)
    byTurn.set(turn, list.slice(-40))
    turns.set(session.id, byTurn)
  })

  ctx.on('agent/turn-stopping', async (payload) => {
    if (!runtime.config.captureEnabled) return
    const identity = runtime.identityFor(payload.agent?.session)
    const sessionId = payload.agent?.session?.id
    const byTurn = turns.get(sessionId) || new Map()
    const messages = (byTurn.get(payload.turn) || []).filter((m) => !isInjectedContext(m.content))
    if (!identity || messages.length === 0) return
    const key = `${identity.session_id}:${payload.turn}`
    if (pending.has(key)) return pending.get(key)
    const chunked = chunkConversationMessages(messages)
    const task = (async () => {
      for (let offset = 0; offset < chunked.length; offset += CONVERSATION_BATCH_SIZE) {
        await runtime.client.addConversation(identity, chunked.slice(offset, offset + CONVERSATION_BATCH_SIZE))
      }
      await runtime.client.addSkillConversation(identity, messages)
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
  })
}
