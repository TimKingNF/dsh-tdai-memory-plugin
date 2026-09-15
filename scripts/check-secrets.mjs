#!/usr/bin/env node
/**
 * 提交前密钥扫描（本地护栏，零依赖）。
 *
 * 为什么要有：插件的密钥**全部只从 env 读**（`TDAI_MEMORY_API_KEY` / `userKey` …），
 * 仓库里不该出现任何真实凭据。但"手滑把 token 贴进文档/测试"这类事故靠人眼查不出来，
 * 所以把它变成一条可执行的规则，并挂在 `npm test` 的最后一环。
 *
 * 用法：
 *   node scripts/check-secrets.mjs            # 扫所有已跟踪文件（默认）
 *   node scripts/check-secrets.mjs --staged   # 只扫暂存区（适合做 pre-commit hook）
 *
 * 命中即退出码 1。**输出只报"规则名 + 文件 + 行号 + 值的长度与首 4 字符"**，
 * 绝不回显完整值——否则扫描器自己就成了泄露渠道。
 */
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** 白名单：每行一个字面串（`#` 后为理由）。命中所在行整行跳过。 */
const allowPath = join(here, 'secret-scan-allowlist.txt')
const ALLOW = existsSync(allowPath)
  ? readFileSync(allowPath, 'utf8').split('\n').map((l) => l.split('#')[0].trim()).filter(Boolean)
  : []
const allowed = (line) => ALLOW.some((literal) => line.includes(literal))

const staged = process.argv.includes('--staged')

/** 绝不匹配的示例值：文档里用于说明的占位串（`sk-mem-xxx`、`AKIA...` 之类）。 */
const PLACEHOLDERS = [/^(sk-)?mem-xxx$/i, /^x{3,}$/i, /^\.\.\.$/, /^your[-_]/i, /^<.*>$/, /^example/i]

const RULES = [
  ['私钥块', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['OpenAI/自建 sk- 密钥', /sk-[A-Za-z0-9]{20,}/],
  ['GitHub token', /(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/],
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['Google API key', /AIza[0-9A-Za-z_-]{30,}/],
  ['Slack token', /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ['Bearer 长串', /Bearer\s+[A-Za-z0-9._-]{20,}/],
  ['JWT', /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['凭据赋值', /(password|passwd|secret|token|api[_-]?key|apikey|credential)\s*[:=]\s*['"][^'"\s]{12,}['"]/i],
  ['npm 凭据', /(_authToken|_auth|npmAuthToken)\s*[:=]/],
]

/** 高熵串：只在"看不出是产物"的文件上跑（minified bundle 与 lockfile 天然全是这类串）。 */
const ENTROPY_RULES = [['高熵串（可能是未命名的密钥）', /[A-Za-z0-9_\-+/=]{40,}/g]]
const ENTROPY_SKIP = /^(client\.js|client\.mjs|package-lock\.json|pnpm-lock\.yaml)$/

function files() {
  const out = staged
    ? execSync('git diff --cached --name-only --diff-filter=ACMR -z', { encoding: 'utf8' })
    : execSync('git ls-files -z', { encoding: 'utf8' })
  return out.split('\0').filter(Boolean)
}

function entropyHit(token) {
  const classes = [/[a-z]/.test(token), /[A-Z]/.test(token), /[0-9]/.test(token)].filter(Boolean).length
  // 至少三类字符混合，且不像纯路径/纯 hex 的 sha 摘要（sha 后面跟 - 或空）
  return classes >= 3 && !/^[0-9a-f]{40,}$/.test(token)
}

const redact = (value) => `${value.slice(0, 4)}…（共 ${value.length} 字符）`
const hits = []
let suppressed = 0

for (const file of files()) {
  let text
  try { text = readFileSync(file, 'utf8') } catch { continue }
  if (text.includes('\0')) continue // 二进制跳过
  const lines = text.split('\n')

  lines.forEach((line, i) => {
    if (allowed(line)) { suppressed += 1; return }
    for (const [name, re] of RULES) {
      const m = line.match(re)
      if (!m) continue
      const value = m[1] ?? m[0]
      if (PLACEHOLDERS.some((p) => p.test(value.trim()))) continue
      hits.push({ file, line: i + 1, name, value })
    }
    if (ENTROPY_SKIP.test(file.split('/').pop())) return
    for (const [name, re] of ENTROPY_RULES) {
      for (const m of line.matchAll(re)) {
        if (!entropyHit(m[0])) continue
        if (PLACEHOLDERS.some((p) => p.test(m[0].trim()))) continue
        hits.push({ file, line: i + 1, name, value: m[0] })
      }
    }
  })
}

const scope = `${files().length} 个${staged ? '暂存' : '已跟踪'}文件`
if (hits.length === 0) {
  console.log(`secret scan passed: ${scope}，未发现凭据`
    + (suppressed > 0 ? `（${suppressed} 行按白名单跳过）` : ''))
  process.exit(0)
}
console.error(`✗ secret scan 命中 ${hits.length} 处，请确认是否为真实凭据后再提交：`)
for (const h of hits) console.error(`   ${h.file}:${h.line}  [${h.name}]  ${redact(h.value)}`)
process.exit(1)
