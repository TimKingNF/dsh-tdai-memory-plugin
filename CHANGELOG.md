# Changelog

本文件记录 dsh-tdai-memory-plugin 的版本变更。格式参考
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> **测试范围声明（0.4.0）**：本版本只在 **DeepSeek Harness `0.1.2-rc.1`** 与
> **TencentDB-Agent-Memory `v2.0.1`** 上做过验证。其它 DSH / MemoryCore 组合未验证，
> 尤其 DSH 的 `SECTION_ORDERS` 表与 `agent/pre-step`、`system-prompt/assemble` 的契约
> 变化会影响本插件的注入行为（见 README「兼容性与测试范围」）。

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
这一项与其它修复一样做了真机验证，数据见 [现场验证](#现场验证真实环境2026-09-16)。

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
- **现场验证**：修好后重启 dsh 复跑 code-graph 召回，失败态命中 0 次。

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
- **现场验证**：修好后复跑 code-graph 召回，失败态命中 0 次。

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

**只有现场验证、没有自动化测试的部分**（如实记录）：

- 召回块在 Web 前端的"一行折叠上下文注入"渲染（`form: 'notice'` → `ContextInjectionRow`）
  由 DSH 客户端实现，本仓库无法覆盖；本仓库只断言消息形态与 `source` 字段。
- 前缀缓存（prompt cache）的命中情况**不能靠自动化测试覆盖**，但它是**可观测**的：
  宿主把上游缓存字段归一化进 usage（DeepSeek 走 `prompt_cache_hit_tokens`），挂在
  `assistant/message` 事件的 `usage.cacheReadTokens` / `inputTokens` 上，会话日志里可读。
  本版就是用它做了改前/改后的对比，见 [现场验证](#现场验证真实环境2026-09-16)。
  （插件的**代码**目前不读它——那属于 §"潜在问题"里的待办。）
- 借入资产（`chat_memory-*` 绑定解析）与 meta 面依赖真实 MemoryCore 数据，
  测试里用夹具替代。

### 现场验证（真实环境，2026-09-16）

自动化测试证明不了"改动在真宿主里生效"。关键改动都在真机上复核过，方法是：
重启 dsh 载入新代码 → 派真实子 agent → 读该会话的日志
（`~/.dsh/sessions/<工作区>/<session-id>/session.jsonl.zstd` 里的 `request/header.system`
与 `user/message` 事件）→ 再用 `tdai_conversation_query` 回查 L0 是否真的没写进去。

#### 1. 子 agent 降级（改前 `ed881f4d`，23 步 ／ 改后 `60453b0d`，3 步）

| 检查项 | 改前 | 改后 |
| --- | --- | --- |
| 子会话 `system` | 13020 字节，与父会话**逐字节相同** | **6925 字节** |
| `<session_context>` | 有 | **无** |
| `<tdai_profile_memory>`（4811 字节） | 有 | **无** |
| `<memory-tools-guide>` / `<knowledge_tools>` | 有 | **无** |
| `TDAI memory 状态` 快照消息 | 863 → 1247 字节 | **无** |
| `<tdai_recalled_l1_memories>` | 2 条 | **0 条** |
| L0 回流 | **37 条** | **0 条**（`tdai_conversation_query` → `total: 0`） |
| **父会话**（本会话） | 注入正常 | **注入正常**（13033 字节、四段齐全；L0 累计 178 条） |

顺带拿到本版第一份真实的缓存账（子会话**第一步请求**的 usage）：

| | 改前 | 改后 |
| --- | --- | --- |
| 总 token | 13748 | 10594（−23%） |
| 缓存命中 `cacheRead` | 11264 | 9728 |
| **全价 `inputTokens`** | 2214 | **797** |

⚠️ **口径**：两个子会话自身的消息体量不同（任务 prompt 3463 字节 vs 634 字节，改前还多一条
2.3KB 的召回块），所以"总 token −3154"是"不注入 + 不召回"的**整体**效果，不要逐项归因。
另：本版初稿曾估算"关掉注入会让子会话首次请求多付 ≈3.3K 未命中 token"，**实测证伪** ——
那个算法把被删掉的 6093 字节也算进了未命中项，而删掉的内容根本不会被发送、也就不会被收费。
修正留痕见 [docs/prompt-design.zh-CN.md](docs/prompt-design.zh-CN.md) §3.4。

#### 2. 代码图谱召回（09-15，对应修复 2 与 7）

修完"工具取错会话"与"知识 `tools/list` 预取失败"后重启 dsh 复跑 code-graph 召回：
**失败态命中 0 次**——改前是"注入显示已绑定 1 个知识资源，工具连续 4 次回未绑定"，
现在注入与工具返回一致。

### 未发布 / 已知限制

- 设置面板里 `l2Limit` / `timeoutMs` / `recallTimeoutMs` / `assetLoadBudgetMs` /
  `assetRetryCooldownMs` **刻意不上面板**（面板只放日常会调的项），只能用 env 配置。
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
