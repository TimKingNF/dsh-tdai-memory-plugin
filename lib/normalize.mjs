/**
 * 会话消息归一化：把 DSH 的消息体翻译成 core 需要的两种形状。
 *
 * ── 为什么要分成两种 ────────────────────────────────────────────────────────
 * 两个端点的 schema 不一样（对齐 MemoryProxy）：
 *
 * | 端点 | 接受的 role | 工具怎么表示 |
 * | --- | --- | --- |
 * | `/v3/skill/conversation/add` | user / assistant / **tool_call** / **tool_result** / system | 独立消息 + `tool_call_id` 配对锚点 |
 * | `/v3/conversation/add`（L0） | **只有** user / assistant / system | 折叠成 `[tool_call] …` / `[tool_result:…]` 文本 |
 *
 * 依据（TencentDB-Agent-Memory 仓库）：
 *   - `MemoryProxy/src/skill/normalize-conversation.ts`：5-role 归一；
 *     `type="reasoning"` / thinking / redacted_thinking / image **一律丢弃**（不进语料）；
 *     assistant 的 text 与 tool_use 拆成两条（text 在前）。
 *   - `agents/asset-import.ts` 的 `toMemoryMessages()`：L0 投影——"工具以
 *     `[tool_call]` / `[tool_result]` 文本形式并入对话流，且不出现 tool_call/tool_result
 *     角色，因为 memory 链路 schema 仅接受 user/assistant/system"；工具文本压空白、
 *     上限 4000 字符。
 *
 * ── 为什么 reasoning 必须丢 ─────────────────────────────────────────────────
 * DSH 的 assistant 消息把内部思考（`type:'reasoning'`）和可见回复放在同一个
 * content 数组里。早先 `safeText()` 会把两者拼成一条写进 L0：实测一轮 32 条记录里
 * 31 条是思考原文、可见回复反而被夹在一条 4600 字符的记录里。L0 是 L1/L2/L3 抽取的
 * 输入，思考噪音会顺着后台抽取污染长期记忆，所以在这里一次性剔除。
 */

/** 工具文本上限，对齐 MemoryProxy `toMemoryMessages()`。 */
const TOOL_TEXT_MAX = 4000

/**
 * 不进记忆的块类型。清单与 MemoryProxy 一致（reasoning/thinking 对齐、image 无抽取价值），
 * 另加 DSH/OpenAI 兼容命名（`reasoning_content`、`input_image`）。
 */
const DROPPED_PART_TYPES = new Set([
  'reasoning',
  'reasoning_content',
  'thinking',
  'redacted_thinking',
  'image',
  'image_url',
  'input_image',
])

const TOOL_CALL_TYPES = new Set(['tool-call', 'tool_use', 'tool_call'])
const TOOL_RESULT_TYPES = new Set(['tool-result', 'tool_result'])

function str(value) {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/** 压空白 + 截断（L0 折叠工具时用，对齐 MemoryProxy）。 */
function collapse(text, max = TOOL_TEXT_MAX) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max)}…` : one
}

/** 去掉不该进记忆的块，返回剩余块数组（字符串输入原样返回，便于继续走 safeText 截断）。 */
export function dropNoiseParts(value) {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.filter((part) => part && typeof part === 'object' && !DROPPED_PART_TYPES.has(part.type))
}

/** 工具结果正文：字符串原样；块数组只取 text 块，reasoning / image 丢弃。 */
function toolResultText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return dropNoiseParts(content)
    .filter((part) => typeof part.text === 'string' && part.text)
    .map((part) => part.text)
    .join('\n')
}

/**
 * 归一化 assistant 消息体。
 *
 * 拆分规则对齐 proxy：text 段合成一条 `assistant`，每个 tool-call 各成一条 `tool_call`
 * （content = arguments 原文）。reasoning / image / 未知块型丢弃；全空的返回 `[]`。
 */
export function normalizeAssistantContent(content, recordKey) {
  if (typeof content === 'string') {
    return content ? [{ role: 'assistant', content, recordKey }] : []
  }
  if (!Array.isArray(content)) return []

  const texts = []
  const toolCalls = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    if (DROPPED_PART_TYPES.has(part.type)) continue
    if (TOOL_CALL_TYPES.has(part.type)) {
      toolCalls.push({
        role: 'tool_call',
        content: typeof part.arguments === 'string' ? part.arguments : JSON.stringify(part.arguments ?? {}),
        toolName: str(part.name),
        toolCallId: str(part.id ?? part.toolCallId ?? part.tool_call_id),
        recordKey,
      })
      continue
    }
    if (typeof part.text === 'string' && part.text) texts.push(part.text)
  }

  const out = []
  if (texts.length > 0) out.push({ role: 'assistant', content: texts.join('\n'), recordKey })
  return out.concat(toolCalls)
}

/**
 * 归一化宿主的 `tool/result` 事件消息体。
 * 形态：`{ source:{kind:'tool',callId}, content:[{ type:'tool-result', toolCallId, content:[{type:'text',text}] }] }`
 */
export function normalizeToolResult(message, recordKey, toolNameByName) {
  const parts = Array.isArray(message?.content) ? message.content : []
  const part = parts.find((candidate) => TOOL_RESULT_TYPES.has(candidate?.type))
  if (!part) return undefined
  const content = toolResultText(part.content)
  if (!content.trim()) return undefined
  const toolCallId = str(part.toolCallId ?? part.tool_call_id ?? message?.source?.callId)
  // 工具名优先取消息自带；DSH 的 tool/result 不带名字，用 tool_call_id 回填。
  const toolName = str(part.tool_name ?? part.toolName) ?? toolNameByName?.get(toolCallId)
  return { role: 'tool_result', content, toolName, toolCallId, recordKey }
}

/**
 * L0 投影：只有 user / assistant 两种 role，工具折叠成文本标记。
 *
 * 记录（record）划分对齐 proxy 的「一条记录一条扁平消息」：真人发言各自成条；
 * assistant 的文本与同一步的工具调用/结果合成一条。`recordKey` 就是记录边界。
 */
export function toL0Records(entries) {
  const records = new Map()
  for (const entry of entries) {
    if (!entry?.content) continue
    const key = entry.recordKey ?? `anon:${records.size}`
    let record = records.get(key)
    if (!record) {
      record = { role: entry.role === 'user' ? 'user' : 'assistant', parts: [] }
      records.set(key, record)
    }
    if (entry.role === 'tool_call') {
      record.parts.push(`[tool_call] ${entry.toolName || 'unknown'}(${collapse(entry.content)})`)
    } else if (entry.role === 'tool_result') {
      record.parts.push(`[tool_result${entry.toolName ? `:${entry.toolName}` : ''}] ${collapse(entry.content)}`)
    } else {
      record.parts.push(entry.content)
    }
  }
  return [...records.values()]
    .map((record) => ({ role: record.role, content: record.parts.filter(Boolean).join('\n') }))
    .filter((record) => record.content.trim())
}

/**
 * Skill 投影：5-role 原样，工具带上 `tool_name` / `tool_call_id` 配对锚点
 * （core 侧要求 tool_call/tool_result 成对，见 MemoryProxy core-client.ts 的强约束）。
 */
export function toSkillMessages(entries) {
  return entries.filter((entry) => entry?.content).map((entry) => {
    const message = { role: entry.role, content: entry.content }
    if (entry.toolName) message.tool_name = entry.toolName
    if (entry.toolCallId) message.tool_call_id = entry.toolCallId
    return message
  })
}
