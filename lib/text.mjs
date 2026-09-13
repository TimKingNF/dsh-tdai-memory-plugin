/** 纯函数工具：文本截断、消息分片、查询清洗、Scene Navigation 剥离。 */

export const TEXT_LIMIT = 12000

/** 与 adapter 一致的安全文本化：字符串截断 12K，blocks 数组拼接。 */
export function safeText(value) {
  if (typeof value === 'string') return value.length > TEXT_LIMIT ? `${value.slice(0, TEXT_LIMIT)}…` : value
  if (Array.isArray(value)) return value.map((item) => safeText(item?.text ?? item?.content ?? '')).filter(Boolean).join('\n').slice(0, TEXT_LIMIT)
  return ''
}

export function truncate(s, max) {
  return s.length > max ? `${s.slice(0, max)}\n...[truncated ${s.length - max} chars]` : s
}

const MESSAGE_CONTENT_MAX_CHARS = 8192
export const CONVERSATION_BATCH_SIZE = 100

function isHighSurrogate(code) {
  return code >= 0xD800 && code <= 0xDBFF
}

function isLowSurrogate(code) {
  return code >= 0xDC00 && code <= 0xDFFF
}

/**
 * 对话消息分片（移植自 MemoryProxy src/tdai/client.ts）：
 * 单条 content 超过 8192 code units 时切分，避免截断 UTF-16 surrogate pair。
 * gateway 按 string.length 校验，因此这里用 JS code units 而非 UTF-8 字节。
 */
export function chunkConversationMessages(messages) {
  return messages.flatMap((message) => {
    if (message.content.length <= MESSAGE_CONTENT_MAX_CHARS) return [message]
    const chunks = []
    let start = 0
    while (start < message.content.length) {
      let end = Math.min(start + MESSAGE_CONTENT_MAX_CHARS, message.content.length)
      if (
        end < message.content.length
        && isHighSurrogate(message.content.charCodeAt(end - 1))
        && isLowSurrogate(message.content.charCodeAt(end))
      ) {
        end -= 1
      }
      chunks.push({ role: message.role, content: message.content.slice(start, end) })
      start = end
    }
    return chunks
  })
}

/**
 * 剥离 persona 尾部的「Scene Navigation (Scene Index)」段
 * （移植自 MemoryProxy tdai-profile-memory-injector.ts）。
 * L2 索引由 <l2_scene_index> 单独注入，persona 内嵌的一份必须去掉，避免重复。
 */
export function stripSceneNavigation(personaContent) {
  const idx = personaContent.indexOf('## 🗺️ Scene Navigation')
  if (idx === -1) return personaContent
  let cut = personaContent.slice(0, idx)
  cut = cut.replace(/\s*-{3,}\s*$/, '')
  return cut.trimEnd()
}

/** 检索 query 清洗：剥掉 system-reminder 等噪声包裹，压缩空白，截断 2048。 */
const NOISE_TAGS = ['system-reminder', 'user_info', 'additional_data', 'question_answer']

export function cleanUserQuery(text) {
  let t = String(text ?? '')
  for (const tag of NOISE_TAGS) {
    t = t.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g'), ' ')
  }
  return t.replace(/\s+/g, ' ').trim().slice(0, 2048)
}
