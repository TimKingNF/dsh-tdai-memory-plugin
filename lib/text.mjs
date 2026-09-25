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

/**
 * 剥离插件注入的哨兵块，只保留真人正文。**现在是兜底判据，不是主判据。**
 *
 * ── 主判据已经换成 `source` ────────────────────────────────────────────────
 * L1 召回改为**独立消息**注入（`source: { kind: 'plugin:dsh-tdai-memory-plugin', form: 'notice' }`，
 * 见 lib/recall.mjs；v4 格式不接受 `kind:'plugin'`），因此结构判据（lib/capture.mjs 里
 * `source.kind !== 'user'` → 整条丢弃）就能认出它，不需要再猜文本。
 *
 * ── 那这个函数还留着干什么 ───────────────────────────────────────────────
 * 历史会话里存量的正文仍然带着注入块（prepend 时代的消息，`source` 是 `{kind:'user'}`，
 * 结构上认不出来）。另外外部写入的种子消息、以及别的插件转发过来的文本可能丢掉
 * `source`。这些情况下只能按文本哨兵剥离：删掉哨兵块本身，保留其余正文。
 *
 * 用非贪婪匹配，只吃到对应闭合标签为止，避免把用户正文一起吞掉。
 */
/** 成对的哨兵块：非贪婪，只吃到自己的闭合标签。 */
const INJECTED_BLOCK_PATTERNS = [
  /<tdai_recalled_l1_memories>[\s\S]*?<\/tdai_recalled_l1_memories>/g,
  /<tdai_profile_memory>[\s\S]*?<\/tdai_profile_memory>/g,
  /<memory-tools-guide>[\s\S]*?<\/memory-tools-guide>/g,
  /<session_context>[\s\S]*?<\/session_context>/g,
]

/**
 * 兜底：**只有开标签、没有闭标签**的残块。
 *
 * 为什么会残缺：消息在进入本函数前先过了 `safeText()`（12K 截断）。如果召回块正好被
 * 截断在中间，成对模式匹配不到，注入内容就会漏进 L0。所以成对清洗之后，再把"从开标签
 * 到文本末尾"整段切掉。
 *
 * 副作用：如果用户正文里**手写**了 `<tdai_recalled_l1_memories>` 字样，其后内容会被
 * 一起切掉。这是有意的取舍——宁可少记一句用户手写的字面量，也不能让注入内容污染长期记忆。
 */
const INJECTED_TRUNCATED_PATTERNS = [
  /<tdai_recalled_l1_memories>[\s\S]*$/g,
  /<tdai_profile_memory>[\s\S]*$/g,
  /<memory-tools-guide>[\s\S]*$/g,
  /<session_context>[\s\S]*$/g,
  // 旧格式（proxy 时代的 historical context 标记）：是**前缀标记**，吃到表达式给出
  // 的范围为止（第二模式覆盖"标记后直接接正文"的写法）。
  /\[TencentDB historical context\][^\n]*/g,
]

export function stripInjectedBlocks(text) {
  if (typeof text !== 'string' || text.length === 0) return ''
  let out = text
  for (const re of INJECTED_BLOCK_PATTERNS) out = out.replace(re, '')
  for (const re of INJECTED_TRUNCATED_PATTERNS) out = out.replace(re, '')
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}
