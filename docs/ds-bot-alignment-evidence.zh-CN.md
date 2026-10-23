# ds-bot × dsh-tdai-memory-plugin：适配证据底本

> **这是什么**：不是结论文档，是**证据底本**。后续任何 agent（人或模型）在讨论「ds-bot 与 tdai 记忆插件如何适配」时，应当直接引用本文的条目，而不是重新取证或凭印象断言。
>
> **本文不做什么**：不给架构建议、不排优先级、不做方案对比。方案设计是另一层的事；这里只放可核对的事实。
>
> **取证日期**：2026-10-17（会话级实测）／2026-10-19（上游与插件代码精读）
> **取证方式**：解压 DSH 会话存储逐行 diff + 三处仓库源码精读 + 本机实跑日志
> **未改动任何被测文件**

---

## 0. 置信度约定

全文每条证据前缀标注来源等级，**四者不可混用**：

| 标记 | 含义 | 可复查方式 |
| --- | --- | --- |
| 【实测】 | 本机会话日志/运行产物中直接观察到的 | 按 §8 命令重跑 |
| 【代码】 | 从源码读出，未经运行验证 | 打开标注的文件:行号 |
| 【文档】 | 仓库文档写明 | 打开标注的文件:行号 |
| 【推断】 | 由上述三者推导，未直接验证 | 见 §7 待验证清单 |

凡标注【推断】的条目，**不得**被后续文档当作既定事实引用。

---

## 1. 取证环境

| 项 | 值 | 来源 |
| --- | --- | --- |
| DSH 版本 | `0.2.0-rc.2` | 运行时环境 |
| profile | `~/.dsh/profiles/web`（单一 profile） | `~/.dsh/profiles/web/package.json` |
| ds-bot 版本 | `0.1.7` | `ds-bot/package.json:3` |
| tdai 上游版本 | `v2.0.1`（CHANGELOG 记为 2.0.1，README 仍写 v2.0.0，文档滞后） | `CHANGELOG.md:12`、`README_CN.md:304` |
| 本插件 | 工作区 `link:` 进 profile | `package.json` |
| ds-bot 源码 | `/mnt/d/workspace/github/DeepSeek-Bot` | 用户本机克隆 |
| tdai 源码 | `/mnt/d/workspace/github/TencentDB-Agent-Memory` | 用户本机克隆 |

**取证期间发生过一次 profile 变更**（重要，影响归因）：2026-10-17 10:36 前后用户重启 DSH 并执行了 `pnpm install`（`profiles/web/node_modules` mtime 10:37、`package.json` mtime 10:38），期间安装了 ds-bot，同时 `@wxg-prc-cpg/browser-skill-dsh-plugin` 升到 `0.3.3`。因此**两次会话的差异不全部来自 ds-bot**，见 §2.3 的归因表。

---

## 2. 会话级实测：纯净对话 vs ds-bot 对话

### 2.1 会话文件与选取依据

| 会话 | 路径 | 说明 |
| --- | --- | --- |
| 纯净（基线） | `~/.dsh/sessions/--mnt-d-workspace-github-dsh-tdai-memory-plugin--/session-af681dcc…（本地会话 id，已截断）/session.v4.jsonl.zstd` | 首条用户消息自述目的：「这是一次纯净的对话，用于等下和 ds-bot 对话的会话日志进行对比」；创建于 10:31 |
| ds-bot | `~/.dsh/sessions/--home-tim-.dsh-bot-workspace--/session-d91212ec…（本地会话 id，已截断）/session.v4.jsonl.zstd` | Bot「Chief」（Main Bot，role `Chief of Staff`）；第一轮开始于 10:38:22 |

两个会话**同进程、同 profile**，区别在于会话性质：纯净会话是普通（非 Bot）会话，ds-bot 会话是 Bot 的 root session。

### 2.2 载荷规模

| 项 | 纯净 | ds-bot | 差值 |
| --- | --- | --- | --- |
| system prompt 字符数 | 23,275 | 34,027 | +10,752（+46.2%） |
| 工具数 | 64 | 84 | +20（+30 / −10，见 §2.3） |
| tools schema（JSON 字符数） | 65,725 | 83,420 | +17,695 |
| 首轮请求 config | `{provider, model, reasoningEffort: "high"}` | `{provider, model}` | **缺 reasoningEffort** |

【实测】全部取自两个会话文件的 `system/message` 与 `request/header` 事件。

### 2.3 差异归因（关键：三个来源不可混淆）

| 差异 | 归因 | 依据 |
| --- | --- | --- |
| system prompt 插入 10,769 字符 / 52 行 | **ds-bot** | §3.1 |
| system prompt 末行工作目录不同 | **会话 cwd 不同**，与插件无关 | 纯净 `/mnt/d/workspace/github/dsh-tdai-memory-plugin` → ds-bot `$DSH_HOME/bot/workspace` |
| 6 个 `browser_*` → 6 个 `bsk_*` | **profile 升级**，与 ds-bot 无关 | `browser-skill` 0.3.3 破坏性改名，见其 README「Breaking tool API migration (0.3.3)」；纯净会话早 7 分钟跑在旧版上 |
| `ask_user_question` 移除 + `ask_user` 新增 | **ds-bot** | §3.2 |
| `create_goal` / `get_goal` / `update_goal` 三个移除 | **ds-bot** | §3.2 |
| 24 个新工具（团队 13 + 记忆 3 + 密钥 2 + 能力 5 + ask_user 1） | **ds-bot** | §3.2、§3.3 |
| 每轮新增 `[Bot team setup]` / `Current time` | **ds-bot** | §3.5 |
| `reasoningEffort` 丢失 | **ds-bot**（通道存在但未传） | §3.4 |

**净账核对**：64 − 10（`ask_user_question` + goal×3 + browser×6）+ 30（`ask_user` + bsk×6 + 24 个 ds-bot 工具）= 84。【实测】逐名核对见 §8 命令。

### 2.4 system prompt 差异（仅两处，其余逐行相同）

对两份 `system/message` 做行级 diff，`opcodes` 只有 2 处非 equal：

**插入块**：10,769 字符，位于 `Read a file before editing it…` 段之后、`Tokens prefixed with @…` 段之前。

| 子块 | 字符数 | 内容摘要 | 来源 |
| --- | --- | --- | --- |
| `# Your identity` | 8,419 | Bot 名（Chief）、role（Chief of Staff）、Main Bot 职责、团队协作 20 条规则 | `ds-bot/src/host/prompt.js:66`（section `bot-identity`，order 640） |
| `# Your memory` | 2,350 | 跨会话记忆规则 + `MEMORY.md` / `team/MEMORY.md` 占位（均为 `(nothing saved yet)`） | `ds-bot/src/host/memory.js:712`（section `bot-memory`，order 645） |

**替换行**：`Your working directory is …`（74 → 56 字符，路径不同）。

**其余 23,275 字符逐行相同**，包括插件注入的 `<session_context>`（含 Agent 人格/角色/规则）、`<tdai_profile_memory>`（L3 画像 + L2 场景索引）、`<memory-tools-guide>`、`<knowledge_tools>`。【实测】

> 结论边界：这一条只说明「ds-bot 没有改动插件的注入内容」。它**不**说明插件的注入在 Bot 会话里是正确的——正确性取决于 §5.3 的挂载点与 query 取法。

### 2.5 每轮注入消息与顺序

| 会话/轮次 | 注入顺序（按 seq） |
| --- | --- |
| 纯净 turn 1 | 用户输入（kind=`user`）→ tdai L1 召回（kind=`plugin:dsh-tdai-memory-plugin`）→ runtime-context → skill-catalog |
| ds-bot turn 1 | `[Bot team setup]`（kind=`bot`）→ runtime-context → skill-catalog → tdai L1 召回 → `Current time: 2026-10-17, 10:38:22 GMT+08:00 (Asia/Shanghai).`（kind=`ds-bot-time-context`） |
| ds-bot turn 2 | `{"kind":"answer_to_pending_question",…}`（kind=`user-question-reply`）→ tdai L1 召回 |

【实测】三条可核对的事实：

1. **ds-bot 会话里没有 `kind='user'` 的消息**（turn 1 是 `bot`，turn 2 是 `user-question-reply`）。
2. tdai 召回块的位置在两边的**相对顺序不同**：纯净在宿主注入块之前，ds-bot 在其之后。
3. `Current time` 每 10 分钟刷新一次（`timeRefreshIntervalMs` 默认 `600_000`，`ds-bot/src/host/time-context.js:6,37`），只在 Bot 会话出现，且通过 `{ prepend: true }` 的 `agent/pre-step` 注册、**追加到 messages 末尾**。

### 2.6 L1 召回的静态对比

| 项 | 纯净 | ds-bot turn 1 | ds-bot turn 2 |
| --- | --- | --- | --- |
| L1 条数 | 5 | 5 | 5 |
| 字符数 | 2,470 | 2,522 | 2,619 |
| 是否含 `<tdai_recalled_skills>` | **含**（5 条 skill） | **不含** | **不含** |

【实测】纯净轮 L1 块内含云端 skill 召回（score 9.10–15.75）；ds-bot 两轮均只有 L1 块。

【推断·未闭合】skill 块缺失**可能**是「本轮 query 未命中 `skillRecallMinScore`（默认 4）」，也可能是「Bot 会话下 query 取错导致检索失效」。二者未区分，见 §7 第 1 条。**不得**据此断言 ds-bot 破坏了 skill 召回。

---

## 3. ds-bot 源码事实

### 3.1 system prompt 注入

- 【代码】两个 `systemPrompt.section`：`bot-identity`（order 640，`src/host/prompt.js:66`）、`bot-memory`（order 645，`src/host/memory.js:712`）。二者文本只依赖该 Session 对应的 Bot 记录，注释明确写「so the prefix stays byte-stable across turns and roster changes」（`prompt.js:1-3`）。
- 【代码】非 Bot 会话 `promptFor()` 返回空字符串（`prompt.js:82`），即**普通 Agent 会话不注入任何 ds-bot 身份段**。

### 3.2 工具注册与摘除

- 【代码】被摘除的原生工具（`src/host/tools.js:12-16`）：
  - `ask_user_question` —— 理由：它会把 turn 挂住，其它 Bot 的消息排在后面
  - `create_goal` / `update_goal` / `get_goal` —— 理由：DS Bot 不跨 part 携带 goal
- 【代码】摘除机制：`agent.ctx.tools.restrict({ deny })`（`tools.js:565-577`），并且注册了一条 `ctx.tools.guard`，在任何 Bot Session 里拒绝 `ask_user_question`（`tools.js:582-585`）。
- 【代码】`ask_user` 由 ds-bot 自己注册（`tools.js:503`）。
- 【代码】ds-bot 注册的工具清单：团队/群聊 13 个（`list_bots` `message_bot` `stop_bot` `create_bot` `update_bot` `list_models` `create_group` `update_group` `delete_group` `post_to_group` `group_relay` `read_own_chat` `read_group_chat`，分布于 `tools.js`、`groups.js:489,582,637`）、记忆 3 个（`remember` `forget` `recall`，`memory.js:774,806,839`）、密钥 2 个（`request_secret` `list_secrets`，`secrets.js:374,423`）、能力 5 个（`save/attach/detach/delete/list_capabilities`，`tools.js`）。

### 3.3 Bot 与群聊的会话性质

- 【代码】「Every Bot is one root Session」（`index.js:1`）。
- 【实测】Bot session 的 `session` 事件里 `delegationDepth: 0`，无 `origin` 字段。
- 【代码】群聊也是一个普通 root session（`parts.js:783` 的 `rt.createSession(...)` 调用路径）。

> 这一条对 §5.3 是决定性的：Bot 不是 subagent，插件的「子会话降级」策略不会生效。

### 3.4 reasoningEffort 通道（易误判，务必按本条引用）

**ds-bot 有完整的 effort 通道，只是在 Bot 未显式设置时不传该字段。**

| 环节 | 位置 | 行为 |
| --- | --- | --- |
| 记录字段 | `roster.js:107-123` | `buildBot` 收 `effort`，经 `resolveEffort` 校验后写入 `bot.effort` |
| 修改入口 | `roster.js:242-247` | `updateBot` 改 `effort`；传 `null`/`''` 删除 |
| 取值判断 | `models.js:100-105` | `bot.effort === undefined` → 返回 `undefined`；模型不认的档位忽略（注释：provider 会硬拒未知 effort） |
| 组装路由 | `models.js:151-153` | `route = {provider, model, ...(effort === undefined ? {} : {reasoningEffort: effort})}` |
| 写入会话 | `models.js:139-149` | 调 `sessionController.selectModel`；随后把被 DSH 改掉的用户默认模型写回 |
| 新 part 重选 | `parts.js:731-735,783,815` | 同一规则 |
| 记忆复盘 | `memory.js:909-924` | **唯一无条件传 effort 的地方**：一次性请求取 `off` 或最低档 |

- 【实测】`~/.dsh/bot/state.json` 中「Chief」记录只有 `model` 与 `appliedModel`，**无 `effort` / `appliedEffort`**。
- 【实测】Bot 会话的 `model/selection` 事件只有 `{provider, model}`；`request/header.config` 同样只有两段。
- 【代码】DSH 侧：`selectModel` 在 `reasoningEffort` 缺省时，`resolveCallConfig` 只在模型声明了 `defaultEffort` 时才补（`dsh-llm/lib/index.js:2180`）；`deepseek-v4.1-flash` 未声明，故解析结果仍是两段。
- 【代码】写入会话的 selection 是**持久事件**：全 DSH 只有 `selectForNextRequest` 一处 append（`dsh-api-session-controller/lib/index.js:319-322`），而调 `selectModel` 的只有 UI 手切模型与 ds-bot。

### 3.5 注入消息的 source 契约

| 消息 | `source.kind` | 附带的字段 | 位置 |
| --- | --- | --- | --- |
| Bot 间消息 / relay | `bot`（`SOURCE_KIND`） | `form` `role` `exchangeId` `senderName` `senderSessionId` `senderRoomId` | `constants.js:41`、`delivery.js:59-60`、`handoffs.js:81` |
| 群聊 post / kickoff | `bot` | `form: 'relay'` `role` `senderName` `senderSessionId` `roomId` | `groups.js:691,818` |
| Bot 首次开场 | `bot` | `role: 'kickoff'` | `delivery.js:30` |
| ask_user 卡片回答 | `user-question-reply` | `tool` `callId` `questions` `answers`（JSON 正文） | `parts.js:64` |
| 时间上下文 | `ds-bot-time-context` | `form: 'snapshot'` | `time-context.js:3,37` |

> 关键：**ds-bot 的 relay 消息全部带 `senderName` / `senderSessionId` / `roomId`**，即「谁说的、在哪个房间说的」在 source 里已经齐备；缺的只是一个「人 / agent」的显式分类位。

### 3.6 capabilities 装配

- 【代码】capability library 统一登记 `mcp` / `skill` / `pack` 三类，`pack` 展开为子项（`capabilities.js:20-40`）；Bot 记录上的 `capabilities` 数组在每次会话前由 `ensureCapabilities(sessionId)` 挂载（`delivery.js:88`、`groups.js` 同名调用）。

---

## 4. tdai 上游（v2.0.1）契约

### 4.1 Agent 是纯元数据实体

- 【文档】Core 明确不托管、不调度、不运行 Agent 本体（`MemoryCore/README_CN.md:9`）。
- 【文档】实体 `AgentEntity{agent_id, team_id, owner_user_id, name, description, prompt, visibility, status, metadata_json}`（`MemoryCore/v3-api-memorycore-doc.md:863`）；唯一性由 `team_id + agent_id` 确定（`MemoryCore/README_CN.md:202`）。
- 【文档】每个 Agent 创建时自动获得独立记忆（`README_CN.md:100`）。
- 【文档】隔离四维：team / agent / user / task（`MemoryCore/README_CN.md:190`）。

### 4.2 分层与管道参数（实测值，写方案时必须用这组数）

| 层 | 写入者 | 读取方式 |
| --- | --- | --- |
| L0 Conversation | Proxy 每轮写回（`MemoryProxy/README_CN.md:29`） | 只读工具 / 面板核对原话 |
| L1 Atom | Core 异步 pipeline 从 L0 抽取（`README_CN.md:248`） | BM25 / 向量 / RRF 按需召回 |
| L2 Scenario | Core L2 runner 聚合（`v3-api-memorycore-doc.md:260-302`） | **只注入索引**，细节靠工具拉 |
| L3 Persona | Core L3 runner 生成 | **全量注入** |

**管道参数（默认值，`MemoryCore/src/config.ts`）**：

- `everyNConversations` = **5**（`config.ts:583`）
- `l1IdleTimeoutSeconds` = **600**（`config.ts:585`）
- L1 预热退避：1 → 2 → 4 → 8 → … → everyN（`utils/pipeline-manager.ts:57-58`）
- L2：per-session 向下 timer，冷会话（超出 `sessionActiveWindowHours` 未活动）取消而非触发（`pipeline-manager.ts:18-23`）
- L3：L2 完成后入队，**全局互斥 concurrency = 1**（`pipeline-manager.ts:26`）

### 4.3 回流链路

- 【文档】Proxy 请求 8 段：`auth → systemUser → sessionInit → injection → rateLimit → forward → extract（一轮结束后回流）→ report`（`MemoryProxy/README_CN.md:39-54`）。
- 【文档】双写：`/v3/skill/conversation/add`（Skill buffer，阈值判定后归档）+ `/v3/conversation/add`（L0，`MemoryProxy/src/tdai/client.ts:109`）。
- 【代码】L0 写为 fire-and-forget + 最多 3 次指数退避 + SIGTERM flush（`MemoryProxy/src/tdai/pending-writes.ts:1-24`）。
- 【文档冲突】`MemoryProxy/README_CN.md:29` 写「同步发」，`:52` 写「异步回流」。**未解决**，见 §7。

### 4.4 Loadout / Fixed Binding

- 【文档】「记忆不是全局 Prompt，而是 Agent 的 Loadout」（`README_CN.md:259`）。
- 【文档】实现 = Memory Asset + **Fixed Binding + ACL**；接口 `agent-fixed-asset/set` **全量覆盖**某 agent 的 `bindings[{asset_id, asset_type, injection_mode, priority, created_by}]`（`v3-api-memorycore-doc.md:935-948`）。
- 【代码】`injection_mode ∈ direct | summary | tool | reference`（`MemoryCore/src/metadata/router/v3-meta-schemas.ts:14`）。
- 【代码】注入前 Proxy 调 `/v3/meta/agent-fixed-asset/list-with-detail` 取该 agent 的绑定（`MemoryProxy/src/injection/injectors/tdai-fixed-asset.ts:1-8`）——**按 agent 分配，不是全局**。
- 【文档】skill / llm_wiki / code_graph / chat_memory 登记为同一 Asset 类型（`v3-api-memorycore-doc.md:929`）。

### 4.5 可见性与接入

- 【文档】可见性 `private | team | restricted | agent | task`（`README_CN.md:230-236`）；ACL 判定顺序 资源→owner→成员→visibility→角色默认→ACL→deny，一期 allow-only（`metadata/service/permission-checker.ts:1-12`）。
- 【文档】Proxy 是透明 LLM 反代，不改协议，只改 base URL（`MemoryProxy/README_CN.md:3-7`）。
- 【文档】**无交互 UI 的客户端用 header 预选** `x-team-id` / `x-agent-id` / `x-task-id` / `x-conversation-id`（`agents/README.md:161-172`）。
- 【文档】分工：Proxy 管接入与转发、不落数据；Core 管存储与处理；所有读写经 Core Gateway `:8420`（`MemoryProxy/README_CN.md:7,11-23`）。

---

## 5. 本插件（dsh-tdai-memory-plugin）契约

### 5.1 身份

- 【文档】「**一个 dsh 进程只对应一个 TDAI 身份**」；身份来自 env 或设置面板，**插件加载时确定一次**；`session_id` 每次调用时从当前会话取（`README_CN.md:467`）。
- 【代码】身份取值 `config.mjs:171,208,216`；`agent_id` 直接作为请求参数（`recall.mjs:219-220,319`、`assets.mjs:206`）。
- 【文档】有意为之：proxy 的「每个会话选 Team/Agent/Task」表单是它作为多用户网关才需要的（`README_CN.md:469`）。
- 【文档】**多身份不支持；「方案 B/C 不做」**（`docs/prompt-injection-redesign.md:489`）。即这不是遗漏，是**已否决的设计决策**。

### 5.2 注入段

| 段 | order | 内容 |
| --- | --- | --- |
| `persona-prefix` | 0 | 替换为一句指引 |
| `session-context` | 520 | `[Agent] + [Role] + [Rules] + [Task]` 逐字 |
| `profile-memory` | 521 | 总述 + L3 + L2 索引 + 总纲 |
| `knowledge-tools` | 522 | 路由行（默认关） |
| `tdai:state` | context 560 | 只放稳定量 |

- 【代码】实现见 `lib/sections.mjs:70,366`、`lib/prompts.mjs:48`。
- 【文档】设计理由：system 是前缀，会话内会变的字节进去就打穿缓存；召回独立成条才不被持久化成用户发言（`README_CN.md:169`）。

### 5.3 召回（**本节的取法与挂载点是冲突根源，务必按行号引用**）

- 【代码】L1 query：`lastUserText(messages)` —— 从后往前取**第一条有文本的消息**，**不判 `role`、不判 `source.kind`**（`recall.mjs:42-49`）；使用点 `recall.mjs:281`：`const l1Query = wantL1 ? cleanUserQuery(lastUserText(payload.messages)) : ''`。
- 【代码】skill query：`humanUserTexts(messages, window)` —— **判 `role`、判 `source.kind`**，只用真人发言（`recall.mjs:72-80`），近 3 条、截 512；使用点 `recall.mjs:102`。
- 【代码】召回块挂载点：`const index = findUserMessageIndex(messages)`，`messages.splice(index >= 0 ? index + 1 : messages.length, 0, …)`（`recall.mjs:369-370`）——**找不到真人消息时插到末尾**。
- 【代码】`findUserMessageIndex` 的白名单：`kind === undefined || kind === 'user'`（`recall.mjs:62-70`）。
- 【代码】召回 handler 以 `{ prepend: true }` 注册为 pre-step 最外层守卫（`recall.mjs:226-230`），注释里点名过 `dsh-time-context`。

> **同一个文件里两套标准**：L1 用不判 kind 的 `lastUserText`，skill 用判 kind 的 `humanUserTexts`。这是内部不一致，不是设计取舍。

### 5.4 回流

- 【文档+代码】按 `role` 分流（`capture.mjs:127-132` 的表）：

| role | `source.kind` | 处理 |
| --- | --- | --- |
| assistant | `model` | 归一化回流（text → assistant；tool-call → tool_call；reasoning 丢弃） |
| user | `user` 或缺省 | 按块剥离注入块后回流；剥完为空则丢弃 |
| user | 其他（`bot` / `skill-catalog` / `tool` / `user-question-reply` …） | **整条丢弃** |
| tool/result | `tool` | 归一化 tool_result |

- 【代码】`recordKey`：真人各成条 `u:{turn}:{n}`；assistant + 同 step 工具合并 `a:{turn}:{step}`（`capture.mjs:71,147`）。
- 【代码】>8192 code units 分片、100 条/批、同 `session:turn` 去重、单轮上限 200；**只回流成功完整轮**（`capture.mjs:201`）。
- 【代码】监听为进程级：`session/event`、`agent/turn-stopping`、`agent/error`（`capture.mjs:180,228,243`）。

### 5.5 子 agent 策略

- 【代码】判定 `header.origin === 'subagent'`，`delegationDepth > 0` 兜底；缺 header 按父会话 fail-open（`subagent.mjs:83-92`）。
- 【文档】默认：读侧 identity/memory/skills 关、knowledge 开；写侧 off（不回流、不建缓冲）。
- 【文档】动因：子会话曾与父会话 prompt 逐字节相同（本插件 4 段占 47%），且一个 23 步的调查子 agent 写入了 37 条 L0（`README_CN.md:266` 与 `subagent.mjs:1-40` 头注释）。

### 5.6 与 proxy 的差异（有意为之）

【文档】无代理层、无 auth/verify、无 ACL 过滤、工具原生注册（token 不进 prompt）、无 session-init 表单、注入走 DSH 原生通道（`README_CN.md:56,459-465`）。

---

## 6. 三处接口冲突（证据对照，不含结论）

| # | 冲突 | 两侧证据 | 已实测的表现 |
| --- | --- | --- | --- |
| 1 | **「什么是人说的话」判定不一致** | ds-bot 认为 relay（`bot`）与卡片回答（`user-question-reply`）都算用户输入；插件只认 `user` 或缺失 | Bot 会话里**一条 `kind='user'` 都没有** → `findUserMessageIndex` 返回 −1（挂载点退化到末尾）且 `lastUserText` 取到注入块（§2.5 顺序印证） |
| 2 | **回流白名单与实际词汇表不匹配** | `capture.mjs:127-132` 丢弃 user 角色下所有非 `user` kind | 人的卡片选择、Bot 间消息、群聊发言均不进 L0；而 Bot 的 assistant 全文回流，会被后台抽取成「关于用户的事实」 |
| 3 | **身份粒度：进程级静态 vs n 个 root session** | 插件「一进程一身份」（`README_CN.md:467`）；ds-bot 的 Bot 是 root session（`index.js:1`），不吃子会话降级（`subagent.mjs:83`） | 若同时使用，所有 Bot 共用同一份 L3 画像、L1 召回池、skill 召回与知识资源 |

**附属冲突（与原生 proxy 接入相关，不影响本插件）**：ds-bot 摘除了 `ask_user_question`（§3.2），而 tdai 对 dsh 的原生接入方式正是用它做 Session Init 表单（`agents/README.md` 快速对照表）。

---

## 7. 未闭合 / 待验证清单

以下条目**不得**作为既定事实引用，需另行实测：

1. **Bot 会话里 L1 的 query 究竟取到哪一条**。机制已从代码读出（`lastUserText` 不判 kind），但具体是 `skill-catalog`、`runtime-context` 还是 `Current time`，取决于 pre-step 链上本插件与 ds-bot `time-context`（两者都 `prepend: true`）谁在外层。验证法：在 `recall.mjs:281` 处临时输出 query 到 stderr，连跑两轮。
2. **skill 块缺失的原因**：query 未命中阈值（`skillRecallMinScore` 默认 4），还是检索被错误 query 拖垮。
3. **`model/selection` 事件的确切触发点**。唯一写入点是 `selectForNextRequest`，调用方只可能是 UI 手切或 ds-bot 的 `applyModel`；但按 `models.js:152` 的短路条件（`appliedModel === ref && appliedEffort === effort` 即返回），若记录已匹配本不该触发。最可能是重启后 `desiredModel` 与已存的 `appliedModel` 不一致导致短路失效——未证实。
4. **Core 是否对召回结果再做一次截断**（插件侧只做条数/预算/超时截断，服务端未验证）。
5. **L0 / L1 有无 TTL 或保留期**。上游文档未记载。若存在，`/v3/conversation/query` 类验证手法要注意时间窗。
6. **Panel 是否能编辑 L1–L3**。`ROADMAP_CN.md:42-53` 说只能查看与删除，`panel-api-doc.md:587-607` 已文档化 `layer-update`。两处文档冲突，需实机确认。
7. **L0 写是同步还是异步**。`MemoryProxy/README_CN.md:29` 与 `:52` 自相矛盾。

---

## 8. 复现命令

### 8.1 解压两份会话并提取 system prompt

```bash
mkdir -p /tmp/dshcmp && cd /tmp/dshcmp

for f in \
  ~/.dsh/sessions/*/session-af681dcc-*/*.zstd \
  ~/.dsh/sessions/*/session-d91212ec-*/*.zstd ; do
  n=$(basename "$(dirname "$f")"); zstd -dc "$f" > "$n.jsonl"
done

python3 - <<'EOF'
import json, glob
for f in glob.glob('/tmp/dshcmp/session-*.jsonl'):
    for line in open(f):
        o = json.loads(line)
        if o.get('type') == 'system/message':
            txt = '\n'.join(c.get('text','') for c in o['data']['message']['content']
                            if c.get('type') == 'text')
            open(f.replace('.jsonl', '.system.txt'), 'w').write(txt)
        if o.get('type') == 'request/header':
            print(f, json.dumps(o['data']['header']['config'], ensure_ascii=False))
EOF

diff -u session-af681dcc-*.system.txt session-d91212ec-*.system.txt
```

### 8.2 工具集差异（含归因核对）

```bash
cd /tmp/dshcmp
python3 - <<'EOF'
import json, glob
def tools(p):
    for f in glob.glob(p):
        for line in open(f):
            o = json.loads(line)
            if o.get('type') == 'request/header':
                return [t['name'] for t in o['data']['header']['tools']]
p = tools('/tmp/dshcmp/session-af681dcc-*.jsonl')
b = tools('/tmp/dshcmp/session-d91212ec-*.jsonl')
print('pure', len(p), 'bot', len(b))
print('only bot :', sorted(set(b) - set(p)))
print('only pure:', sorted(set(p) - set(b)))
EOF
```

### 8.3 注入消息与顺序

```bash
cd /tmp/dshcmp
python3 - <<'EOF'
import json, glob, re
for f in sorted(glob.glob('/tmp/dshcmp/session-*.jsonl')):
    print('='*20, f)
    for line in open(f):
        o = json.loads(line)
        if o.get('type') != 'user/message': continue
        d = o['data']; c = d.get('content')
        txt = c if isinstance(c, str) else '\n'.join(x.get('text','') for x in c)
        kind = (d.get('source') or {}).get('kind')
        print(f"seq={o.get('seq'):3} kind={kind!s:28} len={len(txt):5} :: {txt[:70].replace(chr(10),' / ')}")
EOF
```

### 8.4 ds-bot 侧关键行号定位

```bash
DSB=/mnt/d/workspace/github/DeepSeek-Bot
grep -n "HIDDEN_TOOLS\|GOAL_TOOLS\|BLOCKING_QUESTION_TOOL" $DSB/ds-bot/src/host/tools.js
grep -n "systemPrompt.section" -A3 $DSB/ds-bot/src/host/prompt.js $DSB/ds-bot/src/host/memory.js
grep -n "SOURCE_KIND =" $DSB/ds-bot/src/host/constants.js
grep -n "desiredEffort\|reasoningEffort: effort" $DSB/ds-bot/src/host/models.js
```

### 8.5 插件侧关键行号定位

```bash
cd /mnt/d/workspace/github/dsh-tdai-memory-plugin
grep -n "lastUserText\|humanUserTexts\|findUserMessageIndex" lib/recall.mjs
grep -n "messages.splice(index" lib/recall.mjs
grep -n "source.kind\|=== 'user'" lib/capture.mjs | head
grep -n "origin === 'subagent'" lib/subagent.mjs
```

---

## 9. 引用约定

后续文档引用本文时，请遵循：

1. **不要把【推断】写成事实**。§7 的七条一律视为未闭合。
2. **不要把「ds-bot 造成的差异」与「profile 升级造成的差异」混为一谈**（§2.3）。
3. 引用「ds-bot 没传 reasoningEffort」时，必须完整表述为：**通道存在，但 Bot 记录未设 `effort` 时不传该字段**（§3.4）。单独说「没传」会误导。
4. 引用「Bot 会话没有真人消息」时，必须同时引用 §2.5 的实测顺序与 §5.3 的两处代码，否则无法解释为什么会造成 query 取错。
5. 本文不含任何真实凭据、`userKey`、真实 `agentId`；示例一律用占位符。

---

**本文档只登记证据。** 任何基于本文的设计方案、排期与代码改动，应另立文档，并在此处反向登记其引用的条目编号。
