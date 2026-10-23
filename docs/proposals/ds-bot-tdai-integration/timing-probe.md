# 时序证据：ds-bot 会话的写入钩子与群聊锚点

> 取证：ARK-ALPHA ｜ 日期：2026-10-22 ｜ 状态：实测底本（可直接引用）
> 脚本：[`scripts/dsbot-timing-probe.py`](../../../scripts/dsbot-timing-probe.py) ｜ 结论用于修订 [minimal.md](./minimal.md)

本文件回答两件事：**「按人锚点写回合」在真实会话里什么时候能写、锚点什么时候才进 room log**（§1–§8）；以及**写进去之后 Core 会怎么处理**（§9：写入顺序、L1 计数、L1 是否看 assistant）。 每条结论标四档之一：实测（跑过脚本/读了日志）、代码（源码行）、推断、待验。

## 0. 取数与复跑

```bash
python3 scripts/dsbot-timing-probe.py --json /tmp/timing-probe.json
```

- 数据源：`~/.dsh/bot/state.json`（version=1，5 bots / 3 rooms）+ `~/.dsh/sessions/--home-tim-.dsh-bot-workspace--/*/session.v4.jsonl.zstd`（24 个会话）。
- 解压必须 `zstd -dc`（多帧拼接，Node 的 `zstdDecompressSync` 只解第一帧）。
- 样本量：269 轮、22 条真人消息、13 条群聊锚点。**样本小，别把百分比当定律**，只当「必须处理的概率」。

## 1. 写入钩子的真实时序（实测 + 代码）

事件序列（room root 与 DM 一致）：

```
turn/start → step/start → assistant/message(+tool-call) → step/end
           → [agent/turn-stopping]  ← 不落盘，只在进程内派发
           → turn/end
```

- `agent/turn-stopping` 只在本轮结束**且** `inbox.nextStep` 为空时派发，并且在 `turn/end` 之前（`dsh-agent-loop/lib/index.js:997-1004`）。
- 异常路径（LlmError / abort / pre-step reject）走 `catch` → 直接 `turn/end`，**不经过 turn-stopping**（同文件 `:1006-1030`）。
- 269 轮里 `completed` 265、`aborted` 3、`blocked` 1 ⇒ **失败轮 4/269 ≈ 1.5%**，这些轮的人话在现有实现里会被整轮丢弃。

## 2. 真人消息落在哪一轮（实测）

22 条真人消息**全部**出现在已打开的轮内（`turn/start` 之后、`turn/end` 之前），但事件本身不带 `turn` 字段（`data.turn === undefined`，22/22）。

⇒ 「人话属于哪一轮」只能靠 `currentTurn`（插件现有的 `data.turn ?? currentTurn.get()` 兜底）判定；**不能**从事件里读 turn。把提交时机放在该轮 `turn-stopping` 是可行的。

## 3. 收尾步是否带文本（实测，按角色拆）

| 会话角色 | completed 轮 | 收尾步无 text | 说明 |
| --- | --- | --- | --- |
| `bot-dm`（Bot 私聊） | 22 | 1（5%） | 终稿可取，缺的 1 例是纯工具收尾 |
| `room-member`（群成员隐藏会话） | 114 | 0 | 正常 |
| `room-root`（群聊房间） | 129 | **129（100%）** | 每轮都是一次 `group_relay` 工具调用，没有任何文本 |

- 结论一：**私聊终稿取「最高 step 的 text 块」成立**，约 95% 有内容，缺的那 5% 必须能退化成「只写人话」。
- 结论二：**群聊房间会话永远没有终稿文本**——不是偶发，是结构性的（`group_relay` 只返回成员回复的 JSON）。群聊终稿只能自己蒸，这条设计没有替代方案。

## 4. 群聊锚点什么时候进 room log（实测，B4 的判据）

口径：真人原话若已出现在成员会话的投递文本里，说明 ds-bot 已 `appendRoom`（`appendRoom` 先于 `callMembers`）；再与**包含该消息的那一轮**的 `turn/end` 比。

| 结果 | 条数 | 相对轮末 |
| --- | --- | --- |
| 轮末**之前**已入 log | 10 / 13 | −6.0s ~ −82.7s |
| 轮末**之后**才入 log | 3 / 13 | +22.6s / +23.2s / +23.5s |

⇒ **在轮末单次定位会漏约 23% 的锚点**。必须在轮末尝试、失败则挂 pending，等下一次 turn-stopping 重试；不能「一次找不到就只写人话」——那 3 条恰好是真人明确发了话、最该有上下文的轮次。

⇒ 另有 1 条锚点（`@ARK-Alpha 总结一下`）之后没有新轮次，属于「人不再说话」的边界，由放弃规则兜底。

## 5. room log 的容量与断点（实测）

| 房间 | log 行数 | seq 范围 | room.seq | 截断行 |
| --- | --- | --- | --- | --- |
| `session-03304b8f…` | 60（满） | 32..91 | 91 | 1 |
| `session-243a0014…` | 60（满） | 41..100 | 100 | 2 |
| `session-82661601…` | 28 | 1..28 | 28 | 2 |

- 13 条锚点里 **5 条（38%）已不在 log 里**（被 60 行环覆盖）⇒ 定位失败是常态，不是异常；`lastHumanSeq` 不能假设「日志一定有历史」。
- 断点可能整体滑出环（`lastHumanSeq + 1 < log[0].seq`）⇒ 必须检测并重置，否则窗口计算会取到错误的起点。
- room log 真人行字段只有 `seq / text / who`（**无 botId、无时间戳**）⇒ 按 `who === 'User'` 判定即可；`botId === undefined` 保留作防御，当前 schema 下恒真。

## 6. 文本截断（实测）

- `TEXT_KEPT = 2000`（`ds-bot/src/host/constants.js:27`）。被截断的行带 `length` 字段（实测一条 Bot 长贴 `length: 2650`），全文存在 `<DSH_HOME>/bot/group-lines/<roomId>/<seq>.txt`（当前 5 个文件）。
- 13 条真人锚点**没有一条超过 2000 字符**（中位 34）⇒ 锚点按文本匹配的风险低；真正的截断损失在**窗口内容**（Bot 长贴），摘要输入必须按字符上限裁剪。
- 样本里没有重复锚点（8 条可定位的锚点全部唯一），但「继续」这类短消息天然会重复，取最小 seq 的规则保留。

## 7. 身份索引（实测）

- `bots` 的键名就是 Bot 的当前会话；`rooms` 的键名就是房间会话；`rooms[*].sessions` 是成员隐藏会话。
- **但 `bots[*].sessionId` 会指向别的路径**：`ARK-Alpha` 的 `sessionId = session-2482c7ba…` 落在 `--mnt-d-workspace--`（因为它的 `workDir = /mnt/d/workspace`），其余 4 个 Bot 无 `sessionId`、0 个 segments。
- 3 个房间里 1 个没有 `segments` 键。
- ⇒ **不能按 cwd（是否在 bot workspace 下）推断 Bot 会话**——ARK-Alpha 这条例子会反向错判。索引必须来自 state.json + 持久化信号。

## 8. 对方案的影响（一句话版）

| 原假设 | 实测 | 方案动作 |
| --- | --- | --- |
| 「轮末一定能在 log 里找到锚点」 | 10/13 能，3/13 晚 22–23s | 两阶段：轮末尝试 → pending → 重试 → 放弃 |
| 「群聊可以从房间会话取终稿」 | 129/129 无文本 | 群聊只写自蒸摘要，永不写房间原文 |
| 「私聊最后一步必有文本」 | 21/22 | 保留规则，加「无 text 只写人话」分支 |
| 「失败轮可以整轮丢」 | 1.5% 轮次 | 决策项：失败轮只写人话，还是照旧丢 |
| 「按 bot workspace 判 Bot 会话」 | ARK-Alpha 反例 | 只认 state.json 索引 + 持久化信号 |
| 「log 能覆盖历史锚点」 | 38% 已滑出环 | 断点检测 + 环覆盖告警 + 放弃时推进到日志末尾 |

## 9. 附：同批核实的三个下游事实

这三条不属于会话时序，但决定了「群聊摘要写进去之后会发生什么」，一并记在这里（都是只读取证）。

**Core 按数组顺序写入，不排序。** `POST /v3/conversation/add` 的处理是逐条构造 `acceptedRecords` 再批量插入（`/app/src/gateway/v2-router.ts`，`insertL0Batch` 或逐条 `upsertL0`），没有按 timestamp 重排。`conversationItemSchema` 里 `timestamp` 与 `recorded_at` 都是可选项，"不传时使用服务端接收时间"。
⇒ 「摘要写在人话之前」这个顺序由我们控制，Core 不会打乱。

**L1 的触发计数按 user 条数，不按轮数。** 同一处源码：`const rounds = messages.filter((m) => m.role === "user").length`，只有 `rounds > 0` 才通知管道。
⇒ 本项目每条锚点写 1 条 user，所以「满 5 条」= 5 条锚点触发一次 L1；assistant 记录不计数。

**L1 的输入带着 assistant 消息，但提示词要求忽略它。** `l1-extraction.ts` 的提示词明写「不应该提取：……AI 助手自身的行为或输出」，背景段也标「严禁从中提取」；但消息是按 `[id] [role] [timestamp]: content` 全量拼进去的，`role=assistant` 会被模型看到。
⇒ 这是**提示词约束，不是机械过滤**。摘要以 assistant 写入时，仍要靠「不含第一人称 + 固定前缀」降低被当作用户证据的概率；上线后拿第一批 L1 产出核对主语（见 minimal.md §7 待观测项）。

**dsh-llm 的调用形状**（`scripts/verify-llm-api.mjs`，17 条断言全过）：`LlmRuntime.prototype.stream(options)` 返回 `AsyncIterable<StreamChunk>`；`signal` 是 `GenerateOptions` 的字段，**不是第二个位置参数**；`resolveModelInfo(provider, model, signal?)` 是实例方法；`LlmResolvedModelInfo.reasoning.efforts` 由低到高排列；chunk 装配用导出的 `BlockAssembler`（`push` / `blocks` / `finish`）。
