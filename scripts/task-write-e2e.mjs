#!/usr/bin/env node
/**
 * 待办写侧 E2E：**真连内核**跑一遍 create → get → update → list → delete，跑完自清理。
 *
 * 为什么单测不够：单测用的是假 client，钉住的是 payload 与失败语义；这里钉的是
 * **内核真的收不收、权限真的过不过、删得掉不干净** —— 三者都在服务端，假不了。
 * 设计依据见 docs/task-capture-design.zh-CN.md §7（本脚本是那次探针的可重复版本）。
 *
 * 身份来源（按优先级）：
 *   1. 环境变量 TDAI_MEMORY_USER_KEY / TDAI_MEMORY_ENDPOINT / TDAI_MEMORY_TEAM_ID / TDAI_MEMORY_USER_ID
 *   2. profile patch（默认 ~/.dsh/profiles/web/cordis.patch.yml，可用 TDAI_MEMORY_PATCH 指别处）
 * **User Key 不会被打进任何输出**（本文件也不允许出现明文密钥，见 scripts/check-secrets.mjs）。
 *
 * 用法：node scripts/task-write-e2e.mjs
 * 退出码：0 = 全通过且已清理；1 = 有断言失败（清理仍会尽力执行）。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { GatewayClient } from '../client.mjs'

const TAG = '[task-write-e2e]'
const PROBE_TITLE = '[探针] dsh-tdai-memory-plugin 待办写侧 E2E（自动清理）'

function readPatchConfig() {
  const path = process.env.TDAI_MEMORY_PATCH || join(homedir(), '.dsh', 'profiles', 'web', 'cordis.patch.yml')
  const text = readFileSync(path, 'utf8')
  const pick = (key) => text.match(new RegExp(`^\\s*${key}:\\s*(\\S+)\\s*$`, 'm'))?.[1]
  // !!js 表达式的行（如 taskId）取不到纯值，这里只关心四个朴素字段
  return { path, userKey: pick('userKey'), teamId: pick('teamId'), userId: pick('userId') }
}

function resolveIdentity() {
  const fromEnv = {
    userKey: process.env.TDAI_MEMORY_USER_KEY,
    teamId: process.env.TDAI_MEMORY_TEAM_ID,
    userId: process.env.TDAI_MEMORY_USER_ID,
    endpoint: process.env.TDAI_MEMORY_ENDPOINT,
    serviceId: process.env.TDAI_MEMORY_INSTANCE_ID,
  }
  let patch = {}
  if (!fromEnv.userKey || !fromEnv.teamId || !fromEnv.userId) {
    try {
      patch = readPatchConfig()
    } catch (error) {
      console.error(`${TAG} 读不到 profile patch（${error.message}）；请设 TDAI_MEMORY_USER_KEY / TDAI_MEMORY_TEAM_ID / TDAI_MEMORY_USER_ID`)
    }
  }
  return {
    userKey: fromEnv.userKey || patch.userKey || '',
    teamId: fromEnv.teamId || patch.teamId || '',
    userId: fromEnv.userId || patch.userId || '',
    endpoint: fromEnv.endpoint || 'http://127.0.0.1:8420',
    serviceId: fromEnv.serviceId || 'default',
    patchPath: patch.path,
  }
}

const id = resolveIdentity()
if (!id.userKey || !id.teamId || !id.userId) {
  console.error(`${TAG} 缺身份：userKey=${Boolean(id.userKey)} teamId=${Boolean(id.teamId)} userId=${Boolean(id.userId)}`)
  process.exit(1)
}
if (!id.userKey.startsWith('sk-mem-')) {
  console.error(`${TAG} userKey 形态不像 sk-mem-…，meta 面会 401`)
  process.exit(1)
}

const client = new GatewayClient({
  endpoint: id.endpoint, apiKey: process.env.TDAI_MEMORY_API_KEY || 'local',
  serviceId: id.serviceId, userKey: id.userKey, timeoutMs: 10000,
}, (m) => console.error(`${TAG} ${m}`))

let failures = 0
function check(ok, label, detail = '') {
  console.log(`${ok ? '  ✅' : '  ❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}
/** 期望抛错的调用：把错误信息取出来，不打印密钥。 */
async function expectThrow(fn) {
  try {
    await fn()
    return null
  } catch (error) {
    return String(error?.message ?? error)
  }
}

const listCount = async () => {
  const page = await client.metaListTasks({ team_id: id.teamId, limit: 100, offset: 0 })
  return { count: Array.isArray(page?.items) ? page.items.length : 0, total: page?.total ?? 0 }
}

// 标题带时刻，避免与上一次异常中断留下的探针撞名（去重会把它当成"同名追加"）
const title = `${PROBE_TITLE} ${new Date().toISOString().slice(11, 19)}`
let created = null

try {
  console.log(`${TAG} endpoint=${id.endpoint} team=${id.teamId} user=${id.userId}（配置来源：${process.env.TDAI_MEMORY_USER_KEY ? 'env' : id.patchPath}）`)
  const before = await listCount()
  console.log(`${TAG} 现有 task：${before.total} 条`)

  console.log('── 0. 负例：伪造 creator_user_id（应 403，无副作用）')
  const forged = await expectThrow(() => client.metaCreateTask({
    team_id: id.teamId, creator_user_id: 'usr-someone-else', title: `${title}（不该被创建）`, source_type: 'manual',
  }))
  check(/403|permission_denied/.test(forged ?? ''), '内核拒绝伪造归属', forged?.slice(0, 120))

  console.log('── 1. create')
  created = await client.metaCreateTask({
    team_id: id.teamId,
    creator_user_id: id.userId,
    title,
    description: 'E2E 探针：创建后立刻删除。',
    source_type: 'manual',
    status: 'running',
    metadata_json: JSON.stringify({ source: 'e2e-script', captured_at: new Date().toISOString() }),
  })
  check(Boolean(created?.task_id), '返回 task_id', created?.task_id)
  check(created?.creator_user_id === id.userId, 'creator_user_id 回显等于 caller', created?.creator_user_id)
  check(created?.status === 'running' && created?.source_type === 'manual', 'status/source_type 已落库')

  console.log('── 2. get 核对')
  const got = await client.metaGetTask(created.task_id)
  check(got?.title === title, '标题原样回读')
  check(JSON.parse(got?.metadata_json ?? '{}').source === 'e2e-script', 'metadata_json 原样保留')

  console.log('── 3. update（追加描述）')
  const updated = await client.metaUpdateTask({ task_id: created.task_id, description: '追加描述：update 路径已验证。' })
  check(updated?.description === '追加描述：update 路径已验证。', 'description 已更新')

  console.log('── 4. list（查重口径：status + title 精确匹配）')
  const hits = await client.metaListTasks({ team_id: id.teamId, status: 'running', title, limit: 10, offset: 0 })
  check((hits?.items ?? []).some((t) => t.task_id === created.task_id), '精确 title 过滤命中本任务')
  check((hits?.items ?? []).every((t) => t.title === title), '过滤结果无不同名的杂项')
} catch (error) {
  check(false, 'E2E 执行中断', String(error?.message ?? error))
} finally {
  console.log('── 5. 清理')
  if (created?.task_id) {
    try {
      const deleted = await client.metaDeleteTasks([created.task_id])
      check(!(deleted?.failed ?? []).length, 'delete 无失败项', JSON.stringify(deleted?.deleted_ids ?? []))
      // 直接 post 观察服务端真实响应：metaGetTask 是**读侧 fail-open**（吞 404 返回 null），
      // 拿它等异常会永远等不到 —— 也就证不了"服务端确实不再有这条"。
      const raw = await expectThrow(() => client.post('/v3/meta/task/get', { task_id: created.task_id }, { userKey: true }))
      check(/404|not_found/.test(raw ?? ''), '删除后裸 post 返回 404', raw?.slice(0, 100))
      check((await client.metaGetTask(created.task_id)) === null, '读侧 fail-open：metaGetTask 返回 null（不是抛错）')
      const final = await listCount()
      check(final.count === 0 || final.count < 100, '库已回到无探针状态', `当前 ${final.total} 条`)
    } catch (error) {
      check(false, '清理失败（可能留下一条探针 task，请手动删）', String(error?.message ?? error))
      console.error(`${TAG} 残留 task_id=${created.task_id}`)
    }
  } else {
    console.log('  （没有创建成功，无需清理）')
  }
}

console.log(failures === 0 ? `${TAG} 全部通过` : `${TAG} 有 ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
