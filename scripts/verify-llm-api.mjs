#!/usr/bin/env node
/**
 * 临时校验脚本：核实「群聊前文蒸馏」要用的 dsh-llm 调用形状。
 *
 * 为什么要这个脚本：初稿把 stream 写成 `stream(opts, { signal })`，
 * 而真实签名是 `stream(options)`、signal 在 options 里；resolveModelInfo
 * 是 LlmRuntime 的方法（不是自由函数）；stream 返回 AsyncIterable（要 for await，
 * 不能 .then）。这三条任何一条写错，整条群聊摘要路径都会静默降级。
 *
 * 用法：node /tmp/verify-llm-api.mjs
 * 退出码 0 = 假设全部成立；1 = 有假设被推翻（按打印的 diff 改方案）。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { dirname } from 'node:path'

// DSH 安装位置：优先环境变量，其次用 node 的全局 node_modules 推导（不写死个人路径）。
const DSH = process.env.DSH_INSTALL
  ?? `${execPathRoot()}/lib/node_modules/@deepseek-ai/dsh`
/**
 * node 可执行文件所在的版本目录（nvm 下即 $NVM_BIN 的上一级）。
 * 用它推导全局 node_modules，避免把个人绝对路径写进仓库。
 */
function execPathRoot() {
  return dirname(dirname(process.execPath))
}
const LLM = path.join(DSH, 'node_modules/@deepseek-ai/dsh-llm')
const require = createRequire(path.join(LLM, 'package.json'))

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`)
  if (!ok) failed += 1
}

// ── 1. 模块能不能加载、导出了什么 ────────────────────────────────
const mod = require(LLM)
const LlmRuntime = mod.default ?? mod.LlmRuntime
check('导出 LlmRuntime（LLM 服务类）', typeof LlmRuntime === 'function')
check('导出 BlockAssembler（chunk 装配器）', typeof mod.BlockAssembler === 'function')

const proto = LlmRuntime.prototype
for (const m of ['listModels', 'resolveModelInfo', 'resolveCallConfig', 'prepareCall', 'stream']) {
  check(`LlmRuntime.prototype.${m} 存在`, typeof proto[m] === 'function')
}

// ── 2. stream 是同步返回的 AsyncIterable，不是 Promise ───────────
const src = readFileSync(path.join(LLM, 'lib/types/index.d.ts'), 'utf8')
check('声明里 stream 返回 AsyncIterable（非 Promise）',
  /stream\(options: GenerateOptions\): AsyncIterable<StreamChunk>/.test(src))
check('resolveModelInfo 是 (provider, model, signal?) => Promise',
  /resolveModelInfo\(provider: string, model: string, signal\?: AbortSignal\): Promise<LlmResolvedModelInfo>/.test(src))

// ── 3. GenerateOptions：signal 在 options 内、messages 必填 ───────
const types = readFileSync(path.join(LLM, 'lib/types/types.d.ts'), 'utf8')
const genBlock = types.slice(types.indexOf('export interface GenerateOptions'), types.indexOf('export interface GenerateOptions') + 1800)
for (const key of ['provider', 'model', 'messages', 'reasoningEffort', 'maxTokens', 'signal', 'system']) {
  check(`GenerateOptions 含 ${key}`, new RegExp(`\\b${key}\\??:`).test(genBlock))
}
check('GenerateOptions 里没有第二个位置参数（signal 是字段）',
  /signal\?: AbortSignal;/.test(genBlock))

// ── 4. reasoning.efforts 由低到高，最低档取 efforts[0] ────────────
check('LlmResolvedModelInfo.reasoning.efforts 存在且「从低到高」',
  /reasoning\?: LlmModelReasoningInfo/.test(types) && /from least to greatest/.test(types))
check('BlockAssembler 有 push/blocks/message/finish',
  ['push', 'blocks', 'message', 'finish'].every(k => new RegExp(`\\b${k}\\(`).test(readFileSync(path.join(LLM, 'lib/types/assembler.d.ts'), 'utf8'))))

// ── 5. 打印可直接抄进 lib/dsbot-context.mjs 的调用模板 ────────────
//
// ⚠️ 插件侧**不能** `import '@deepseek-ai/dsh-llm'`：它不是本插件的依赖（package.json 里
// 只有 schemastery），从插件目录解析会 ERR_MODULE_NOT_FOUND。`BlockAssembler` 仍然值得
// 断言存在（宿主一定有），但插件不引它 —— 自己累加 `text-delta` 就够了，而且能顺手丢掉
// `reasoning-delta`（摘要不需要思考内容）。下面这份模板与 lib/dsbot-context.mjs 的实现一致。
console.log('\n---- 已核实的调用模板（插件侧可用写法）----')
console.log(`const llm = ctx.get('llm')          // 拿不到就降级，不抛错
if (!llm) return { ok: false, reason: 'no-llm' }

const signal = AbortSignal.timeout(8000)
// resolveModelInfo 是**实例方法**，可能 throw；拿不到档位就不带 reasoningEffort。
let effort
try {
  const info = await llm.resolveModelInfo(provider, model, signal)
  const efforts = info?.reasoning?.efforts ?? []
  effort = (efforts.find(e => e.id === 'off') ?? efforts[0])?.id
} catch { effort = undefined }

const options = {
  provider, model,
  messages: [{ role: 'user', content: [{ type: 'text', text: userPrompt }] }],
  system: systemPrompt,
  maxTokens: 600,
  signal,                                    // 在 options 里，不是第二个参数
  ...(effort === undefined ? {} : { reasoningEffort: effort }),
}

let text = ''
for await (const chunk of llm.stream(options)) {   // AsyncIterable，必须 for await
  if (chunk?.type === 'text-delta') text += chunk.text   // reasoning-delta 丢掉
}
`)

console.log(failed === 0 ? '\n结论：全部假设成立，按上面模板实现。' : `\n结论：${failed} 条假设被推翻，先改方案再写代码。`)
process.exit(failed === 0 ? 0 : 1)
