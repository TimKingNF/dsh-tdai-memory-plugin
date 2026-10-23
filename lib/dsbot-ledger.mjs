/**
 * ds-bot 集成的持久层：**一个文件**装下索引快照、群聊断点、pending 与私聊幂等位。
 *
 * 方案：docs/proposals/ds-bot-tdai-integration/minimal.agents.md §3.3（结构与语义写死）
 *
 * ── 为什么必须是插件自己的文件 ──────────────────────────────────────────────
 *
 * ds-bot 的目录**只读**是硬约束（不写 `~/.dsh/bot` 下任何文件，含日志/临时文件）。
 * 而注释里那三样东西又必须跨进程存活：state.json 索引（读不到时兜底）、群聊
 * `(roomId, humanSeq)` 断点（否则同一段前文会被反复蒸）、私聊幂等位（Core 不返回
 * 记录 id，去重只能靠自己）。所以落 `<DSH_HOME>/storages/tdai-memory-plugin/dsbot-state.json`。
 *
 * ── 损坏语义：**不许把"读不到"当成"没有"** ─────────────────────────────────
 *
 * | 情况 | 行为 |
 * | --- | --- |
 * | ENOENT | 空台账，正常首启 |
 * | JSON 解析失败 / `version !== 1` / EACCES / 目录不可写 | **停写** Bot 会话全部记录 + 一条告警（点名路径与错误原文） |
 * | 配置路径在 `<DSH_HOME>/bot` 之下 | 拒绝该路径、回退默认、告警 |
 *
 * 为什么停写而不是"当成空台账继续"：台账一"空"，同一个房间的前文会被整段重新蒸一遍，
 * 同一个人的话会被重复写进 L0 —— L0 没有客户端记录 id，写进去就删不干净。
 * 宁可这一段时间不写记忆（人话还在会话里，下一轮正常轮次会补上），也不制造重复。
 *
 * ── 原子写 ──────────────────────────────────────────────────────────────────
 *
 * `*.tmp-<pid>-<rand>` + `rename`，同目录 rename 在 POSIX 上是原子的。写队列串行化 +
 * 50ms 合并：一轮里索引、断点、阶段各改一次，没必要落盘三次。
 */

import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises'
import { dirname, join, resolve as resolvePath, sep } from 'node:path'
import { resolveDshHome } from './dsbot.mjs'

export const LEDGER_VERSION = 1
const WRITE_DEBOUNCE_MS = 50

/** 默认台账路径（`<DSH_HOME>/storages/tdai-memory-plugin/dsbot-state.json`）。 */
export function defaultLedgerPath(dshHome) {
  return join(resolveDshHome(dshHome), 'storages', 'tdai-memory-plugin', 'dsbot-state.json')
}

/**
 * 路径校验：拒绝 `<DSH_HOME>/bot` 之下的路径。
 *
 * 理由不是"洁癖"：ds-bot 会把这些目录当成自己的状态，插件往里塞文件可能被它清扫/覆盖，
 * 更糟的是把插件的断点写进它的 memory 目录后，被它当成长期记忆读回去。
 *
 * @returns {{ path: string, rejected?: string }}
 */
export function resolveLedgerPath({ configured, dshHome } = {}) {
  const home = resolveDshHome(dshHome)
  const fallback = defaultLedgerPath(home)
  const text = typeof configured === 'string' ? configured.trim() : ''
  if (!text) return { path: fallback }
  const target = resolvePath(text)
  const forbidden = resolvePath(join(home, 'bot'))
  if (target === forbidden || target.startsWith(forbidden + sep)) {
    return { path: fallback, rejected: target }
  }
  return { path: target }
}

/** 空台账。 */
function emptyLedger() {
  return { version: LEDGER_VERSION, index: undefined, rooms: {}, direct: {} }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export class DsbotLedger {
  #path
  #log
  #data = emptyLedger()
  #blocked = false
  #blockReason = ''
  #loaded = false
  #writeTimer
  #writing = Promise.resolve()
  #dirty = false
  #rejected

  constructor({ path, dshHome, log } = {}) {
    const resolved = resolveLedgerPath({ configured: path, dshHome })
    this.#path = resolved.path
    this.#rejected = resolved.rejected
    this.#log = typeof log === 'function' ? log : () => {}
    if (resolved.rejected) {
      // 告警在 load() 里统一打（构造期打日志会早于插件的 logger 就绪）
    }
  }

  get path() {
    return this.#path
  }

  get blocked() {
    return this.#blocked
  }

  get blockReason() {
    return this.#blockReason
  }

  /** 读台账。ENOENT 当空；其余失败一律停写。**幂等**（重复调用只读一次）。 */
  async load() {
    if (this.#loaded) return this
    this.#loaded = true
    if (this.#rejected) {
      this.#log(`[dsbot] 台账路径落在 ds-bot 目录下，已拒绝：${this.#rejected}；回退到 ${this.#path}`)
    }
    let text
    try {
      text = await readFile(this.#path, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return this
      this.#block(`台账不可读（${error?.code ?? error?.message ?? error}）`)
      return this
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      this.#block(`台账 JSON 解析失败（${error?.message ?? error}）`)
      return this
    }
    if (!isPlainObject(parsed)) {
      this.#block('台账顶层不是对象')
      return this
    }
    if (parsed.version !== LEDGER_VERSION) {
      this.#block(`台账版本不匹配（version=${String(parsed.version)}，期望 ${LEDGER_VERSION}）`)
      return this
    }
    this.#data = {
      version: LEDGER_VERSION,
      index: isPlainObject(parsed.index) ? parsed.index : undefined,
      rooms: isPlainObject(parsed.rooms) ? parsed.rooms : {},
      direct: isPlainObject(parsed.direct) ? parsed.direct : {},
    }
    // 目录不可写要在第一次写的时候才会暴露，这里先探一次（失败同样停写）。
    await this.#probeWritable()
    return this
  }

  #block(reason) {
    this.#blocked = true
    this.#blockReason = reason
    this.#log(`[dsbot] ${reason}（${this.#path}）；Bot 会话写侧停写，读侧不受影响`)
  }

  async #probeWritable() {
    try {
      await mkdir(dirname(this.#path), { recursive: true })
      const probe = `${this.#path}.tmp-probe-${process.pid}`
      await writeFile(probe, '', 'utf8')
      await unlink(probe)
    } catch (error) {
      this.#block(`台账目录不可写（${error?.code ?? error?.message ?? error}）`)
    }
  }

  /** 索引快照（`DsbotIndex` 启动时恢复用）。 */
  getIndex() {
    if (this.#blocked) return undefined
    return this.#data.index
  }

  /** 写入索引快照（同内容会被 `DsbotIndex` 自己拦住，这里不再比对）。 */
  recordIndex({ stateMtimeMs, sessions, signals } = {}) {
    if (this.#blocked) return false
    this.#data.index = {
      stateMtimeMs: Number.isFinite(stateMtimeMs) ? stateMtimeMs : undefined,
      sessions: isPlainObject(sessions) ? sessions : {},
      signals: Array.isArray(signals) ? signals.slice(0, 500) : [],
    }
    this.#touch()
    return true
  }

  /** 房间断点/pending/阶段（返回副本，改它不会影响台账）。 */
  room(roomId) {
    const entry = this.#data.rooms[roomId]
    return isPlainObject(entry) ? structuredCloneSafe(entry) : {}
  }

  /** 覆盖式更新房间条目（`patch` 里值为 undefined 的键会被删掉）。 */
  patchRoom(roomId, patch) {
    if (this.#blocked || !roomId) return false
    const next = { ...(isPlainObject(this.#data.rooms[roomId]) ? this.#data.rooms[roomId] : {}), ...patch }
    for (const [key, value] of Object.entries(next)) if (value === undefined) delete next[key]
    this.#data.rooms[roomId] = next
    this.#touch()
    return true
  }

  /** 私聊幂等位。 */
  direct(botId) {
    const entry = this.#data.direct[botId]
    return isPlainObject(entry) ? structuredCloneSafe(entry) : {}
  }

  setDirect(botId, patch) {
    if (this.#blocked || !botId) return false
    const next = { ...(isPlainObject(this.#data.direct[botId]) ? this.#data.direct[botId] : {}), ...patch }
    for (const [key, value] of Object.entries(next)) if (value === undefined) delete next[key]
    this.#data.direct[botId] = next
    this.#touch()
    return true
  }

  /** 立即落盘（测试与写侧关键节点用；平时靠 50ms 合并）。 */
  async flush() {
    if (this.#writeTimer) {
      clearTimeout(this.#writeTimer)
      this.#writeTimer = undefined
    }
    await this.#writeNow()
    await this.#writing
  }

  #touch() {
    this.#dirty = true
    if (this.#blocked) return
    if (this.#writeTimer) return
    this.#writeTimer = setTimeout(() => {
      this.#writeTimer = undefined
      void this.#writeNow()
    }, WRITE_DEBOUNCE_MS)
    // 定时器不该把进程吊住（测试/退出）。
    this.#writeTimer?.unref?.()
  }

  #writeNow() {
    if (!this.#dirty || this.#blocked) return this.#writing
    this.#dirty = false
    const payload = JSON.stringify(this.#data)
    const target = this.#path
    this.#writing = this.#writing
      .then(async () => {
        await mkdir(dirname(target), { recursive: true })
        const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
        await writeFile(tmp, payload, 'utf8')
        await rename(tmp, target)
      })
      .catch((error) => {
        // 写失败 = 停写：继续写会让"断点/幂等位丢失"变成沉默的重复写入。
        this.#block(`台账写入失败（${error?.code ?? error?.message ?? error}）`)
      })
    return this.#writing
  }
}

/** `structuredClone` 的兜底（老 Node / 非可克隆值就退化成 JSON 往返）。 */
function structuredCloneSafe(value) {
  try {
    return structuredClone(value)
  } catch {
    return JSON.parse(JSON.stringify(value))
  }
}
