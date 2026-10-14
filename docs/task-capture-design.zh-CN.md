# 对话内待办 → TDAI task 捕获机制 · 设计方案

> 状态：**已实现（v1，2026-10-14）** —— 见 §12 实现记录。§10 的第 6 步（云端 skill 装 SOP）未做，
> 待用户确认后再上（它是 prompt 内容，与工具 description 同批审）。
> 目标读者：本插件后续实现者（含 AI）
> 相关接口盘点见上一轮调研：内核 `/v3/meta/task/*` 共 6 条 task + 3 条 task-agent + 2 条 participation-log

---

## 1. 要解决的问题

现在的待办散落在三种载体里，都不是长期档案：

| 载体 | 寿命 | 问题 |
| --- | --- | --- |
| DSH 原生 `todo_write` | 当前会话 | 会话一关就没了 |
| 团队任务板 `team_task_create` | 团队/会话生命周期 | 不是个人长期待办库 |
| 本地待办 md | 文件在 | **很容易跟踪丢失**（本次要消灭的正是这个） |

目标载体：**TDAI task**——服务端持久、Panel 可见、其他 agent 可见、且带 `task_id` 归属。

### 目标

- 对话里用户**明确要求记录**的待办，能一步落进 TDAI task，无需切窗口、无需手打命令。
- 落库的记录半年后还能看懂：原话、来源会话、可回溯。
- 记错了能撤销，不留垃圾在库里。

### 非目标（本版明确不做）

- **不主动识别隐含待办**（用户 2026-10-14 拍板：只在明确说"记一下"时写，见 §3）。
- 不做每轮旁路 LLM 抽取——判定力在模型侧已经有了，再抽一次是重复付费。
- 不做本地 md 双写。目标是消灭本地文件，不是给它加一个镜像。
- **不把新建的 task 自动绑定为会话 `task_id`**（理由见 §9）。

---

## 2. 架构：工具是手，模型是脑，skill 是口径

三者不是二选一：

| 层 | 承担什么 | 为什么是它 |
| --- | --- | --- |
| **工具**（插件新增 3 个） | 执行写入 / 查询 / 更新删除 | 只有插件进程拿得到 `x-tdai-user-key`；凭据不进模型可见的 prompt |
| **模型**（agent 本人） | 判定"这句话是不是明确要求记录" | 语义判断，正则做不到；模型本来就在读这轮对话，边际成本为零 |
| **skill**（云端 skill） | 记录口径、去重口径、失败处理 SOP | 靠每轮 skill 召回自动浮上来，不占常驻 prompt 预算 |

被否掉的方案与理由：

| 方案 | 否掉的原因 |
| --- | --- |
| 插件正则拦截自动写 | 无判定力。误记/漏记不可控，且用户无法预期写了什么 |
| 上游 `mem:create-task` 命令族 | DSH 路径用不上：MemoryProxy 的 `/v3/session/create-task` handler 在本版 `server.ts` 未注册，且 DSH 插件直连内核，不经过 proxy 的 LLM 转发 |
| 每轮旁路 LLM 抽取 | 每轮多一次 LLM 调用 + 延迟，收益与成本不匹配 |
| 纯 skill 提示（不加工具） | 没有写工具 = 没有手；skill 只能让模型"知道该记"，记不进去 |

---

## 3. 触发口径（已拍板）

**只在用户明确指示记录时写入。** 疑似待办但用户没说记 → 不写、不调工具（可以口头提一句"要不要我记下来"）。

### 3.1 "明确指示"的判定范围

算明确指示（典型表述，不要求字面命中）：

- "记一下：……" / "记个待办" / "帮我记下来"
- "把这个加到 task 里" / "记到任务里"
- "待办加上：……"

不算：

- 陈述一件将来要做的事，但没有记录指令（"下周要交季度报告"）
- 提问、抱怨、计划性闲聊
- 我（agent）自己提议的事项
- 我判断出的"隐含待办"

### 3.2 一轮多条

用户说过一次"记一下"之后，**同一轮对话里他点出的多条待办都可以记**，不必让他每条都说一遍咒语。判定边界以用户说话的语义边界为准（分号、换行、"还有"是他自己的切分信号）。

### 3.3 落库前的一句话确认不要

不确认。直接写 + 回执（见 §6），错了靠撤销。用户已明确选了"省一次往返"。

---

## 4. 代码落点（3 处）

### 4.1 `client.mjs` — meta 面写方法

现有 `headers(identity, { userKey })` 已支持 userKey 透传，`post()` 已处理 envelope 拆包与 `code != 0` 抛错，直接复用。

```js
// ── meta 面 · task 写侧（全部需要 userKey）─────────────────────────────

/** 建 task。creator_user_id 必须 == caller（内核强制），由调用方传入。 */
metaCreateTask(body) {
  return this.post('/v3/meta/task/create', body, { userKey: true, session: false, task: false })
}

/** 按 team + 过滤条件列 task，用于查重。 */
metaListTasks(body) {
  return this.post('/v3/meta/task/list', body, { userKey: true, session: false, task: false })
}

/** 更新 description / status。内核只允许 task creator 调。 */
metaUpdateTask(body) {
  return this.post('/v3/meta/task/update', body, { userKey: true, session: false, task: false })
}

/** 撤销：物理删除。 */
metaDeleteTasks(taskIds) {
  return this.post('/v3/meta/task/delete', { task_ids: taskIds }, { userKey: true, session: false, task: false })
}
```

**关键差异：写侧一律用 `post()`，不用 `safe()`。** `safe()` 的 fail-open 是读侧优点（失败返回 null，不阻断 DSH），但写侧静默失败 = "以为记上了其实没记上"，正是本方案要消灭的失败模式。错误必须原样抛回模型可见的工具输出。

`session: false, task: false` 的理由：meta 面不吃 `x-tdai-session-id` / `x-tdai-task-id`，带上无害但语义噪音；且避免将来误把会话 task_id 混进 meta 调用。

### 4.2 `lib/tools.mjs` — 注册 3 个工具

沿用现有 `register()` 闭包（含 `toParameterJsonSchema` / `render(_args, value)` / `sessionOf(exec, ctx)`）：

| 工具名 | 参数 | 说明 |
| --- | --- | --- |
| `tdai_task_add` | `title`(必填, ≤40 字), `note`(可选), `dedupe`(可选, 默认 true) | 建 task；`dedupe=true` 时先按 title 精确查重 |
| `tdai_task_list` | `status`(可选, 默认 running), `limit`(1–20) | 列本团队 task，供模型查重/看现状 |
| `tdai_task_update` | `task_id`(必填), `note`(可选), `status`(可选) | 追加描述或改状态（running/completed） |
| `tdai_task_delete` | `task_id`(必填) | 撤销，物理删除 |

写入字段映射：

```js
{
  team_id: identity.team_id,
  creator_user_id: identity.user_id,   // 必须 == caller：内核 assertCallerIsResourceOwner
  title,
  description: note,
  source_type: 'manual',               // 枚举只有 manual/tapd/github/other
  status: 'running',
  metadata_json: JSON.stringify({
    source: 'dsh',
    session_id: identity.session_id,
    agent_id: identity.agent_id,
    quote,                              // 用户原话
    captured_at: new Date().toISOString(),
  }),
}
```

守卫：

- `!runtime.userKey()` → 直接回「未配置 user key，无法写入 task」，不做假成功。
- 写工具**不挂 `readEnabled()`**（读侧总开关），跟 `taskWriteEnabled` 自己的开关走——对齐 `captureEnabled` 与读侧独立开门的既有先例。
- 工具描述里写清"何时该用 / 何时不必用"（本插件已有此惯例，例如 10 个只读工具的描述）。

### 4.3 `lib/settings.mjs` + `config.mjs` — 新增开关

- `taskWriteEnabled`（布尔，**默认关**）。理由：写的是你的生产库，先隔离彩排，E2E 通过后再打开（对齐既有"涉险变更先彩排"的做法）。
- 回滚：置 false 即恢复纯只读；已写入的 task 不受影响，删不删另说。

---

## 5. 记录口径（决定半年后这些 task 还能不能用）

| 字段 | 口径 |
| --- | --- |
| `title` | 用户原话压成**可执行短句**，≤40 字（与上游 proxy 的截断口径一致）。不润色成"XX 事项跟进" |
| `description` | 原文引用 + 一句上下文（哪个会话、在聊什么时说的） |
| `metadata_json` | `{source, session_id, agent_id, quote, captured_at}` —— 将来 task 莫名其妙时能回溯到原话 |
| `source_type` | 固定 `manual` |
| `status` | 新建一律 `running` |

反例（不许写进 title）：`跟进`、`XX 相关事项`、`待处理：XX` —— 这类标题三个月后等于没写。

---

## 6. 去重、撤销

**去重**：`dedupe=true` 时先 `task/list {team_id, status:'running', title:<精确>}`。命中 → 走 `update` 在 description 追加一行（带日期），**不新建**。用**精确匹配**，不用相似度/embedding——相似度去重是给自己埋坑（把两件不同的事合并成一件，比多一条重复记录糟得多）。

**回执**：写入后回一句 `已记：<title>（task-xxxxxxxx）`。回执里必须带 task_id，它是撤销的唯一把手。

**撤销**：
- 对话式：用户说"撤销上一条" → 模型调 `tdai_task_delete`。
- 插件侧保留**本次会话最后写入的 task_id 列表**（内存，不落盘），供 slash 命令 `/tdai-task-undo` 用；这样即使用户表达含糊也能删对。

---

## 7. 实测证据（2026-10-14，E2E 探针，已清理）

跑在本地内核 `http://127.0.0.1:8420`，用插件配置里的 `sk-mem-*` user key，全链路真实调用：

| 步骤 | 结果 |
| --- | --- |
| 0. 负例：`creator_user_id` 伪造为他人 | `HTTP 403 permission_denied: caller is not resource owner` ✅ 闸门有效，无副作用 |
| 1. `task/create` | `HTTP 200 code=0`，返回 task_id `task-xxxxxxxxxx`，status=`running`，creator=当前 user |
| 2. `task/get` 核对 | 字段回读一致，`metadata_json` 原样保留 |
| 3. `task/update` 追加描述 | `HTTP 200 code=0`，description 已替换 |
| 4. `task/list` 精确 title 过滤 | `total=1`，命中目标条 → 查重口径可用 |
| 5. `task/delete` | `{"deleted_ids":["task-xxxxxxxxxx"],"failed":[]}` |
| 6. 复核 `task/get` | `HTTP 404 task_not_found` ✅ |
| 7. 复核 `task/list` | `total=0` ✅ 库已回到干净状态 |

**TaskEntity 实测字段**（13 个）：
`task_id / team_id / creator_user_id / title / description / source_type / source_url / status / risk_level / auto_assign_floating_assets / metadata_json / created_at / updated_at`

**身份四元组**：`service_id=default`、`team_id=team-xxxxxxxx`、`agent_id=agt-xxxxxxxx`、`user_id=usr-xxxxxxxx`（user key 解出来就是它，实测 `auth/verify` valid=true）。
`task_id` 当前为空 → 对应用户看到的「task=未配置」。

**task_id 形态**：`task-` + 12 位小写字母数字。

---

## 8. 验证计划（实现阶段）

1. **单测**（`test/task-write.test.mjs`，mock client）：
   - `tdai_task_add` 的 payload 字段与 `creator_user_id == identity.user_id`；
   - `dedupe=true` 且 title 命中 → 走 update 不走 create；
   - userKey 缺省 → 明确失败文案，不假成功；
   - `render(args, value)` 签名（对齐 `test/tools-render.test.mjs` 已有的教训：第一个形参是参数，写错会静默回显参数）；
   - `taskWriteEnabled=false` → 工具调用被拒。
2. **E2E**（同上探针脚本，做成可重复执行的脚本，跑完自清理）。
3. **失败态文案**：401 `missing_user_key` / 401 `invalid_user_key` / 403 `permission_denied` / 404 `task_not_found` 四种，都不得吞成"已记录"。
4. **回归**：10 个只读工具与注入链路不受影响；`readEnabled=false` 时写工具仍可用（独立开关）。

---

## 9. 风险与刻意不做的事

| 项 | 处理 |
| --- | --- |
| 写侧 fail-open 假成功 | 禁用 `safe()`，错误必须回给模型（§4.1） |
| 把新建 task 绑为会话 `task_id` | **不做**。`task_id` 是数据隔离维度，已有历史记录 task_id 为空串，中途改会切分记忆桶（L0/L1 都带 task_id 列）。要做得单独评审，且只对新会话生效 |
| 库被塞垃圾 | 只在明确指示时写（§3）+ 精确去重 + 可撤销 |
| 误判成"已记录" | 回执必须带 task_id；E2E 复核步骤写进验证计划 |
| 权限模型变化 | `creator_user_id` 必须是 caller 这条是内核强制的，插件不可能绕过；用户 key 过期 → 明确报错 |

---

## 10. 分步实施与工作量

| 步骤 | 内容 | 预估 |
| --- | --- | --- |
| 1 | `client.mjs` 四个 meta 写方法 | 0.5h |
| 2 | `lib/tools.mjs` 四个工具 + 守卫 | 1.5h |
| 3 | `taskWriteEnabled` 开关（settings schema + config 解析 + 面板字段） | 0.5h |
| 4 | 单测 | 1h |
| 5 | E2E 脚本（可重复、自清理） | 0.5h |
| 6 | 云端 skill `tdai-task-capture`（记录口径 + 触发边界 SOP） | 0.5h |

合计约半天。建议顺序：1→2→4→5（先能跑能验），确认无误后再 3（开开关）、6（装口径）。

---

## 11. 待定项

- `tdai_task_update` 是否允许改 `title`：内核允许，本插件倾向**不允许**（标题漂移会让去重失真）。**v1 实现里已按"不允许"落地**（工具参数只有 note/status）。
- `/tdai-task-undo` 之外要不要 `/tdai-task list`（在 DSH 里直接看待办）：暂缓，避免与 Panel 重复。
- 一条 task 的生命周期：初期靠手动 `status=completed`；将来若要"日结提醒未完成待办"，那是独立提案。

---

## 12. 实现记录（2026-10-14）

### 落地清单

| 文件 | 改动 |
| --- | --- |
| `client.mjs` | 4 个 meta 写方法（`post()` 而非 `safe()`）；`post()` 非 2xx 分支补上响应体的 `code`/`message` |
| `lib/tools.mjs` | `registerTaskTools` + 4 个工具 + 会话级最近写入记录（`lastWrittenTasks` / `forgetWrittenTask`） |
| `config.mjs` | `taskWriteEnabled`（默认关，独立写侧） |
| `lib/settings.mjs` | schema / `SCHEMA_KEYS` / `VOLATILE_KEYS` 三处同步 |
| `client.card.tsx` + `client.js` | 面板「写侧」组新增开关（已 rebuild） |
| `cordis.patch.yml` | `TDAI_MEMORY_TASK_WRITE_ENABLED` 透传（`load.test.mjs` 有"每个 schema 键都要透传 env"的护栏） |
| `index.mjs` | 接线 `registerTaskTools`；runtime 加 `hasUserKey()` / `taskWriteEnabled()` |
| `lib/commands.mjs` | `/tdai-task-undo [task_id]`；`/tdai-status` 与 `/tdai-help` 同步 |
| `test/task-write.test.mjs` | 15 组断言（新） |
| `test/load.test.mjs` | 工具数 10 → 14 + 写工具无条件注册断言 |
| `scripts/task-write-e2e.mjs` | 可重复真连 E2E（自清理） |

### 验证结果

- `npm test`：全绿（含新增 15 组 + 既有 settings-card / prompt-budget / secret-scan）。
- `node scripts/task-write-e2e.mjs`：全绿、exit 0、库无残留（2026-10-14 二次实跑）。

### 实现期踩到的两个坑（都已修）

1. **`/tdai-task-undo` 把命令名当成了 task id**。`invocation.rawInput` 是 `/tdai-task-undo`，
   而它本身就含 `task-undo` 这一段 —— 用 `task-[0-9a-z]+` 去匹配会先命中它，"本会话最近一条"
   的兜底**永不生效**（每次都去删一个不存在的 `task-undo`，还会被内核 404 挡回来）。
   修法：先把命令名摘掉，再要求 id ≥6 位（真实形态是 `task-` + 10~12 位随机串）。
   单测第 13 组钉住了这条。
2. **E2E 脚本拿读侧方法等异常**。校验"删除后取不到"时用了 `client.metaGetTask()` ——
   它是读侧 fail-open（吞掉 404 返回 `null`），于是 `expectThrow` 永远等不到异常，
   测试自己报假阴性。改成裸 `client.post()` 观察服务端真实响应，另加一条断言明确
   "读侧 fail-open 返回 null" 的语义。

### 实际代价（原方案低估的一项）

4 个工具的 schema 是**常驻上下文**，实测 **2872 B**：

| 工具 | schema 字节 |
| --- | --- |
| `tdai_task_add` | 1308 |
| `tdai_task_update` | 629 |
| `tdai_task_delete` | 489 |
| `tdai_task_list` | 446 |
| 合计（含原有 10 个则 6543 → **9415 B**） | 2872 |

关着开关也要付这笔钱：`taskWriteEnabled` 是 volatile 字段（面板可改），改它**不会**重新
apply 插件，所以"关着时注册、打开时生效"做不到 —— 只能无条件注册、调用时判开关。
想省这笔字节就得砍 `tdai_task_add` 的描述（1308 B 里大部分是触发口径），
但那正是"只在明确要求时写"的判据来源，砍它等于砍掉保底档。
