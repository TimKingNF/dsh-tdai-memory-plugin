# Changelog

本文件记录 dsh-tdai-memory-plugin 的版本变更。格式参考
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> **测试范围声明（0.7.0）**：本版本在 **DeepSeek Harness `0.2.0-rc.2`**（本机当前运行版本）
> 与 **TencentDB-Agent-Memory `v2.0.1`** 上实操验证过：system 段注入、`agent/pre-step` 两段召回
> （L1 + skill）、14 个工具（10 只读 + 4 写侧待办，后者需另开开关与 User Key）、设置面板均已实际使用；
> 0.7.0 新增的 task 写侧另有真连内核的 E2E（`scripts/task-write-e2e.mjs`，跑完自清理）。
> 上一发布版（0.6.1）的验证基线是 DSH `0.2.0-rc.2` + MemoryCore `v2.0.1`；更早的 `0.1.7-rc.1`
> 迁移审计见 [docs/dsh-0.1.7-migration.md](docs/dsh-0.1.7-migration.md)。
> 其它 DSH / MemoryCore 组合未验证，
> 尤其 DSH 的 `SECTION_ORDERS` / `CONTEXT_ORDERS` 两张表、`agent/pre-step`、
> `system-prompt/assemble`、以及设置页的 `Config` + `configForms` 契约变化会影响本插件
> （见 README「兼容性与测试范围」，以及 [docs/dsh-0.1.7-migration.md](docs/dsh-0.1.7-migration.md)）。

---

## [Unreleased]

## [0.7.0] - 2026-10-15

### 新增：对话里说"记一下" → 待办直接写进 TDAI task（`taskWriteEnabled`，默认关）

#### 为什么

待办此前只活在三种地方，都不是长期档案：DSH 原生 `todo_write`（会话一关就没）、
团队任务板（随团队生命周期）、本地待办 md（**很容易跟踪丢失**）。目标载体是 MemoryCore
的 task —— 服务端持久、MemoryPanel 可见、其他 agent 可见、且带 `task_id` 归属。

#### 设计（**工具是手、模型是脑、skill 是口径**，不是三选一）

- 判定留给**模型**：待办判定是语义问题（"下周三前交报告" vs "最近在琢磨换电脑"），
  正则做不到；再起一路 LLM 抽取则是每轮重复付费。
- **插件出工具**：只有插件进程拿得到 `x-tdai-user-key`，凭据不进模型可见的 prompt。
- **口径写进工具 description**（工具 schema 本来每轮都在上下文里，不额外占注入预算），
  详细 SOP 留给云端 skill。
- 被否掉的：插件正则拦截自动写（无判定力）、每轮旁路 LLM 抽取（成本）、
  上游 `mem:create-task` 命令族（DSH 直连内核，不经过 MemoryProxy 的 LLM 转发）。

#### 触发口径：只在用户明确要求时写（保底档）

"记一下" / "帮我记下来" / "加到 task 里" 才算；推测出的待办不写（最多问一句要不要记），
自己提议的事、用户的提问都不写。同一轮里用户说过一次之后，他点出的多条待办都记。

#### 实现

| 文件 | 改动 |
| --- | --- |
| `client.mjs` | meta 面新增 `metaCreateTask` / `metaListTasks` / `metaUpdateTask` / `metaDeleteTasks`；**用 `post()` 不用 `safe()`** —— 写侧静默失败 = 假成功 |
| `client.mjs` | `post()` 的非 2xx 分支补上**响应体里的 `code`/`message`**（原先只抛 `HTTP 403`，把唯一能修的线索丢掉） |
| `lib/tools.mjs` | 新增 `registerTaskTools`：4 个工具 + 会话级「最近写入的 task_id」记录（供撤销） |
| `config.mjs` / `lib/settings.mjs` / `client.card.tsx` / `cordis.patch.yml` | 新开关 `taskWriteEnabled`（默认关，volatile，面板可见，env `TDAI_MEMORY_TASK_WRITE_ENABLED`） |
| `lib/commands.mjs` | `/tdai-task-undo [task_id]`（删本会话最近写入的那条，不依赖模型记住 id）；`/tdai-status` 与 `/tdai-help` 同步 |
| `test/task-write.test.mjs` | 新增：payload 形状 / 精确去重 / 开关与 userKey 缺失时零网络拒绝 / **失败必须 fail-loud** / 撤销 |
| `test/load.test.mjs` | 工具数 10 → 14，并断言 4 个写工具**无条件注册**（开关是 volatile，条件注册会延迟到重启才生效） |
| `scripts/task-write-e2e.mjs` | 可重复的真连 E2E（create → get → update → list → delete → 复核 404），跑完自清理 |

#### 验证（2026-10-14 实测，本机内核 `127.0.0.1:8420`）

- E2E 全绿：伪造 `creator_user_id` 被 403 拒绝；create/get/update/精确 title 查重/delete 全通过；
  删除后裸 post 得 `404 task_not_found`、`list` 回到 0 条、库中无残留。
- 单测：`npm test` 全绿（新增 15 组断言，含"写侧失败文案里不得出现读侧那句『暂时不可用』"）。
- 实现期踩到并修掉的两个坑：① `/tdai-task-undo` 的 rawInput 里命令名本身就含 `task-undo`，
  按 `task-[0-9a-z]+` 匹配会把它当成显式 id → "最近一条"兜底永不生效（已加"先摘命令名 + id ≥6 位"双保险）；
  ② E2E 脚本一开始拿 `metaGetTask` 等 404 异常 —— 它是读侧 fail-open（吞掉 404 返回 null），
  等不到异常，改裸 `post` 观察服务端真实响应。

#### 代价（明确记一笔）

4 个工具的 schema 是**常驻上下文**：实测 2872 B（`tdai_task_add` 一条就 1308 B），
工具 schema 总量 6543 B → **9415 B**。默认关也照付这笔钱 —— 因为不改注册机制就无法
"关着时注册、打开时生效"（volatile 字段变更不重新 apply 插件）。
`docs/prompt-design.zh-CN.md` 里"工具 schema 未纳入预算测试"那条缺口因此更值钱了。

### 修复：知识服务的失败被一律说成"不可达" —— 参数写错也看不出原因

#### 现象（2026-10-14 实测）

- 模型把 `read_page` 的 `refs` 写成了 `path`。服务端回得很清楚：
  `{"code":400,"message":"refs is required (non-empty array)"}`，
  但模型收到的是 **`知识工具调用失败：知识服务不可达。`**
- 拿到这个"对方挂了"的假诊断之后，它连试四种参数写法（`path` / 裸路径 / `id` / 另一个字段），
  五次全败，于是断定"知识库里没有"，改用本地文件自己拼了一份文档。
- 直连实测：`POST 127.0.0.1:8424/v3/tools/call` **200 / 3.8ms**，服务全程是好的；
  同一条 4xx 响应里那句 `refs is required` 一直都在，只是没人转达。

#### 根因

`GatewayClient.#postTo()` 把**所有**失败（网络错误 / HTTP 4xx / 5xx / 信封 `code != 0`）都归成
同一个 `null` 返回值，调用方（`knowledgeToolsCall` / `knowledgeToolsList`）只能回一句
"知识服务不可达"。真实原因（HTTP 状态、业务码、服务端 message）只写进插件日志，
而插件的 `log()` 走 `ctx.logger.warn`、**不落盘** —— 等于唯一能修它的那一方看不到。

#### 修复

- `#postTo` 改为返回 `{ ok: true, data }` / `{ ok: false, error }`：`error` 是**给模型看的一句话**，
  含 HTTP 状态 / 业务码 / 服务端 message；只有纯网络层失败才说"请求失败（… cause: …）"。
  重试判据不变（网络 / 5xx / 429 重试一次；4xx 与业务码不重试）。
- `knowledgeToolsList` 同步改成 `{ ok, tools }` / `{ ok: false, error }`，与"资源确实没有工具"
  （`tools: []`）分得开；`tdai_knowledge_tools` 的文案从"无法获取 X 的工具清单（知识服务不可达）"
  改成带上真实原因；`assets.mjs` 的工具清单预取与三处测试桩同步适配。
- 顺带补一个**静默失败点**：wiki 的 `read_page` 对取不到的引用回 `code=0` +
  `{ref, not_found:true}`（没有 `content`），模型分不清"页面不存在"和"这页是空的"。
  现在会在 JSON 之后追加一句
  `[tdai] N 个引用没取到内容（页面不存在、路径写错或本来就是空页）：…`。

#### 测试

- `test/knowledge-retry.test.mjs`：新增 4xx / 5xx / 业务码的错误转达断言（含事故现场那条
  `HTTP 400 · refs is required (non-empty array)`）、"只有纯网络失败才说请求失败"、
  `tools/list` 的三态（成功 / 失败 / 空清单）、空引用注解；原先断言"一律 知识服务不可达"的
  用例全部改成新语义。
- 变异验证：把 `error.brief` 退回写死的"知识服务不可达。" → 用例 2 立刻挂。
- **用真实服务跑了一遍**（不打桩、不改运行中的 dsh）：错参数 → 服务端原话；
  正确 `refs` → 正文正常返回；不存在的页 → 空引用注解；`tools/list` → 7 个工具。

---

## [0.6.1] - 2026-10-14

### 修复：知识 skill 正文被进程级冻结 —— 新绑定/新同步的知识资源拿不到 `knowledge_id`

#### 现象（2026-10-14 实测）

- 用户新建了一个知识资源（自建 wiki《自制力》，40 页，含 `wiki/sources/链式启动协议.md`，即 RSIP）
  并绑到 agent。system 里的 `tdai:knowledge-tools` 路由行**已经**列出它（"自制力（wiki）"），
  但模型加载 `tdai-team-knowledge` 拿到的正文里**只有另外两个资源**：
  它只有名字、没有 `knowledge_id`，`tdai_knowledge_call` 无从下手，
  最后对用户宣称"记忆和技能里都没有…我把手上这三个知识资源和你的 vault 都扫过了"（实际只扫了两个）。
- **换新会话没用、`/tdai-sync` 也没用**：路由行会更新（它每轮从实时资产渲染），
  正文不会——只有重启 dsh 才会变。
- 铁证：同一个会话、同一分钟里，路由行写"已绑定 3 个资源"，skill 正文写 2 个
  （`session-a7e6a413` 01:47:44 的 system 与 01:47:52 的 `skill` 工具返回）。

#### 根因

1. `ctx.skills.register` 登记的是**进程级、按名 first-wins** 的 runtime skill
   （dsh-skill `lib/index.js:193-200`）：同名重复注册只 `logger.warn` 一句，然后返回一个
   **no-op disposer**，既不覆盖也不报错。宿主里只有一份正文，**第一个注册的会话赢了**，
   之后所有会话（含新会话）读到的都是它。
2. 插件的幂等判据原本是 `Set<sessionId>`（"每个 session 注册一次"），前提假设是
   "正文在注册时冻结、同一 session 内资产不变"。这个前提漏掉了"注册本身是进程级的"：
   每个新 session 的那次注册都只是撞在 first-wins 上被静默丢弃，**连一条日志都没有**。
3. 正文里含每个资源的 `knowledge_id`，而模型只能从这里拿到 id（路由行只有名字）。
   于是"后来新增/新同步的资源"永远拿不到 id —— 资产绑好了、路由可见了、正文里没有。

#### 修复（`lib/sections.mjs` · `registerKnowledgeSkill`）

- 幂等判据从 **session** 改成**正文指纹**；正文变了就 `dispose` 旧的、再注册新的
  （同一个同步块内完成，别的会话看不到中间态）。
- 进程级槽位保存**赢家那次**注册返回的 disposer（重复注册拿到的是 no-op，必须留住第一次的，
  否则摘不掉旧条目）；同时记住正文与它来自哪次资产加载。
- **单调闸门**：正文来自各会话**自己的**资产快照，旧会话在整个生命周期里都不会重新拉资产。
  用 `SessionAssets.loadedAt` 做闸门，只允许**严格更新**的快照替换（首次注册不受约束；
  没有时间戳的资产不许覆盖有时间戳的）——否则一个还开着的老会话下一轮 assemble
  就会把正文刷回旧的，两个会话互相覆盖。
- 换新失败时尽量把旧正文挂回去（宁可暂时陈旧，也不要整段消失），槽位不提交，下一轮 assemble 重试。
- 顺带：成功换新会记一条日志（这个 bug 之前是完全静默的），并删掉 `session/disposed`
  里那个只服务于旧幂等 Set 的清理分支。

#### 测试

- `test/knowledge-skill.test.mjs`：假宿主的注册表按 dsh-skill 语义重写
  （**first-wins + no-op disposer + warning**），新增 `body()` 返回"模型真正会读到的正文"。
  新增用例 7/8/9：资产变化 → 正文热更新（旧实现在这里被 first-wins 吞掉）、
  旧快照不得回滚新正文、无时间戳不许覆盖、换新失败要回滚并可重试。
  两处变异验证：去掉 dispose → 用例 7 挂；去掉 `loadedAt` 闸门 → "旧快照不得覆盖新正文"挂。
- `test/subagent.test.mjs`：断言口径从"子会话也注册一次"改成"子会话拿到刷新后的知识资产时，
  正文跟着更新"（正文级幂等之后，同内容不再重复注册才是正确行为）。

### 修复：知识工具的 allowlist 与会话资产对齐（skill 正文 / 会话快照之间的时间差）

#### 现象

上一条修好之后，正文是**进程级最新**的，而 `tdai_knowledge_call` 的 allowlist 取的是
**会话级资产缓存**，于是又多出一种失败：正文里列着新资源的 id，模型照着调，
被回一句"未绑定的知识资源"——明明正文里就有。它和上一条同源，也会把模型推到
"知识库里没有"这个结论上。

#### 修复（`lib/tools.mjs` · `registerKnowledgeTools`）

- 目标 id 不在当前清单里、且手上这份资产**够老**（超过 `ASSET_FRESH_MS = 10s`）时，
  先 `assets.refresh(sessionId, policy)` 强制刷一次再判；刷完仍然没有，才回
  "未绑定 + 当前可用清单"。命中就直接走原路径（零额外开销）。
- 两个刻意留的边界：**没有资产**时不在工具里强制刷新——那条路已由上面的 `ensure` 处理
  （带失败冷却），不该再打一遍网关；**资产够新**时直接拒绝——刚查过，没必要再查。
  刷新成功后 `loadedAt` 变新 → 10s 内不会重复刷新，模型连喂几个不存在的 id 也打不穿网关。

#### 测试

`test/knowledge-tools.test.mjs` 新增用例 8–11：陈旧资产 + 正文新 id → 刷新后真调通
（`tdai_knowledge_call` / `tdai_knowledge_tools` 都覆盖）、资产够新 → 零刷新直接拒绝、
刷新后仍没有 → 只刷一次不循环、无资产 → 走既有提示且不刷新。
两处变异验证：删掉刷新块 → 用例 8 挂；去掉"够老"闸门 → 用例 9 挂。


---

## [0.6.0] - 2026-10-11

### 变更：云端 skill 从「常驻目录」改成「每轮按需召回」

原来每轮请求的 system 里常驻一份 `/v3/skill/listing` 的 top-20 目录（`tdai:available-skills` 段）。
它有三个毛病，实测数据如下：

- **贵**：本机 20 条自有 skill 的完整描述 = **15,300 字节**（占当时常驻注入的绝大部分），
  而且是每一步都随请求发送（缓存命中也要占上下文窗口）；
- **不全**：本机 agent 名下实际有 **77 个** active skill（`/v3/skill/list` 实测 `total=77`），
  top-20 只覆盖四分之一；
- **不准**：它的检索 query 是 agent 的**合并 prompt**（本机 7,162 字符），跟用户这一轮说的话无关；
  而且这条 query 没截断，撞上 core 的 `query ≤ 2048` 校验，**永久返回 `code=40001`、静默降级为空段**
  （连状态快照都只是老老实实写着"云端 Skill（未加载）"，没人看）。

替代方案：**每轮按当前对话检索、命中才注入**。

- query：**最近 3 条真人消息**拼窗口、截 512 字符（只取最后一条会死在"继续"这类无信息轮次；
  不掺 agent prompt，那是把 query 冲淡成宏观文本的老毛病）；
- 检索：`/v3/skill/search`（FTS5 索引 `name` + `description` + 正文截断 4000 字符，中文走 jieba
  `cutForSearch` 分词；实测"睡眠体检"这类连写也能命中）；
- 注入：默认 top-3（面板可调，1–10），渲染成 `<tdai_recalled_skills>`，与 L1 召回**共用一条
  plugin 消息**（同一条尾部消息、同一个硬超时、同样 fail-open）；**描述原样返回、不截断** ——
  只折叠空白（换行→空格），因为本机描述普遍 100–900 字符，砍到 80 字符只剩半句、
  模型只能靠名字猜用途；正文仍按需 `tdai_skill_view` 取；
- 去重：同一会话内命中集与"上一次注入"完全相同则跳过，不往历史里堆重复块；
- 两段召回**各自 fail-open**：skill 检索抛错不影响同一条消息里的 L1 块。

**字节账**（`test/prompt-budget.test.mjs` 实测）：

| | 改造前 | 改造后 |
| --- | --- | --- |
| system 常驻（示例规模） | 5,768 B（含 skill 目录段 424 B） | **5,344 B** |
| skill 相关载荷 | 真实目录 **15,300 B**（本机全量描述，每步） | 命中时 2.5–4.5 KB（实测：3 条 2,541 B / 4 条 3,456 B / 5 条 4,486 B），零命中 0 |
| 覆盖 | 20 / 77 | 按需检索全库（77 条自有 + 团队共享） |

删除的部件（少一个部件就少一类静默失效）：

- `tdai:available-skills` system 段（order 522 释放；`tdai:knowledge-tools` 从 523 收成 522 保持连号）；
- `client.skillListing()`、`lib/assets.mjs` 的 skills 面（资产加载少一轮 HTTP）、
  `lib/prompts.mjs` 的 `renderSkillsBlock` / `wrapAvailableSkillsBlock` / `buildListingQuery`；
- 那条 `40001` 路径整体退役（**新路径复用已经截断到 2048 的 `searchSkills`**）。

配套：

- **开关与旋钮**：复用 `skillsEnabled`，语义收窄为「云端 skill 召回」，卡片上移到读侧（挂在读侧总开关
  下，**不受「System prompt 注入」总闸约束** —— 它与 L1 召回一样走消息尾部）；紧跟两个数字输入
  **`skillRecallLimit`（条数上限，默认 3，1–10）** 与 **`skillRecallMinScore`（分数下限，默认 4，
  0 = 关掉闸门）**——**实际注入条数 = 过分数闸门后的前 N 条**，两个旋钮共同决定；
  描述不截断后这块的体量就是"条数 × 描述长度"，**想省就调小条数，不要砍描述**；
  同样可用 env 配置（`TDAI_MEMORY_SKILL_RECALL_LIMIT` / `TDAI_MEMORY_SKILL_RECALL_MIN_SCORE`）。
  默认 4 的依据是本机实测分带：无信息轮次（"继续"、"今天天气不错，随便聊聊"）top 分 1.9–3.6，
  真相关轮次（"RRG 日评 skill"、"这个报错怎么修"）4.1–15.4 —— 闸门落在 3.6 与 4.1 之间；
- **工具描述改准**：`tdai_skill_search` 原来写"检索本会话目录**之外**的 skill" —— 目录没了以后这句话
  会让模型以为自有 skill 已可见、反而不检索；`tdai_skill_view` 的 `skill_name` 来源同步改成
  `<tdai_recalled_skills>` / 检索结果；
- **状态快照 / `/tdai-status`**：`云端 Skill 未加载` 改为 `云端 skill 召回=开/关（上限 N 条）`；
- **测试**：`test/recall.test.mjs` 新增 7 组用例（命中注入 / 零命中不注入 / 同集合去重 / 开关 /
  分数闸门 / skill 失败不影响 L1 / query 窗口只收真人消息）；`test/subagent.test.mjs` 断言子会话
  一次 skill 检索都不发；`test/prompt-budget.test.mjs` 给召回块加 1000 B 硬上界；
  `test/capture-filter.test.mjs` 的标记清单纳入 `<tdai_recalled_skills>`。

**待观测**（留给真实使用验证，不在这里下结论）：每轮命中率、命中后真的调 `tdai_skill_view` 的转化率、
以及零命中轮次里"本该有 skill"的比例。

### 新增：TDAI agent 的「角色定位 prompt + 规则固定 prompt」注入

起因：更早一轮改造把 `agent.prompt` 从 `tdai:session-context` 里删掉，理由是"persona 已由 DSH preset
的 `deployment:persona` 段注入"。实测这条假设对 TDAI 的 agent prompt **不成立** —— 本机 profile
的 preset persona 只有一句 `You are a coding agent powered by the {{model}} model.`
（`cordis.yml` 的 `personaPrefix`），MemoryCore 里那份 7162 字符的 ARK-ALPHA 角色 / 规则定义
**没有任何通道进入模型上下文**。

- **字段口径**（本插件自己确定，来源是 MemoryCore 本体）：人格拆在两个字段里 ——
  `metadata_json.ui.role_prompt`（MemoryPanel 的「角色定位 prompt」）与
  `metadata_json.ui.rules_prompt`（「规则固定 prompt」）；服务端另把二者按
  `[role, rules].filter(Boolean).join('\n\n')` 合并进 `prompt` 列。
  依据：`MemoryCore/src/metadata/service/metadata-service.ts:104-117`、
  `MemoryPanel/web/src/components/team/AgentEditDialog.tsx:184-193`、
  `MemoryPanel/web/src/i18n/zh-CN.ts:844,847`。本机实测：`role_prompt` 7162 字符 / 19090 字节，
  `rules_prompt` 空，`prompt` == 合并结果（逐字节相同）。
- `lib/prompts.mjs` 新增 `resolveAgentPrompts(agentRaw)`：**以拆分字段为准、`prompt` 兜底**
  （兜底时整段算 role），坏 JSON / 空值不抛；`resolveAgentPrompt()` 保留为合并视图，
  只给状态快照 / `/tdai-status` / 预算观测用。
- **注入位置（prompt 模板先经用户确认）**：角色 / 规则**住进 `<session_context>`**，
  按 `[Agent]`（id / name / description）→ `[Role]` → `[Rules]` → `[Task]` 的顺序带标签注入
  （空的那个字段连标签都不出现）；persona 槽（`deployment:persona-prefix`，order 0）只放一句
  英文指引：

  > Your identity, role and rules are defined in the <session_context> block below; follow it when replying to the user.

  实测渲染顺序：`harness:identity` → persona 槽（指引句）→ `tdai:session-context`（信封 + 三段）。
- `lib/sections.mjs`：persona 槽文本改为指引句（**替换** DSH 部署 / preset 的 persona，与
  `dsh-persona` 覆盖同一段名是同一个机制，区别是本插件改在 `system-prompt/assemble` 之后，
  不在注册表里抢段名）；该段标 `interpolate: false`。指引句只在**块非空**且开关链全开时写 ——
  资产拉不出来时块是空的、DSH 会把空段整个丢掉，这时写指引句等于指一个不存在的东西，
  宁可不写（persona 保持 DSH 原样，fail-open）。
- **⭐ 全段关插值**：`tdai:session-context` / `tdai:profile-memory` / `tdai:available-skills` /
  `tdai:knowledge-tools` 注入时一律带 `interpolate: false`。这些段的正文全部来自 MemoryCore
  （画像、场景索引、skill 目录、知识资源、agent 的 role / rules）即**用户内容**，出现字面
  `{{...}}` 完全可能；DSH 对未知变量是抛错（`dsh-system-prompt/lib/index.js:160-170`），
  一个手写的 `{{foo}}` 就能让每轮请求都失败。关插值后按字面发出（同 `:113-114`），
  而这些文本本来也不使用 DSH 变量（`{{model}}` / `{{cwd}}` 只在 persona 段）。
- `lib/prompts.mjs` 的角色 / 规则正文会**中和 `</session_context>`**（转义成 `<\/session_context>`）：
  正文里手写闭合标签会提前闭合信封，也会把下游按哨兵剥离的逻辑切错。
- `lib/assets.mjs`：`agentDetail` 增加 `rolePrompt` / `rulesPrompt`（正文）与 `agentPrompt`（合并视图）；
  `needAgentDetail` 的判据改为 `policy.identity && cfg.sessionContextEnabled && cfg.agentPromptEnabled`。
- 「人格没生效」看两处：`/tdai-status`（`lib/commands.mjs`）报角色 / 规则 prompt 各多少字符，
  `tdai:state` 快照（`lib/sections.mjs`）只报**是否装载**；两者都不打印正文。
- **开关**：`agentPromptEnabled`（默认**开**）、`agentPromptKeepBase`（默认关 = persona 槽只放指引句；
  开 = 先保留 DSH 原 persona 行再接指引句）。归属**身份面**（子 agent 默认拿不到），并**挂在
  `sessionContextEnabled` 之下**（角色 / 规则住在那个块里，块关掉 → 标签与指引句一起消失），
  设置卡片上按同样层级置灰。两键进入 `Config` schema 与 `cordis.patch.yml` 的 env 透传
  （`TDAI_MEMORY_AGENT_PROMPT_ENABLED` / `TDAI_MEMORY_AGENT_PROMPT_KEEP_BASE`）。
- **测试**：`test/smoke.test.mjs` 覆盖 `resolveAgentPrompts` 拆分 / 兜底 / 空值与
  `renderSessionContext` 的标签顺序、`includePrompts=false`、闭合标签转义；
  `test/sections.test.mjs` 覆盖"指引句替换 / 保留原行 / 关开关不动 / 会话上下文关掉时一起消失 /
  资产不可用时不写指引句 / 正文带 `{{}}` 与伪造闭合标签 / 子会话不继承"；
  `test/settings-card-render.test.mjs` 覆盖新的多级依赖置灰矩阵。
- **文档**：README / README_CN 的「人格注入」小节按确认后的模板重写，
  `docs/prompt-injection-redesign.md` 就地更正阶段 2"persona 由 preset 注入"这条假设。

**子 agent 策略从"读侧一刀切降级"改为"能力面拆分"；知识端点加 1 次重试。** 起因是一次真实事故：
四人调查团队的子 agent 全部被策略闸门挡在知识库之外（`tdai_knowledge_call` 直接返回
"本会话是子 agent 会话，读侧已按子 agent 策略降级"），wiki 原文只能由父会话逐页投喂。

### 修复：子 agent 默认保留知识库与工具

- `lib/subagent.mjs` 新增 `subagentReadPolicy(config, session)`，把读侧拆成四个能力面：
  `identity`（`tdai:session-context`）、`memory`（画像 / L1 召回 / `tdai:state` 快照）、
  `skills`（`tdai:available-skills` 云端目录）、`knowledge`（知识资产 / 知识路由 /
  `tdai-team-knowledge` skill / 知识工具）。子会话默认 `knowledge=true`，其余三个 false；
  `subagentInjectionEnabled=true` 仍是"全量继承"逃生门（`readSideAllowed()` 语义不变）。
- 接线全部按面判定：`index.mjs`（`agent/created` 预热只预热用得着的面）、`lib/sections.mjs`
  （section 渲染 + 知识 skill 注册）、`lib/recall.mjs`（L1 召回）、`lib/tools.mjs`
  （删掉子会话拒绝分支，改为"知识面 + 缓存未就绪时按面补一次 `ensure`"）、`lib/commands.mjs`
  （`/tdai-status` 现在打印本会话的能力面矩阵）。
- `lib/assets.mjs`：`ensure/warm/refresh(sessionId, policy)` 按能力面加载 —— 子会话不再为 meta
  详情、借入 agent、L3/L2、skill listing 各打一轮 HTTP；策略签名变化会让同会话旧缓存失效。

### 修复：知识服务调用 1 次重试 + 日志

- `client.mjs` 的 `#postTo` 从"单次尝试"改为"最多 2 次"：网络 / 超时 / HTTP 5xx / 429 重试；
  HTTP 4xx 与业务 `code != 0` 直接返回（确定性失败不重试，只白等一个 timeout）。
- 每次尝试分开打日志，带失败原因（含 `error.cause` 的 code）与耗时；重试成功也留痕，
  否则看不见这条链路是抖的。主网关的 `safe()` 失败日志同样带上 cause。

### 文档与注释更正

- README / README_CN / `docs/prompt-design.zh-CN.md` §3.4 / 设置卡片文案与注释：按能力面重写
  子 agent 一节，并标明那组缓存实测数字属于"连知识侧一起关"的初版配置（现默认多回一块
  307 B 的知识路由）。
- 修正 `source.kind === 'plugin'` 的写法：v4 硬拒绝笼统的 `plugin`；宿主 runtime context 是
  `runtime-context`，本插件召回消息是 `plugin:dsh-tdai-memory-plugin`。
- 新增 `test/knowledge-retry.test.mjs`（6 组真 HTTP 断言：连接层/5xx 重试、4xx 与业务码不重试、
  cause 日志）；`test/subagent.test.mjs` 改为"知识面保留 + 身份与记忆不注入"的成对断言，
  并锁住"子会话的资产加载只带知识面"。

---

## [0.5.0] - 2026-09-25

**DSH `0.1.2-rc.1` → `0.1.7-rc.1` 兼容性迁移。** 起因是一次真实升级后的兼容性审计：
在本机把 DSH 升到 `0.1.7-rc.1` 后，0.4.0 仍然能挂载、召回与回流都正常，但**设置页整条链
失效**，启动日志里留下一行

```
[tdai-memory] settings unavailable: settingsCtx.settings.register is not a function
```

完整审计过程（每一项契约的核对方式与现场证据）见
[docs/dsh-0.1.7-migration.md](docs/dsh-0.1.7-migration.md)。这里只记结论与修复。

### 变更（DSH 侧删掉的 API）

#### 1. host 设置命名空间：`settings.register()` → `export const Config`

- **现象**：面板命名空间不存在；`settings.register` 抛 `TypeError`，被插件的 try/catch 吞掉，
  只留一行日志。
- **根因**：0.1.7-rc.1 的 live `settings` 服务只剩
  `configure / prepareDocument / describe / update / replace / mutate`，`register` 被整体删除；
  新模型是**声明式**的：插件导出 `Config`（schemastery schema），settings 服务据此校验 entry
  config 并投影表单，命名空间 key 就是 profile patch 的 entry id。
- **修复**：`index.mjs` 导出 `export const Config = buildSettingsSchema()`；
  `lib/settings.mjs` 改为只做两件事——提供 schema、`settings.configure({ auto: false })`（本插件
  自带设置页，别让宿主再生成一个）。插件不再自行 merge 配置：**非 volatile** 字段写入后
  Loader 带着新 config **重新 apply**（`applies: 'live'`），`client` / `assets` 随之整体重建，
  旧的 `rebuild()` 删除；**volatile** 字段（面板字段）写入只原地更新访问器，走下面的
  「连带改造」。
- **踩坑记录（已用测试锁住）**：`cordis.patch.yml` 的 `!!js process.env.X ?? ''` 在 env 未设置时给
  **空字符串**，而裸 `z.boolean()` / `z.natural()` 遇到 `''` 会抛
  `expected boolean but got` → **整个 entry 加载失败**。所以布尔/数字字段用
  `z.union([z.boolean(), z.string()])` / `z.union([z.natural().min().max(), z.string()])`，
  归一化仍交给 `config.mjs` 的 `boolOpt` / `numOpt`。
  另：**不用 `z.transform()`** —— 它的回调会被 `toJSON()` 按源码序列化进 schema 包络，
  客户端 rehydrate 时重新求值，回调引用外部常量（如 FALSEY）就会在浏览器侧抛
  `FALSEY is not defined`（已实测）。
- **顺带修好的一处静默缺陷**：`apiKeyEnv` 原先不在 schema 里。schemastery 的 object 会保留未知
  键，所以它侥幸能用；但现在显式声明，避免换校验实现时被剥掉（丢了就是
  `process.env[undefined]` → 凭据静默失效）。

#### 2. client 设置页：`settingsScope` → `configForms`，`settings.plugin.item` → `settings.section`

- **现象**：卡片静默不挂载（不报错、不占位）——`inject = ['settingsScope', 'slots']` 的服务
  永远不出现，cordis 就不会执行 apply。
- **根因**：0.1.7-rc.1 **整个装机里没有 `settingsScope`**（覆盖全部 `@deepseek-ai/dsh-*`、
  预构建前端 `dsh-web-frontend/dist`、profile 的 `node_modules`；唯一命中是 `dsh-context` /
  `dshmarket` 的客户端**消费**代码），槽位 `settings.plugin.item` 也不存在了。
- **修复**：`client.card.tsx` 改用
  - `ctx.configForms.get('tdai-memory')` 取表单（`getSnapshot/subscribe/mutate/set/unset`）；
  - 注册进 **`settings.section`** —— 设置面板左侧的**顶层导航页**，与 profile 里其它第三方
    插件（`dsh-better-sidebar` / `dsh-workspace-drag` / `dshmarket`）一致；
  - **无条件注册**（不用 `whileServed` 包）：命名空间缺失时卡片渲染一条可见的自解释说明，
    而不是静默消失——故障可诊断性优先；
  - secret 字段（`userKey`）明文跨 wire 就被 redact 删掉，卡片改为从 `describe()` 的
    `secrets` 侧信道显示「已设置（留空表示不改动）」。
- **踩坑记录**：最初挂的是 `settings.plugins.tab`（「内置插件」分区里的二级 tab，官方
  inventory 用那个）。实测用户**在设置导航里根本看不到**，直接反馈"没有设置项"——藏在二级
  tab 等于没有。改挂 `settings.section` 后与其它第三方插件同层可见。
- **外观不变**：分组、依赖置灰、身份告警、草稿式提交全部保留（渲染测试原样通过）。

#### 3. `agent/session-start` → `agent/created`

- **现象**：会话建立的资产预热是**静默死代码**（监听永不触发）。
- **根因**：0.1.7-rc.1 全源码 grep `session-start` 为 0 处；对应事件是 `agent/created`
  （serial，`{ agent, source, signal? }`）/ `session/created`。
- **修复**：改听 `agent/created`；测试同时断言**不再**监听已不存在的旧名。

#### 4. `agent/pre-step` 改写 decision 必须 spread

- **现象**：注入召回块时返回 `{ kind: 'enter', messages }`（新建对象），会吞掉内层 listener 设的
  字段。
- **根因**：0.1.7-rc.1 的 `PreStepDecision.enter` 多了可选 `startsRequestSeries`（"在本步准入的
  消息之前开一段新的 model 消息序列"），官方 practices 明确要求不拥有决策的 listener 用
  `{ ...decision, messages }`。
- **修复**：改为 spread，并加回归测试（断言自定义字段存活、内层 messages 不被原地修改）。

#### 5. 设置页可见性：`Config` 必须有 `.volatile()` 字段（且 schemastery ≥ 3.18.4）

- **现象**：设置导航里出现了「TDAI Memory」，但内容写「设置当前不可用：宿主没有暴露本插件的
  设置命名空间（tdai-memory）」。
- **根因**：`dsh-settings` 的 `describe()` 对每个 loader entry 先算 `volatileForm(schema)`：
  对象节点只保留**标了 volatile 的子字段**，一个都没有就返回 `undefined`，而 `describe()` 对
  `undefined` 的 entry **直接 `return []`**。本插件最初**故意没有给任何字段加 `.volatile()`**
  （以为配置变更走"重新 apply"更干净），于是这个 entry 在 `describe()` 里根本不存在，
  客户端 `configForms.get('tdai-memory')` 恒为 `unavailable`。
- **修复**：`volatile` = **"用户可在设置页编辑"**（0.1.7-rc.1 的约定，官方
  `dsh-client-ui-conversation` / `dsh-agent-default-model` 都只把用户可编辑字段标 volatile）：
  - 面板上的 19 个字段全部 `.volatile()`（新增导出 `VOLATILE_KEYS`）；
  - 部署期字段（`apiKeyEnv` / `l2Limit` / 各类预算与冷却）保持**非 volatile**，
    既不出现在设置页，也不受面板写入影响；
  - **依赖升到 `@deepseek-ai/schemastery@^3.18.4`**：`.volatile()` 与"校验后生成
    `{ get() }` 访问器"都是 3.18.4 才有的；3.18.2 里只认 meta 标记、不会生成访问器，
    而 loader 的 `_commitVolatile` 靠访问器原地更新配置（跨副本安全：标记是
    `Symbol.for("cosmokit.volatile.write")`）。
- **连带改造（volatile 变更不会重新 apply 插件）**：
  - `config.mjs` 新增 `liveValue()`，`resolveConfig` 对 volatile 访问器和普通值都能归一化；
  - `index.mjs` 的 `client` / `assets` 改为**按配置签名惰性重建**——每次都重新
    `resolveConfig()`（所以面板改完立即生效），签名变了就重建派生对象（顺带丢弃会话资产缓存，
    因为资产内容本身就依赖 `skillsEnabled` / `knowledgeEnabled` 这些开关）。
- **诊断加固**：`applySettings` 在启动后自检一次并写**宿主日志**
  （`settings: namespace "tdai-memory" served/NOT served`）——这正是本次唯一无法从客户端
  看清、只能靠宿主日志定位的一环。

#### 6. 召回注入的 `source.kind:'plugin'` 会让**整轮运行失败**（v4 会话格式硬拒绝）

- **现象**：读侧开关打开后，发消息即
  `本轮运行失败 format v4 message requires a producer-owned source kind`；把开关关掉
  （`enabled=false`）就正常 —— 故障被精确定位在**注入路径**，而不是请求链路。
- **根因**：召回块是独立注入的一条 `user/message`，其 `source` 用了 **v3 的万能包装**
  `{ kind: 'plugin', plugin: 'dsh-tdai-memory-plugin', form: 'notice', summary }`。
  v4 会话格式在入库处直接拒绝这个 kind
  （`dsh-session-format-v3-to-v4/lib/index.js:126` 的 `source()`：`value["kind"] === "plugin"` → 抛错）。
- **审计判断错在哪**：只验了 `dsh-session` 的 `assertMessageEventShape`（它对 `user/message`
  仅要求 `source.kind` 是非空字符串），于是把这一项记成"类型层漂移、运行时可用"。
  真正的门在**会话格式层**（`assertV4RowAdmission`），审计没覆盖到 —— 这是本次唯一一处
  "审计结论错误、并因此把 bug 放到真机上"的地方。
- **修复**：`lib/recall.mjs` 改用 v4 的 producer kind
  `SOURCE_KIND = 'plugin:dsh-tdai-memory-plugin'`（正是 v3→v4 迁移对未知第三方插件
  `producerKind(plugin, role)` 给出的规范取值），并**去掉 v3 的 `plugin` 字段**。
  这样老会话（迁移后）与新消息的 kind 完全一致。
- **验证**：用真校验器 `assertV4RowAdmission` 跑过 —— 旧形态
  `REJECT: format v4 message requires a producer-owned source kind`（复现线上报错），新形态 `PASS`。
  测试侧钉死三条：kind 非空、`!== 'plugin'`、无残留 `plugin` 字段。
- 顺带把测试夹具里的旧形态改成 v4 真实形态（`kind:'runtime-context'` 对应宿主的 runtime context；
  `plugin:dsh-tdai-memory-plugin` 对应本插件）。

#### 7. 审计确认「未变」的部分（因此没有改动）

`tools.register`（`output:{schema,render}` 仍必填）、`systemPrompt.section/context`、
`system-prompt/assemble`、`skills.register`（`source:'runtime'` 仍合法）、`commands.register`
及 `{kind:'success'|'error',text}`、`tools/skills/commands/sessions` 服务名、
`session/event` / `agent/error` / `agent/turn-stopping` / `session/flush` / `session/disposed`、
durable 事件名（`user/message` / `assistant/message` / `tool/result` / `turn/start` /
`step/start` / `turn/end`）、`SessionHeader.origin/delegationDepth`、客户端模块格式
（`__ModuleLoader__.load({id:包名, factory})`）、`dsh.bundle.patch` / `dsh.client.platform`、
patch 的 `!!js`。

> 例外：`source.kind` 一项原先被归到"未变/无害"，后被真机证明是硬失败，已按上面 §6 修复。

### 其它

- `test/section-registry.test.mjs` 的手抄 order 表同步到 0.1.7-rc.1，并把 `CONTEXT_ORDERS`
  也纳入断言（插件 Section 520–523 / context 560 仍然安全）。
- 新增护栏：patch 透传的 env 值必须能通过 `Config` 校验；pre-step 必须保留 decision 的额外字段；
  客户端产物不得再出现 `settingsScope` / `settings.plugin.item`，必须出现 `configForms` /
  `settings.section`；命名空间缺失时必须渲染可见的自解释说明；不再监听 `agent/session-start`；
  **注入消息的 `source.kind` 不得为 `'plugin'`**（v4 硬拒绝）。
- 设置页交互（2026-09-25 二次调整）：挂成**顶层设置导航页**（`settings.section`，与 profile 里其它
  第三方插件一致）之后，去掉了原来的二级折叠头（`aria-expanded` / chevron / `open` 状态）——
  进页面即见全部开关，少一次点击；渲染测试新增"不得再有折叠头部"的护栏。
- 真机验证（`0.1.7-rc.1`）：entry `include:tdai-memory` 以 `status: "schema"` 挂载；
  10 个 `tdai_*` 工具出现在 live Tool 目录；客户端产物进入 `__DSH_BOOT__` 并被
  `plugins/??…/client.js` 批次实际下发；身份恢复后 `tdai_memory_query` 返回真实记忆
  （26 条），运行态快照显示 L3 1 段 / L2 3 条 / 知识资源 1 个。

### 历史设置的找回（迁移操作，不是代码改动）

升级到 0.1.7-rc.1 时，DSH 的 settings 导入器把旧的 `~/.dsh/settings.yaml` 改名为
`settings.yaml.imported`，再**逐段** `settings.update(ns, values)`；**导入当刻本插件已被 profile
重建丢掉**，没有 `tdai-memory` 这个 entry，于是该段更新失败，只留在改名后的文件里
（`dsh-settings` 注释原文：*"a section the running composition rejects is logged and remains
only in the renamed file"*）。用户此前配置的身份与知识库设置因此**没有丢，只是没被迁移**。

找回办法（本次执行）：插件装回来后，把 `settings.yaml.imported` 复制回 `settings.yaml` 并重启
一次让导入器重跑 → `tdai-memory` 段的 `serviceId / teamId / agentId / userId / userKey /
knowledgeEnabled / knowledgeEndpoint` 全部落进 profile 的用户层，其余字段的 `!!js` env 表达式
原样保留（合并而非整段替换）。

> ⚠️ **一处未解释的异常（如实记录）**：该段里 `enabled: true` 与 `captureEnabled: true` 被导入器
> 写成了 `false`（同段的 `knowledgeEnabled: true` 正确）。已用**导入器自己的 `yaml` 包**复核：
> 解析结果是布尔 `true`；本插件 schema 对 `true → true` 也正确。无法从已读代码复现，暂记为待查。
> 处理：在 profile 用户层把这两个字段改回 `true`（`patchReload: live` 立即生效）。
> **再次导入后需复查这两个开关。**
>
> 对照：**面板保存路径已验证正常** —— 用户在设置页把开关改成 false 并保存后，profile 用户层
> 精确落盘（`enabled: false` / `captureEnabled: false`），说明 `configForms.mutate` → `settings.write`
> → 用户层这条链是通的。

---

## [0.4.0] - 2026-09-16

这一版是**提示词注入链路的重写 + 一批静默缺陷的修复**。核心目标的量化结果是：
system 段注入从 **9953 → 5768 字节（-42%）**，其中团队知识块从 4492 → 307 字节
（完整内容改为按需加载的 runtime skill）；同时把"开召回就卡住""工具结果被参数回显"
"召回块污染用户发言"三类线上可见的问题全部修掉。

**体积账要如实读**（详见 [docs/prompt-design.zh-CN.md](docs/prompt-design.zh-CN.md) §0）：
工具 schema 同期从 2774 → 6446 字节（新增 2 个知识工具 1497 字节；8 个记忆工具的描述
按"何时用 / 何时不必用"扩写，+2175 字节——这是把规则从 system 搬进工具描述的直接代价）。
因此**常驻合计 12727 → 12214 字节（-4%）**。真正的收益在结构上：4492 字节
"每轮付费、多数轮用不到"的知识配方，换成了 307 字节路由 + 3587 字节**按需加载**的 skill 正文。

这一版还补上了**子 agent 会话的降级**（默认不继承注入、不回流，见
[修复 10](#10-子-agent-会话把父-agent-的记忆整套继承并把执行过程写进长期记忆)）：
子 agent 的任务通常范围明确，父 agent 的画像与召回是干扰，而它的执行过程更不该进长期记忆。

### 修复

按影响面从大到小排列。每条给出**现象 → 根因 → 修复 → 覆盖它的测试**。

#### 1. 工具调用返回的是模型自己的参数，而不是真实结果（静默数据丢失）

- **现象**：`tdai_memory_query {limit:3}` 的返回内容是 `{"limit":3}`——检索结果被丢掉，
  而且不报错，只表现为"结果看起来像回显"，极难发现。
- **根因**：`lib/tools.mjs` 的输出投影写成 `render(value)`，而 DSH 的
  `ToolOutputDefinition.render` 契约是 **`(args, value)`**：第一个形参是**参数**
  （`dsh-tools/lib/types/index.d.ts`）。于是每次工具调用的第一个参数被当成返回值渲染。
- **修复**：`render(_args, value)`，并给 `output.schema` 补 `{ type: 'string' }`。
- **测试**：`test/tools-render.test.mjs`（锁 `render(args, value)` 契约、
  拒绝文案可达、输出 schema 一致）。

#### 2. 工具在错误的会话上执行（"知识工具永远说没绑定资源"）

- **现象**：同一会话内 system prompt 注入显示"知识资源 1 个"，而知识工具连续 4 次
  都回"当前会话没有绑定团队知识资源"。
- **根因**：`lib/tools.mjs` 旧代码用 `ctx.agent?.session || ctx.sessions?.list?.()[0]`
  取会话。插件根 ctx 上没有 `agent` 服务（第一个分支恒 undefined），而
  `SessionStore.list()` 按插入序返回，`[0]` 是**进程里最早创建的那个 session**。
  资产按 session 缓存，查老 session 自然恒空。
- **修复**：改为 `sessionIdOf(exec, ctx)`——从 `exec.agent.session` 取（DSH 的
  scheduler 调 `tool.execute(args, exec)`，当前 agent 挂在第二参数上）。
  同时 `test/load.test.mjs` 断言每个工具的 `execute.length >= 2`，防止再有人
  把第二个形参删掉。
- **测试**：`test/knowledge-tools.test.mjs`（用例 7「会话解析」）、
  `test/load.test.mjs`。

#### 3. "一开召回，发消息就一直阻塞等待"（网关卡死时整轮被拖住）

- **现象**：MemoryCore 网关慢或不可达时，每一步都要等几十秒；用户观感是插件把
  DSH 主链路拖死了。
- **根因**（三处叠加）：
  1. `agent/pre-step` 里 `await assets.ensure()`——**整包资产加载挡在模型请求之前**
     （meta 面 + 自有/借入 agent 的 L3/L2 + skill listing + 知识资源，每个请求各自 5s 超时）；
  2. 资产加载**失败即删缓存**，于是每一步都重新付一次这份代价（看起来像死循环）；
  3. L1 检索没有硬超时，网关不响应时该步一直挂着。
- **修复**：引入**三道硬闸门**，并把"等待"限制在唯一允许等待的位置：

  | 闸门 | 参数（默认） | 作用 |
  | --- | --- | --- |
  | 检索硬超时 | `recallTimeoutMs`（3000ms） | 超时即放弃本轮召回，不卡住这一轮 |
  | 整包资产总预算 | `assetLoadBudgetMs`（5000ms） | 最坏情况"第一步"只等一个预算，超预算按失败降级注入 |
  | 失败冷却期 | `assetRetryCooldownMs`（15000ms） | 失败后一段时间内不再重试（`0` = 不冷却） |

  其余位置一律改成**只读缓存 + 后台预热**（`peek()` / `warm()`，绝不 await）；
  `/tdai-sync` 显式刷新可以打破冷却期。
- **测试**：`test/assets-budget.test.mjs`（总预算封顶 / 失败冷却 / refresh 破冷却 /
  并发幂等 / dispose 清理 / 知识地址改写）、`test/gateway-timeout.test.mjs`
  （起一个**真实卡死的 HTTP 服务**，断言 150ms 超时下整轮 <1500ms 返回；
  以及"慢但可用时照常召回"）、`test/recall.test.mjs`（不阻塞主链路）。

#### 4. L1 召回块被写进"用户发言"，污染回显与记忆写入

- **现象**：前端把召回内容当用户输入回显；写回 L0 时只能靠文本剪裁；
  任何按"真人发言"判断的宿主逻辑都误判。
- **根因**：召回块曾以 **prepend 语义**插进真人那条 user 消息，而宿主会把
  `decision.messages` **原样持久化**（`dsh-agent-loop` 的
  `session.append("user/message", …)`）——插进去的内容就永久留在用户消息正文里。
- **修复**：
  - 召回块改成**独立一条 plugin 消息**（`source: { kind: 'plugin', plugin, form: 'notice' }`），
    splice 到本轮真人消息**之后**；真人消息正文一个字节都不动（前端渲染成一行可折叠的
    "上下文注入"）。
  - 回写过滤的主判据由"看文本有没有某个标签"换成**结构判据 `source.kind`**；
    文本哨兵（`stripInjectedBlocks`）降级为兜底，只为**存量历史消息**与丢失 `source`
    的外部文本服务。
  - 顺带修掉两个边界：`content` 必须是 `ContentBlock[]`（裸字符串会在发请求与持久化
    两处炸）；`messages` 为空时绝不注入（宿主靠 `length === 0` 判定轮次结束）。
- **测试**：`test/recall.test.mjs`（防御兜底 / 独立 inject 消息 / 真人消息零改动 /
  不阻塞主链路）、`test/capture-filter.test.mjs`（`source` 主判据 / 按块剥离 /
  缺 `source` 降级 / 模型消息保留）。

#### 5. 内部思考（reasoning）被当成对话写进长期记忆

- **现象**：实测一轮 32 条 L0 记录里 **31 条是思考原文**，可见回复反而被夹在一条
  4600 字符的记录里。
- **根因**：DSH 的 assistant 消息把 `type:'reasoning'` 与可见回复放在同一个 content
  数组里，旧代码用 `safeText()` 一起拼成一条。L0 是 L1/L2/L3 抽取的**唯一输入**，
  思考噪音会顺着后台抽取污染长期记忆。
- **修复**：新增 `lib/normalize.mjs`，按端点 schema 做**两套投影**——
  skill 端点收 5-role（`tool_call`/`tool_result` 带配对锚点），L0 端点折叠成
  `[tool_call] name(args)` 文本；`reasoning` / `thinking` / 图片一律丢弃（对齐
  MemoryProxy 的 `normalize-conversation.ts`）。
- **测试**：`test/capture-normalize.test.mjs`（reasoning 丢弃 / L0 折叠 / skill 5-role /
  失败轮不回流）。

#### 6. 失败轮次（模型报错 / abort / pre-step reject）会被回流

- **根因**：宿主只在成功路径派发 `agent/turn-stopping`，失败轮的缓冲没人清理；
  而"半轮对话"进 L0 会被后台抽取当成完整一轮消费。
- **修复**：`agent/error` 与 `turn/end` 上兜底——记日志 + 丢弃该轮缓冲，**不写记忆**。
- **测试**：`test/capture-normalize.test.mjs`（失败轮不回流）、
  `test/capture-filter.test.mjs`。

#### 7. 知识服务 `tools/list` 预取失败（skill 正文里没有可用工具）

- **现象**：知识 skill 正文里只剩"可用工具：未取到"；容器化部署下
  `/v3/knowledge/list` 返回的是服务端视角地址（如 `http://host.docker.internal:8424/v3`），
  插件进程在宿主上访问不到，表现为 `fetch failed`。
- **修复**：
  - 新增配置 `knowledgeEndpoint`：只替换 scheme/host/port，**path 原样保留**，
    在"进入任何下游调用之前"完成改写，工具与 skill 正文都只认资产里的 `service_url`；
    非法 URL 一律回落原地址，不抛。
  - `GatewayClient` 新增 `#postTo` / `knowledgeToolsList` / `knowledgeToolsCall`，
    对"资源自己的 base"发请求，并显式判 `data.isError`（code-graph 失败时仍回
    `code=0`，只把错误放在 `isError` 里——不判就会把失败当成功结果喂给模型）。
- **测试**：`test/assets-budget.test.mjs`（知识地址改写）、
  `test/knowledge-tools.test.mjs`（参数透传 / `isError` 语义 / fail-open）。

#### 8. 知识 skill 静默丢失（cordis 服务获取姿势错误）

- **现象**：宿主明明挂了 `dsh-skill`，`tdai-team-knowledge` 却不出现。
- **根因**：`skills` 是**别的插件在自己的 fiber 里 provide 的服务**，而本插件的
  `inject` 只声明了 `['tools','systemPrompt','sessions']`。cordis 的 ctx 是 Proxy，
  读一个未声明又不是本 fiber 祖先链上的服务名时，**取值动作本身就抛**
  `cannot get property "skills" without inject`——`ctx.skills?.register` 里的 `?.`
  一点用都没有（它拦的是 `undefined.register`）。
- **修复**：改走 `ctx.inject(['skills'], cb)`——服务就绪后在带依赖的子 ctx 上回调，
  宿主没有 `skills` 时回调永不执行，天然 fail-open。
- **测试**：`test/knowledge-skill.test.mjs`（假宿主按 cordis 语义做成
  "未声明的服务名一读就抛"的 Proxy，避免这个 bug 再溜回"单测全绿"的状态）。

#### 9. 四个配置项在 env 里配置静默无效

- **现象**：README 把 `TDAI_MEMORY_RECALL_TIMEOUT_MS`、
  `TDAI_MEMORY_ASSET_LOAD_BUDGET_MS`、`TDAI_MEMORY_ASSET_RETRY_COOLDOWN_MS`、
  `TDAI_MEMORY_KNOWLEDGE_ENDPOINT` 写进了 env 表，实际配了没有任何效果——因为
  插件拿到的是 `cordis.patch.yml` **透传进来的对象**，这四个键当时根本没在 patch 里。
  默认值恰好等于文档里写的值，所以"看起来是对的"。
- **修复**：`cordis.patch.yml` 补齐这四个键的 env 透传；并给
  `assetRetryCooldownMs` 换用允许 `0` 的解析函数（`0` = 不冷却，用原来那个
  "必须 > 0"的解析器会被悄悄换成默认值 15000，而设置面板是允许 0 的，两侧语义必须一致）。
- **测试**：`test/load.test.mjs` 新增护栏——`resolveConfig` 输出的每个配置键都必须在
  `cordis.patch.yml` 里有对应行，且 `assetRetryCooldownMs` 的 `0` / `'0'` / `''`
  三种输入语义正确。

#### 10. 子 agent 会话把父 agent 的记忆整套继承，并把执行过程写进长期记忆

- **现象**（实测本机数据）：派一个子 agent 时，子会话的 system prompt 与父会话**逐字节相同**
  （13020 字节），其中本插件的 4 个注入段占 **6093 字节（47%）**；子会话还会各自做一轮 L1 召回
  （实测 2 条、共约 4.4KB）。更严重的是回写：`captureEnabled` 是进程级开关，
  `agent/turn-stopping` 对任何会话都生效 —— 一个 23 步的调查子 agent 把 **37 条消息**
  （任务 prompt、整份 diff、测试原始输出、每条工具调用）写进了 L0，会被后台抽取当成
  "关于用户的记忆"。子 agent 的任务通常范围明确，这些内容对长期记忆是工作噪音。
- **根因**：本插件注册的 section 在**全局层**，`agent/pre-step` 与 `session/event` 监听是进程级的，
  子会话天然一并继承；插件此前不区分会话类型。
- **修复**：新增两个开关，**默认都对子 agent 关闭**——
  `subagentInjectionEnabled=false`（子会话不注入 4 个段、不做 L1 召回、不注册知识 skill、
  **不预热资产**；只读工具仍在）、`subagentCaptureEnabled=false`（子会话不回流）。
  判定用 DSH 的 durable 标记 `session.header.origin === 'subagent'`（`delegationDepth` 兜底），
  spawn 与 fork 两种子会话都覆盖；**缺 header 一律按父会话处理**（fail-open 到"维持现状"）。
  见 `lib/subagent.mjs`。
- **缓存代价（实测，非估算）**：改前 / 改后各一个真实子会话首请求的 usage 对比 ——
  system prompt 13020 → **6925 字节**，总 token 13748 → **10594**（−23%），
  其中**全价 token 2214 → 797**（−1417），缓存命中 11264 → 9728。
  也就是说：**关掉子会话注入并没有让它多付缓存差价**，反而每步更小更便宜
  —— 大额命中来自请求最前面的工具数组（38 个 schema，位置没动），而被删掉的 6093 字节
  根本不再计价；唯一失去命中的只有 DSH 自己的尾部段（约 500–800 tokens，位置前移导致）。
  （初版 CHANGELOG 曾估算为"约 3.3K tokens 的未命中差价"，那个算法把被删掉的字节也算进了未命中项，
  已按实测修正。完整账与修正留痕见 docs/prompt-design.zh-CN.md §3.4。）
- **附带收益**：子会话不再预热资产 —— 每个子会话省掉一整轮资产请求（扇出 N 个子 agent 就省 N 份）。
- **测试**：新增 `test/subagent.test.mjs`，每个用例**成对**断言"子会话降级 + 父会话照旧"
  （防止把父会话一起降级这类事故）；已做变异验证：把判定改成恒 true 或恒 false，测试都会红。

#### 11. 其它小修

- `/tdai-help` 里残留了一段**旧版 8 工具清单**，与新写的 10 工具清单重复（`lib/commands.mjs`）。
- `.gitignore` 补 `test/.tmp/`（设置卡片测试会在这里生成临时 ESM）。
- 提示词体积软基线 `test/prompt-budget.baseline.json` 仍是改造前的快照
  （`tdai:knowledge-tools` 记的是 4492，而当前是 307），已按新版重跑 `--save`。

### 变更

#### 提示词注入（读侧）

- **段名与 order 规范化**：统一 `tdai:` 前缀；order 改为**连号 520–523**
  （DSH 先比 order、相同才比 name，留间隔等于主动留出被别人插入的空间），
  落在 `deployment:persona(0)` 与 `plan:policy(500)` 之间的空闲带；
  运行时状态段走 `systemPrompt.context()` 通道（user 角色消息，order 560），**不进 system**。
- **`tdai:overview` 并入 `tdai:profile-memory`**：段数 5 → 4；两者讲的是同一件事，
  合并后资产加载失败时该段仍非空。
- **不再重复注入 persona**：`<session_context>` 不再注入 `agent.prompt` 全文
  （那份已由 DSH preset 的 `deployment:persona` 段注入，再注一遍是同样几千字发两次）。
- **团队知识 skill 化**：原先把「判据 + 资源清单 + curl 配方」整段常驻 system（4492 字节，
  **每轮付费**）。现在拆成三处：system 只留一行路由（307 字节）→ 完整判据与资源清单进
  DSH **runtime skill** `tdai-team-knowledge`（按需加载，3587 字节）→ 执行交给两个原生工具。
  会话开始时预取每个资源的 `tools/list` 并写进 skill 正文，模型加载 skill 的那一刻
  就拿到可用工具名与参数，省掉一次自发现往返。
- **`<knowledge_tools>` 不再出现租户/会话字面值**：旧实现把 `x-conversation-id: <session_id>`、
  `x-tdai-user-id: <userId>` 这类**实际取值**写进 prompt，导致同一实例下每个用户、每个会话
  渲染出的字节都不同，这段 system 前缀无法跨会话复用上游前缀缓存；现改为不随会话变化的
  占位说明。整块 curl 配方（`renderKnowledgeToolsBlock`）已**下线**，仅保留为对照参考。
- **注入通道按"字节稳定性"分工**：会话内不变的进 system（section），会话内会变的走
  `context` / `agent/pre-step`；`<memory-tools-guide>` 瘦身到 342 字节，场景清单逐条搬进
  工具 description（工具 schema 本来就要发给模型，写在那里不额外占 prompt 预算）。

#### 只读工具（8 → 10）

- 新增 `tdai_knowledge_tools`（列某资源可用工具）与 `tdai_knowledge_call`（执行只读查询，
  如 code-graph 的 `explore` / `search` / `callers` / `impact`，wiki 的 `search` / `read_page`）。
- `tdai_knowledge_call` **只接受当前会话已绑定**的 `knowledge_id`：模型凭空编一个 id
  直接拒绝，不会拿它去请求服务端。
- 知识服务在 code-graph 失败时仍回 `code=0`（错误放在 `data.isError`），已显式判定，
  不再把失败当成功结果。

#### 配置与设置面板

- 新增配置项：`recallTimeoutMs`、`assetLoadBudgetMs`、`assetRetryCooldownMs`、
  `knowledgeEndpoint`（面板 + env 双通道）。
- 设置卡片重排为三组（**读侧** / **写侧** / **身份与地址**）：4 个注入子开关缩进显示，
  被上层开关关掉时置灰并给出原因 tooltip；新增「单轮召回条数上限」数字输入
  （空串 = 回落 env/默认，1–20 之外按区间收敛并在保存结果里说明）；身份不全时在读侧那组
  下面直接点名缺哪些字段；数值字段统一归一化成 number 再提交（宿主 schema 是
  `z.natural()`，字符串会被直接拒绝）。
- `/tdai-status` 输出补全：身份来源（env / settings）、缺哪些字段、L3/L2/知识资源的
  装载情况、每个知识资源的工具清单是否预取成功。

#### 子 agent 会话

- 默认不继承读侧、不回流（两个开关见上一条修复）。面板新增「子 agent · 委派出去的子会话」分组，
  环境变量 `TDAI_MEMORY_SUBAGENT_INJECTION_ENABLED` / `TDAI_MEMORY_SUBAGENT_CAPTURE_ENABLED`。
- `/tdai-status` 现在会报告两个开关、以及**当前会话是不是子 agent 会话**（含委派深度与父会话），
  用来解释"开关明明开着却什么都没注入"。
- 子会话里调 `tdai_knowledge_call` 会得到可解释的提示（"本会话是子 agent 会话，读侧已降级"），
  而不是容易被误解成配置问题的"当前会话没有绑定团队知识资源"。

#### 文档

- README 拆成英文（`README.md`）与中文（`README_CN.md`）两个版本。
- 新增 `docs/prompt-design.zh-CN.md`：讲清本插件的提示词优化思路、缓存视角下的风险
  （含"装别的插件会改提示词、导致前缀缓存失效"），以及尚未解决的潜在问题。
- `docs/prompt-design.zh-CN.md` §3.4 记录子 agent 会话的实测账（含缓存对比），
  并在 §0 / §5 的自检清单里加入"子会话会不会继承这段内容"这一问。
- README 双语版都新增了「子 agent 会话」小节与两个新开关的 env 条目。
- `docs/prompt-injection-redesign.md` 保留为施工图（含全部决策记录与引用出处）。

### 测试

`npm test` 覆盖 16 个测试文件 + 14 处 `node --check`，全部通过（≈3s，无网络依赖；
涉及网关的两个用例起本地 HTTP 服务）。新增/接入的测试与它们锁定的行为：

| 测试文件 | 锁定的行为 | 类型 |
| --- | --- | --- |
| `test/smoke.test.mjs` | 各渲染纯函数的基本契约（含"不再注入 agent.prompt"） | 契约 |
| `test/load.test.mjs` | 10 个工具 / sections / 命令注册；`execute.length >= 2`；面板字段 ↔ `SCHEMA_KEYS`；**配置键 ↔ `cordis.patch.yml` env 透传** | 契约 + 回归护栏 |
| `test/recall.test.mjs` | pre-step 防御兜底、独立 plugin 消息形态、真人消息零改动、不阻塞主链路、空 messages 不注入 | 回归护栏 |
| `test/assets-budget.test.mjs` | 资产总预算封顶 / 失败冷却 / refresh 破冷却 / 并发幂等 / dispose 清理 / 知识地址改写 | 回归护栏 |
| `test/gateway-timeout.test.mjs` | 真 HTTP 卡死时 pre-step 与资产加载都有界返回；慢但可用时照常召回 | 回归护栏 |
| `test/sections.test.mjs` | section 注入端到端装配、开关降级 | 契约 |
| `test/section-registry.test.mjs` | 分带 / order 唯一 / 不占 DSH 保留 order / 占位 / context 通道 | 契约 + 回归护栏 |
| `test/capture-filter.test.mjs` | `source` 主判据、按块剥离兜底、缺 source 降级、模型消息必须保留 | 回归护栏 |
| `test/capture-normalize.test.mjs` | reasoning 丢弃 / L0 折叠 / skill 5-role / 失败轮不回流 | 回归护栏 |
| `test/tools-render.test.mjs` | `render(args, value)` 契约、拒绝文案可达、输出 schema 一致 | 回归护栏 |
| `test/knowledge-skill.test.mjs` | runtime skill 注册 / 描述路由 / 正文完整 / 幂等 / fail-open / cordis inject 语义 / 路由块瘦身 | 回归护栏 |
| `test/knowledge-tools.test.mjs` | 越权拒绝 / 参数透传 / `isError` 语义 / 缺参 / fail-open / schema / 会话解析 | 回归护栏 |
| `test/settings-card.test.mjs` | 字段 ↔ schema 一致、数值归一化、身份判定、**`client.js` 与 `client.card.tsx` 同源** | 回归护栏 |
| `test/settings-card-render.test.mjs` | 面板分组 / 条数上限输入框 / 依赖置灰矩阵 / 身份告警 | 契约 |
| `test/subagent.test.mjs` | 子会话判定、system 不注入、L1 不召回、不预热资产、不回流、知识工具可解释；**每个用例成对断言父会话照旧** | 回归护栏 |
| `test/prompt-budget.test.mjs` | 各注入块字节数硬上界（`tdai:knowledge-tools` ≤ 600 等）+ 软基线不增长 | 契约 |

**自动化测试覆盖不到的部分**（如实记录）：

- 召回块在 Web 前端的"一行折叠上下文注入"渲染（`form: 'notice'` → `ContextInjectionRow`）
  由 DSH 客户端实现，本仓库无法覆盖；本仓库只断言消息形态与 `source` 字段。
- 前缀缓存（prompt cache）的实际命中由服务端决定，测试只能保证"同一会话内渲染出的字节稳定"
  （`test/prompt-budget.test.mjs`）。命中数本身是可观测的：宿主把上游缓存字段归一化进 usage
  （DeepSeek 走 `prompt_cache_hit_tokens`），挂在 `assistant/message` 事件的
  `usage.cacheReadTokens` / `inputTokens` 上，会话日志里可读。插件的**代码**目前不读它——
  那属于 §"潜在问题"里的待办。
- 借入资产（`chat_memory-*` 绑定解析）与 meta 面依赖真实 MemoryCore 数据，
  测试里用夹具替代。

### 未发布 / 已知限制

- 设置面板里 `apiKeyEnv` / `l2Limit` / `timeoutMs` / `recallTimeoutMs` / `assetLoadBudgetMs` /
  `assetRetryCooldownMs` **刻意不上面板**（面板只放日常会调的项；`apiKeyEnv` 是"环境变量名"而不是
  凭据本身，放进面板只会让人把密钥误填进一个期望变量名的格子），只能用 env 配置。
  这六个键 = `lib/settings.mjs` 的 `PATCH_ONLY_KEYS`。
- `lib/capture.mjs` 的 `INJECTED_MARKERS` 只用于文档化与测试断言（真正的剔除逻辑在
  `lib/text.mjs` 的 `stripInjectedBlocks`），运行时不读它；`capture-filter` 用例 6
  断言"清单里的每个标记都必须真能被剥掉"。
- `docs/prompt-injection-redesign.md` §9 决策表第 4 行仍写着"L1 召回改成 prepend 语义"，
  该决定已在 §11 回退，**以 §11 为准**。
- 工具 schema（10 个 ≈6446 字节）尚未纳入 `test/prompt-budget.test.mjs` 的预算覆盖，
  后续加工具或改 description 时不会有红灯提醒。
- 子 agent 降级**不含工具**：10 个只读工具在子会话里仍然注册（约 6446 字节 schema）。
  要连工具一起对子 agent 收紧，用 DSH 原生的 `dsh-tool-subagent` 的 `toolFilter`
  （`tools.restrict()`）—— 那是部署级选择，且会让前缀在最前面分叉。

---

## [0.3.0] 及更早

0.3.0 之前的内容没有单独的 CHANGELOG 记录。历史版本可通过
`git log --oneline` 与 `git show <commit>` 查看；首个公开提交为
`e9ccc27 version 0.0.3`。
