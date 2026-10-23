/**
 * 群聊前文蒸馏测试。
 *
 * 为什么必须有这个文件：群聊没有现成终稿（实测 129/129 轮收尾步无文本），摘要是插件
 * 自己蒸出来的，写进 L0 后**删不干净**。这里的每一条断言都在锁一个会静默降级的点：
 *   - 调用形状错了（signal 放到第二个位置参数、把 stream 当 Promise）→ 每轮都退化成
 *     "只有人话"，日志里没有异常，只有记忆悄悄变少；
 *   - 失败路径抛异常 → turn-stopping 被拖垮，整轮（连人话）都写不进去；
 *   - 摘要格式漂移（少 `结论：`、超长、第一人称）→ L1 抽取把 Bot 措辞当成用户自述；
 *   - 只读输入读错（MEMORY 条目、group-lines 全文）→ 蒸出来的东西是错的还没有告警。
 *
 * 所以六条失败路径（ok / no-llm / no-model / error / empty / timeout）全部要有独立用例，
 * 且 timeout 用真的 `AbortSignal.timeout` 跑一个永不 resolve 的 stream —— 不能靠打桩绕过。
 *
 * 依据：docs/proposals/ds-bot-tdai-integration/minimal.agents.md §3.4 / §3.5 / §3.6 / §4.2-16
 * 运行：node test/dsbot-context.test.mjs
 */

import assert from 'node:assert'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DsbotIndex } from '../lib/dsbot.mjs'
import {
  DISTILL_MAX_TOKENS,
  DISTILL_TIMEOUT_MS,
  MEMORY_ENTRY_MAX_CHARS,
  MEMORY_MAX_ENTRIES,
  SUMMARY_BODY_MAX_CHARS,
  SUMMARY_MAX_CHARS,
  buildDistillPrompt,
  buildWindow,
  distillRoom,
  expandAnchorLine,
  readMemoryEntries,
  renderSummaryBlock,
} from '../lib/dsbot-context.mjs'

// 计数器只为在结尾报出**实际执行**的断言条数（含循环里的），断言本身仍用 node:assert。
let checks = 0
const eq = (actual, expected, message) => {
  checks += 1
  assert.equal(actual, expected, message)
}
const deepEq = (actual, expected, message) => {
  checks += 1
  assert.deepEqual(actual, expected, message)
}
const ok = (value, message) => {
  checks += 1
  assert.ok(value, message)
}

/**
 * 给可能挂住的调用套一个 ref 过的看门狗。
 *
 * 为什么不能只 `await`：`AbortSignal.timeout()` 的定时器是 unref 的（实测），若被测代码
 * 自身没能返回，事件循环里没有 ref 的 handle，Node 会**直接退出**——测试文件"绿着"结束，
 * 后面的用例一条都没跑。看门狗把失败变成显式 reject。
 */
async function withDeadline(promise, ms, label) {
  let timer
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 没在 ${ms}ms 内返回，测试会挂住`)), ms)
  })
  try {
    return await Promise.race([promise, guard])
  } finally {
    clearTimeout(timer)
  }
}

// ── 0) 契约常量：数值就是方案里写死的，改动会牵连 capture 与记录上限 ──────────
{
  eq(DISTILL_TIMEOUT_MS, 8000, '蒸馏超时必须是 8s')
  eq(DISTILL_MAX_TOKENS, 5000, 'maxTokens 默认必须是 5000（思考 token 会从预算里扣）')
  eq(SUMMARY_MAX_CHARS, 1200, '记录级上限必须是 1,200')
  eq(SUMMARY_BODY_MAX_CHARS, 600, '摘要正文上限必须是 600')
  eq(MEMORY_MAX_ENTRIES, 6, '背景段最多 6 条')
  eq(MEMORY_ENTRY_MAX_CHARS, 200, '单条 MEMORY 截 200 字符')
}

// ── 1) buildWindow：顺序（旧→新）与 `<who>: <text>` 格式 ──────────────────────
{
  eq(buildWindow([]), '', '空数组返回空串')
  eq(
    buildWindow([{ who: 'User', text: '先做读侧' }, { who: 'Rex', text: '同意，写侧我来' }]),
    'User: 先做读侧\nRex: 同意，写侧我来',
    '格式 `<who>: <text>`，顺序即入参顺序（旧→新）',
  )
  eq(
    buildWindow([{ who: 'Rex', text: '  第二段  ' }, { who: 'User', text: '第三段' }]),
    'Rex: 第二段\nUser: 第三段',
    '文本去首尾空白，顺序保持旧→新',
  )
  eq(
    buildWindow([{ who: 'User', text: '   ' }, { who: 'Rex', text: '留下' }]),
    'Rex: 留下',
    '空文本行丢弃',
  )
}

// ── 2) buildDistillPrompt：三段内容 + bullet/结论 要求 + 背景段边界 ───────────
{
  const prompt = buildDistillPrompt({
    roomName: 'TDAI-memory 集成',
    windowText: 'User: 先做读侧\nRex: 同意',
    memoryEntries: ['- Tim 负责集成 [source: group "TDAI-memory 集成"; by: Bot]'],
  })
  ok(prompt.system.includes('- '), 'system 段要求 bullet 以 "- " 开头')
  ok(prompt.system.includes('结论：'), 'system 段要求结论行')
  ok(prompt.system.includes('第一人称'), 'system 段禁止第一人称')
  ok(prompt.user.includes('User: 先做读侧') && prompt.user.includes('Rex: 同意'), '对话段含窗口原文')
  ok(prompt.user.includes('Tim 负责集成'), '背景段含 MEMORY 条目')
  ok(
    prompt.user.indexOf('Tim 负责集成') < prompt.user.indexOf('User: 先做读侧'),
    '背景段必须排在对话段之前',
  )
  ok(prompt.user.includes('严禁从中提取'), '给背景条目时必须写明不得从中提取')

  const withoutMemory = buildDistillPrompt({ roomName: 'R', windowText: 'User: x', memoryEntries: [] })
  ok(!withoutMemory.user.includes('严禁从中提取'), '没有背景条目时不出现背景段')
  ok(withoutMemory.user.includes('User: x'), '没有背景条目时对话段照旧')
}

// ── 3) renderSummaryBlock：前缀行 / 缺结论补齐 / 两道字符上限 ────────────────
{
  const normal = renderSummaryBlock({
    roomName: 'TDAI-memory 集成',
    fromSeq: 94,
    toSeq: 129,
    body: '- 甲 决定先做读侧\n- 乙 负责蒸馏\n结论：读侧已定，写侧下一步',
  })
  eq(
    normal,
    '[群聊「TDAI-memory 集成」· 前文 seq 94–129]\n- 甲 决定先做读侧\n- 乙 负责蒸馏\n结论：读侧已定，写侧下一步',
    '固定前缀行 + 正文，页脚行不占 bullet 条数',
  )

  const noConclusion = renderSummaryBlock({ roomName: 'R', fromSeq: 1, toSeq: 2, body: '- 甲 只说了句话' })
  ok(noConclusion.startsWith('[群聊「R」· 前文 seq 1–2]\n'), '缺结论时前缀行不变')
  ok(noConclusion.endsWith('结论：未收口'), '正文缺「结论：」时补「结论：未收口」')
  eq(noConclusion.split('结论：').length - 1, 1, '补出来的结论不能出现两行')

  const empty = renderSummaryBlock({ roomName: 'R', fromSeq: 1, toSeq: 2 })
  eq(empty, '[群聊「R」· 前文 seq 1–2]\n结论：未收口', '正文为空时只留前缀行与结论')

  const noSeq = renderSummaryBlock({ roomName: 'R', body: '- x' })
  ok(noSeq.startsWith('[群聊「R」· 前文 seq ?–?]'), 'seq 缺失写 "?"，不编造数字')

  const longBody = Array.from({ length: 6 }, (_, i) => `- 第${i + 1}条 ${'很长'.repeat(80)}`).join('\n')
  const long = renderSummaryBlock({
    roomName: 'TDAI-memory 集成',
    fromSeq: 94,
    toSeq: 129,
    body: `${longBody}\n结论：还有几件没做完，需要继续`,
  })
  ok(long.length <= SUMMARY_MAX_CHARS, `总长必须 ≤${SUMMARY_MAX_CHARS}，实际 ${long.length}`)
  const bodyPart = long.slice(long.indexOf('\n') + 1)
  ok(bodyPart.length <= SUMMARY_BODY_MAX_CHARS, `正文部分必须 ≤${SUMMARY_BODY_MAX_CHARS}，实际 ${bodyPart.length}`)
  ok(long.includes('结论：还有几件没做完，需要继续'), '截断不能吃掉结论行')
  ok(long.startsWith('[群聊「TDAI-memory 集成」· 前文 seq 94–129]\n'), '超长正文不影响前缀行')
}

// ── 4) distillRoom 正常路径：只累加 text-delta，档位优先 off ─────────────────
{
  const calls = []
  const llm = {
    async resolveModelInfo(provider, model, signal) {
      calls.push({ kind: 'info', provider, model, signal })
      return { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }, { id: 'off' }] } }
    },
    async *stream(options) {
      calls.push({ kind: 'stream', options })
      // 思考内容不能进摘要：reasoning-delta 一律丢掉。
      yield { type: 'reasoning-delta', text: '先想想（不该进摘要）' }
      yield { type: 'text-delta', text: '- 甲 决定先做读侧' }
      yield { type: 'text-delta', text: '\n结论：读侧已定' }
    },
  }
  const result = await distillRoom({
    llm,
    model: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
    roomName: 'TDAI-memory 集成',
    windowText: 'User: 先做读侧\nRex: 同意',
    memoryEntries: [],
  })
  ok(result.ok === true, `正常路径应成功，实际：${JSON.stringify(result)}`)
  eq(result.text, '- 甲 决定先做读侧\n结论：读侧已定', '只拼 text-delta，reasoning-delta 必须丢弃')

  const info = calls.find((call) => call.kind === 'info')
  eq(info.provider, 'opencode-go', 'provider 原样传给 resolveModelInfo')
  eq(info.model, 'deepseek-v4.1-flash', 'model 原样传给 resolveModelInfo')
  ok(info.signal instanceof AbortSignal, 'resolveModelInfo 的第三个参数是 AbortSignal')

  const streamed = calls.find((call) => call.kind === 'stream').options
  eq(streamed.provider, 'opencode-go', 'provider 进 options')
  eq(streamed.model, 'deepseek-v4.1-flash', 'model 进 options')
  eq(streamed.maxTokens, DISTILL_MAX_TOKENS, 'maxTokens 进 options')
  eq(streamed.reasoningEffort, 'off', '有 off 档时优先 off')
  ok(streamed.signal instanceof AbortSignal, 'signal 必须放在 options 里（不是第二个位置参数）')
  ok(typeof streamed.system === 'string' && streamed.system.length > 0, 'system 段必须传给模型')
  eq(streamed.messages[0].role, 'user', '对话段以 user 消息传入')
  ok(
    streamed.messages[0].content[0].text.includes('User: 先做读侧'),
    '对话段内容必须进 user 消息',
  )
}

// ── 5) 档位兜底：resolveModelInfo 抛错 / 没有 efforts ────────────────────────
{
  let options
  const throwingInfo = {
    async resolveModelInfo() {
      throw new Error('provider 未注册')
    },
    async *stream(opts) {
      options = opts
      yield { type: 'text-delta', text: '- 乙 做完了\n结论：无' }
    },
  }
  const result = await distillRoom({
    llm: throwingInfo,
    model: { provider: 'p', model: 'm' },
    roomName: 'R',
    windowText: 'User: x',
    memoryEntries: [],
  })
  ok(result.ok === true, 'resolveModelInfo 失败不应判死整条蒸馏')
  ok(!('reasoningEffort' in options), '拿不到 info 就不带 reasoningEffort')

  const lowEffort = {
    async resolveModelInfo() {
      return { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }
    },
    async *stream(opts) {
      options = opts
      yield { type: 'text-delta', text: '- 丙 做了\n结论：有' }
    },
  }
  await distillRoom({
    llm: lowEffort,
    model: { provider: 'p', model: 'm' },
    roomName: 'R',
    windowText: 'User: x',
    memoryEntries: [],
  })
  eq(options.reasoningEffort, 'low', '没有 off 档时取 efforts[0]（最低档）')
}

// ── 6) no-llm：拿不到 llm / 没有 stream 都返回失败对象，不抛 ────────────────
{
  const base = { model: { provider: 'p', model: 'm' }, roomName: 'R', windowText: 'User: x', memoryEntries: [] }
  deepEq(await distillRoom({ ...base, llm: undefined }), { ok: false, reason: 'no-llm' }, 'llm 缺失 → no-llm')
  deepEq(
    await distillRoom({ ...base, llm: { resolveModelInfo: async () => ({}) } }),
    { ok: false, reason: 'no-llm' },
    'llm 没有 stream → 同样按 no-llm（不抛 TypeError）',
  )
}

// ── 7) no-model：拆不出 provider/model 就不调模型 ────────────────────────────
{
  const llm = {
    async *stream() {
      throw new Error('不该被调用')
    },
  }
  const base = { llm, roomName: 'R', windowText: 'User: x', memoryEntries: [] }
  deepEq(await distillRoom({ ...base, model: undefined }), { ok: false, reason: 'no-model' }, 'model 缺失 → no-model')
  deepEq(await distillRoom({ ...base, model: { provider: 'p' } }), { ok: false, reason: 'no-model' }, '缺 model 字段 → no-model')
  deepEq(await distillRoom({ ...base, model: { provider: '', model: 'm' } }), { ok: false, reason: 'no-model' }, 'provider 为空 → no-model')
}

// ── 8) stream 抛错 → error；半截文本不能当成功结果 ───────────────────────────
{
  const base = { model: { provider: 'p', model: 'm' }, roomName: 'R', windowText: 'User: x', memoryEntries: [] }
  const throws = {
    async *stream() {
      throw new Error('boom')
    },
  }
  const threw = await distillRoom({ ...base, llm: throws })
  eq(threw.ok, false, 'stream 抛错 → 失败')
  eq(threw.reason, 'error', 'stream 抛错 → error')
  eq(threw.detail.stage, 'stream', 'detail 标注失败发生在 stream 阶段')

  const throwsAfterText = {
    async *stream() {
      yield { type: 'text-delta', text: '- 半截' }
      throw new Error('boom')
    },
  }
  const partial = await distillRoom({ ...base, llm: throwsAfterText })
  eq(partial.ok, false, '先吐了半截再抛错，也必须整体判失败（不能把半截写进 L0）')
  eq(partial.reason, 'error', '半截 + 抛错仍记 error')
}

// ── 9) 空输出 → empty ──────────────────────────────────────────────────────
{
  const base = { model: { provider: 'p', model: 'm' }, roomName: 'R', windowText: 'User: x', memoryEntries: [] }
  const onlyReasoning = {
    async *stream() {
      yield { type: 'reasoning-delta', text: '想了很久' }
    },
  }
  // 只有思考内容 → empty，并带上细节（reasoningChars / outputTokens），
  // 现场判别"是思考吃光预算，还是适配器没发 text-delta"就靠这几个数。
  const onlyReasoningResult = await distillRoom({ ...base, llm: onlyReasoning })
  eq(onlyReasoningResult.ok, false, '只有思考内容 → 判失败')
  eq(onlyReasoningResult.reason, 'empty', '只有思考内容 → empty')
  eq(onlyReasoningResult.detail.reasoningChars, 4, 'detail 记录思考字符数')
  eq(onlyReasoningResult.detail.textDeltas, 0, 'detail 记录正文 delta 长度')

  const onlyBlank = {
    async *stream() {
      yield { type: 'text-delta', text: '   \n  ' }
    },
  }
  eq((await distillRoom({ ...base, llm: onlyBlank })).reason, 'empty', '只有空白也算空输出')
}

// ── 9a) maxTokens 可由调用方覆盖（配置项 botContextMaxTokens）────────────────
{
  const base = { model: { provider: 'p', model: 'm' }, roomName: 'R', windowText: 'User: x', memoryEntries: [] }
  const seen = []
  const llm = {
    async resolveModelInfo() { return { reasoning: { efforts: [] } } },
    stream(options) {
      seen.push(options.maxTokens)
      return (async function* stream() { yield { type: 'text-delta', text: '- 一\n结论：ok' } })()
    },
  }
  await distillRoom({ ...base, llm, maxTokens: 4321 })
  eq(seen.at(-1), 4321, '调用方传的 maxTokens 应原样进 options')
  await distillRoom({ ...base, llm, maxTokens: 0 })
  eq(seen.at(-1), DISTILL_MAX_TOKENS, '非法值回落到默认常量')
  await distillRoom({ ...base, llm })
  eq(seen.at(-1), DISTILL_MAX_TOKENS, '不传就用默认值')
}

// ── 9e) 首轮"成功但空" → 去掉 system 重试一次 ────────────────────────────────
{
  const base = { model: { provider: 'p', model: 'm' }, roomName: 'R', windowText: 'User: x', memoryEntries: [] }
  const calls = []
  const emptyThenOk = {
    async *stream(options) {
      calls.push({ hasSystem: typeof options.system === 'string' && options.system.length > 0, user: options.messages[0].content[0].text })
      if (calls.length === 1) {
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield { type: 'text-delta', text: '- 降级成功\n结论：ok' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const result = await distillRoom({ ...base, llm: emptyThenOk })
  eq(result.ok, true, '首轮空、次轮有文本 → 整体成功')
  eq(result.usedFallback, true, '标注走了降级路径')
  eq(result.fallbackStep, 1, '标注停在第 2 段')
  eq(calls.length, 2, '成功即停，不再走第 3 段')
  eq(calls[0].hasSystem, true, '首轮带 system')
  eq(calls[1].hasSystem, false, '次轮去掉 system')
  ok(calls[1].user.includes('团队群聊的记录员'), 'system 内容折进了 user（模型仍能看到口径）')

  // 两次都空 → 保留首轮 detail，并把次轮挂在 retry 下
  const alwaysEmpty = {
    async *stream() {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const failed = await distillRoom({ ...base, llm: alwaysEmpty })
  eq(failed.ok, false, '阶梯全空 → 失败')
  eq(failed.reason, 'empty', '仍记 empty')
  eq(failed.detail.sent.withSystem, true, 'detail 记录首轮是带 system 的那次')
  ok(failed.detail.retry1 && failed.detail.retry1.sent.withSystem === false, 'retry1 记录次轮不带 system')
  ok(failed.detail.retry2 && failed.detail.retry2.sent.path === 'stream', 'retry2 记录第三段走 plain stream')
}

// ── 9d) sessionId 必须透传（opencode-go 靠它填 x-opencode-session 头）──────────
{
  const base = { model: { provider: 'opencode-go', model: 'm' }, roomName: 'R', windowText: 'User: x', memoryEntries: [] }
  const seen = []
  const llm = {
    async *stream(options) {
      seen.push(options.sessionId)
      yield { type: 'text-delta', text: '- 一\n结论：ok' }
    },
  }
  await distillRoom({ ...base, llm, sessionId: 'session-room-1' })
  eq(seen.at(-1), 'session-room-1', 'sessionId 必须进 options（否则 opencode-go 报 MissingSessionID）')
  await distillRoom({ ...base, llm })
  eq(seen.at(-1), undefined, '没有 sessionId 时不硬造一个')
}

// ── 9c) 终端 finish 是错误 → 判 error，不能伪装成 empty ─────────────────────
{
  const base = { model: { provider: 'p', model: 'm' }, roomName: 'R', windowText: 'User: x', memoryEntries: [] }
  const errorFinish = {
    async *stream() {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'quota exceeded', code: 'X' } } }
    },
  }
  const r1 = await distillRoom({ ...base, llm: errorFinish })
  eq(r1.ok, false, 'finish=error → 失败')
  eq(r1.reason, 'error', 'finish=error 不能记成 empty')
  eq(r1.detail.failure.message, 'quota exceeded', 'failure 原文进 detail')

  const abortedFinish = {
    async *stream() {
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } } }
    },
  }
  eq((await distillRoom({ ...base, llm: abortedFinish })).reason, 'timeout', 'finish=aborted → timeout')

  const maxTokensOnlyThinking = {
    async *stream() {
      yield { type: 'reasoning-delta', text: '想了很久很久' }
      yield { type: 'usage', usage: { outputTokens: 5000 } }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    },
  }
  const r3 = await distillRoom({ ...base, llm: maxTokensOnlyThinking })
  eq(r3.reason, 'empty', '只有思考 + max-tokens → empty')
  eq(r3.detail.finishReason, 'max-tokens', 'detail 记录 max-tokens（说明是预算被吃光）')
  eq(r3.detail.outputTokens, 5000, 'detail 记录输出 token')
}

// ── 9b) 非流式回退：文本只在 block-end 里（没有 text-delta）──────────────────
{
  const base = { model: { provider: 'p', model: 'm' }, roomName: 'R', windowText: 'User: x', memoryEntries: [] }
  const blockEndOnly = {
    async *stream() {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '- ARK 合并了分支\n结论：已收口' } }
    },
  }
  const result = await distillRoom({ ...base, llm: blockEndOnly })
  eq(result.ok, true, '只有 block-end 也应判成功（非流式回退）')
  eq(result.text, '- ARK 合并了分支\n结论：已收口', 'block-end 里的正文被采用')

  // 有 delta 时不重复拼 block-end —— 否则摘要会出现两份正文。
  const both = {
    async *stream() {
      yield { type: 'text-delta', text: '- 只算一次' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '- 只算一次' } }
    },
  }
  eq((await distillRoom({ ...base, llm: both })).text, '- 只算一次', 'delta 与 block-end 同时存在时不重复')
}

// ── 10) timeout：真的 AbortSignal.timeout + 永不 resolve 的 stream ──────────
{
  const base = { model: { provider: 'p', model: 'm' }, roomName: 'R', windowText: 'User: x', memoryEntries: [] }
  const never = {
    async *stream() {
      await new Promise(() => {}) // 永不 resolve，也永不看 signal
    },
  }
  const started = Date.now()
  const result = await withDeadline(
    distillRoom({ ...base, llm: never, timeoutMs: 10 }),
    1500,
    '永不 resolve 的 stream',
  )
  eq(result.ok, false, '永不 resolve 的 stream 必须按 timeout 返回')
  eq(result.reason, 'timeout', 'reason=timeout')
  eq(result.detail.budgetMs, 10, 'detail 记录预算')
  ok(typeof result.detail.elapsedMs === 'number', 'detail 记录实际耗时')
  ok(Date.now() - started < 1500, '超时路径必须自己返回，不能靠看门狗兜')

  // 另一类真实形态：上游响应中止（抛 AbortError）——统一记 timeout，不记 error。
  const aborts = {
    async *stream({ signal }) {
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    },
  }
  const aborted = await withDeadline(
    distillRoom({ ...base, llm: aborts, timeoutMs: 10 }),
    1500,
    'abort 后抛 AbortError 的 stream',
  )
  eq(aborted.reason, 'timeout', '中止导致的中断统一记 timeout，不记 error')
}

// ── 11) readMemoryEntries：条目筛选、截断、条数上限、路径与缺失 ──────────────
{
  const home = await mkdtemp(join(tmpdir(), 'dsbot-context-'))
  try {
    const index = new DsbotIndex({ dshHome: home })
    const teamDir = join(home, 'bot', 'memory', 'team')
    await mkdir(teamDir, { recursive: true })
    const longFact = `- 长条目 ${'甲'.repeat(260)} [source: group "TDAI"; by: Bot]`
    await writeFile(join(teamDir, 'MEMORY.md'), [
      '# MEMORY',
      '',
      '这里是说明段落，不是条目。',
      '- 事实一 [source: group "TDAI-memory 集成" 10-20 09:53; by: Bot; added: 2026-10-20]',
      '## 小标题',
      longFact,
      '- 事实二',
      '- 事实三',
      '- 事实四',
      '- 事实五',
      '- 事实六',
      '- 事实七',
    ].join('\n'), 'utf8')

    const entries = await readMemoryEntries(index, { roomId: 'r1' })
    eq(entries.length, MEMORY_MAX_ENTRIES, '最多取 MEMORY_MAX_ENTRIES 条')
    ok(entries[0].startsWith('- 事实一'), '只取 "- " 开头的行，且保持文件顺序')
    ok(entries.every((entry) => entry.length <= MEMORY_ENTRY_MAX_CHARS), `每条 ≤${MEMORY_ENTRY_MAX_CHARS} 字符`)
    ok(entries.some((entry) => entry.length === MEMORY_ENTRY_MAX_CHARS), '超长条目被截到恰好 200 字符')
    ok(!entries.some((entry) => entry.startsWith('#')), '标题行不取')
    ok(!entries.some((entry) => entry.startsWith('这里是')), '说明段落不取')
    eq((await readMemoryEntries(index, { roomId: 'r1', limit: 2 })).length, 2, 'limit 生效')
    eq((await readMemoryEntries(index, { roomId: 'r1', limit: 0 })).length, 0, 'limit=0 返回空')

    const botDir = join(home, 'bot', 'memory', 'bots', 'ARK-Alpha')
    await mkdir(botDir, { recursive: true })
    await writeFile(join(botDir, 'MEMORY.md'), '- Bot 级事实 [source: group "TDAI"; by: Bot]\n', 'utf8')
    deepEq(
      await readMemoryEntries(index, { botId: 'ARK-Alpha' }),
      ['- Bot 级事实 [source: group "TDAI"; by: Bot]'],
      'botId 走 memory/bots/<botId>/MEMORY.md',
    )
    deepEq(await readMemoryEntries(index, { botId: '不存在的Bot' }), [], '文件不存在返回 []')
    deepEq(await readMemoryEntries(undefined, { roomId: 'r1' }), [], 'index 不可用返回 []')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

// ── 12) expandAnchorLine：截断长贴读全文，读不到退回日志文本 ────────────────
{
  const home = await mkdtemp(join(tmpdir(), 'dsbot-context-'))
  try {
    const index = new DsbotIndex({ dshHome: home })
    const dir = join(home, 'bot', 'group-lines', 'r1')
    await mkdir(dir, { recursive: true })
    const full = `这条长贴被 TEXT_KEPT 截断，全文在这里。${'补'.repeat(3000)}`
    await writeFile(join(dir, '7.txt'), full, 'utf8')

    const truncated = { seq: 7, who: 'User', text: '这条长贴被 TEXT_KEPT 截断，全文在这里。', truncated: true, length: full.length }
    eq(await expandAnchorLine(index, 'r1', truncated), full, '截断行从 group-lines 读全文')

    const raw = { seq: 7, who: 'User', text: '日志文本', length: full.length }
    eq(await expandAnchorLine(index, 'r1', raw), full, '直接来自 state.json 的行只带 length，也按截断处理')

    const missing = { seq: 8, who: 'User', text: '文件不在时的截断头部', truncated: true, length: 9000 }
    eq(await expandAnchorLine(index, 'r1', missing), '文件不在时的截断头部', '读不到全文退回日志里的截断文本')

    const short = { seq: 7, who: 'User', text: '短句' }
    eq(await expandAnchorLine(index, 'r1', short), '短句', '未截断的行不读磁盘')

    eq(await expandAnchorLine(undefined, 'r1', missing), '文件不在时的截断头部', 'index 不可用也不抛')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

console.log(`dsbot-context: ok（${checks} 条断言）`)
