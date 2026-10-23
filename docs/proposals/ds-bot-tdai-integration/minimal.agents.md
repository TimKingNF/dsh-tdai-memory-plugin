# 最小集成 · agent 执行层

> 配套人读稿：[minimal.md](./minimal.md)｜负责人：Tim ｜ 日期：2026-10-22 ｜ 状态：**已实施（r3）**，偏差见人读稿 §11
> 本文只放执行层：步骤、契约、验收、禁止事项。设计理由与取舍在人读稿，冲突以人读稿为准。
> 时序事实见 [timing-probe.md](./timing-probe.md)，动手前先跑一遍探针。

## 0. 何时用 / 何时不用

- 用：按本稿实现 ds-bot × tdai 的最小集成（lean 读侧 + 按人锚点写回合）。
- 不用：做历史回放、每 Bot 一个 agent、群聊记忆隔离、身份映射——这些在 [§9](./minimal.md#9-下一步迭代规划) 里，尚未开工。

开工前先读三节：[§1 结论](./minimal.md#1-结论)（改什么、不改什么）、[§7 待决](./minimal.md#7-待决问题分析)（哪几件还要实测定夺）、[时序实测](./timing-probe.md)（为什么必须两阶段）。

## 1. 前置事实（动手前核对，不靠记忆）

| 事实 | 位置 / 取法 |
| --- | --- |
| 唯一写钩子 | `agent/turn-stopping`，成功路径且在 `turn/end` 之前（`dsh-agent-loop/lib/index.js:997-1004`）；异常轮走 `catch → turn/end`，不经过它（同文件 `:1006-1030`） |
| 真人消息形状 | `user/message` 的 `data = {content, source, role, id}`；`source.kind` 是判据；**`data.turn` 缺失（实测 22/22）**，归属轮靠 `currentTurn` |
| 会话 id 表 | 事件 session id = `bots` 键名 / `rooms` 键名 / `rooms[*].sessions` 的值；`bots[*].sessionId` 是 Bot 当前会话（可能不在 bot workspace，实测 ARK-Alpha 为 `/mnt/d/workspace`）；`segments[*].sessionId` 是 rollover 旧段；**容忍 `segments` 缺失** |
| room log | `state.json` → `rooms[*].log`，最多 60 行，字段 `who / botId / text / seq`（真人行只有 `seq/text/who`，**无时间戳**）；截断行多一个 `length` |
| 长贴全文 | `<DSH_HOME>/bot/group-lines/<roomId>/<seq>.txt`（`TEXT_KEPT=2000`，`constants.js:27`；`groups.js:132-146`） |
| ds-bot 长期记忆 | `<DSH_HOME>/bot/memory/team/MEMORY.md`、`memory/bots/<botId>/MEMORY.md`；条目形如 `- 事实 [source: group "X" 10-20 09:53; by: Bot; added: 2026-10-20]` |
| 主持 Bot 模型 | `rooms[*].admin` → `bots[admin].model`（缺失时取 `members` 里第一个存在的 Bot），形如 `opencode-go/deepseek-v4.1-flash` |
| 现有写入白名单 | `lib/capture.mjs:153`（`kind !== 'user'` 整条丢） |
| 写接口 | `POST /v3/conversation/add`，`content ≤ 8192`，单批 ≤ 100，只收 `role/content/timestamp?` |
| 读侧策略调用点 | `index.mjs:114`（`readPolicyFor` 本体）、`index.mjs:179`（预热）、`sections.mjs:376`、`sections.mjs:392`、`recall.mjs:268`；`lib/assets.mjs` 只消费传入的 policy（`:216`），**不是调用方**；`commands.mjs:32,48` 与 `tools.mjs:555` 经 `readPolicyFor` 间接生效 |
| `knowledgeEnabled` 默认 | **false**（`config.mjs:156`、`lib/settings.mjs:104`） |
| Core 的写入顺序 | `v2-router.ts` 按数组顺序批量插入，不按 timestamp 排序；`conversationItemSchema` 里 `timestamp` 可选、`content ≤ 8192` |
| Core 的 L1 计数 | `rounds = messages.filter(m => m.role === 'user').length` —— 按 **user 条数**，不是轮数（`v2-router.ts`） |

## 2. 步骤（每步一个 done when）

0. **先跑时序探针，确认环境与假设没变**
   `python3 scripts/dsbot-timing-probe.py --json /tmp/timing-probe.json`。
   done when：输出里 `room-root` 的 completed 轮「收尾步无 text」仍接近 100%，群聊锚点「晚于轮末」不为 0；若两者都变了，先改设计方案再动代码。

1. **`lib/dsbot.mjs`：索引与策略**
   建 `sessionIndex`（bots / `bots[*].sessionId` / segments / rooms / `rooms[*].sessions` / `rooms[*].segments` 五类，缺失容忍）；对 state.json 做 5 秒 mtime 缓存 + `forceRefresh()`；`sessionPolicy(cfg, session)` 返回**超集** `{subagent, inherit, bot, kind, identity, memory, skills, knowledge}`（保留 `subagent`/`inherit`，否则 `test/subagent.test.mjs` 的 `deepEqual` 与 `FULL_POLICY` 全挂）；`roomLog(roomId)` 返回 `{lines, seq, truncated}`。
   done when：fixture 下 bot / room / room-member / ordinary 四类判定正确；`npm test` 通过（含更新后的 `test/subagent.test.mjs`）。

2. **`lib/dsbot-ledger.mjs`：持久层**
   落 `<DSH_HOME>/storages/tdai-memory-plugin/dsbot-state.json`（§3.3 结构）；原子写（`*.tmp` + `rename`）；启动时 `mkdir -p`；路径校验（拒绝 `<DSH_HOME>/bot` 之下）。
   done when：ENOENT 当空台账；坏 JSON / `version≠1` / EACCES / 目录不可写 → 停写 + 告警（点名路径与错误原文）；路径指向 bot 目录 → 拒绝并回退默认 + 告警。

3. **读侧接线**
   把 `readPolicyFor` 本体换成 `sessionPolicy`（内部先判子会话、再判 Bot 会话），并逐处核对 `index.mjs:179` 预热与 `sections.mjs:392` 装配；Bot 会话 `identity=false, memory=false, skills=true, knowledge=true`；`agent/created` 预热只按新策略的面走。
   done when：Bot 会话 system prompt 里没有 `<session_context>`、`<tdai_profile_memory>`、`<tdai_recalled_l1_memories>`；`knowledgeEnabled=true` 时有 `<knowledge_tools>`（默认 false 时**不要求**）；普通会话 prompt diff 为空。

4. **Bot 会话的 skill query**
   `buildSkillQuery` 在 Bot 会话改用 `buildBotSkillQuery`：取最后一条 `kind='bot'` 的 user 消息，剥信封（`[Group post from X]` / `[Group chat "…" · your turn]` / `[Bot team setup]` / `[Handoff · part N]` / `[Checkpoint N]`），room 正文取 `This round so far` 到 `Speaking order` 之间，兜底末 512 字符。
   done when：`buildBotSkillQuery([relay])` 非空；真会话日志里能打出非空 query 与命中条数。

5. **私聊写侧（turn-stopping）**
   只收人锚点（`kind ∈ {user, user-question-reply}`）；终稿取本轮**最高 step** 的 text 块（工具调用与 tool_result 全丢）；轮内无人锚点则整轮不写；不调 `addSkillConversation`。
   done when：纯 relay 轮新增 0 条；真人一轮 2 条（终稿缺失时 1 条）；工具 0 条；`timestamp` 用事件时间。

6. **卡片归一化**
   解析 `user-question-reply` 的 JSON（`questions[].question/detail/options` 与 `answers`），拼成 `[卡片] 问：… / 可选：… / 答：…`，截 1,200 字符；解析失败保底 `[卡片] ` + 原文。
   done when：夹具里卡片答案写成可读问答，`role=user`。

7. **群聊两阶段**
   轮末 `forceRefresh()` 后定位（`who==='User'`，有 `botId` 时必须 undefined；文本规范化；取**最小** `seq > 断点`；歧义即视为未命中）；命中则算窗口（`断点 < seq < 锚点 seq`，最后 N 条）→ 蒸 → 写摘要 → 写人话 → 推进断点；未命中则记 pending 且不写；pending 重试上限 3 次或 10 分钟，超限只写人话 + typed skip + 断点推进到日志末尾。**蒸馏失败同样只写人话 + `distill-failed`，不写任何兜底原文。**
   done when：三种夹具各自通过——轮末即命中（2 条）、晚一轮命中（先 0 条后 2 条）、永不命中（1 条 + skip + 断点前移）。

8. **失败轮**
   Bot 会话的 `agent/error` 与 `turn/end`（非 completed）：**只写本轮已缓冲的人话**（已决），不写终稿、不做摘要，并记一条日志。
   done when：失败轮夹具里写出 1 条人话、0 条终稿；普通会话行为不变。

9. **环覆盖与断点**
   `lastHuman.seq + 1 < log[0].seq` 视为断点滑出：窗口从 `log[0].seq` 起、告警 `checkpoint-lost`、并重置断点。
   done when：夹具里造 60 行环 + 旧断点，产出告警与正确的窗口起点。

10. **开关、设置页与状态**
    新增七个字段（§3.1），其中三个开关要进设置页：`client.card.tsx` 加一组 "Bot 会话 · ds-bot"（带 `dimmedBy` 串联）→ `node build-card.mjs` 重建 `client.js` → 同步 `test/settings-card.test.mjs` 的字段断言。`/tdai-status` 输出 `dsbot=<bot|room|room-member|ordinary> skill=<on|off> write=<on|off> bot=<id|-> room=<id|-> ledger=<path>`；`dsbotAwarenessEnabled=false` 后行为与现状逐字节一致（且只有它能恢复全量回流）。
    done when：面板改开关即时生效（volatile）；关总闸后 Bot 会话恢复全量注入与全量回流。

11. **测试**
    按 §4.2 的 19 组夹具落测。
    done when：`npm test` 全绿；每组断言「写了几条、role 是什么、内容前缀是什么、台账怎么变」。

## 3. 契约

### 3.1 配置键与开关语义

七个字段，全部 `.volatile()`（面板可见）。**三个开关是串联的**：Bot 侧的两个子开关只有在插件全局开关为真时才有效。

| 键 | 类型 | 默认 | 面板标签 | 作用 |
| --- | --- | --- | --- | --- |
| `dsbotAwarenessEnabled` | vol bool | `true` | 识别 ds-bot 会话 | 总闸。关掉后不索引 state.json、Bot 会话按普通会话处理（唯一能回到改动前的开关） |
| `botSkillInjectEnabled` | vol bool | `true` | Bot 会话注入云端 skill | 注入开关。只管 `<tdai_recalled_skills>` 与每轮 skill 检索；身份 / L3 画像 / L1 召回对 Bot 会话**恒关**，不给开关（理由见下） |
| `botWritebackEnabled` | vol bool | **`false`** | Bot 会话回写记忆 | 回写开关。`true` 才按人锚点写 L0；默认 `false`，首次上线由你手动打开 |
| `botContextDistillEnabled` | vol bool | `true` | 群聊前文蒸馏 | 关掉后群聊只写人话 |
| `botContextMessages` | vol num 0–20 | `5` | 群聊窗口条数 | 0 等同关闭蒸馏 |
| `botContextReuseMemory` | vol bool | `false` | 复用本群 MEMORY 条目 | 默认关，避免归因回环 |
| `botContextModel` | vol str | `''` | 蒸馏模型 | 空 = 主持 Bot 的模型。主持 Bot 若挂在会思考的模型上（`off` 档不存在），思考 token 会挤掉正文，建议填一个无思考档位的小模型，如 `deepseek-official/deepseek-flash` |
| `botContextMaxTokens` | vol num 100–32000 | `5000` | 蒸馏输出上限 | 思考 token 也从这里扣；正常摘要只花 200–300，这个值只是上限 |
| `botContextTimeoutMs` | vol num 2000–60000 | `15000` | 蒸馏超时 | 思考型模型在 5,000 预算下可能想十几秒；8 秒会 timeout（现场踩过） |
| `dsbotLedgerPath` | vol str | `''` | 台账路径 | 空 = `<DSH_HOME>/storages/tdai-memory-plugin/dsbot-state.json`；不接受 `<DSH_HOME>/bot` 之下 |

**有效值只在两处计算，不许散落到各调用点**：

```js
// 读侧（lib/dsbot.mjs 的 sessionPolicy）
const skillInject = cfg.dsbotAwarenessEnabled && cfg.botSkillInjectEnabled
            && cfg.enabled && cfg.skillsEnabled          // 读侧总开关 + 云端 skill 召回闸
// 写侧（lib/dsbot.mjs 的 writebackAllowed）
const write  = cfg.dsbotAwarenessEnabled && cfg.botWritebackEnabled
            && cfg.captureEnabled                          // 全局回写总闸
```

| 想达到的效果 | 需要的开关组合 |
| --- | --- |
| Bot 会话只注入 skill、不回写（默认） | 总闸 on；`botSkillInject=true`；`botWriteback=false` |
| Bot 会话也不注 skill | `botSkillInject=false`（Bot 会话只剩知识工具） |
| Bot 会话回写 | 再加 `botWriteback=true` + 全局 `captureEnabled=true` |
| 完全回到改动前 | `dsbotAwarenessEnabled=false`（其余开关失效） |

**为什么身份与记忆不给开关**：Bot 会话的 `identity` 与 `memory` 在代码里恒为 `false`，不是"暂时关掉"，是三条设计结论：

1. `<session_context>` 装的是 tdai agent 的角色与规则，而 ds-bot 的 `# Your identity` 已经在同一份 system prompt 里；两边各写一份必漂移，角色权威归 ds-bot，tdai 侧 `prompt` 留空。
2. `memory` 面同时管 L3 画像与 L1 召回。本阶段没有「每 Bot 一个 tdai agent」，打开就等于所有 Bot 共用一份人物画像，且 Bot 之间的讨论会被当成"关于人"的证据。
3. 真要用调试，把策略改成 `inherit` 走代码，不要做成面板开关——面板上一个能开的东西，早晚会被当成受支持的用法。

设置页实现（`client.card.tsx` 新增一组 "Bot 会话 · ds-bot"，用现成的 `dimmedBy` 表达串联）：

| 面板字段 | `dimmedBy` | 置灰提示 |
| --- | --- | --- |
| 识别 ds-bot 会话 | — | — |
| Bot 会话注入云端 skill | `['dsbotAwarenessEnabled','enabled','skillsEnabled']` | 「Bot 会话识别 / 读侧总开关 / 云端 skill 召回」任一关闭时置灰；hint 注明身份与记忆不注入 |
| Bot 会话回写记忆 | `['dsbotAwarenessEnabled','captureEnabled']` | 「Bot 会话识别 / 对话回流」任一关闭时置灰 |
| 群聊前文蒸馏 | `['dsbotAwarenessEnabled','botWritebackEnabled']` | 回写关着时蒸馏没有意义 |
| 群聊窗口条数 / 复用 MEMORY | 同上 | — |

常量（不进配置）：`ANCHOR_RETRY_LIMIT=3`、`ANCHOR_RETRY_WINDOW_MS=600000`、蒸馏超时 8s、`maxTokens=600`、摘要上限 1,200 字符。

### 3.2 写入契约

| 会话 | 触发 | 写入（按顺序） | session_id | 上限 |
| --- | --- | --- | --- | --- |
| 私聊（bot） | 本轮有 ≥1 人锚点 | `user`（人话或卡片）+ `assistant`（终稿） | bot 会话 id | 8,000 / 条 |
| 群聊（room） | 锚点已在 log 定位到 | `assistant`（前文摘要）+ `user`（人话） | 房间会话 id | 摘要 1,200 / 人话 8,000 |
| 群成员会话 | 永不 | — | — | — |
| 普通会话 | 原逻辑 | 原逻辑 | 原 session | 原逻辑 |

- 身份统一：`team_id / agent_id / user_id` 一律取 canonical（`cfg.teamId / agentId / userId`）；`session_id` 按上表。**一个实例一个 `user_id`**，多真人房间会把不同说话人合并成同一人——已知限制，见 [§9](./minimal.md#9-下一步迭代规划)。
- 每条记录都传 `timestamp`（人话用 `user/message` 的 `time`，终稿用该 step 的时间），不依赖批内隐式顺序。
- 一轮里有多个锚点按 `seq` 顺序逐个处理：群聊每个锚点各写「摘要 + 人话」，私聊每个锚点各写一条 user、终稿只写一条。
- 群聊摘要没有可写的窗口时（窗口为空或只有 User 行）→ 只写人话。
- 页脚一行：`[群聊「<房间名>」· 前文 seq <a>–<b>]`，便于事后核对窗口与去重。

### 3.3 台账

```json
{
  "version": 1,
  "index": {
    "stateMtimeMs": 1792561219195,
    "sessions": { "<sid>": { "kind": "bot|room|room-member", "botId": "", "roomId": "" } },
    "signals": ["<见过 kind=bot 的 sid>"]
  },
  "rooms": {
    "<roomId>": {
      "lastHuman": { "seq": 92, "hash": "sha1:…" },
      "pending": { "text": "原文", "time": 1792561219195, "hash": "sha1:…", "attempts": 1, "firstSeenAt": 1792561219195 },
      "stage": { "summary": "written|pending", "human": "written|pending" }
    }
  },
  "direct": { "<botId>": { "lastMessageId": "a1f10052-…" } }
}
```

读取语义（写死，不许实现者自选）：

| 情况 | 行为 |
| --- | --- |
| 文件不存在（ENOENT） | 空台账，正常首启 |
| JSON 解析失败 / EACCES / `version !== 1` | **停写** Bot 会话全部记录 + 一条告警（点名路径与错误原文）；**不得**推断为「无台账」 |
| 目录不可写 / 写入失败 | 同上，停写 + 告警 |
| 配置路径在 `<DSH_HOME>/bot` 之下 | 拒绝该路径、回退默认、告警 |

幂等与崩溃恢复：

- 群聊：键 `(roomId, humanSeq)` + `contentHash`；写顺序 = 先落 `stage`（`summary: pending`）→ 写摘要 → 更新 `summary: written` → 写人话 → 更新 `human: written` → 推进 `lastHuman`。任一步崩溃后按 `stage` 续跑：`summary=written` 就只补人话。
- 私聊：键 `(sessionId, lastMessageId)`；终稿与人话同批提交，重复投递直接跳过。
- 群聊 pending 的重试计数只在「轮末定位失败」时 +1，命中后立即清零。

### 3.4 记录格式

```text
私聊 user      <原话>
私聊 user      [卡片] 问：<q>
               可选：<o1> / <o2>
               答：<a>
私聊 assistant <终稿原文>
群聊 assistant [群聊「<房间名>」· 前文 seq <a>–<b>]
               - <谁 做了什么 / 决定了什么 / 留下什么未决>
               - …
               结论：<团队当前状态；没有结论写「未收口」>
群聊 user      <原话>
```

摘要正文是 3–5 条 `- ` 开头的行为 + 一行 `结论：`（页脚行不计入条数），总量 ≤600 字符，记录级上限 1,200。

### 3.5 蒸馏调用（形状已核，见 `scripts/verify-llm-api.mjs`）

- 取 llm：`const llm = ctx.get('llm')`；拿不到 → 只写人话 + `distill-failed`，不抛错。
- 模型：`rooms[*].admin` → `bots[admin].model`，缺失时取 `members` 里第一个存在的 Bot；按 `/` 拆 `provider/model`；拆不出 → 只写人话。
- 档位：`const info = await llm.resolveModelInfo(provider, model, signal)`（**方法**，不是自由函数）；`info.reasoning.efforts` 由低到高，优先 `id === 'off'`，否则 `efforts[0]`；拿不到就不带 `reasoningEffort`。
- 调用（三条硬约束：`signal` 在 options 内、`stream` 是 AsyncIterable、装配用 `BlockAssembler`）：

```js
import { BlockAssembler } from '@deepseek-ai/dsh-llm'

const signal = AbortSignal.timeout(8000)
const info = await llm.resolveModelInfo(provider, model, signal)
const efforts = info?.reasoning?.efforts ?? []
const effort = (efforts.find((e) => e.id === 'off') ?? efforts[0])?.id
// 消息必须是完整 Message（id + role + content + source），裸 {role, content} 会被适配器丢掉内容。
const message = { id: randomUUID(), role: 'user', content: [{ type: 'text', text: userPrompt }], source: { kind: 'dsh-tdai-memory-distill' } }

const options = {
  provider, model,
  messages: [message],
  system: systemPrompt,
  maxTokens,                 // 配置项 botContextMaxTokens（默认 5,000）
  signal,
  sessionId: `tdai-distill:${roomId}`,  // ⚠️ 两件事：① opencode-go 靠它填 x-opencode-session（缺了 400）；
                                        // ② 必须是**合成 id**——传真实房间 id 会被 ds-bot 的 llm/stream
                                        //    监听器当成群聊 relay 轮接管，只回一个空 finish，请求到不了模型
  ...(effort === undefined ? {} : { reasoningEffort: effort }),
}
const assembler = new BlockAssembler()
for await (const chunk of llm.stream(options)) assembler.push(chunk)
const text = assembler.blocks().filter((b) => b.type === 'text').map((b) => b.text).join('')
```

- 提示词三段：系统段（只输出 bullet + 结论，不加评价、不用第一人称）、背景段（MEMORY 条目 ≤6 条、每条 ≤200 字符，默认关）、对话段（`<who>: <text>`，旧→新）。
- 失败（超时 / 报错 / 空文本 / 未注册 provider）：**只写人话 + `distill-failed` skip，不写兜底原文**。理由：兜底原文是 Bot 措辞，进 L0 只会制造归因风险；宁可该轮前文不进记忆。

### 3.6 失败矩阵

| 情况 | 读侧 | 写侧 |
| --- | --- | --- |
| `state.json` 不可读，台账有 `index` | lean（用 stale 索引） | 停写 + 告警 |
| `state.json` 不可读，台账无 `index` | 原逻辑 | 原逻辑 + 告警 |
| 台账损坏 / 版本不符 / 不可写 | 不受影响（策略不依赖台账） | 停写 + 告警，点名文件与错误原文 |
| 群聊锚点本轮未定位 | — | 记 pending，0 条 |
| pending 超限（3 次 / 10 分钟） | — | 只写人话 + typed skip + 断点推进到日志末尾 |
| 蒸馏超时 / 失败 / 空输出 | — | 只写人话 + `distill-failed` |
| Core 写入失败 | — | 不推进断点/阶段，下轮按 stage 重试 |
| `agent/error` / `turn/end` 非 completed | — | 只写人话（已决），不写终稿 |
| `ctx.llm` 不存在 | — | 只写人话 + `distill-failed`，不报错 |

## 4. 验收

### 4.1 命令

```bash
cd /mnt/d/workspace/github/dsh-tdai-memory-plugin
npm test
node --check lib/dsbot.mjs
node --check lib/dsbot-ledger.mjs
node --check lib/dsbot-context.mjs
node --check lib/capture.mjs
node --check index.mjs
python3 scripts/dsbot-timing-probe.py            # 时序假设是否仍成立
node scripts/verify-llm-api.mjs                   # 蒸馏调用形状是否仍成立（17 条断言）
```

### 4.2 夹具清单（19 组）

| # | 场景 | 断言 |
| --- | --- | --- |
| 1 | DM 正常轮 | 2 条：user=原话 → assistant=最高 step 文本；都带 timestamp |
| 2 | DM 纯 relay 轮 | 0 条 |
| 3 | DM 收尾步无 text | 1 条（仅 user） |
| 4 | 群聊轮末即命中 | 2 条：assistant 摘要（含 `seq a–b`）→ user |
| 5 | 群聊晚一轮命中 | 首轮 0 条 + pending；次轮 2 条 |
| 6 | 群聊永不命中 | 1 条 + typed skip + 断点推进到日志末尾 |
| 7 | 台账坏 JSON | 0 条 + 告警含路径与解析错误原文 |
| 8 | 台账 `version=2` | 0 条 + 告警 |
| 9 | 崩溃注入（摘要已写、人话未写） | 重试只写人话，摘要不重复 |
| 10 | 重复投递同一 `messageId` | 仍为 2 条 |
| 11 | 一轮多锚点 | 群聊每锚点各 2 条；私聊 N 条 user + 1 条终稿 |
| 12 | `state.json` 不可读 + 台账有 index | lean + 停写 + 告警 |
| 13 | 普通会话 | prompt diff 为空（golden） |
| 14 | 台账路径指向 bot 目录 | 拒绝 + 回退默认 + 告警 |
| 15 | 环覆盖（断点滑出） | `checkpoint-lost` 告警 + 窗口起点=`log[0].seq` |
| 16 | 蒸馏失败（超时/空文本） | 只写 1 条人话 + `distill-failed`；**不写任何兜底原文** |
| 17 | skill 注入开关 | `botSkillInject=false` → 无 `<tdai_recalled_skills>`；`true` 且 `skillsEnabled` 开 → 有；两种状态下 Bot 会话都没有 `<session_context>` 与 `<tdai_profile_memory>` |
| 18 | 回写开关 | `botWriteback=false` → 0 条；改 `true` 但全局 `captureEnabled=false` → 仍 0 条（全局优先） |
| 19 | 设置页 | 三个开关出现在面板；父开关关闭时子开关置灰且提示文案正确（`CARD_FIELDS` 断言） |

### 4.3 现场三条（重启后跑）

```bash
# 1) 状态行：应出现 dsbot=bot / dsbot=room 与台账路径
/tdai-status

# 2) Bot 会话零注入：输出应为 0（路径按实际 DSH_HOME 发现，不要写死用户名）
SID=<bot session id>
zstd -dc "$(ls -d ~/.dsh/sessions/*/"$SID"/session.v4.jsonl.zstd | head -1)" \
  | grep -c '<session_context>\|<tdai_profile_memory>\|<tdai_recalled_l1_memories>' || true

# 3) 群里说一句后，当日新增记录数应为 2；写入前后各查一次并相减（带时间过滤，不能只靠 limit）
curl -s "$TDAI_ENDPOINT/v3/conversation/query" -H "authorization: Bearer $TDAI_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"team_id":"'$TDAI_TEAM'","agent_id":"'$TDAI_AGENT'","user_id":"'$TDAI_USER'","session_id":"<roomId>","limit":20}'
```

## 5. 禁止事项

- 不修改 ds-bot 源码；不写 `~/.dsh/bot` 下任何文件（含日志、台账、临时文件、`group-lines`）。
- 不调 `/v3/skill/conversation/add`（Bot 会话）；不改 `toSkillMessages` 的普通会话行为。
- 不创建 tdai agent，不改 `TDAI_MEMORY_AGENT_ID`。
- 不改变普通会话的注入、召回、回流；不以「顺手统一」为名重构。
- 不覆盖 `r4.md`、`final.md`（已标废案，仍不覆盖）；本稿与它们冲突时只在本稿范围内生效。
- 不把 relay、注入块、工具调用、纯 Bot 互投轮写进 L0。
- 不按 cwd（是否在 bot workspace 下）推断 Bot 会话。
- 不把「台账读失败」当成「没有台账」。
- 不写任何「兜底原文」：蒸馏失败就只写人话，`group-lines` 的全文只作为蒸馏输入，不进 L0。
- 不在没有 `done when` 证据的情况下宣布某步完成。
- 不给 Bot 会话注入 `identity` / `memory`（面板上也没有这个开关）；真要调试改代码，不做成配置项。
- 不在 Bot 分支里直接读 `cfg.botSkillInjectEnabled` / `cfg.botWritebackEnabled`：一律走 `sessionPolicy()` 与 `writebackAllowed()`，否则「受全局开关影响」会漏在某个调用点。

## 6. 锚点

- 设计结论与边界：[§1](./minimal.md#1-结论)
- 术语：[§2](./minimal.md#2-名词解释)
- 选项与被否掉的方案：[§3](./minimal.md#3-思路分析)
- 架构 / 流程 / 时序：[§4](./minimal.md#4-架构图和架构图描述) · [§5](./minimal.md#5-流程图和流程图描述) · [§6](./minimal.md#6-时序图)
- 待决与待实测：[§7](./minimal.md#7-待决问题分析)
- 风险与回滚：[§8](./minimal.md#8-风险评估)
- 工时：[§10](./minimal.md#10-改动清单与工时)
- 时序实测底本：[timing-probe.md](./timing-probe.md)
