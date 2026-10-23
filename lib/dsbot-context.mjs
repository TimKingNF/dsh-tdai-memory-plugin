/**
 * 群聊前文蒸馏：把 room log 的一段窗口交给主持 Bot 的模型，蒸成一条可直接写进 L0 的
 * assistant 摘要（3–5 条 `- ` bullet + 一行「结论：」）。
 *
 * 方案：docs/proposals/ds-bot-tdai-integration/minimal.agents.md §3.4 / §3.5 / §3.6
 *       docs/proposals/ds-bot-tdai-integration/minimal.md §1（「群聊没有现成终稿可抄」）
 *
 * ── 为什么群聊必须自蒸 ──────────────────────────────────────────────────────
 *
 * 实测群聊房间会话的 129/129 个 completed 轮**收尾步没有任何文本**（每轮都是一次
 * `group_relay` 工具调用），所以「群聊终稿」没有可抄的对象；把房间原文贴进 L0 也不
 * 成立：117 条 room 块共 489,699 字符，占入站字符 55%，会把真人对话淹没，还会把 Bot
 * 的措辞当成抽取语料。唯一可行的口径是插件拿窗口 + 主持 Bot 的模型蒸出一段摘要，
 * 以 assistant 身份写入。
 *
 * ── 三条不能退的线 ──────────────────────────────────────────────────────────
 *
 * 1. **失败只返回失败对象，绝不抛、绝不写兜底原文。** 兜底原文是 Bot 措辞，进 L0 只会
 *    制造归因风险（L1 会把它当成"关于人"的证据）；宁可该轮前文不进记忆。所以这里每个
 *    导出函数的失败路径都是 `{ ok:false, reason }`，没有 throw，也没有"降级原文"分支。
 * 2. **不 import `@deepseek-ai/dsh-llm`。** 它不是本插件的依赖，从插件目录解析会
 *    `ERR_MODULE_NOT_FOUND`（已实测）。而蒸摘要只需要累加 `text-delta`，
 *    用不上 `BlockAssembler`——方案稿 §3.5 那段 import 是在 dsh 发布目录里核形状时
 *    写的，原样抄进插件会当场炸。
 * 3. **不使用第一人称。** 摘要以 assistant 写进 L0，但 L1 抽取看到的是整段内容；
 *    带"我/我们"的句子会被抽成用户自述。这是**提示词约束，不是机械过滤**
 *    （timing-probe.md §9），所以口径写在 system 里；也不能写得过重，否则限制词本身
 *    会漏进摘要。
 *
 * ── 调用形状（scripts/verify-llm-api.mjs，17 条断言） ───────────────────────
 *
 * `llm.stream(options)` 同步返回 AsyncIterable；`signal` 是 options 的**字段**，
 * 不是第二个位置参数；`resolveModelInfo(provider, model, signal)` 是**实例方法**。
 * 任何一条写错，整条群聊摘要路径都会静默降级成"只有人话"。
 *
 * ── 失败矩阵（minimal.agents.md §3.6） ──────────────────────────────────────
 *
 * | 情况 | 返回 |
 * | --- | --- |
 * | `ctx.llm` 拿不到 / 没有 `stream` | `{ok:false, reason:'no-llm'}` |
 * | 房间拆不出 `provider/model` | `{ok:false, reason:'no-model'}` |
 * | 超时、被中止（含上游吞掉中止后正常结束） | `{ok:false, reason:'timeout'}` |
 * | 其他异常 | `{ok:false, reason:'error'}` |
 * | 输出为空或只有空白 | `{ok:false, reason:'empty'}` |
 *
 * 调用方（`lib/capture.mjs`）拿到 `ok:false` 一律只写人话 + `distill-failed` skip。
 */

import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

/** 蒸馏超时：8 秒。群聊轮末是同步路径，超时太久会把 turn-stopping 拖住。 */
export const DISTILL_TIMEOUT_MS = 8000
/**
 * 输出上限默认值：5,000 token（配置项 `botContextMaxTokens` 可改，范围 100–32,000）。
 *
 * 为什么不是 600（原方案值）：`reasoningEffort: 'off'` 在 pi-ai 适配器里只是**省略推理参数**，
 * 不是关掉思考 —— 供应商默认会思考时，思考 token 照样从 `maxTokens` 里扣。600 的预算
 * 被思考吃光后，正文一个字都不剩，`distillRoom()` 只能返回 `empty`（2026-10-23 08:24 现场：
 * 群聊一轮只写进一句人话，台账 skip=distill-empty）。官方注释见 `dsh-llm-pi-ai` 的
 * `reasoningInfo()`：「`off` is translated to omitting the reasoning option … a provider
 * whose own default is to think would keep thinking with `off` selected」。
 *
 * 5,000 只是**上限**：正常摘要 200–300 token 就停，不产生额外成本。
 */
export const DISTILL_MAX_TOKENS = 5000
/** 记录级上限（含固定前缀行），对应 §3.2 的「摘要 1,200 / 条」。 */
export const SUMMARY_MAX_CHARS = 1200
/** 摘要正文上限（bullet + 结论），对应 §3.4 的「总量 ≤600 字符」。 */
export const SUMMARY_BODY_MAX_CHARS = 600
/** 背景段最多给 6 条 MEMORY 条目：再多会把"背景"变成"主体"，模型会照着抄。 */
export const MEMORY_MAX_ENTRIES = 6
/** 单条 MEMORY 截 200 字符；条目本身是 ds-bot 的长期事实，取其主干即可。 */
export const MEMORY_ENTRY_MAX_CHARS = 200

/**
 * 窗口输入的字数上限：正常窗口是 `botContextMessages`（默认 5）× `TEXT_KEPT`（2000）
 * 量级，触不到；只有上游把已展开的长贴拼进窗口时才会命中。命中就丢最旧的一侧——
 * 摘要服务的是"最近的团队状态"，留最新比留开头有用。
 */
const WINDOW_INPUT_MAX_CHARS = 12000
/** 房间名要进固定前缀行，必须单行且短：换行会把前缀拆开，事后按页脚去重就认不出来。 */
const ROOM_NAME_MAX_CHARS = 40
/** 一行「结论：」的字数上限；超长说明模型跑偏，截断给 bullet 留出正文预算。 */
const CONCLUSION_MAX_CHARS = 200

const CONCLUSION_RE = /^结论\s*[：:]\s*/
const BARE_CONCLUSION_RE = /^结论$/

// ── 只读输入 ────────────────────────────────────────────────────────────────

/**
 * 读 ds-bot 的长期记忆条目（`memory/team/MEMORY.md` 或 `memory/bots/<botId>/MEMORY.md`）。
 *
 * 只取 `- ` 开头的行：文件里还有标题、说明段落，它们不是"事实"，进背景段只会稀释
 * 注意力。路径一律从 `index.memoryPath()` 取（插件侧不自己拼 `<DSH_HOME>/bot/...`），
 * 这样目录布局变更只改一处。
 *
 * 文件不存在 / 读失败 / index 不可用 → `[]`：背景段本来就是可选的（默认关），
 * 不能因为它把蒸馏整条路拖垮。
 */
export async function readMemoryEntries(index, { roomId, botId, limit = MEMORY_MAX_ENTRIES } = {}) {
  let path = ''
  try {
    path = typeof index?.memoryPath === 'function' ? index.memoryPath({ roomId, botId }) : ''
  } catch {
    return []
  }
  if (typeof path !== 'string' || !path) return []

  let text
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return []
  }

  const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : MEMORY_MAX_ENTRIES
  if (max === 0) return []

  const entries = []
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('- ')) continue
    entries.push(line.length > MEMORY_ENTRY_MAX_CHARS ? line.slice(0, MEMORY_ENTRY_MAX_CHARS) : line)
    if (entries.length >= max) break
  }
  return entries
}

/**
 * 被 `TEXT_KEPT=2000` 截断的长贴：从 `group-lines/<roomId>/<seq>.txt` 读全文。
 *
 * 只读。读不到（文件被清理、seq 编号对不上）就退回 `line.text`——截断的头部仍然
 * 可读，比丢掉整条强；但**绝不**把全文当摘要写进 L0，它只作蒸馏输入（§3.6）。
 * 未截断的行直接返回日志文本，不去碰磁盘。
 */
export async function expandAnchorLine(index, roomId, line) {
  const text = typeof line?.text === 'string' ? line.text : ''
  const truncated = line?.truncated === true || Number.isFinite(line?.length)
  if (!truncated) return text

  let path = ''
  try {
    path = typeof index?.groupLinePath === 'function' && Number.isFinite(line?.seq)
      ? index.groupLinePath(roomId, line.seq)
      : ''
  } catch {
    return text
  }
  if (!path) return text

  try {
    const full = await readFile(path, 'utf8')
    return full || text
  } catch {
    return text
  }
}

// ── 蒸馏输入 ────────────────────────────────────────────────────────────────

/**
 * 窗口行 → 蒸馏输入（旧→新）：每行 `<who>: <text>`。
 *
 * 用 `who` 而不是 `botId`：room log 里人行的 `who` 是 `User`，Bot 行是显示名，
 * 混在一条提示里要让模型分得清"谁说的"；空文本行丢掉（日志里有空行）。
 */
export function buildWindow(entries) {
  if (!Array.isArray(entries)) return ''
  const lines = []
  for (const entry of entries) {
    const text = typeof entry?.text === 'string' ? entry.text.trim() : ''
    if (!text) continue
    const who = typeof entry?.who === 'string' && entry.who.trim() ? entry.who.trim() : '?'
    lines.push(`${who}: ${text}`)
  }
  return lines.join('\n')
}

/**
 * 三段提示词：系统段（口径）、背景段（MEMORY 条目，可选）、对话段（`<who>: <text>`）。
 *
 * 返回 `{ system, user }`：系统段走 `options.system`，背景段与对话段拼进 user——
 * 分开是因为口径与语料混在一条消息里时，模型更容易把"要求"当成"前文的一部分"抄进摘要。
 *
 * 背景段只在真有条目时出现，且带一句「严禁从中提取」：MEMORY 里本来就有旧摘要，
 * 不划边界就会形成"摘要抄摘要"的归因回环（`botContextReuseMemory` 默认关也是这个原因）。
 */
export function buildDistillPrompt({ roomName, windowText, memoryEntries } = {}) {
  const name = roomNameFor(roomName)
  const entries = normalizeMemoryEntries(memoryEntries)

  const system = [
    '你是团队群聊的记录员：把用户给出的群聊前文（旧→新）浓缩成一条可长期保存的记录。',
    '',
    '输出格式：',
    '- 先写 3–5 条要点，每行以 "- " 开头，一条一行；',
    '- 最后单起一行写结论，以 "结论：" 开头。',
    '',
    '写法要求：',
    '- 每条要点写清"谁 做了什么 / 决定了什么 / 留下什么未决"，主语用前文里出现过的称呼；',
    '- 只记录前文里真实发生的内容，不补充外部知识，不评价、不建议、不揣测动机；',
    '- 不用第一人称（不出现"我""我们"），也不写"建议""可以考虑"这类口气：这段记录会以第三方视角保存；',
    '- 不用标题、编号、加粗或代码块，除 "- " 和 "结论：" 外不加别的标记；',
    '- 前文没有可归纳的内容时，只输出一行：结论：未收口',
  ].join('\n')

  const parts = []
  if (entries.length > 0) {
    parts.push(
      '## 背景：团队长期记忆（只用来理解上下文；严禁从中提取要点，也不要把这些条目当成这次对话里发生过的事）',
      ...entries,
      '',
    )
  }

  const window = clipWindow(typeof windowText === 'string' ? windowText.trim() : '')
  parts.push(
    `## 对话：群聊「${name}」前文（旧→新）`,
    window || '（没有可用的前文）',
    '',
    '请按系统要求输出。',
  )

  return { system, user: parts.join('\n').trim() }
}

/**
 * 拼最终写进 L0 的摘要记录：固定前缀行 + 正文（bullet + 结论）。
 *
 * ```text
 * [群聊「<房间名>」· 前文 seq <a>–<b>]
 * - …
 * 结论：…
 * ```
 *
 * 前缀行写在这里而不是交给调用方：§3.4 要求摘要**固定以它开头**，散到调用点就会
 * 出现有的带、有的不带。注意方案稿把它叫「页脚」，但 §3.4 的记录格式与 §7 的
 * 「摘要固定以 … 开头」都要求它在第一行——按后者实现。
 *
 * 两道上限：正文 ≤600（`SUMMARY_BODY_MAX_CHARS`，模型被要求写 3–5 条时自然满足），
 * 整条记录 ≤1,200（`SUMMARY_MAX_CHARS`，兜底）。缺「结论：」时补「未收口」——
 * 群聊不写 Bot 终稿，团队状态只靠这一行表达，空着比写"未收口"更糟。
 */
export function renderSummaryBlock({ roomName, fromSeq, toSeq, body } = {}) {
  const name = roomNameFor(roomName)
  const head = `[群聊「${name}」· 前文 seq ${seqText(fromSeq)}–${seqText(toSeq)}]`

  const { bullets, conclusion } = splitBody(body)
  const conclusionText = `结论：${clipText(conclusion, CONCLUSION_MAX_CHARS) || '未收口'}`
  const bulletBudget = Math.max(0, SUMMARY_BODY_MAX_CHARS - conclusionText.length - 1)
  const bulletText = clipText(bullets, bulletBudget)
  let text = `${head}\n${bulletText ? `${bulletText}\n` : ''}${conclusionText}`

  // 记录级兜底：前缀 + 正文两道上限都满足时这里不会触发；留着是为了"总长有上界"
  // 在任意入参下都成立（调用方也会按 1,200 截断，双保险不冲突）。
  if (text.length > SUMMARY_MAX_CHARS) {
    const budget = Math.max(0, SUMMARY_MAX_CHARS - head.length - 1 - conclusionText.length - 1)
    const clipped = clipText(bulletText, budget)
    text = `${head}\n${clipped ? `${clipped}\n` : ''}${conclusionText}`
    if (text.length > SUMMARY_MAX_CHARS) text = text.slice(0, SUMMARY_MAX_CHARS)
  }
  return text
}

// ── 蒸馏调用 ────────────────────────────────────────────────────────────────

/**
 * 调主持 Bot 的模型蒸一段摘要。
 *
 * 只做一件事：把拼好的 prompt 交给 `llm.stream()`，累加 `text-delta`。**不自己挑模型**
 * （模型由 `index.modelForRoom(roomId)` 在 capture 侧决定），也不重试（重试会把轮末
 * 拖超时；失败就是"这一轮前文不进记忆"，见 §3.6）。
 *
 * 为什么必须和 abort 赛跑，而不是只靠 `signal`：`for await` 能否返回取决于上游实现，
 * 一个永不结束/永不响应中止的 stream 会把 turn-stopping 挂死。超时以 abort 事件为准；
 * 竞速失败的一方（run）要挂空 catch，否则它之后抛出的 rejection 会变成
 * unhandledRejection，把宿主进程带崩。
 */
export async function distillRoom({
  llm,
  model,
  roomName,
  windowText,
  memoryEntries,
  timeoutMs = DISTILL_TIMEOUT_MS,
  maxTokens = DISTILL_MAX_TOKENS,
  sessionId,
} = {}) {
  if (!llm || typeof llm.stream !== 'function') return { ok: false, reason: 'no-llm' }

  const provider = typeof model?.provider === 'string' ? model.provider.trim() : ''
  const modelId = typeof model?.model === 'string' ? model.model.trim() : ''
  if (!provider || !modelId) return { ok: false, reason: 'no-model' }

  const prompt = buildDistillPrompt({ roomName, windowText, memoryEntries })
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DISTILL_TIMEOUT_MS
  const tokens = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : DISTILL_MAX_TOKENS
  const deadlineAt = Date.now() + ms

  /**
   * 消息必须是**完整消息**（`id` + `role` + `content` + `source`）。
   *
   * 为什么不是裸的 `{ role, content }`：dsh-llm 的 `createUserMessage()` 会补
   * `id = randomUUID()` 与 `source`，而适配器按消息做投影/回放时依赖这两个字段。
   */
  const userMessage = (text) => ({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'dsh-tdai-memory-distill' },
  })

  const pickEffort = (info) => {
    const efforts = Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts : []
    return (efforts.find((item) => item?.id === 'off') ?? efforts[0])?.id
  }

  /**
   * 跑一次。`withSystem=false` 时把系统段折进 user —— 这是"模型返回空消息"的降级路径，
   * 有些路由会丢掉单独的 `system` 字段，折进去就一定能被模型看到。
   */
  const attempt = async ({ withSystem, mode = 'prepared' }) => {
    const remaining = Math.max(1, deadlineAt - Date.now())
    const signal = AbortSignal.timeout(remaining)
    const system = withSystem ? prompt.system : ''
    const user = withSystem ? prompt.user : `${prompt.system}\n\n${prompt.user}`
    const message = userMessage(user)

    let options
    let stream
    const usePrepareCall = mode !== 'plain' && typeof llm.prepareCall === 'function'
    if (usePrepareCall) {
      try {
        const call = await llm.prepareCall({ provider, model: modelId, maxTokens: tokens }, signal, (controls, info) => {
          const effort = pickEffort(info)
          return typeof effort === 'string' && effort ? { ...controls, reasoningEffort: effort } : controls
        })
        options = {
          ...call.config,
          messages: [message],
          signal,
          // ⚠️ opencode-go 用 `sessionId` 填 `x-opencode-session` 头；缺了就是 400。
          ...(typeof sessionId === 'string' && sessionId ? { sessionId } : {}),
          ...(withSystem ? { system } : {}),
        }
        stream = call.stream.bind(call)
      } catch (error) {
        return {
          ok: false,
          reason: signal.aborted ? 'timeout' : 'error',
          detail: { stage: 'prepareCall', message: String(error?.message ?? error) },
        }
      }
    } else {
      // 老宿主 / 测试替身：手动解析档位后直接 stream。
      let effort
      try {
        const info = await llm.resolveModelInfo?.(provider, modelId, signal)
        effort = pickEffort(info)
      } catch {
        effort = undefined
      }
      options = {
        provider,
        model: modelId,
        messages: [message],
        maxTokens: tokens,
        signal,
        ...(typeof sessionId === 'string' && sessionId ? { sessionId } : {}),
        ...(withSystem ? { system } : {}),
        ...(typeof effort === 'string' && effort ? { reasoningEffort: effort } : {}),
      }
      stream = (opts) => llm.stream(opts)
    }

    const startedAt = Date.now()
    const TIMED_OUT = Symbol('timeout')
    let text = ''
    /** 只在没有任何 text-delta 时才用它：有些适配器/非流式回退只发 `text_end`（block-end）。 */
    let blockText = ''
    let reasoningChars = 0
    let finish
    let usage
    let outputTokens
    const chunkTypes = {}
    const firstChunks = []

    const run = (async () => {
      try {
        for await (const chunk of stream(options)) {
          // 中止后不再累加：已收到的半截摘要不能当成功结果写进 L0。
          if (signal.aborted) break
          const chunkType = String(chunk?.type ?? 'unknown')
          chunkTypes[chunkType] = (chunkTypes[chunkType] ?? 0) + 1
          if (firstChunks.length < 3) {
            try {
              firstChunks.push(JSON.stringify(chunk).slice(0, 240))
            } catch {
              firstChunks.push(`<unserializable ${chunkType}>`)
            }
          }
          switch (chunk?.type) {
            case 'text-delta':
              if (typeof chunk.text === 'string') text += chunk.text
              break
            case 'block-end':
              // 非流式回退：整块文本只在 block-end 里。有 delta 时不拼，避免重复。
              if (chunk?.block?.type === 'text' && typeof chunk.block.text === 'string') {
                blockText += chunk.block.text
              }
              break
            case 'reasoning-delta':
              if (typeof chunk.text === 'string') reasoningChars += chunk.text.length
              break
            case 'finish':
              finish = chunk.reason
              break
            case 'usage':
              usage = chunk.usage
              if (Number.isFinite(chunk?.usage?.outputTokens)) outputTokens = chunk.usage.outputTokens
              break
            default:
              break
          }
        }
        return { kind: 'done' }
      } catch (error) {
        return { kind: signal.aborted ? 'timeout' : 'error', message: String(error?.message ?? error) }
      }
    })()

    const aborted = new Promise((resolve) => {
      if (signal.aborted) {
        resolve(TIMED_OUT)
        return
      }
      signal.addEventListener('abort', () => resolve(TIMED_OUT), { once: true })
    })

    const winner = await Promise.race([run, aborted])
    if (winner === TIMED_OUT || signal.aborted) {
      return { ok: false, reason: 'timeout', detail: { elapsedMs: Date.now() - startedAt, budgetMs: ms, chunks: chunkTypes } }
    }
    if (winner.kind === 'timeout') {
      return { ok: false, reason: 'timeout', detail: { elapsedMs: Date.now() - startedAt, budgetMs: ms, chunks: chunkTypes } }
    }
    if (winner.kind === 'error') {
      return { ok: false, reason: 'error', detail: { stage: 'stream', message: winner.message } }
    }

    const finishKind = finish?.kind
    // 终端失败是"错误"，不是"空输出"（供应商报错曾被伪装成 empty，现场查了两轮）。
    if (finishKind === 'error') {
      return { ok: false, reason: 'error', detail: { finishReason: finishKind, failure: finish?.failure } }
    }
    if (finishKind === 'aborted') {
      return { ok: false, reason: 'timeout', detail: { finishReason: finishKind, failure: finish?.failure } }
    }

    const out = (text || blockText).trim()
    if (!out) {
      return {
        ok: false,
        reason: 'empty',
        detail: {
          finishReason: finishKind,
          outputTokens,
          reasoningChars,
          textDeltas: text.length,
          blockEndChars: blockText.length,
          failure: finish?.failure,
          // 请求侧发了什么、适配器吐了哪些 chunk、usage 长什么样 —— 一次看全。
          sent: {
            provider,
            model: modelId,
            maxTokens: tokens,
            withSystem,
            path: usePrepareCall ? 'prepareCall' : 'stream',
            systemChars: system.length,
            userChars: user.length,
            hasSessionId: Boolean(sessionId),
            reasoningEffort: options.reasoningEffort,
          },
          chunks: chunkTypes,
          firstChunks,
          finishRaw: (() => {
            try {
              return JSON.stringify(finish).slice(0, 300)
            } catch {
              return undefined
            }
          })(),
          usage,
        },
      }
    }
    return { ok: true, text: out, finishReason: finishKind, usedFallback: !withSystem }
  }

  /**
   * 降级阶梯（只在"成功但空"时走，且共享同一个 deadline）：
   *   1. `prepareCall` + system          —— 标准路径
   *   2. `prepareCall`，system 折进 user —— 怀疑独立 system 被路由丢掉
   *   3. 直接 `llm.stream`（不走 prepareCall）—— 怀疑 prepared 句柄本身有问题
   *
   * 每一步的 detail 都挂在台账里，哪一步成功就是答案；三步都空则说明问题在更上游
   * （中间件/适配器），台账里的 `firstChunks` / `finishRaw` 会给出原始证据。
   */
  const ladder = [
    { withSystem: true, mode: 'prepared' },
    { withSystem: false, mode: 'prepared' },
    { withSystem: true, mode: 'plain' },
  ]
  let firstFailure
  for (const [index, step] of ladder.entries()) {
    if (index > 0 && Date.now() >= deadlineAt) break
    const result = await attempt(step)
    if (result.ok) {
      return index === 0 ? result : { ...result, usedFallback: true, fallbackStep: index }
    }
    const retryable = result.reason === 'empty' && result.detail?.finishReason === 'stop'
    if (index === 0) firstFailure = result
    else if (firstFailure) {
      firstFailure.detail ??= {}
      firstFailure.detail[`retry${index}`] = result.detail ?? { reason: result.reason }
    }
    if (!retryable) break
  }
  return firstFailure
}

// ── 内部工具 ────────────────────────────────────────────────────────────────

/** 房间名进前缀行前先压成单行（含全角空格），并限长。 */
function roomNameFor(roomName) {
  const text = String(roomName ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return '未命名房间'
  return clipText(text, ROOM_NAME_MAX_CHARS)
}

/** 背景条目归一：只收字符串、补 "- " 前缀、按上限截断（调用方传脏数据也不至于超预算）。 */
function normalizeMemoryEntries(entries) {
  if (!Array.isArray(entries)) return []
  const out = []
  for (const entry of entries) {
    const text = typeof entry === 'string' ? entry.trim() : ''
    if (!text) continue
    out.push(clipText(text.startsWith('- ') ? text : `- ${text}`, MEMORY_ENTRY_MAX_CHARS))
    if (out.length >= MEMORY_MAX_ENTRIES) break
  }
  return out
}

/**
 * 正文拆成「bullet 部分」与「结论」。
 *
 * 结论取**最后**一条 `结论：` 行（模型偶尔先写一句"结论待定"再给真正的结论），
 * 其余非空行按原序拼回 bullet 部分（不强行改写成 `- `：改写会掩盖模型跑偏，
 * 而前缀行是否是 bullet 只影响可读性，不影响 L0 语义）。
 */
function splitBody(body) {
  const lines = String(body ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  let conclusionIndex = -1
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (CONCLUSION_RE.test(lines[i]) || BARE_CONCLUSION_RE.test(lines[i])) {
      conclusionIndex = i
      break
    }
  }

  const conclusion = conclusionIndex >= 0
    ? lines[conclusionIndex].replace(CONCLUSION_RE, '').trim()
    : ''
  // 除了保留的最后一条，前面出现过的「结论：」行也一并丢掉，避免正文里出现两行结论。
  const bullets = lines.filter((line, index) => index !== conclusionIndex && !CONCLUSION_RE.test(line)).join('\n')
  return { bullets, conclusion }
}

function clipWindow(text) {
  if (text.length <= WINDOW_INPUT_MAX_CHARS) return text
  return text.slice(-WINDOW_INPUT_MAX_CHARS)
}

/** 截断到 `max` 字符（含省略号）；`max <= 0` 返回空串。 */
function clipText(value, max) {
  const text = String(value ?? '')
  if (max <= 0) return ''
  if (text.length <= max) return text
  if (max === 1) return '…'
  return `${text.slice(0, max - 1)}…`
}

/** seq 可能缺失（日志行不完整）；缺失时前缀行里写 `?`，不编造数字。 */
function seqText(seq) {
  if (Number.isFinite(seq)) return String(seq)
  const text = typeof seq === 'string' ? seq.trim() : ''
  return text || '?'
}
