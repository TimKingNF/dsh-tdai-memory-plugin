# 🧠 dsh-tdai-memory-plugin

[English](README.md) · **中文**

DeepSeek Harness 的 [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)
插件：在 DSH 会话内实现**上下文召回与注入**（读侧），并把每轮对话**旁路回流 MemoryCore**
做持久化（写侧）。

与 [DSH-TDAI-Memory-Adapter](https://github.com/Vocllum/DSH-TDAI-Memory-Adapter) 的关系：本项目
在其「自动 recall + turn 捕获 + 只读工具」的骨架上，把 MemoryProxy 的核心记忆能力（L2/L3 注入、
自有+借入 L1 召回、Skill/Knowledge 注入、session_context）以 **DSH 进程内原生方式**移植过来 ——
不需要 MemoryProxy 转发层，凭据不出进程。

> **当前版本 0.4.0** · 变更见 [CHANGELOG](CHANGELOG.md) · 文档：
> [提示词注入优化说明](docs/prompt-design.zh-CN.md) ·
> [改造施工图](docs/prompt-injection-redesign.md)

## ⚠️ 兼容性与测试范围

**本版本只在下面这个组合上验证过，其它版本组合未经验证。**

| 组件 | 已验证版本 | 说明 |
| --- | --- | --- |
| DeepSeek Harness（DSH） | **`0.1.2-rc.1`** | 发布时安装的版本 |
| [TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) | **`v2.0.1`** | MemoryCore / MemoryKnowledge HTTP API |

为什么要写死版本：

- 读侧绑定的是 DSH 的内部契约：`systemPrompt.section()` / `systemPrompt.context()`、
  `system-prompt/assemble` waterfall、`agent/pre-step` waterfall、`skills.register()`、
  `tools.register()`（含 `render(args, value)` 输出投影）与 `settings.register()`。
  DSH 重构其中任何一处都会改变插件行为。
- 段 **order 分带**（500–599）是对着 DSH `SECTION_ORDERS` 表的**本地副本**断言的
  （`test/section-registry.test.mjs`）。DSH 升级若调整了那张表，测试**不会自动变红** ——
  需要有人手工同步副本，否则插件可能悄悄占到保留位。
- 召回与回流调用 MemoryCore 的 `/v3/*` HTTP API（`/v3/core/read`、`/v3/scenario/ls`、
  `/v3/skill/listing`、`/v3/knowledge/list`、`/v3/atomic/search`、`/v3/meta/*`、
  `/v3/conversation/add`、`/v3/skill/conversation/add`）与知识服务
  （`{service_url}/tools/list`、`{service_url}/tools/call`），Core 版本升级同样可能改动这些 schema。

## 功能

### 读侧（`enabled` 总开关）

全部通过 **DSH 原生接口**注入，不改写请求体（详见
[docs/prompt-injection-redesign.md](docs/prompt-injection-redesign.md)）。

| 注入块 | 通道 | DSH 接口 | order | 内容 |
| --- | --- | --- | --- | --- |
| `tdai:session-context` | system section | 同上 | 520 | agent / task 身份（**不含 persona 全文**，那份由 preset 注入） |
| `tdai:profile-memory` | system section | 同上 | 521 | 插件总述 + L3 画像 + L2 场景索引 + 记忆工具总纲 |
| `tdai:available-skills` | system section | 同上 | 522 | 云端 skill **补充**目录（原生目录由 DSH 自己发） |
| `tdai:knowledge-tools` | system section | 同上 | 523 | 团队知识资源的**一行路由**（默认关） |
| `tdai-team-knowledge` | DSH runtime skill | `skills.register` | — | 完整判据 + 资源清单 + 工具清单，**按需加载** |
| `tdai:state` | runtime context | `systemPrompt.context` | 560 | 运行时状态快照，作为 **user 角色消息**进消息列表，不进 system |
| `<tdai_recalled_l1_memories>` | pre-step | `agent/pre-step` | — | L1 召回：一条**独立**的 plugin 消息（`form: 'notice'`），紧跟本轮真人消息之后；真人消息正文一个字节都不动 |

数据来源：`/v3/core/read`（L3）、`/v3/scenario/ls`（L2）、`/v3/skill/listing`（skill）、
`/v3/knowledge/list`（knowledge）、`/v3/atomic/search`（L1 召回）、`/v3/meta/*`（agent/task 详情）。

**子 agent 会话（DSH 派出去的子会话）默认不继承以上任何一项**，见
[子 agent 会话](#子-agent-会话默认读侧关写侧关)。

**L1 召回为什么不写进用户那条消息**：宿主要在 `agent/pre-step` 之后把
`decision.messages` **原样持久化**（`dsh-agent-loop` 的 `session.append("user/message", …)`）。
如果把召回块 prepend 进真人消息，那段内容就会永久留在"用户发言"里 —— 前端把它当用户输入回显、
回写 L0 只能靠文本哨兵裁剪、任何按 `source.kind === 'user'` 判真人发言的地方都会误判。
所以召回块走独立消息：正文干净、`source.kind === 'plugin'` 让回写整条丢弃、前端渲染成一行
可折叠的"上下文注入"（不塞进用户气泡）。

**段 order 为什么连号**：DSH 先比 order、order 相同才比 name。插件各段用连号（520–523），
别人只能插在整块之前或之后，不会把 TDAI 内容切成两半。

**为什么有的块进 section、有的走 context/pre-step**：判据是"同一会话内字节会不会变"。
会变的（L1 召回）绝不进 system —— system 是前缀，抖一次就打穿上游的前缀缓存。
详见设计文档 §5.3。

### 团队知识为什么做成 skill

wiki / code-graph 的「判断依据 + 资源清单 + curl 配方」原来整段常驻 system（4.4KB），
**每一轮都要付费**，而多数轮次根本用不到。现在拆成两半：

| 部分 | 位置 | 何时进上下文 | 体积 |
| --- | --- | --- | --- |
| 有哪些资源、什么场景该用 | `tdai:knowledge-tools`（system section） | 每轮 | ~300 字节 |
| 完整判据 + 资源清单 + **可用工具清单** | `tdai-team-knowledge`（DSH runtime skill） | **模型主动加载时** | ~3.6KB |
| 工具调用方式 | `tdai_knowledge_tools` / `tdai_knowledge_call`（原生工具 schema） | 工具目录里 | — |

三件事分别落在三个地方，各司其职：

1. **system** 只留一行路由（有哪些资源、要跨文件信息就去加载 skill）；
2. **skill 正文** 承载判据与资源清单 —— 会话开始时插件会预取每个资源的 `tools/list`
   并写进正文，所以模型**加载 skill 的那一刻就拿到了可用工具名与参数**，省掉一次自发现往返；
3. **原生工具** 负责执行：schema 由宿主校验，端点与租户请求头由插件处理，模型不用记 URL。

实现用 `ctx.skills.register()`（DSH 运行时 skill）注册，所以它和 DSH 自带的 skill 走同一套
机制：目录只带 name + description，宿主负责摘要去重，正文用 `skill` 工具加载。

实测：4 个 system 注入段从 **9953 → 5768 字节**（-42%）。但常驻总量要如实看：同版本工具
schema 从 2774 → 6446 字节（新增 2 个知识工具 + 记忆工具描述扩写），**常驻合计 12727 → 12214
字节（-4%）**；真正的收益是结构性的——4.4KB「每轮付费、多数轮用不到」的内容，变成了 307 字节
路由 + 3.6KB 按需加载的 skill 正文。完整账目见
[docs/prompt-design.zh-CN.md](docs/prompt-design.zh-CN.md) §0。

只有 `knowledgeEnabled=true` 且当前 agent 确实绑定了知识资源时才注册 skill。

### 只读工具 ×10

- 语义检索：`tdai_memory_search`（L1 原子记忆）、`tdai_conversation_search`（L0 对话原文）、
  `tdai_skill_search`（团队 Skill）
- 结构化查询：`tdai_memory_query`（L1 按 type/时间/分页）、`tdai_conversation_query`（L0 按 session/时间/分页）
- 资源读取：`tdai_read_scene`（L2 场景全文）、`tdai_scenario_ls`（L2 场景列表）、
  `tdai_skill_view`（Skill 全文 + manifest）
- 团队知识：`tdai_knowledge_tools`（列某资源可用工具）、`tdai_knowledge_call`（执行只读查询，
  如 code-graph 的 `explore` / `search` / `callers` / `impact`，wiki 的 `search` / `read_page`）

`tdai_knowledge_call` 只接受**当前会话已绑定**的知识资源 id：模型若凭空编一个 id，
工具直接拒绝，不会拿它去请求服务端。

### Slash 命令 ×4

| 命令 | 作用 |
| --- | --- |
| `/tdai-sync` | 刷新当前会话的记忆资产缓存（session_context / L2L3 / Skill / Knowledge） |
| `/tdai-status` | 查看插件状态（身份来源、开关、已加载资产、知识工具清单是否预取成功） |
| `/tdai-archive` | 立即归档当前会话，触发后台 Skill 提取（对应 proxy 的 `mem:create-skill`） |
| `/tdai-help` | 命令与工具速查 |

### 写侧（`captureEnabled`，独立开关）

- 每轮真人对话结束：`/v3/conversation/add`（L0 短期记忆）+ `/v3/skill/conversation/add`（Skill 归档触发）
- 对齐 proxy：单条 >8192 code units 分片（surrogate 安全）、100 条/批、同 session 串行
- 自动剔除插件注入的召回块，避免污染记忆
- L1/L2/L3 提取由 MemoryCore 后台异步完成

**两套投影（对齐 MemoryProxy）**：两个端点的 schema 不同，所以同一轮消息按端点各投影一次
（`lib/normalize.mjs`）：

| 端点 | role | 工具怎么表示 |
| --- | --- | --- |
| `/v3/skill/conversation/add` | user / assistant / `tool_call` / `tool_result` / system | 独立消息 + `tool_call_id` 配对锚点 |
| `/v3/conversation/add`（L0） | 只有 user / assistant | 折叠成 `[tool_call] name(args)` / `[tool_result:name] …` |

- **内部思考（`reasoning`）与图片一律丢弃**，对齐
  `MemoryProxy/src/skill/normalize-conversation.ts`。reasoning 与可见回复在 DSH 里
  同属一条 assistant 消息的 content 数组，早先会被一起写进 L0（实测一轮 32 条里
  31 条是思考原文），而 L0 是 L1/L2/L3 抽取的唯一输入 —— 思考噪音会污染长期记忆。
- **失败轮不回流**：宿主只在成功路径派发 `agent/turn-stopping`，模型报错 / 被 abort /
  被 pre-step reject 的轮次走不到那里。插件在 `agent/error` 与 `turn/end` 上兜底：
  记日志 + 清缓冲，但**不写记忆** —— 半轮对话进 L0 只会被后台抽取当成"完整的一轮"消费。

### 子 agent 会话（默认：读侧关、写侧关）

DSH 派子 agent（`subagent` / `subagent_fork` 工具）时，子会话会继承本插件注册在全局层的
section，并且同样触发进程级的监听。默认配置下的实测后果：

- 子会话的 system prompt 与父会话**逐字节相同**（13020 字节，其中我们的 4 个段占 6093 字节 = 47%），
  并且会各自做一轮 L1 召回（实测 2 条、约 4.4KB）；
- 由于 `captureEnabled` 是进程级开关，一个 23 步的调查子 agent 往 L0 写了 **37 条消息**
  （任务 prompt、整份 diff、测试原始输出、每条工具调用）——后台抽取会把这类工作噪音
  当成"关于用户的记忆"。

所以插件现在默认对子会话退让：

| 开关 | 默认 | 对子会话的效果 |
| --- | --- | --- |
| `subagentInjectionEnabled` | **关** | 不注入 system 段、不做 L1 召回、不注册知识 skill、不预热资产；10 个只读工具仍在 |
| `subagentCaptureEnabled` | **关** | 子会话的对话不回流 MemoryCore |

判定用 DSH 的 durable 标记 `session.header.origin === 'subagent'`（`delegationDepth > 0` 兜底），
spawn 与 fork 两种子会话都覆盖；**缺 header 一律按顶层会话处理**（fail-open 到"维持现状"）。
`/tdai-status` 会报告这两个开关，以及当前会话是不是子 agent 会话。

**缓存说明（实测，非估算）**：对比改动前后各一个真实子会话的第一步请求 ——
system prompt 13020 → **6925 字节**，单次请求总 token 13748 → **10594**（−23%），
其中**全价 token 2214 → 797**，缓存命中 11264 → 9728。也就是说：**关掉子会话注入不会让它
多付缓存差价** —— 大额命中来自请求最前面的工具数组（38 个 schema，位置没动），
而被删掉的 6093 字节根本不再计价；唯一失去父缓存的只有 DSH 自己的尾部段
（约 500–800 tokens，因为位置前移）。如果你用 DSH 原生的 `dsh-tool-subagent` 的
`persona` / `toolFilter` 定制子 agent，前缀本来就最先分叉。
完整账目见 [docs/prompt-design.zh-CN.md](docs/prompt-design.zh-CN.md) §3.4。

### 通用

- **fail-open**：Gateway 任何故障只记日志，不阻断 DSH
- **会话级资产缓存**：session-start 预热 + pre-step 懒加载兜底；section 同步读缓存，首轮即可注入
- **静态身份**（单人场景），不做多用户与 auth/verify

## 安装

```bash
cd dsh-tdai-memory-plugin
npm install          # 拉 schemastery（settings schema 依赖）
npm run build:client # 构建 Web 设置卡片 bundle（client.js）

dsh plugin --profile web add ./dsh-tdai-memory-plugin
# 重启目标 profile 生效
```

## 配置

### 方式一：Web 设置面板（推荐，快捷切换）

「设置 → 插件 → TDAI Memory」卡片，可即时切换：

- **读侧**：读侧总开关、L1 自动召回（含**单轮召回条数上限**）、System prompt 注入，以及注入下的 4 个段
- **写侧**：对话回流（独立于读侧）
- **子 agent**：子会话是否继承读侧、是否回流（默认都关）
- **身份与地址**：MemoryCore 地址、实例 ID、Team / Agent / User / Task ID、User Key、
  知识服务地址改写

开关的依赖关系（卡片上按同一层级分组、置灰显示"暂不生效"）：

```
读侧总开关 enabled ──┬─ L1 自动召回 recallEnabled（上限 recallLimit，1–20）
                     ├─ System prompt 注入 injectionEnabled
                     │    ├─ 会话上下文 sessionContextEnabled
                     │    ├─ 长期记忆   profileMemoryEnabled
                     │    ├─ Skill 列表 skillsEnabled
                     │    └─ 知识库     knowledgeEnabled
                     └─ 只读工具（无独立开关）

写侧总开关 captureEnabled —— 独立，既不受 enabled 也不受 injectionEnabled 约束

子 agent 会话（按会话判定，不受上面开关影响）
  subagentInjectionEnabled —— 子会话是否继承读侧   默认关
  subagentCaptureEnabled   —— 子会话是否回流       默认关
```

三个容易踩的点：

1. **`injectionEnabled` 只管 system prompt 的那 4 个段**，关掉它**不影响** L1 召回；
2. **回流不依赖读侧**：读侧全关时仍照常把对话写回 MemoryCore（capture-only）；
3. **身份不全是读侧失效的头号原因**（`readEnabled = enabled && 身份齐全`）：卡片会在读侧那组下面点名缺哪些字段。

开关即时生效；身份字段变更后**新会话**生效（已有会话的注入缓存不变）。留空文本框 = 回落到 env；
「单轮召回条数上限」留空则回落到 env / 默认 5，填 1–20 之外的数字会按区间收敛并在保存结果里说明。

### 方式二：env

```bash
# ── 必填身份 ──
export TDAI_MEMORY_INSTANCE_ID=default      # memory 实例 id（x-tdai-service-id / space_id）
export TDAI_MEMORY_TEAM_ID=team-xxx
export TDAI_MEMORY_AGENT_ID=agt-xxx
export TDAI_MEMORY_USER_ID=usr-xxx
export TDAI_MEMORY_API_KEY=...              # serviceToken（Bearer，仅 env，不进设置面板）

# ── 推荐 ──
export TDAI_MEMORY_USER_KEY=sk-mem-xxx      # meta 面（agent/task 详情、借入资产）；缺省则借入与 session_context 降级
export TDAI_MEMORY_TASK_ID=task-xxx         # 可选：session_context [Task] 段 + 回流归属

# ── 开关 ──
export TDAI_MEMORY_ENABLED=true             # 读侧总开关：召回 + 注入 + 工具
export TDAI_MEMORY_CAPTURE_ENABLED=true     # 回流（写侧），独立于读侧全部开关
export TDAI_MEMORY_RECALL_ENABLED=true      # L1 自动召回
export TDAI_MEMORY_INJECTION_ENABLED=true   # system prompt 注入总闸（只管下面 4 个段）
export TDAI_MEMORY_SESSION_CONTEXT_ENABLED=true
export TDAI_MEMORY_PROFILE_MEMORY_ENABLED=true
export TDAI_MEMORY_SKILLS_ENABLED=true
export TDAI_MEMORY_KNOWLEDGE_ENABLED=false  # 团队知识资源注入，默认关

# ── 子 agent（子会话）──
export TDAI_MEMORY_SUBAGENT_INJECTION_ENABLED=false  # 子会话是否继承读侧（默认关）
export TDAI_MEMORY_SUBAGENT_CAPTURE_ENABLED=false    # 子会话是否回流（默认关）

# ── 调参 ──
export TDAI_MEMORY_ENDPOINT=http://127.0.0.1:8420
export TDAI_MEMORY_RECALL_LIMIT=5           # L1 合并 top-K（1–20，面板里也可改）
export TDAI_MEMORY_L2_LIMIT=3               # L2 场景索引条数
export TDAI_MEMORY_TIMEOUT_MS=5000          # 单个 HTTP 请求超时
export TDAI_MEMORY_KNOWLEDGE_ENDPOINT=http://127.0.0.1:8424  # 改写知识服务 service_url 的 origin

# ── 主链路保护（别调大到"发消息会一直等"的程度）──
export TDAI_MEMORY_RECALL_TIMEOUT_MS=3000   # L1 检索硬超时：超时即放弃本轮召回
export TDAI_MEMORY_ASSET_LOAD_BUDGET_MS=5000  # 整包资产（meta+L3/L2+skill+knowledge）加载总预算
export TDAI_MEMORY_ASSET_RETRY_COOLDOWN_MS=15000  # 加载失败后的冷却期：期内不重试（0=每次重试）
```

配置优先级：**Web 设置 > env > 内置默认值**。身份不完整时读侧自动停用并告警，写侧不受影响；
`TDAI_MEMORY_API_KEY` 只从 env 读取，不写入设置面板。

**三个"主链路保护"参数说明**：读侧对 MemoryCore 的调用全部发生在模型请求**之前**
（`system-prompt/assemble` 注入资产、`agent/pre-step` 召回），网关慢或挂时如果无限等、
或者失败了每一步都重拉一次，用户看到的就是"一开召回，发消息一直阻塞等待"。
因此：资产加载有**总预算**（超预算按失败降级，缺 L2/L3/Skill 也照常回答）、
失败后有**冷却期**（不逐步重试）、召回检索有**硬超时**（超时少一次召回而不是卡住这一轮）。

**`TDAI_MEMORY_KNOWLEDGE_ENDPOINT` 说明**：`/v3/knowledge/list` 返回的 `service_url` 是
**服务端视角**的地址，容器化部署里常见 `http://host.docker.internal:8424/v3`，插件进程跑在
宿主上时不可达（现象：`fetch failed` → `tools/list` 全空 → skill 正文只剩"可用工具：未取到"）。
配置本项后只替换 scheme/host/port，**path 原样保留**；填了非法 URL 会回落原地址，不会把整包
资产加载拖成失败。

## 与 MemoryProxy 的差异（有意为之）

- **无代理层**：不转发 LLM 流量，不做限流/计费/存储抽象——那些是 proxy 基础设施，不属于插件职责
- **无 auth/verify**：数据面接受显式身份，meta 面用 `x-tdai-user-key`，静态身份下 verify 不必要
- **无 ACL 过滤**：借入资产来自本人 agent 绑定，单用户场景不做 acl/check（proxy 的 fail-closed 设计面向多用户）
- **工具原生注册**：替代 skill-bridge/memory-bridge 的 curl 方案，serviceToken 不进 prompt
- **无 session-init 表单**：静态身份下跳过 team/agent/task 选择流程

## 身份的语义（重要）

**一个 dsh 进程只对应一个 TDAI 身份。** 身份来自 `TDAI_MEMORY_*` 环境变量或 Web 设置面板
（面板优先），在插件加载时确定一次；`session_id` 每次调用时从当前会话取。

这是有意为之：proxy 的"每个会话选 Team/Agent/Task"表单，是它作为**多用户网关**才需要的能力；
本插件是 DSH 进程内的单用户组件，静态身份是更自然的形态。需要多身份时，换进程或改配置。

用 `/tdai-status` 可以确认当前生效的身份、它的来源（env / settings）、以及缺哪些字段。

## 开发

```bash
npm install
npm run build:client   # 修改 client.card.tsx 后重新打 client.js
npm test               # 语法检查 + 纯函数/接线测试（不依赖网络）
```

测试套件就是发版闸门。动提示词内容前，有两个护栏需要知道：

- `test/prompt-budget.test.mjs` —— 每个注入块的**字节硬上界** + 软基线
  （有意改动后跑 `node test/prompt-budget.test.mjs --save` 重记基线）；
- `test/section-registry.test.mjs` —— 断言插件的 order 分带不与 DSH 保留 order 撞车
  （DSH 的 order 表在这里是**本地抄本**，升级 DSH 后要手工同步）。

## 文档

| 文档 | 语言 | 内容 |
| --- | --- | --- |
| [CHANGELOG.md](CHANGELOG.md) | 中文 | 版本变更；0.4.0 逐条列出修复、根因与覆盖它的测试 |
| [docs/prompt-design.zh-CN.md](docs/prompt-design.zh-CN.md) | 中文 | 提示词注入的优化思路、缓存视角下的风险（含"装别的插件会改提示词 → 前缀缓存失效"）与尚未解决的潜在问题 |
| [docs/prompt-injection-redesign.md](docs/prompt-injection-redesign.md) | 中文 | 改造施工图：每一条决策、每一处对 DSH / 插件 / proxy 源码的引用 |

## License

MIT
