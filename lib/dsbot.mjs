/**
 * ds-bot 会话索引与读侧策略：**只读** ds-bot 的 `state.json`，把会话分成四态，
 * 并给出该会话的读侧能力面 / 写侧许可。
 *
 * 方案：docs/proposals/ds-bot-tdai-integration/minimal.md（人读稿）
 *       docs/proposals/ds-bot-tdai-integration/minimal.agents.md（执行层）
 * 时序证据：docs/proposals/ds-bot-tdai-integration/timing-probe.md
 *
 * ── 为什么需要这个文件 ──────────────────────────────────────────────────────
 *
 * ds-bot 把「一个 Bot 的私聊」「一个群的房间会话」「群成员的隐藏会话」都实现成**普通
 * DSH 会话**，插件侧从 `session.header` 完全看不出区别。不识别它们的后果实测过：
 *   - Bot 会话里白背 7,339 字符 `<session_context>` 与 3,158 字符 `<tdai_profile_memory>`；
 *   - 群聊每轮都是一次 `group_relay` 工具调用（129/129 轮收尾步无文本），
 *     按普通会话回流会把 74% 的 relay 字符当成真人记忆写进 L0。
 *
 * 判据只有一个：ds-bot 自己的 `state.json`。**不能按 cwd 推断** —— 实测 `ARK-Alpha`
 * 的 `bots[*].sessionId` 落在 `--mnt-d-workspace--`（因为它的 `workDir=/mnt/d/workspace`），
 * 「会话在不在 bot workspace 下」这条会把 Bot 会话反向错判成普通会话。
 *
 * ── 四态 ────────────────────────────────────────────────────────────────────
 *
 * | kind | 判定 | 读侧 | 写侧 |
 * | --- | --- | --- | --- |
 * | `bot` | `bots` 键名 / `bots[*].sessionId` / `bots[*].segments[*].sessionId` | lean（只 skill） | 按人锚点写回合 |
 * | `room` | `rooms` 键名 | lean | 按人锚点写回合（含前文蒸馏） |
 * | `room-member` | `rooms[*].sessions` 的值 / `rooms[*].segments[*][*].sessionId` | lean | **永不写** |
 * | `ordinary` | 其余全部 | 原逻辑（子会话降级照旧） | 原逻辑 |
 *
 * `bots[*].segments`（rollover 旧段）在真实数据里 5 个 Bot 全是空、3 个房间有 1 个没有
 * `segments` 键 —— 所有遍历都必须容忍缺失，缺了就当没有。
 *
 * ── lean 策略为什么是这四项 ──────────────────────────────────────────────────
 *
 * - `identity=false`：`<session_context>` 装的是 tdai agent 的角色与规则，而 ds-bot 的
 *   `# Your identity` 已经在同一份 system prompt 里；两边各写一份必漂移，角色权威归 ds-bot。
 * - `memory=false`：本阶段没有「每 Bot 一个 tdai agent」，开 L3/L1 等于所有 Bot 共用一份
 *   人物画像，且 Bot 之间的讨论会被抽成"关于人"的证据。
 * - `skills=true`（受 `botSkillInjectEnabled` 约束）：云端 skill 是**按轮检索**的能力面，
 *   与身份无关，Bot 干活真用得上。
 * - `knowledge=true`：知识面从来不是噪音（子 agent 那次真实事故就是把它和记忆混在一个闸门里）。
 *
 * 这两条（identity / memory 恒 false）**不是开关**：面板上一个能开的东西，早晚会被当成
 * 受支持的用法。真要调试就改代码走 `inherit`。
 *
 * ── 有效值只在两处算 ────────────────────────────────────────────────────────
 *
 * `sessionPolicy()` 里的 `skillInject` / `writeback`，以及导出的 `writebackAllowedFor()`。
 * 调用点**不许**直接读 `cfg.botSkillInjectEnabled` / `cfg.botWritebackEnabled`，否则
 * 「受全局开关影响」这件事迟早漏在某个分支里。
 */

import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { captureAllowed, isSubagentSession, subagentReadPolicy } from './subagent.mjs'

/** state.json 的 mtime 缓存时长（轮末定位时用 `forceRefresh()` 跳过一次）。 */
export const STATE_CACHE_MS = 5000

/**
 * 群聊 pending 的重试上限（常量，不进配置）。
 *
 * 实测 3/13 的锚点晚 22–23 秒才进 room log；一次 turn-stopping 间隔通常十几秒，
 * 3 次 ≈ 一分钟没等到就放弃，避免一条锚点把后续窗口永久卡住。
 */
export const ANCHOR_RETRY_LIMIT = 3
export const ANCHOR_RETRY_WINDOW_MS = 600000

/**
 * DSH 主目录。
 *
 * 优先 `DSH_HOME`（宿主/测试注入），否则 `~/.dsh`。**不要**把它写死成用户名路径：
 * 现场验收脚本与测试都要能在临时目录里跑。
 */
export function resolveDshHome(explicit) {
  const text = typeof explicit === 'string' ? explicit.trim() : ''
  if (text) return text
  const env = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return env || join(homedir(), '.dsh')
}

/** 台账里的短哈希（锚点/内容指纹用，sha1 前 12 位足够区分）。 */
export function shortHash(text) {
  return createHash('sha1').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 12)
}

/**
 * 锚点/日志文本的规范化：空白折叠 + 去零宽 + 去首尾空白。
 *
 * 只做"稳定化"，不做模糊匹配：**空格与全角空格差异必须消掉**（真人手打 vs ds-bot
 * 转存的换行），但不做编辑距离 —— 宁可定位失败挂 pending，也不要把别人的话认成这条锚点。
 */
export function normalizeAnchorText(text) {
  return String(text ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u00A0\u3000]/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .trim()
}

/** `provider/model` 拆分；拆不出返回 undefined（调用方据此跳过蒸馏）。 */
export function parseModelRef(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  const slash = text.indexOf('/')
  if (slash <= 0 || slash === text.length - 1) return undefined
  return { provider: text.slice(0, slash), model: text.slice(slash + 1) }
}

// ── Bot 会话的 skill query ───────────────────────────────────────────────────

/**
 * ds-bot 投递给 Bot 的消息信封。逐条剥掉后才能当检索 query 用。
 *
 * 实测形态（`ds-bot/src/host/parts.js` 的 `format*`）：
 *   `[Group post from PM]`、`[Group chat "TDAI-memory DS Bot 集成" · your turn]`、
 *   `[Bot team setup]`、`[Handoff · part 1]`、`[Checkpoint 3]`
 */
const ENVELOPE_RE = /^\[(?:group post from [^\]\n]*|group chat[^\]\n]*|bot team setup|handoff[^\]\n]*|checkpoint[^\]\n]*)\]\s*/i

/** 剥掉开头的 ds-bot 信封行（可能有多个嵌套，最多剥 4 层）。 */
/**
 * 剥掉 `dsh-ui` 代码块，换成一行标记。
 *
 * 为什么必须剥：Bot 的终稿是 Markdown，里面可能嵌 `\`\`\`dsh-ui {...}` 的 UI spec。
 * 那段 JSON 是给渲染器看的，不是给读者看的——原样写进 L0 会同时造成两件事：
 * ① 吃掉 `RECORD_MAX_CHARS` 的预算（一张卡片动辄几百到上千字符）；
 * ② 让 L1 抽取把 `"type":"table","columns":[...]` 这类键名当对话内容。
 *
 * 为什么留标记而不是删干净：读的人（和抽取模型）需要知道"这里原本有一张卡片"，
 * 否则上下文会出现莫名断层。
 *
 * @param text - 原始助手文本。
 * @returns 剥掉 UI 块并压平多余空行的文本。
 */
export function stripUiFences(text) {
  if (typeof text !== 'string' || text.length === 0) return ''
  const replaced = text
    // 完整块（含结尾围栏）
    .replace(/```dsh-ui\b[\s\S]*?```/g, '\n[结构化卡片]\n')
    // 未闭合的尾巴（流式被截断时的常见形态）
    .replace(/```dsh-ui\b[\s\S]*$/, '\n[结构化卡片]\n')
  return replaced
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function stripBotEnvelopes(text) {
  let out = String(text ?? '').replace(/^\s+/, '')
  for (let i = 0; i < 4; i += 1) {
    if (!ENVELOPE_RE.test(out)) break
    out = out.replace(ENVELOPE_RE, '')
  }
  return out.trim()
}

/**
 * 群聊投递正文里"本轮前文"那一段。
 *
 * ds-bot 的群消息长这样：`... This round so far ... <历史> ... Speaking order: ...`。
 * 任一端缺失就返回空串，由调用方退回"剥信封后的全文"。
 */
export function extractRoomRoundBody(text) {
  const source = String(text ?? '')
  const start = source.search(/this round so far/i)
  if (start === -1) return ''
  const tail = source.slice(start + 'this round so far'.length)
  const end = tail.search(/\bspeaking order\b/i)
  return (end === -1 ? tail : tail.slice(0, end)).trim()
}

/**
 * Bot 会话的 skill 检索 query：取**最近一条**可用的 user 消息，按来源分别处理。
 *
 * ── 为什么不能只认 `kind === 'bot'`（现场踩过）──────────────────────────────
 *
 * 我最初按方案写成"只取最后一条 `kind='bot'` 的 user 消息"——那是**群聊 relay**的形态。
 * 但私聊（DM）里，真人发的话是以 `source.kind === 'user'` 直接进来的（实测 2026-10-22
 * 23:55 的 ARK-Alpha 会话：真人消息 kind='user'，只有握手包是 kind='bot'）。只认 bot
 * 的结果是 DM 轮 query 恒空 → `agent/pre-step` 提前返回 → **自动 skill 召回一次都没发生**，
 * 只能靠 Bot 自己手动调 `tdai_skill_search`。现场核过的证据：那次会话里两次
 * `/v3/skill/search` 的时间戳与 Bot 的 `tdai_skill_search` 工具调用完全重合，自动召回 0 次。
 *
 * 现在的口径：从后往前找 role=user 且 `kind ∈ {user, bot}` 的消息，**谁最近用谁**：
 *   - `kind='user'`（DM 真人）：原文即 query；
 *   - `kind='bot'`（群聊 relay / 握手包）：剥信封；群聊取 `This round so far` 到
 *     `Speaking order` 之间的本轮正文，兜底全文；
 *   - 其余 kind（plugin / runtime-context / time-context / skill-catalog /
 *     user-question-reply）一律跳过——那些不是"人要求 Bot 做什么"。
 *
 * 为什么不用 `buildSkillQuery()`（普通会话那条）：普通会话取"真人最近几条"并清洗，
 * 在 Bot 会话里会把 relay 包也当真人话；而 DM 与群聊的 query 语义本来就不同
 * （DM = 用户问什么，群聊 = 本轮前文），所以这里按来源分流。
 *
 * @param messages DSH 的 `payload.messages`
 * @param opts.chars 字符上限（默认 512）
 */
export function buildBotSkillQuery(messages, { chars = 512 } = {}) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role !== 'user') continue
    const kind = message?.source?.kind
    if (kind !== 'user' && kind !== 'bot') continue
    const raw = messageText(message.content)
    if (!raw) continue
    if (kind === 'bot') {
      const stripped = stripBotEnvelopes(raw)
      const body = extractRoomRoundBody(stripped) || stripped
      const query = body.replace(/\s+/g, ' ').trim()
      if (!query) continue
      return query.length > chars ? query.slice(-chars) : query
    }
    const query = raw.replace(/\s+/g, ' ').trim()
    if (!query) continue
    return query.length > chars ? query.slice(-chars) : query
  }
  return ''
}

/** 从 content（字符串或 blocks 数组）取纯文本；非文本块（工具/图片）跳过。 */
function messageText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part && (part.type === 'text' || part.type === undefined))
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
}

// ── 写侧许可 ────────────────────────────────────────────────────────────────

/**
 * 写侧有效值（**唯一计算点之一**）。
 *
 * - 普通会话：原逻辑（`captureAllowed`，子会话默认不回流）；
 * - 群成员隐藏会话：永不写（它的内容就是群聊轮次的另一份副本）；
 * - Bot 私聊 / 房间：`dsbotAwarenessEnabled && botWritebackEnabled && captureEnabled`。
 *
 * @param cfg     resolveConfig 的结果
 * @param session DSH session
 * @param info    `lookup()` 的返回值（不传则按普通会话处理）
 */
export function writebackAllowedFor(cfg, session, info) {
  const kind = info?.kind ?? 'ordinary'
  if (kind === 'ordinary') return captureAllowed(cfg, session)
  if (kind === 'room-member') return false
  return Boolean(cfg?.dsbotAwarenessEnabled && cfg?.botWritebackEnabled && cfg?.captureEnabled)
}

// ── 索引 ────────────────────────────────────────────────────────────────────

/**
 * state.json 索引。
 *
 * 生命周期：`agent/created` / 写侧入口处 `refresh()`（惰性 + mtime 缓存），群聊轮末
 * `refresh({ force: true })`。台账持有上一次成功的索引快照，state.json 读不到时用它
 * 兜底（`source: 'stale'`）—— 读侧照常 lean，写侧停写并告警。
 */
export class DsbotIndex {
  #dshHome
  #ledger
  #log
  #cacheMs
  #state = undefined
  #stateAt = 0
  #mtimeMs = 0
  #ok = false
  #reason = ''
  #sessions = new Map()
  #bots = new Map()
  #rooms = new Map()
  #signals = new Set()
  #persistedSig = ''

  constructor({ dshHome, ledger, log, cacheMs = STATE_CACHE_MS } = {}) {
    this.#dshHome = resolveDshHome(dshHome)
    this.#ledger = ledger
    this.#log = typeof log === 'function' ? log : () => {}
    this.#cacheMs = cacheMs
    this.#restoreFromLedger()
  }

  get dshHome() {
    return this.#dshHome
  }

  statePath() {
    return join(this.#dshHome, 'bot', 'state.json')
  }

  /**
   * 从台账恢复上一次成功的索引。
   *
   * 为什么需要：`state.json` 读不到（JSON 半写/权限/被清理）时，如果把会话当普通会话
   * 处理，Bot 会话会被**全量回流**——这是最坏的一种污染。台帐里有索引就按 stale 用，
   * 同时写侧停写。
   */
  #restoreFromLedger() {
    const index = this.#ledger?.getIndex?.()
    if (!index || typeof index !== 'object') return
    if (Number.isFinite(index.stateMtimeMs)) this.#mtimeMs = index.stateMtimeMs
    const sessions = index.sessions
    if (sessions && typeof sessions === 'object') {
      for (const [sid, info] of Object.entries(sessions)) {
        if (sid && info && typeof info === 'object') this.#sessions.set(sid, normalizeKindInfo(info))
      }
    }
    if (Array.isArray(index.signals)) for (const sid of index.signals) if (sid) this.#signals.add(sid)
    if (this.#sessions.size > 0) this.#reason = 'state.json 尚未读取，索引来自台账'
  }

  /** 读 state.json（mtime 缓存；`force` 跳过缓存）。 */
  async refresh({ force = false } = {}) {
    const path = this.statePath()
    const now = Date.now()
    if (!force && this.#ok && now - this.#stateAt < this.#cacheMs) return this.status()

    let fileStat
    try {
      fileStat = await stat(path)
    } catch (error) {
      this.#fail(`state.json 不可读（${error?.code ?? error?.message ?? error}）`)
      return this.status()
    }
    if (!force && this.#ok && fileStat.mtimeMs === this.#mtimeMs) {
      this.#stateAt = now
      return this.status()
    }

    let text
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      this.#fail(`state.json 读取失败（${error?.code ?? error?.message ?? error}）`)
      return this.status()
    }

    let state
    try {
      state = JSON.parse(text)
    } catch (error) {
      // 半写/PID 写坏的 JSON：保留上一份索引（stale），不推断成"空状态"。
      this.#fail(`state.json 解析失败（${error?.message ?? error}）`)
      return this.status()
    }
    if (!state || typeof state !== 'object') {
      this.#fail('state.json 顶层不是对象')
      return this.status()
    }

    this.#state = state
    this.#mtimeMs = Number.isFinite(fileStat.mtimeMs) ? fileStat.mtimeMs : Date.now()
    this.#stateAt = now
    this.#ok = true
    this.#reason = ''
    this.#rebuild(state)
    this.#persist()
    return this.status()
  }

  /** 群聊/写侧入口用：强制刷一次（跳过 mtime 缓存，但 mtime 没变仍不重建）。 */
  forceRefresh() {
    return this.refresh({ force: true })
  }

  /** 状态行（`/tdai-status`、告警文案、测试断言用）。 */
  status() {
    return {
      ok: this.#ok,
      stale: this.#sessions.size > 0 && !this.#ok,
      reason: this.#reason,
      path: this.statePath(),
      mtimeMs: this.#mtimeMs,
      bots: this.#bots.size,
      rooms: this.#rooms.size,
      sessions: this.#sessions.size,
      signals: this.#signals.size,
    }
  }

  #fail(reason) {
    this.#ok = false
    this.#reason = reason
    this.#log(`[dsbot] ${reason}（${this.statePath()}）；${this.#sessions.size > 0 ? '沿用台账里的旧索引，写侧停写' : '没有可用索引，Bot 会话按普通会话处理'}`)
  }

  #rebuild(state) {
    const sessions = new Map()
    const bots = new Map()
    const rooms = new Map()

    // 先房间、后 Bot：Bot 的判定更具体，冲突时以 Bot 为准（两者 id 空间本不该重叠）。
    for (const [roomId, room] of Object.entries(state.rooms && typeof state.rooms === 'object' ? state.rooms : {})) {
      if (!room || typeof room !== 'object') continue
      rooms.set(roomId, {
        roomId,
        name: typeof room.name === 'string' ? room.name : '',
        admin: typeof room.admin === 'string' ? room.admin : '',
        members: Array.isArray(room.members) ? room.members.slice() : [],
        seq: Number.isFinite(room.seq) ? room.seq : undefined,
        log: Array.isArray(room.log) ? room.log : [],
        sessions: room.sessions && typeof room.sessions === 'object' ? room.sessions : {},
        segments: room.segments && typeof room.segments === 'object' ? room.segments : {},
      })
      sessions.set(roomId, { kind: 'room', botId: '', roomId })
      for (const sid of Object.values(rooms.get(roomId).sessions)) {
        if (typeof sid === 'string' && sid) sessions.set(sid, { kind: 'room-member', botId: '', roomId })
      }
      for (const list of Object.values(rooms.get(roomId).segments)) {
        for (const seg of Array.isArray(list) ? list : []) {
          const sid = seg?.sessionId
          if (typeof sid === 'string' && sid) sessions.set(sid, { kind: 'room-member', botId: '', roomId })
        }
      }
    }

    for (const [botId, bot] of Object.entries(state.bots && typeof state.bots === 'object' ? state.bots : {})) {
      if (!bot || typeof bot !== 'object') continue
      bots.set(botId, {
        botId,
        name: typeof bot.name === 'string' ? bot.name : '',
        model: typeof bot.model === 'string' ? bot.model : '',
        workDir: typeof bot.workDir === 'string' ? bot.workDir : '',
        sessionId: typeof bot.sessionId === 'string' ? bot.sessionId : '',
      })
      sessions.set(botId, { kind: 'bot', botId, roomId: '' })
      if (typeof bot.sessionId === 'string' && bot.sessionId) {
        sessions.set(bot.sessionId, { kind: 'bot', botId, roomId: '' })
      }
      for (const seg of Array.isArray(bot.segments) ? bot.segments : []) {
        const sid = seg?.sessionId
        if (typeof sid === 'string' && sid) sessions.set(sid, { kind: 'bot', botId, roomId: '' })
      }
    }

    this.#sessions = sessions
    this.#bots = bots
    this.#rooms = rooms
    // 见过 kind=bot 的会话 id 永久记账：Bot 换会话后，旧 id 再出现也按 Bot 处理（宁可停写）。
    for (const [sid, info] of sessions) if (info.kind === 'bot') this.#signals.add(sid)
  }

  /**
   * 索引快照落台账。
   *
   * 只在内容变化时写（state.json 每次落盘 mtime 都会变，但索引通常没变），避免
   * 每轮一次无意义的原子写。台账损坏/停写时静默跳过 —— 索引只是"锦上添花的记忆"，
   * 不该因为它把主链路拖垮。
   */
  #persist() {
    if (!this.#ledger?.recordIndex) return
    const sessions = {}
    for (const [sid, info] of this.#sessions) sessions[sid] = info
    const signals = [...this.#signals]
    const sig = JSON.stringify([this.#mtimeMs, sessions])
    if (sig === this.#persistedSig) return
    this.#persistedSig = sig
    try {
      this.#ledger.recordIndex({ stateMtimeMs: this.#mtimeMs, sessions, signals })
    } catch (error) {
      this.#log(`[dsbot] 索引写台账失败：${error?.message ?? error}`)
    }
  }

  /**
   * 会话 id → 四态。
   *
   * - 命中索引：`{kind, botId, roomId, source: 'state'|'stale'}`；
   * - 只在信号里出现过（Bot 换会话后的旧 id）：`{kind:'bot', botId:'', source:'signal'}`，
   *   写侧据此**停写并告警**，不做任何推断；
   * - 其余：`{kind:'ordinary'}`。
   */
  lookup(sessionId) {
    const id = typeof sessionId === 'string' ? sessionId : ''
    if (!id) return { kind: 'ordinary', source: 'none' }
    const hit = this.#sessions.get(id)
    if (hit) return { ...hit, source: this.#ok ? 'state' : 'stale' }
    if (this.#signals.has(id)) return { kind: 'bot', botId: '', roomId: '', source: 'signal' }
    return { kind: 'ordinary', source: 'none' }
  }

  /**
   * 读侧策略（**唯一计算点**）。返回的是 `subagentReadPolicy()` 的**超集**：
   * 多出 `bot / kind / botId / roomId / sessionId / skillInject / writeback` 六个字段。
   *
   * 为什么必须保留 `subagent` / `inherit`：`test/subagent.test.mjs` 对策略做
   * `deepEqual`，`/tdai-status` 也靠这两项解释"为什么少了某些段"。
   */
  sessionPolicy(cfg, session) {
    const sessionId = typeof session?.id === 'string' ? session.id : ''
    const subagent = isSubagentSession(session)
    const info = this.lookup(sessionId)

    if (!cfg?.dsbotAwarenessEnabled || info.kind === 'ordinary') {
      const base = subagentReadPolicy(cfg, session)
      return {
        ...base,
        bot: false,
        kind: 'ordinary',
        botId: '',
        roomId: '',
        sessionId,
        skillInject: Boolean(base.skills && cfg?.enabled && cfg?.skillsEnabled),
        writeback: captureAllowed(cfg, session),
      }
    }

    // Bot / 房间 / 群成员隐藏会话：一律 lean。identity 与 memory 恒 false（不是开关）。
    const facet = Boolean(cfg.botSkillInjectEnabled)
    // state.json 读不到（只能靠台账 stale 索引）或该会话只以 signal 形式存在时**停写**：
    // 读侧可以按旧索引继续 lean，写侧不能按旧索引硬写（§3.6「停写 + 告警」）。
    const writable = this.#ok && info.source !== 'signal'
    return {
      subagent,
      inherit: false,
      bot: true,
      kind: info.kind,
      botId: info.botId ?? '',
      roomId: info.roomId ?? '',
      sessionId,
      identity: false,
      memory: false,
      skills: facet,
      knowledge: true,
      skillInject: Boolean(facet && cfg.enabled && cfg.skillsEnabled),
      writeback: writable ? writebackAllowedFor(cfg, session, info) : false,
    }
  }

  /** 写侧许可（`sessionPolicy().writeback` 的独立入口，供 capture 在事件阶段快速判定）。 */
  writebackAllowed(cfg, session) {
    const info = this.lookup(session?.id)
    if (info.kind !== 'ordinary' && (!this.#ok || info.source === 'signal')) return false
    return writebackAllowedFor(cfg, session, info)
  }

  /** 房间的日志与元信息（未命中返回 undefined）。 */
  roomLog(roomId) {
    const room = this.#rooms.get(roomId)
    if (!room) return undefined
    const lines = room.log
      .filter((line) => line && typeof line === 'object')
      .map((line) => ({
        seq: line.seq,
        who: typeof line.who === 'string' ? line.who : '',
        botId: typeof line.botId === 'string' ? line.botId : undefined,
        text: typeof line.text === 'string' ? line.text : '',
        truncated: line.length !== undefined,
        length: Number.isFinite(line.length) ? line.length : undefined,
      }))
      .filter((line) => Number.isFinite(line.seq))
    const seqs = lines.map((line) => line.seq)
    return {
      roomId,
      name: room.name,
      adminBotId: room.admin,
      members: room.members,
      seq: room.seq,
      lines,
      firstSeq: seqs.length > 0 ? Math.min(...seqs) : undefined,
      lastSeq: seqs.length > 0 ? Math.max(...seqs) : undefined,
      truncated: lines.filter((line) => line.truncated).length,
    }
  }

  /**
   * 在 room log 里定位一条真人锚点。
   *
   * 规则（写死，见 minimal.agents.md §2 第 7 步）：
   *   - 只认 `who === 'User'` 且**没有** `botId` 的行（真人行只有 `seq/text/who`）；
   *   - 文本规范化后**完全相等**；被 `TEXT_KEPT=2000` 截断的行允许"日志是锚点的前缀"；
   *   - 候选 = `seq > afterSeq` 的行；恰好 1 条才算命中，0 条是未命中，≥2 条是**歧义**
   *     （同样视为未命中：宁可挂 pending，也不要把别人的话认成这条）。
   *
   * @returns {{hit:true,line:object}|{hit:false,reason:'not-found'|'ambiguous'|'no-room',candidates?:number[]}}
   */
  locateAnchor(roomId, text, { afterSeq = 0 } = {}) {
    const log = this.roomLog(roomId)
    if (!log) return { hit: false, reason: 'no-room' }
    const needle = normalizeAnchorText(text)
    if (!needle) return { hit: false, reason: 'not-found' }
    const candidates = log.lines.filter((line) => {
      if (line.who !== 'User') return false
      if (line.botId !== undefined) return false
      if (!Number.isFinite(line.seq) || line.seq <= afterSeq) return false
      const stored = normalizeAnchorText(line.text)
      if (!stored) return false
      // 截断行：日志只存了前 2000 字符，锚点更长时按前缀匹配。
      return line.truncated ? needle.startsWith(stored) : stored === needle
    })
    if (candidates.length === 1) return { hit: true, line: candidates[0] }
    if (candidates.length === 0) return { hit: false, reason: 'not-found' }
    return { hit: false, reason: 'ambiguous', candidates: candidates.map((line) => line.seq) }
  }

  /** 房间的主持 Bot（`admin` → `members` 里第一个存在的 Bot）。 */
  botForRoom(roomId) {
    const room = this.#rooms.get(roomId)
    if (!room) return undefined
    const pick = (botId) => (botId && this.#bots.has(botId) ? this.#bots.get(botId) : undefined)
    const admin = pick(room.admin)
    if (admin) return admin
    for (const botId of room.members) {
      const bot = pick(botId)
      if (bot) return bot
    }
    return undefined
  }

  /** 房间蒸馏模型：主持 Bot 的 `provider/model`；拆不出返回 undefined。 */
  modelForRoom(roomId) {
    const bot = this.botForRoom(roomId)
    if (!bot) return undefined
    const parsed = parseModelRef(bot.model)
    if (!parsed) return undefined
    return { ...parsed, botId: bot.botId, botName: bot.name }
  }

  /** 长期记忆文件路径（`memory/team/MEMORY.md` 与 `memory/bots/<botId>/MEMORY.md`）。 */
  memoryPath({ roomId, botId } = {}) {
    const base = join(this.#dshHome, 'bot', 'memory')
    if (botId) return join(base, 'bots', botId, 'MEMORY.md')
    if (roomId) return join(base, 'team', 'MEMORY.md')
    return join(base, 'team', 'MEMORY.md')
  }

  /** 被截断长贴的全文路径（`group-lines/<roomId>/<seq>.txt`）。 */
  groupLinePath(roomId, seq) {
    return join(this.#dshHome, 'bot', 'group-lines', String(roomId), `${seq}.txt`)
  }

  /** Bot 元信息（`/tdai-status` 的 `bot=<id>` 与测试用）。 */
  bot(botId) {
    return botId ? this.#bots.get(botId) : undefined
  }

  /** 房间元信息。 */
  room(roomId) {
    return roomId ? this.#rooms.get(roomId) : undefined
  }
}

/** 台账里恢复出来的条目做一次形状归一（脏数据不至于把策略搞崩）。 */
function normalizeKindInfo(info) {
  const kind = ['bot', 'room', 'room-member'].includes(info.kind) ? info.kind : 'ordinary'
  return {
    kind,
    botId: typeof info.botId === 'string' ? info.botId : '',
    roomId: typeof info.roomId === 'string' ? info.roomId : '',
  }
}
