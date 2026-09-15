# 提示词注入改造方案（定稿 v2）

> 本文是施工图。**每一处结论都标注了可追溯的出处**，格式为 `仓库相对路径:行号`。
> 涉及的三个代码库：
>
> - `DSH` = `<dsh-install>/`
>   内部包在 `node_modules/@deepseek-ai/<包名>/`，下文省略这个前缀，直接写 `dsh-system-prompt/lib/index.js`。
> - `PLUGIN` = 本仓库 `<repo>/`
> - `PROXY` = `<tdai-repo>/MemoryProxy/`

---

## 0. 本版相对上一版的变更

依据你的三条回答：

| 你的决定 | 方案变化 |
| --- | --- |
| proxy 后续**完全绕开**，插件就是它的替代品，直接对 MemoryCore 读写 | 方案从"插件 + proxy 共存、各自修正注入"改为**插件是唯一所有者**；同时**新增两个必须解决的新问题**：身份从哪来（§6）、写回路径复核（§6.3） |
| L1 召回**由插件开关决定** | 保留 `agent/pre-step` 通道，不再讨论"下线"；但要把代价写进开关语义（§5.3） |
| wiki / CodeGraph / 云端 SKILL **先继续用 curl 文本指引** | `<knowledge_tools>` 保留现状，只做一处缓存修正（§5.6）；"注册成 DSH 工具"列为后续独立阶段（§8） |

另外有两处是上一版遗漏、这一版补上的：

- 旧的静态 section 名叫 `tdai-memory`（`PLUGIN/lib/sections.mjs:52`，改造前），与 settings 命名空间**同名**。DSH 的 section 是独立名字表，两者不冲突，但同名会让日志和排查时无法区分，本版一并拆分（§5.2）。
- `<knowledge_tools>` 的渲染里把 5 个请求头的**字面值**写进了 prompt（`PLUGIN/lib/prompts.mjs:243-246`）——这是会话内稳定的，但同一 memory 实例被多个用户共用时会导致每次会话的 system 字节不同。本版列为缓存修正项（§5.6）。

## 0.1 第二轮修订（你已拍板）

> ⚠️ **2026-09-15 复修**：下表**第 3 条（L1 召回 prepend 语义）已回退** —— 实测发现
> prepend 会把召回块永久写进"用户发言"，前端回显与回写都跟着变形。现改为
> **独立 plugin 消息（`form: 'notice'`）**，同时给主链路加了三道硬闸门。
> 完整依据、日志证据、护栏测试见 **§11**。读本文其余部分时请以 §11 为准。

| # | 你的决定 | 落地位置 |
| --- | --- | --- |
| 1 | 身份方案**选 A**（静态身份）；回写路径按设计建议做**更健壮** | §6.1、§6.3、阶段 5 |
| 2 | 段 order 更**紧凑**，避免被其他插件插入切开 | §5.1（order 改为 **520–523 连号**）、阶段 1 |
| 3 | ~~L1 召回**改成 prepend 语义**，与 proxy 原版一致~~ → **已回退为独立消息** | ~~§5.3、阶段 4~~ **§11** |
| 4 | `tdai:overview` 静态段**按建议调整**（并入 `tdai:profile-memory`） | §5.2、阶段 1 + 阶段 2 |
| 5 | `MEMORY_TOOLS_GUIDE` 瘦身**可接受** | §5.5、阶段 2 |

**第 3 条带来一个新冲突，本版已解掉（记在这里，避免以后有人踩）：**

prepend 是把召回内容**插进"真人发的那条 user 消息"里**，而那条消息的 `source` 是 `{ kind: 'user' }`——没法再兼容地标注"其中一段是注入的"。于是"按 `source` 做回写过滤"这条更健壮的做法，会被 prepend 削弱。

**解法（现在只剩一条主判据，§11 之后）**：

- **`source` 通道（唯一主判据）**：插件注入的独立消息一律带
  `source: { kind: 'plugin', plugin: 'dsh-tdai-memory-plugin', ... }`，回写按
  `source.kind/plugin` 过滤。L1 召回块现在也走这条通道，不再需要"靠文本猜"。
- **文本哨兵降级为兜底**：只为**存量**历史消息（prepend 时代写下的正文）和丢失
  `source` 的外部文本服务；`test/capture-filter.test.mjs` 用例 3/3b 继续锁住它。

---

## 1. 名词表（DSH 术语 → 你熟悉的概念）

这一节是给"没写过 agent 插件"的人准备的。后面所有章节都建立在这些概念上。

| DSH 术语 | 一句话解释 | 类比 |
| --- | --- | --- |
| **插件（Plugin）** | 一个导出 `apply(ctx, config)` 的模块。挂进 DSH 后，它能往各种注册表里加东西 | Spring 里的 `@Component` + `BeanPostProcessor` |
| **ctx** | 插件拿到的运行时句柄，所有能力都从它上面取（`ctx.tools`、`ctx.systemPrompt`…） | 一个服务容器 / `ApplicationContext` |
| **section（提示词段）** | system prompt 里的一个**具名片段**。名字唯一，带一个数字 `order` | 一条带 `@Order` 的 `HandlerInterceptor`；order 就是排序权重 |
| **assemble（装配）** | DSH 每一步（step）向模型发请求前，把所有 section 按 order 拼成完整 system prompt 的过程 | 请求前把所有拦截器的输出拼成报文 |
| **waterfall（瀑布）** | DSH 的钩子机制：注册的回调按序串成一条链，每个回调拿到 `next()`，自己决定要不要 `await next()` 继续往下 | Servlet Filter 链 / Koa 洋葱模型 |
| **agent/pre-step** | 一步模型调用**发起前**的 waterfall。能拿到本轮消息列表，返回 `{kind, messages}` 决定真正发什么 | 请求链路最外层的 Filter |
| **runtime context（运行时快照）** | 一条**角色为 `user` 的消息**（详见 §1.1），不是 system 文本。它混在消息列表里表达"当前状态" | 随请求携带的上下文 Header，而不是写死在配置文件里 |
| **tool（工具）** | 模型能调用的函数。DSH 会把**真正的 JSON Schema**发给模型，不是让模型去敲命令 | RPC 接口定义 / OpenAPI schema |
| **skill（技能）** | 一段可被加载的说明文档（SKILL.md）。DSH 会先把**目录**告诉模型，模型再按名加载全文 | 可热加载的插件文档 |
| **KV cache / 前缀缓存** | 上游模型服务对"与上一轮完全相同的前缀"做缓存复用，前缀一旦有个字节变了，从变化处往后全部重算 | HTTP 层的 `ETag` / CDN 缓存；改一个字符，整份响应缓存失效 |
| **token 计量** | 宿主按它**实际发出的请求**统计上下文占用、压缩阈值、成本 | 计费网关按它看到的报文计费 |

### 1.1 「user 角色」到底是什么（必读，最容易理解错的一节）

**它不是"人类说的话"。** 它指 LLM 对话 API 里消息的四种角色之一：

| role | 谁产生 | 本会话里对应什么 |
| --- | --- | --- |
| `system` | 宿主 | 所有 section 拼出来的 system prompt |
| `user` | **宿主或插件也能造** | 你敲的那句话，**以及** runtime context 快照、skill 目录 |
| `assistant` | 模型 | 回复、工具调用 |
| `tool` | 工具 | bash / read 的执行结果 |

依据：`dsh-llm/lib/types/message.d.ts:118-124`，`Message.role` 只有 `'system' | 'user' | 'assistant'` 三个值——**没有第四种**。所以 DSH 要表达"当前沙箱策略/审批策略"这类动态状态时，没有 system 之外的专用通道，只能造一条 `role: "user"` 的消息。

**完整链路（从后往前读最清楚）：**

1. **造消息** —— `dsh-agent-loop/lib/index.js:65-88` 的 `RuntimeContextProjection.project()`：

```js
project(current, sections) {
    if (this.retained === void 0 && current.length === 0) return;
    const snapshot = current.length === 0 ? CLEARED : current;
    if (this.retained?.text === snapshot) return;        // ← 内容未变 → 返回 undefined，本步不追加
    return createUserMessage({                            // ← 造一条 user 消息
        content: [{ type: "text", text: snapshot }],
        source: { kind: "plugin", plugin: SOURCE, form: "snapshot", sections }
    });
}
```

`createUserMessage` = `{ ...input, role: "user" }` + deep-freeze + 唯一 id（`dsh-llm/lib/types/message.js:34-47`）。

2. **进本轮消息列表，且排在已有消息之前** —— `dsh-agent-loop/lib/index.js:506-513`：`messages: context === void 0 ? claimed : [...claimed, context]`。插件（如 `dsh-tool-skill`）追加的内容排在 `claimed` **之后**。

3. **落盘成持久历史** —— `dsh-agent-loop/lib/index.js:560`：`this.session.append("user/message", message, { surfaceOp: "append" })`。`session.append` 把整条消息（**含 `source`**）快照进 append-only 日志（`dsh-session/lib/index.js:1403-1422`）。

**三条实现约定：**

- **(a) 变了才追加。** `project()` 有 `if (this.retained?.text === snapshot) return;` 的去重，并追踪上一条自己造的 context 消息是否仍可见（`:40-59`）。context 变空时发 `CLEARED`（`:19`：`"Current runtime context: none. Earlier runtime-context snapshots no longer apply."`）。**任何走这条通道的插件都要遵守同样约定**，否则每步都多一条消息。
- **(b) 靠 `source` 区分来源，不靠文本。** `source.kind` 取值（`dsh-llm/lib/types/message.d.ts:94-104`）：`'user'`（真人）/ `'plugin'`（插件，带 `plugin` 包名）/ `'model'` / `'tool'`（带 `callId`）。`form` 是**内容形态**语义枚举（`:42-54`）：`instructions` / `catalog` / `snapshot` / `notice` / `relay` / **`recall`**。其中 `recall` = "从别处会话日志摘来的材料"——**语义上正是 L1 召回的形态**。
- **(c) 模型看不见 `source`。** 它是给宿主（日志、UI、回写过滤）用的元数据，发往上游时被剥掉。**开头那句话是模型唯一的信号**，必须写清"这是什么、与别的东西什么关系"。

**用普通模式提示词验证**——你那份标准提示词的消息序列对应关系：

```
[system]  You are an AI agent powered by DeepSeek Harness. …（51 段 section 拼成，含 persona）
[user]    <system-reminder> A skill is a reusable set of … </system-reminder>       ← dsh-tool-skill 造（:238-256）
[user]    Current runtime context. This snapshot supersedes … Approval policy: ask. ← dsh-agent-loop:505 造
```

后两条都是 `role: "user"` 的消息，都不是你打的字。


---

## 2. 当前 DSH 的标准提示词长什么样

### 2.1 它的组装模型

DSH 的 system prompt = **若干 section 按 order 升序拼接**，段与段之间用空行连接，**空文本的段直接丢弃**。

出处：`dsh-system-prompt/lib/index.js:108-110`

```js
function renderPrompt(assembly) {
  return assembly.sections.map((section) => interpolate(section, assembly.variables, "section"))
    .filter((text) => text.length > 0).join("\n\n");
}
```

排序规则：`dsh-system-prompt/lib/index.js:93-95`——先比 `order`，**order 相同则比 name 的 code-unit**（即按名字字典序，不是按注册顺序）。

装配时机：每一步模型调用前，`dsh-agent-loop/lib/index.js:497-507`：

```js
async preStep(target, position) {
  const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal));   // :502
  const sections = renderContextSections(assembly);
  const context = this.runtimeContext.project(joinContextSections(sections), sections);          // :505
  const decision = await this.dispatch.waterfall("agent/pre-step", { messages: claimed, ...position, signal }, ...); // :506
```

注意 `:505`：**runtime context 不进 system**，它是被投影成消息列表里的一条 user 消息。

### 2.2 段的分配表（谁占了哪个位置）

抄自 `dsh-system-prompt/lib/index.js:10-40`：

```
-1000 harness:identity        -900 harness:source        -800 app:web-surface
    0 deployment:persona        500 plan:policy            600 team:policy
  800 tools:ptc-only            900 context:file-reference
 1000 TOOL_BASH  1010 TOOL_PWSH  1100 TOOL_READ  1200 TOOL_WRITE  1300 TOOL_EDIT
 1400 TOOL_GLOB  1500 TOOL_GREP  1600 TOOL_JOBS  1700 TOOL_PTY
 2000 TOOL_WEB_SEARCH  2100 TOOL_WEB_FETCH  2200 TOOL_LSP  2300 TOOL_SESSION_QUERY
 2400 TOOL_GOAL  2500 TOOL_CORDIS  2600 TOOL_WORKFLOW  2700 TOOL_RALPH  2800 TOOL_SUBAGENT
 2900 TOOL_REPORT  5000 TOOLS_SDK  9000 DELIVERABLE_FILE_REFERENCES  9900 STRUCTURED_OUTPUT
```

注册这些段的具体插件（抽样，用于理解风格）：

| 段名 | order 常量 | 注册处 |
| --- | --- | --- |
| `harness:identity` | `HARNESS_IDENTITY` | `dsh-system-prompt/lib/index.js:209-213` |
| `deployment:persona` | `DEPLOYMENT_PERSONA` | `dsh-system-prompt/lib/index.js:214-218`，由 `dsh-persona` 同名覆盖（`dsh-persona/lib/index.js:35-39`） |
| `harness:source` | `HARNESS_SOURCE` | `dsh-app-boot/lib/index.js:1529-1536` |
| `app:web-surface` | `WEB_SURFACE` | `dsh-web-app/lib/index.js:188-190` |
| `tool:read` | `TOOL_READ` | `dsh-tool-fs/lib/index.js:326-330` |
| `tool:cordis` | `TOOL_CORDIS` | `dsh-tool-cordis/lib/index.js:8610-8614` |

### 2.3 系统提示词之外的另外两条通道

**(a) runtime context → user 消息。** 生产者：

- `sandbox:policy`，order 110 —— `dsh-sandbox-policy/lib/index.js:122-126`
- `approval:policy`，order 115 —— `dsh-user-approval/lib/index.js:80-84`
- `subagent:delegation`，order 120 —— `dsh-subagent/lib/index.js:701-703`（仅子 agent）

它们渲染后由 `joinContextSections` 包上开头句 `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.`（`dsh-system-prompt/lib/index.js:127-132`），再由 `dsh-agent-loop` 投影成消息。

**(b) skill 目录 → user 消息。** 由 `dsh-tool-skill` 在 `agent/pre-step` 里发（`dsh-tool-skill/lib/index.js:203-236`），内容形如：

```
<system-reminder>
A skill is a reusable set of task-specific instructions. The following skills are available in this session:

<available_skills>
- `名字`: 描述
</available_skills>
...
</system-reminder>
```

关键机制：它算一个 **sha256 摘要**（`dsh-tool-skill/lib/index.js:301-304`），摘要没变就**不重发**（`:219-230` 算摘要 → `:220-230` 命中即原样返回或回收旧目录）；真变了才重建，首次发布用 `renderCatalogMessage`（`:238`），后续用 `renderCatalogUpdate`（`:262`）发一份"完整替换"目录（`:231` 是二选一的分支）。这套机制是 DSH 用来省 prompt 预算的手段：目录内容稳定时，它**每轮都不出现在请求里**。

### 2.4 DSH 留给插件的接口（全部）

| # | 接口 | 出处 | 说明 |
| --- | --- | --- | --- |
| 1 | `ctx.systemPrompt.section({name, order, text})` | `dsh-system-prompt/lib/index.js:223-231` | 加一段 system。`order` 必须有限数，否则抛（`:224-226`） |
| 2 | `ctx.systemPrompt.context({name, order, text})` | `:249-256` | 加一段 runtime 快照（进 user 消息，不进 system） |
| 3 | `ctx.systemPrompt.tools(provider)` | `:275-280` | 提供工具 schema |
| 4 | `ctx.systemPrompt.variable(name, provider)` | `:287-294` | 注册 `{{name}}` 变量，供段文本插值 |
| 5 | `system-prompt/assemble` waterfall | `:342` | 拿到完整 `{sections, contexts, tools, variables}`，可任意改 |
| 6 | `agent/pre-step` waterfall | `dsh-agent-loop/lib/index.js:506` | 拿到消息列表，可增删消息 |
| 7 | `complete: true` | `:325-334` | 该段成为**唯一**完整提示词。多个同时生效直接抛 |
| 8 | 作用域 shadow | `dsh-scope`，`{name} is already registered (for a per-agent override, register through that agent's ctx instead)`（`dsh-system-prompt/lib/index.js:185`） | 同名段可被 agent 作用域覆盖 |

**硬约束（写代码前必须知道）：**

1. **同层同名直接抛。** `NamedEntries.insert` 在名字已存在时 `throw this.duplicateError(name)`（`dsh-scope/lib/index.js:29-31`）。
2. **段的 text 函数每一步都跑。** 因为 `assemble()` 在 `preStep` 里被调用（`dsh-agent-loop/lib/index.js:502`），所以 text 函数里**不能有阻塞 IO**。
3. **变量插值是严格的。** 未知变量、注册了但没值、格式不合法，全部抛错（`dsh-system-prompt/lib/index.js:155-168`）。这是"宁可直接失败也不要发出一份坏 prompt"的设计。

---

## 3. proxy 方案的问题（逐条给出处）

proxy 是**进程外的 HTTP 中间层**：它拿到上游 POST body，parse 成中立结构，跑 hook，再 serialize 回 body（`PROXY/src/injection/pipeline.ts:80-147`）。

它对 DSH 的整体流程是：

```
DSH ──HTTP──► proxy ──(改写 body)──► 真正的模型上游
                ▲
                └─ hook 在这里改 system 文本
```

五个问题：

### 3.1 位置靠猜

proxy 给每个 hook 声明一个"落点"（`InjectionPoint`，9 个候选，`PROXY/src/injection/types.ts:154-163`）和一个"语义锚点"（`AnchorTarget`，`types.ts:223-230`）。锚点要生效，必须有个"宿主档案"把语义名翻译成宿主 prompt 里的真实结构键：

- Claude Code：`memory → # Memory`（`PROXY/src/injection/agents/claude-code/index.ts:38-52`）
- CodeBuddy：`memory → <memories>`（`PROXY/src/injection/agents/codebuddy/profile.ts:27-41`）

**DSH 没有对应档案。** 于是 `pipeline.ts:356-370` 的锚点路径必然解析不到，全部回落到粗粒度的 `point` 行为。proxy 自己的注释里已经记过一次因此导致的翻车：`before_tools` 解析不到时会"顶到最前面，把资产块甩到 persona 之前污染开场"（`PROXY/src/injection/pipeline.ts:416-424`）。

**结论**：在 DSH 上，proxy 的注入位置不是设计出来的，是碰出来的。

### 3.2 重复注入

proxy 注册了 7 个 injector（`PROXY/src/injection/index.ts:298-387`），其中至少两块和本插件重复：

| proxy 的块 | 出处 | 本插件的对应物 |
| --- | --- | --- |
| `<tdai_memory_tools>`（一整篇 curl 配方，"TencentDB Agent Memory 已接入…"） | `PROXY/src/injection/injectors/tdai-tools-injector.ts:79-190` | 8 个原生工具（`PLUGIN/lib/tools.mjs:46-147`） |
| `<memory-tools-guide>`（记忆使用规则、调用上限） | `PROXY/src/injection/injectors/tdai-profile-memory-injector.ts:164-210` | 同上 + profile-memory 段 |

同一个能力在 prompt 里出现两遍，指令互相打架：一遍让模型去 Bash 里 curl，一遍让模型调原生工具。

### 3.3 破坏前缀缓存

proxy 改的是 **system 前缀文本**。DSH 的 `dsh-system-prompt` README 明确写了前缀稳定性的判定条件：

> `dsh-system-prompt/README.md:148`：*Prefix-stable while identity, persona, variables, section text, and order render identically. Any change may invalidate reuse from the first changed system-prompt token.*

外部改写发生在 DSH 装配**之后**，DSH 无从知晓，也就无从保证稳定。

### 3.4 token 计量失真

proxy 在 DSH 发完请求之后改 body。**这是推断**，依据是调用链方向：DSH 的 loop 发出请求（`dsh-agent-loop/lib/index.js:502` 装配 → 后续 step 发送），而 proxy 是在它自己的进程里收到这个请求之后才改的（`PROXY/src/handler.ts:1238-1266`）。因此 DSH 看到的 token 数与上游实际收到的不一致，宿主侧的上下文占用/压缩阈值/成本统计都会偏。

### 3.5 不可观测

注入发生在 DSH 之外，DSH 的 `system-prompt/change` 事件、section 注册表、trace 都看不到这些块。出问题只能去 proxy 日志捞（proxy 为此专门写了 `PROXY/src/injection/observer.ts` 和 `asset-reflection-injector.ts`）。

---

## 4. 目标形态

```
DSH 每步装配（dsh-agent-loop/lib/index.js:502）
├── sections（按 order 排序 → join "\n\n" → 丢空段）
│   ├── harness:identity                -1000   ← DSH
│   ├── harness:source                   -900   ← DSH
│   ├── app:web-surface                  -800   ← DSH
│   ├── deployment:persona                  0   ← preset（ARK-ALPHA）
│   ├── tdai:overview                     510   ← 本插件
│   ├── tdai:session-context              520   ← 本插件
│   ├── tdai:profile-memory               530   ← 本插件
│   ├── tdai:available-skills             540   ← 本插件
│   ├── tdai:knowledge-tools              550   ← 本插件（默认关）
│   ├── plan:policy                       500 ┐ DSH / 其他插件，
│   ├── team:policy                       600 ┘ 插件不越界到 610+
│   └── tool:*                          1000+   ← DSH
├── contexts → user 角色 runtime 快照（dsh-agent-loop/lib/index.js:505）
│   ├── sandbox:policy                    110   ← DSH
│   ├── approval:policy                   115   ← DSH
│   └── tdai:state                        560   ← 本插件（新增，见 §5.5）
└── tools（schema 通道，独立传送）
    └── tdai_* 共 8 个（PLUGIN/lib/tools.mjs）

agent/pre-step（dsh-agent-loop/lib/index.js:506）
├── dsh-tool-skill：skill 目录（摘要未变则不重发）
└── 本插件：<tdai_recalled_l1_memories>（每轮不同，故意放这里，见 §5.3）
```

**一句话**：一处分段只有一个所有者，没有外部改写，没有重复。

---

## 5. 设计规则

### 5.1 规则一：分带 + 连号 order + 命名前缀

**占 500–599 这一段。** 理由：

- `deployment:persona` 在 0，`plan:policy` 在 500，`team:policy` 在 600（`dsh-system-prompt/lib/index.js:10-40`）。
- 500–599 这一段在 DSH 里**没有其他所有者**，语义上正好是"agent 的会话上下文"，放记忆资产合适。
- 改造前插件用的是 610–640，落在 `team:policy(600)` 和 `tools:ptc-only(800)` 之间——那段是**策略类插件**（plan-mode、agent-teams 之类）的区，属于占错位。

**order 必须连号（520/521/522/523），不要留大间隔。** 依据你第 2 条决定：

DSH 的排序是"先比 order，order 相同才比 name"（`dsh-system-prompt/lib/index.js:93-95`）。这意味着**任何第三方插件只要把 order 落在两个号之间，就会物理插进我们的两段中间**，把 TDAI 的记忆块切成两半——而插进来的是什么内容我们完全无法预期。留间隔等于主动留出被插入的空间：

```
留间隔（旧方案）：  520 ── 530 ── 540 ── 550     ← 521..529、531..539、541..549 共 27 个空隙
连号（本版）：      520  521  522  523           ← 只剩 519 之前、524 之后的边界
```

连号之后，插件内容在 prompt 里是**一段连续文本**；别人的段只可能在整块之前或之后出现，不会插到中间。

> 注：连号只解决"被别人切开"，不解决"别人挤进 500–599 这一段"——那取决于其他插件选什么号。这是 DSH 的 order 机制本身的限制（任意第三方可用任意有限 order，`dsh-system-prompt/README.md:54`），无法从插件侧根除。**能做的**是把我们自己的块做成不可分割的一段，并在测试里断言连号。

**命名统一加 `tdai:` 前缀**，与 DSH 的 `tool:` / `app:` / `plan:` / `context:` 风格对齐，日志和排查时一眼能认出归属。

| 段名 | order | 内容 | 是否依赖资产 |
| --- | --- | --- | --- |
| `tdai:session-context` | 520 | agent / task 身份 | 是 |
| `tdai:profile-memory` | 521 | L3 persona + L2 场景索引 + 工具用法总纲 + 插件总述 | 是 |
| `tdai:available-skills` | 522 | 云端 skill 补充目录 | 是 |
| `tdai:knowledge-tools` | 523 | wiki / code-graph 指引 | 是 |

**`tdai:overview` 不再单独存在**（依据你第 4 条决定）。那段"TencentDB Agent Memory 已接入……"的静态说明并入 `tdai:profile-memory` 的开头——它和 profile-memory 讲的是同一件事（"你有哪些记忆能力、怎么用"），分成两段只是把一个话题拆开写。合并后：

- 段数从 5 降到 4，prompt 里少一个段间空行和一次重复的自我介绍；
- 静态文本与资产内容在同一段内，渲染顺序自然（先总述，再画像与索引）；
- **失败降级更简单**：资产没加载出来时，这一段仍然输出总述（告诉模型"有这个能力，可以用工具查"），而不是整段空白。

**`tdai:state` 仍走 `systemPrompt.context()`，order 560。** 它和 section 是**两张不同的表**（`dsh-system-prompt/lib/index.js:185-186` 分别建 `sections` 和 `contexts`），所以 560 不会和 section 的 520–523 冲突，也不参与 system 文本的排序——它最终是消息列表里的一条 user 消息（见 §1.1）。把它写成连号之外的 560，是为了明确表达"这不属于 system 分段带"。

**可验收的断言**（`PLUGIN/test/section-registry.test.mjs`）：

- 插件任何段的 order 都不等于 DSH 保留表的任何一个值；
- 插件内部 order **连号且不重复**、段名不重复；
- 插件段整体位于 `deployment:persona` 之后、`team:policy` 之前。

### 5.2 规则二：settings 命名空间与 section 名分离

改造前：静态段名 = `tdai-memory`（`PLUGIN/lib/sections.mjs:52`，改造前），settings 命名空间 = `tdai-memory`（`PLUGIN/lib/settings.mjs:10`），二者同名。

- **技术上没有冲突**：settings 命名空间是 `settings` 服务的名字表，section 是 `systemPrompt` 的名字表，两张表互不相干。
- **但排查时无法区分**：`settings.yaml` 里的 `tdai-memory:` 段落和日志里的 section 名长得一样。

**本版处理**：section 层全部改成 `tdai:*`（且不再有 `tdai:overview`）；settings 命名空间**保持 `tdai-memory` 不变**（`PLUGIN/lib/settings.mjs:10`）。原因：`~/.dsh/settings.yaml` 里已经持久化了 `tdai-memory:` 这个键，改名会导致用户已保存的配置（`serviceId/teamId/agentId/userId/userKey`）失联。前端卡片里的 `const NS = 'tdai-memory'`（`PLUGIN/client.card.tsx:14`）同理不动。

### 5.3 规则三：按"稳定性"分通道

判据只有一条：**同一 session 内，这段字节会不会变。**

| 类型 | 通道 | 例子 | 原因 |
| --- | --- | --- | --- |
| session 内稳定 | system section | L3/L2、身份、skill 目录 | 前缀稳定 → 上游缓存可复用 |
| 每轮不同且必须给模型看 | `agent/pre-step` 追加消息 | L1 召回 | 消息列表尾部本来每轮都在变，不影响前缀 |
| 随会话状态变化、想被平台统一管理 | `systemPrompt.context` | TDAI 运行状态 | 平台自己有一致性管理（`dsh-agent-loop` 的 runtime context 投影器） |

**L1 召回的定位（依据你的回答 2）**：保留，由 `recallEnabled` 开关控制。但要接受代价，并写进开关文案：

- 现状：每轮在消息列表**追加一条新的 user 消息**（`PLUGIN/lib/recall.mjs:98`）。
- proxy 原版是 `prepend` 进"最后一条 user 消息"里（`PROXY/src/injection/pipeline.ts:448-457`），不新增消息。
- **两者都不改 system 前缀**，所以都不会打穿 system 的缓存。差别在消息列表结构：追加会多一条 user 轮次，prepend 不改结构。
- **建议**（阶段 4 实施）：改成 prepend 语义，与 proxy 原版一致，减少"凭空多一轮对话"对模型理解对话结构的影响。
- 无论哪种，给召回块加一个**字符预算上限**（现在只有条数上限 `recallLimit`）。

### 5.4 规则四：目录类内容只发一次

DSH 的 skill 目录由 `dsh-tool-skill` 独占发布（`dsh-tool-skill/lib/index.js:203-236`），带摘要去重。

本插件的 `tdai:available-skills` 必须降级为**补集**：

- 保留：一句"云端团队 skill 用 `tdai_skill_search` / `tdai_skill_view` 取用"+ 列表；
- **删除**：`SKILL_LISTING_HEADER`（`PLUGIN/lib/prompts.mjs:133-145`）里那套"扫一遍、宁可多加载、不要漏"的加载规则。那是写给 DSH 原生 `skill` 工具（`dsh-tool-skill/lib/index.js:60-65` 定义的工具）的，重复写会让模型在"该调 `skill` 还是该调 `tdai_skill_view`"之间犹豫。

### 5.5 规则五：能用工具描述表达的，不写进 prompt

"什么时候必须先查记忆""每轮调用上限"这类规则，本质是**工具使用说明**。它们应该落在 8 个工具的 `description` 里（`PLUGIN/lib/tools.mjs:46-147`），因为工具 schema 本来就要发给模型，写在这里**不额外占 prompt 预算**。

system 里只保留 3–5 行总纲（`PLUGIN/lib/prompts.mjs:42-79` 的 `MEMORY_TOOLS_GUIDE` 需要瘦身）。

### 5.6 规则六：`<knowledge_tools>` 的缓存修正

`renderKnowledgeToolsBlock` 目前把 5 个请求头的字面值展开进 prompt（`PLUGIN/lib/prompts.mjs:243-246`）：

```
x-conversation-id: <session_id>
x-tdai-user-id: <userId>
x-tdai-team-id: <teamId>
x-tdai-agent-id: <agentId>
x-tdai-space-id: <spaceId>
```

问题：其中 `session_id` 是会话级的，`userId/teamId/agentId/spaceId` 是进程级静态配置。同一 memory 实例被多个用户共用时，每个用户每会话的 system 字节都不同 → **前缀缓存无法跨会话复用**。

**修正**（阶段 3 实施）：prompt 文本里只保留**头名和取值说明**，例如 `-H 'x-tdai-service-id: <当前 memory 实例>'`，让模型照抄占位说明；真实取值由 curl 请求时的运行时环境提供。这样这段文本对所有会话**逐字节相同**。

> 注：knowledge 端点不需要密钥（`PLUGIN/lib/prompts.mjs:229-231` 的注释），所以把值从 prompt 里拿掉不影响可调用性。

---

## 6. 绕开 proxy 后必须解决的三件事

这一节是本版**最重要**的部分——proxy 走了以后，有些它顺手做的事没人接。

### 6.1 身份从哪来（影响最大）

**proxy 现在的做法**：会话初始化时，proxy 伪造一个 `ask_user_question` 工具调用，让用户选 Team / Agent / Task（`PROXY/src/session/dsh/form.ts:248-260` 构造响应，`:141-157` 是"是否关联团队资产"那一步）。用户选完，proxy 把结果写进 session 信息，之后每个请求都带着它（`PROXY/src/handler.ts:1226-1236` 派生出 TDAI identity）。

**本插件现在的做法**：身份完全来自静态配置——env 或 settings 面板（`PLUGIN/config.mjs:59-70` 的 `identityComplete` / `baseIdentity`），在插件加载时确定一次（`PLUGIN/index.mjs:28-32`），`session_id` 从每次调用的 session 对象上取（`PLUGIN/index.mjs:62-65`）。

**差距**：绕开 proxy 后，**"每个会话可选不同 Team/Agent/Task"的能力消失了**，整个进程只有一个身份。

**三个可选方案：**

| 方案 | 做法 | 成本 | 适用 |
| --- | --- | --- | --- |
| **A. 接受静态身份（已选定）** | 就用 settings/env。文档写明"一个 dsh 进程对应一个 TDAI 身份" | 0 | 单人单 agent 场景（你现在的用法） |
| B. 插件自己发起表单 | 插件注册一个工具，引导模型调用 DSH 原生的 `ask_user_question` 来选身份，选中后写进会话级状态 | 中：多一轮对话，且模型可能不配合 | 需要多身份切换 |
| C. slash 命令切换 | 加 `/tdai-identity team=… agent=… task=…`，写进会话级状态 | 中：命令必须记住参数顺序，体验一般 | 需要多身份但能接受手动 |

**最终决定：选 A**（依据你第 1 条回答）。理由：身份选择本质是 **proxy 作为多用户网关**才需要的能力；插件是进程内单用户组件，静态身份是更自然的形态。

**选定 A 之后，阶段 5 的工作从"三选一"变成三件具体的事**（见 §7 阶段 5）：文档写明限制、`/tdai-status` 暴露身份来源与实际取值、缺字段时日志点名。B/C 移入 §8 后续课题。

### 6.2 session-init 表单消失后的副作用

proxy 的表单还承担一个 UI 作用：让用户显式确认"本次会话是否关联团队资产"。消失后：

- 用户不再有"这次不注入记忆"的入口 → 需要靠 settings 面板的开关（已有，`PLUGIN/lib/settings.mjs`）；
- 建议在阶段 5 加一句文档说明 + 在 `/tdai-status` 里显示当前身份来源（env 还是 settings）。

### 6.3 写回路径复核

**好消息：写回路径是完整的，不依赖 proxy。**

- 插件监听宿主事件 `session/event`（`PLUGIN/lib/capture.mjs:39`）收集每轮消息，在 `agent/turn-stopping` 时双写：`/v3/conversation/add`（L0）+ `/v3/skill/conversation/add`（Skill 归档）（`PLUGIN/lib/capture.mjs:56-60` + `PLUGIN/client.mjs:101-106`）。
- 它还会剔除插件自己注入的块，避免污染记忆：`INJECTED_MARKERS` 过滤（`PLUGIN/lib/capture.mjs:14-20`），在 `:60` 生效。

**已做的实测（2026-09-14）**：扫描 `~/.dsh/sessions/` 下全部 13 个会话日志，检索召回标记 `<tdai_recalled_l1_memories>`。命中全部落在 `tool/result`、`assistant/chunk`、`assistant/message`、`tool/call` 这四类事件里——**没有任何一条落在 `user/message` 事件上**。即 `isInjectedContext` 的过滤**当前是生效的**，召回块没有被写进 L0。

**为什么仍要列进验收项**：这个过滤依赖一份**硬编码标记清单**（`PLUGIN/lib/capture.mjs:15`），而不是"凡注入必过滤"的机制。改造会改变注入块的文本形态，一旦标记与实际渲染文本对不上，过滤就会静默失效——而失效的方向是**把注入内容当用户真实发言写进长期记忆**，污染永久且难以事后清理。

**验收做法**（阶段 3 完成后跑一轮真实会话）：

```bash
zstd -dc ~/.dsh/sessions/<workspace>/<session>/session.jsonl.zstd | python3 -c "
import sys, json
c = {}
for line in sys.stdin:
    if 'tdai_recalled_l1_memories' not in line: continue
    d = json.loads(line); c[d['type']] = c.get(d['type'], 0) + 1
print(c)   # 期望：不含 user/message
"
```

**顺带一条设计建议**：把"哪些块算注入"从标记清单改成**结构性判据**。DSH 的消息对象支持 `source` 字段，`dsh-tool-skill/lib/index.js:238-256` 就是范例（`createUserMessage({ source: { kind: "skill-catalog", form: "catalog", entries } })`）。按 `source.kind` 过滤，比按"文本里出现某个标签"过滤可靠得多，也不会因为文案改动而失效。

### 6.4 curl 文本指引的定位（依据你的回答 3）

按你的决定，`<knowledge_tools>`（wiki / code-graph / 云端 skill）**先维持 curl 文本指引**，不注册成原生工具。本版只做 §5.6 的缓存修正。

需要你知道的代价，以便后续决策：

- curl 文本指引 = 让模型用 Bash 工具去敲命令。它**占了 prompt 预算**（`PLUGIN/lib/prompts.mjs:233-317` 是一大段），且**失败率高于原生工具**（模型可能记错 URL、漏 header）。
- 原生工具 = DSH 把 schema 发给模型，参数有校验，失败信息结构化。代价是插件要管工具生命周期。
- 已经注册成原生工具的那 8 个（`PLUGIN/lib/tools.mjs`）是这条路的样板，后续 knowledge 工具可以照抄。

---

## 7. 分阶段施工

每一步都给出：改什么文件、用什么 DSH 接口、验收标准、回滚方式。

### 阶段 0 · 建契约测试（已完成）

**已做**：新增 `PLUGIN/test/section-registry.test.mjs`。它自带一份 DSH 中心 order 表的副本，断言：插件段不占保留位、插件内部 order/name 唯一、动态段首次求值为空、用假宿主跑完整的装配+渲染流程验证相对顺序。

**为什么先做这个**：改造要动段名和 order，没有一个能自动变红的护栏，就无法证明"改完是对的"。

**验收**：`npm test` 通过。

### 阶段 1 · 段名、连号 order、overview 合并

**目标**：把段注册的形状一次性定下来（名字、order、段数），此后阶段 2 只改文本内容，不再动结构。

**改什么**

| 文件 | 改动 |
| --- | --- |
| `PLUGIN/lib/sections.mjs` | `SECTION_ORDERS` 改为连号 **520/521/522/523**；**删除 `tdai:overview` 段**，其静态文本合并进 `tdai:profile-memory` 的渲染函数开头 |
| `PLUGIN/lib/prompts.mjs` | `renderProfileMemory` 增加"插件总述"前缀（原 `tdai:overview` 的文本），并保证**资产为空时仍输出该前缀**（这样模型知道有工具可用） |
| `PLUGIN/test/section-registry.test.mjs` | 断言从"5 个段"改为"4 个段"、order 连号、且没有任何段 order 落在连号之外 |
| `PLUGIN/test/load.test.mjs`、`PLUGIN/test/sections.test.mjs` | 同步去掉 `tdai:overview` |

**验收**

- `npm test` 全绿；
- 断言里明确写出：`orders` 排序后相邻两项差 **恒为 1**（防回归）；
- 用假宿主渲染一次，确认 `tdai:profile-memory` 段开头就是那段总述、且资产为空时仍非空。

**回滚**：只动 `lib/sections.mjs` 一张表 + 测试；`git checkout` 即回。

### 阶段 2 · 内容去重与瘦身

**改什么**

| 文件 | 改动 | 依据 |
| --- | --- | --- |
| `PLUGIN/lib/prompts.mjs:9-35` | `renderSessionContext` 去掉 `prompt:` 段 | agent 的 persona 已由 preset 注入（`dsh-agent-presets/presets/cordis/agent.cordis.yml:17-30`），全文再注一遍是同内容两遍 |
| `PLUGIN/lib/prompts.mjs:42-79` | `MEMORY_TOOLS_GUIDE` 瘦身到 3–5 行 | §5.5（你已确认可接受） |
| `PLUGIN/lib/prompts.mjs:133-148` | `SKILL_LISTING_HEADER/FOOTER` 重写为补集语义 | §5.4 |
| `PLUGIN/lib/tools.mjs:46-147` | 8 个工具的 `description` 补齐"何时必须调用 / 何时不必" | 承接上一条删掉的规则 |

**验收**

1. 把改造前后的 `renderPrompt` 输出 diff 出来，**行数应下降**；
2. 逐条打勾"旧内容 → 新位置"，确认无信息丢失（尤其是"必须先查记忆的 4 个场景"和"每轮调用上限"）；
3. 真实会话跑 3 个典型问题做人工回归：**"我叫什么"**（应触发 `tdai_memory_search`）、**"上次那个 bug 怎么修的"**（应触发 `tdai_conversation_search`）、**"帮我改段代码"**（不应触发任何记忆工具）。

**风险**：中。删减提示词内容会影响模型行为，所以这一步必须配人工回归，不能只看测试。

### 施工进度与顺序修正

实际施工顺序与上面的建议顺序有出入，记录在此以免看代码时困惑：

| 阶段 | 状态 | 说明 |
| --- | --- | --- |
| 0 契约测试 | ✅ 完成 | `test/section-registry.test.mjs` |
| 1 段名 + 连号 order + overview 合并 | ✅ 完成 | 段数 5 → 4，order 520–523 |
| 2 去重与瘦身 | ✅ 完成 | 见下方「内容迁移对照表」 |
| 3 状态归位 + 缓存修正 + 回写健壮化 | ✅ 完成 | 含**阶段 4 的配套项**（按块剥离），理由见下 |
| 4 L1 召回 prepend | ✅ 完成 | 与阶段 3 的配套项必须同批改，故提前 |
| 5 身份（方案 A） | ✅ 完成 | README + `/tdai-status` + 点名日志 |
| 6 观测 | ⏳ 未做 | `/tdai-status` 已含 section 与资产信息，剩余部分待做 |

**为什么阶段 4 的配套项要提前到阶段 3 做**：prepend 一旦生效，召回块就混进了真人那条
user 消息里，而那条消息的 `source` 是 `{ kind: 'user' }`。如果回写仍是"整条丢弃"，
**用户真实说的话会跟着被丢掉**（实测确认了这个行为，见 `test/capture-filter.test.mjs`
用例 3 的注释）。两件事分开做，中间会存在一个"丢数据"的窗口，所以同批完成。

---

### 阶段 3 · 状态归位 + 缓存修正 + 回写健壮化

**改什么**

1. 新增 runtime context：`ctx.systemPrompt.context({ name: 'tdai:state', order: 560, text })`，输出会话级稳定的 TDAI 状态（instance / team / agent、各资产是否装载、注入总闸与召回开关）。接口出处 `dsh-system-prompt/lib/index.js:249-256`。
   **必须遵守 DSH 的 context 约定**（§1.1 的 (a)）：内容要稳，别把"本轮召回命中 3 条"这种每轮都变的量放进去——那会导致每一步都追加一条新消息。
2. `PLUGIN/lib/prompts.mjs:243-246`：`<knowledge_tools>` 的请求头改成占位说明（§5.6）。
3. `PLUGIN/lib/capture.mjs:14-20`：把回写过滤从**纯文本哨兵**改成**并集判据**：
   - 主判据：`event.data.source` 为 `{ kind: 'plugin', plugin: 'dsh-tdai-memory-plugin' }` → 丢弃；
   - 兜底判据：文本中包含已知哨兵（`<tdai_recalled_l1_memories>` 等）→ 丢弃。
4. 给插件自己注入的独立消息补 `source` 标记（凡是通过 `agent/pre-step` 追加的消息）。

**验收**

- 状态快照出现在消息列表的 runtime context 段里，**不在 system 里**（用 `section-registry.test.mjs` 的同款假宿主断言）；
- 对同一 memory 实例、不同会话，`tdai:knowledge-tools` 渲染出的文本**逐字节相同**；
- **新增单测**：构造一条"用户消息 = 召回块 + 真人正文"的假事件（模拟 prepend 之后的形态），断言过滤后剩下的**恰好等于真人正文**。这条测试是为阶段 4 铺路的——prepend 之后没有任何 `source` 可依赖，只能靠哨兵，必须锁住。

### 阶段 4 · L1 召回改成 prepend 语义 —— ⚠️ **已被 §11 回退**

> 本节保留为历史记录。prepend 在真实宿主里的行为与预判不符（宿主会把
> `decision.messages` 原样持久化，于是召回块变成"用户发言"的一部分），
> 2026-09-15 已改回**独立 plugin 消息**。**以 §11 为准**，尤其注意：
> §11 里选的是 `form: 'notice'`（折叠一行说明），不是下面提到的 `form: 'recall'`
> —— 后者在客户端对应 session-reference 的 `references` 载荷，我们并不产出那个结构。

**改什么**：`PLUGIN/lib/recall.mjs:98`——从"追加一条新 user 消息"改为"prepend 进本轮最后一条 user 消息"，与 proxy 原版一致（`PROXY/src/injection/pipeline.ts:448-457` 的 `prependTextToMessage`）；新增召回块**字符预算**上限。

**为什么用 prepend**（依据你第 3 条决定）：不新增一条 user 轮次，模型看到的是"同一轮对话里带了一段背景材料"，而不是"凭空多了一轮用户发言"。

**已知代价（必须记录）**：prepend 之后召回内容与真人输入**共用同一条消息**，那条消息的 `source` 是 `{ kind: 'user' }`，所以**无法再靠 `source` 判断哪部分是注入的**。回写过滤退化为依赖文本哨兵——这正是阶段 3 那条新增单测要锁住的东西。

**验收**

- 召回开启时消息条数 **不变**（对比关闭时），且召回块出现在本轮用户消息**开头**；
- 阶段 3 的过滤单测在改造后**依然通过**；
- 真实会话确认模型仍能区分"这是背景材料"与"这是用户说的"。

**风险**：低到中。如果人工回归发现模型把召回内容当成了用户的要求，回退方案是恢复"独立消息 + `source.form: 'recall'`"（DSH 的 `ContextForm` 里本来就有 `recall` 这个语义值，`dsh-llm/lib/types/message.d.ts:53-54`）。

### 阶段 5 · 身份方案落地（选 A）

**已定**：静态身份。要做的是把限制写清楚、让它可观测：

1. `README.md` 写明：**一个 dsh 进程 = 一个 TDAI 身份**；多身份需换进程或改配置。
2. `/tdai-status` 输出增加"身份来源"（env / settings）与四个 ID 的实际取值。
3. 补一条日志：插件加载时若身份不完整，说清缺哪几个字段（现在只说"identity incomplete"）。

**验收**：`/tdai-status` 能一眼看出当前身份与来源；缺字段时日志点名。

**不做**：B（插件发起表单）、C（slash 命令切换）——列为 §8 的后续课题。

### 阶段 6 · 观测

`/tdai-status` 扩展：列出当前注册的 section 表（名字 / order / 本次渲染字节数）、runtime context 内容、资产缓存时间戳、召回命中条数。日志补上每步装配的总字节数与各段渲染耗时。

**为什么值得做**：proxy 有 `observer.ts`，插件目前只有 `ctx.logger.warn`。改造后所有注入都在 DSH 内部，**能否观察**直接决定以后出问题好不好查。

`/tdai-status` 扩展：列出当前注册的 section 表（名字/order/本次渲染字节数）、runtime context 内容、资产缓存时间戳、召回命中条数。日志补上每步装配的总字节数与各段渲染耗时。

**为什么值得做**：proxy 有 `observer.ts`，插件目前只有 `ctx.logger.warn`。改造后所有注入都在 DSH 内部，**能否观察**直接决定以后出问题好不好查。

---

## 8. 后续独立课题（本次不做）

1. **wiki / CodeGraph 注册为 DSH 原生工具**：替换 `<knowledge_tools>` 的 curl 指引（`PLUGIN/lib/prompts.mjs:233-317`）。可照抄现有 8 个工具的写法（`PLUGIN/lib/tools.mjs:46-72`）。
2. **资产反射**：proxy 有 `/analyse` marker + `asset-reflection-injector.ts`（`PROXY/src/injection/injectors/asset-reflection-injector.ts:70-78`），让模型自评"这轮用到了哪些注入资产"。可做成 slash 命令按需触发，不占常驻 prompt。
3. **ACL**：proxy 对每个借入 agent 的上下文做 `acl/check(read)`（`PROXY/src/injection/injectors/tdai-l1-recall-injector.ts:38-42`）。单人场景不需要，多用户场景需要，且**必须在请求期做**（不进 prompt）。
4. **身份切换（B / C 方案，本次不做）**：见 §6.1。B = 插件注册工具、引导模型调用原生 `ask_user_question` 选身份；C = `/tdai-identity team=… agent=… task=…` 写进会话级状态。仅在真的需要"一个进程内多身份"时再做。

---

## 8.0 知识能力 skill 化（本轮完成，替代 §8 后续课题 1）

原计划把「团队知识」做成常驻 system section。实际做成了 **DSH runtime skill** —— 因为
skill 机制比方案里设想的更合适：

| 维度 | 常驻 section（原方案） | runtime skill（实际做法） |
| --- | --- | --- |
| 每轮成本 | 4.4KB 常驻，多数轮次用不到也要付费 | system 里只留 ~300 字节路由行 |
| 正文何时进上下文 | 每轮 | 模型调 `skill` 工具时 |
| 与 DSH 的关系 | 自己造一段文本 | 进 DSH **原生 skill 目录**，与自带 skill 同一套机制 |
| 目录去重/重发 | 自己维护 | 宿主负责（摘要比对，`dsh-tool-skill/lib/index.js:203-236`） |
| 正文完整性 | 受 prompt 预算约束，只能精简 | 不受约束，可写全 |

**实测**：常驻 prompt 9953 → 5768 字节（-42%）；知识 skill 正文 4157 字节按需加载。

**接口与依据**：
- 注册：`ctx.skills.register(skill)`，签名 `dsh-skill/lib/types/index.d.ts:256-259`；
  `SkillRegistration` 形状见 `:81-85`（name / description / whenToUse? / source / content / invocation?）
- 名字规则 `^[a-z0-9]+(?:-[a-z0-9]+)*$`：`dsh-skill/lib/index.js:17`
- 加载后正文被包成 `<skill_content>` + `<skill_instructions>`：`dsh-skill/lib/index.js:57-70`
- 默认 invocation 策略：省略即 model 与 user 两个面都可见（`index.d.ts:81-85`）

**实现落点**：
- `lib/prompts.mjs`：`KNOWLEDGE_SKILL_NAME` / `KNOWLEDGE_SKILL_DESCRIPTION` / `KNOWLEDGE_SKILL_WHEN_TO_USE`、
  `renderKnowledgeSkillContent()`（正文）、`renderKnowledgeRouteBlock()`（system 侧路由行）
- `lib/sections.mjs`：`registerKnowledgeSkill()`，在 assemble 里按 session 幂等注册
- `test/knowledge-skill.test.mjs`：注册 / 描述路由 / 正文完整 / 幂等 / fail-open / 路由块瘦身

**遗留**：`renderKnowledgeToolsBlock()` 已下线但保留为对照参考（函数头有显式标注）。
`knowledgeEnabled=false` 或当前 agent 未绑定资源时不注册。

## 8.0.1 知识调用改为原生工具（本轮完成，§8 后续课题 1 收尾）

紧接着 skill 化做完的一步：把「执行知识查询」也做成 DSH 原生工具，最终形成三处分工：

| 关注点 | 落在哪 | 体积 | 何时进上下文 |
| --- | --- | --- | --- |
| 有哪些资源、什么时候该用 | `tdai:knowledge-tools`（system section） | ~300B | 每轮 |
| 判据 + 资源清单 + **工具清单** | `tdai-team-knowledge`（runtime skill 正文） | ~3.6KB | 模型加载 skill 时 |
| 怎么调 | `tdai_knowledge_tools` / `tdai_knowledge_call`（工具 schema） | 工具目录 | 工具目录常驻 |

**关键设计：工具清单在会话开始时预取。** 知识服务是 progressive-exposure 设计
（先 `tools/list` 再 `tools/call`，MemoryKnowledge doc:507-510）。插件在 `#loadKnowledge`
里就对每个资源调一次 `tools/list`，把结果写进 skill 正文 —— 模型**加载 skill 的那一刻
就拿到了工具名与参数**，省掉一次自发现往返；原生工具只负责执行。
预取失败时正文退回"先用 `tdai_knowledge_tools` 查一次"的指引。

**为什么只注册 2 个工具而不是 16 个。** 知识服务的工具是**按资源动态定义**的
（wiki 7 个、code-graph 9 个，doc:568-575），插件无法在注册时静态展开。
而且 DSH 的注释明确说过工具目录要稳定（计划模式里"工具目录跨模式保持不变以维持请求缓存稳定性"）。
所以对外只暴露"发现"与"执行"，明细放运行时数据。

**越权防护（重要）**：`tdai_knowledge_call` 只接受**当前会话已绑定**的 `knowledge_id`
（判据是 assets 缓存里的资源列表）。模型若凭空编一个 id，工具直接拒绝并列出可用 id，
**不会拿编出来的 id 去请求服务端**。见 `test/knowledge-tools.test.mjs` 用例 2。

**错误语义**：知识服务在 code-graph 工具执行失败时仍回 `code=0`，把错误放在 `data.isError`
（doc:573）。客户端 `knowledgeToolsCall()` 必须显式判 `isError`，否则失败会被当成成功结果
喂给模型。见用例 4。

**端点注意**：这两个端点**不在 MemoryCore 上**，而在每个资源自己的 `service_url`
（已含 API 路径，如 `http://kb.internal/v3`）。因此 `GatewayClient` 新增了按资源切换 base
的 `#postTo()`，只带 `x-tdai-service-id`，不带 MemoryCore 的 Bearer 与身份头。

**实测**：skill 正文因去掉 curl 配方从 4157 → 3587 字节（带工具清单约 3.8KB）；
常驻 prompt 不变（5768 字节）。工具数 8 → 10。

---

## 8.1 内容迁移对照表（阶段 2 用，防信息丢失）

阶段 2 删掉了 `MEMORY_TOOLS_GUIDE` 的大部分内容。这张表把"删掉的东西去哪了"逐条列出，
便于事后核对没有信息丢失。

| 原内容（`MEMORY_TOOLS_GUIDE`，改造前 40 余行） | 新位置 |
| --- | --- |
| "这不是文档，这是你的可用能力""禁止说我没有这个工具""需要 curl / MCP" | **删除**：本插件是原生工具，工具 schema 直接发给模型，不需要这些自我辩护 |
| 记忆规则总纲（L3/L2 已直注、L0/L1 要主动检索） | 保留在总纲（3 行版） |
| "用户提及历史/过去/之前"→ `tdai_conversation_search` | `tdai_conversation_search` 的 `description` |
| "用户涉及自己身份/偏好/习惯"→ `tdai_memory_search` | `tdai_memory_search` 的 `description` |
| "用户要求你回忆/找"→ 直接触发工具 | 同上（并入触发条件表述） |
| "答案强依赖历史事实"→ 关键词化后检索 | `tdai_memory_search` 的 `description` |
| "需要 L2 场景全文"→ `tdai_read_scene` | `tdai_read_scene` 的 `description` + profile-memory 段内的说明行 |
| "不需要查的场景"（你是谁 / 帮我改代码 / 同轮已能回答 / L3 已有） | 各工具 `description` 里的 "You do not need it when…" / "Not needed when…" |
| 每轮检索 ≤ 3 次 | `tdai_memory_search` / `tdai_conversation_search` 的 `description`（**软约束**，见下） |
| "检索无果要说不确定" | 保留在总纲（3 行版） |
| "同一 L2 path 不要重复读" | `tdai_read_scene` 的 `description` |
| 典型流程 curl 示例 | **删除**：原生工具不需要 curl |

**"软约束"的含义**：那个 ≤3 次的上限**代码里没有强制**（grep `lib/` 只有提示词里提过它）。
现在的处理是把它写进工具描述作为行为引导。如果你希望它变成硬约束，需要在工具执行路径里
加计数器——那是独立一段工作，不在本方案范围内。

### 8.2 施工中发现并修掉的两个缺陷（都在改造过程中实测暴露）

| 缺陷 | 怎么发现的 | 影响 | 修复与护栏 |
| --- | --- | --- | --- |
| **模型回复全部不回流 L0** | 写 `capture-filter.test.mjs` 用例 1 时断言失败（期望 `[user, assistant]`，实际 `[user, user]`） | assistant 消息的 `source.kind` 是 `'model'`，被"非 user 一律丢"判据误伤 → L0 里只剩用户单边发言，长期记忆质量塌陷 | `entriesFor()`（`lib/capture.mjs`）改为**先按 `role` 分流**；用例 1 作为回归护栏 |
| **prepend 后真人正文被连坐丢弃** | 设计 prepend 时推演出来的冲突（§0.1），实测确认 | 召回开启时，每条用户消息都会被整条丢弃 | `stripInjectedBlocks()` 按块剥离（含截断残块、旧格式标记兜底）；`capture-filter` 用例 3/3b 锁住 |

两个缺陷都是**只有把行为写成断言才会暴露**的那一类。这也是阶段 0 先建契约测试的价值所在。

---

## 9. 决策记录（已全部拍板）

| # | 问题 | 决定 | 落地位置 |
| --- | --- | --- | --- |
| 1 | 身份方案 | **A：静态身份**（一个 dsh 进程 = 一个 TDAI 身份），文档写清限制 + `/tdai-status` 暴露来源 | §6.1、阶段 5 |
| 2 | 回写路径 | 按设计建议**做健壮**：`source` 判据为主 ∪ 文本哨兵兜底，并加一条过滤单测 | §0.1、§6.3、阶段 3 |
| 3 | 段 order | **连号 520–523**，插件内容在 prompt 里成为不可分割的一段 | §5.1、阶段 1 |
| 4 | L1 召回 | ~~改成 prepend 语义~~ → **已回退为独立 plugin 消息**（`form: 'notice'`）。prepend 会把召回块永久写进"用户发言"，前端回显与回写都跟着变形 | ~~§5.3、阶段 4~~ **§11.3** |
| 5 | `tdai:overview` | **并入 `tdai:profile-memory`**，段数 5 → 4 | §5.1、阶段 1 |
| 6 | `MEMORY_TOOLS_GUIDE` | **瘦身可接受**（3–5 行），详细规则迁进 8 个工具的 `description` | §5.5、阶段 2 |
| 7 | wiki / CodeGraph / cloud SKILL | **继续用 curl 文本指引**，只做 §5.6 的缓存修正 | §6.4、阶段 3 |
| 8 | 知识能力形态（§8.0 起追加） | **skill 化 + 原生工具**：system 只留一行路由，判据与资源清单进 runtime skill，执行交给 `tdai_knowledge_tools` / `tdai_knowledge_call`（取代第 7 条的 curl 指引） | §8.0、§8.0.1 |

**已无人拍板事项。** 施工顺序：阶段 1 → 2 → 3 → 4 → 5 → 6（阶段 0 已完成）。

---

## 10. 引用索引（便于逐个核对）

### DSH

| 主题 | 位置 |
| --- | --- |
| 段位分配表 | `dsh-system-prompt/lib/index.js:10-40` |
| 排序规则（order → name） | `dsh-system-prompt/lib/index.js:93-95` |
| renderPrompt（丢空段、空行连接） | `dsh-system-prompt/lib/index.js:108-110` |
| 变量插值严格性 | `dsh-system-prompt/lib/index.js:155-168` |
| section/context/tools/variable 注册 | `dsh-system-prompt/lib/index.js:223-294` |
| assemble 主流程 | `dsh-system-prompt/lib/index.js:299-345` |
| 同名段抛错 | `dsh-system-prompt/lib/index.js:185` + `dsh-scope/lib/index.js:29-31` |
| complete 段语义 | `dsh-system-prompt/lib/index.js:325-334` |
| 前缀缓存稳定性说明 | `dsh-system-prompt/README.md:148` |
| 第三方可用任意有限 order | `dsh-system-prompt/README.md:54` |
| runtime context 渲染 | `dsh-system-prompt/lib/index.js:127-141` |
| 每步装配 + 投影 + pre-step | `dsh-agent-loop/lib/index.js:497-507` |
| runtime context 去重 + CLEARED | `dsh-agent-loop/lib/index.js:19`、`:40-88` |
| 消息追加落盘 | `dsh-agent-loop/lib/index.js:560` |
| 消息角色只有三种 | `dsh-llm/lib/types/message.d.ts:118-124` |
| `source.kind` / `ContextForm` | `dsh-llm/lib/types/message.d.ts:42-54`、`:94-104` |
| `createUserMessage` | `dsh-llm/lib/types/message.js:34-47` |
| session.append 持久化 | `dsh-session/lib/index.js:1403-1422` |
| skill 目录发布与去重 | `dsh-tool-skill/lib/index.js:203-236`、`:238-270`、`:301-304` |
| skill 工具定义 | `dsh-tool-skill/lib/index.js:60-65` |
| sandbox / approval context | `dsh-sandbox-policy/lib/index.js:122-126`、`dsh-user-approval/lib/index.js:80-84` |

### PLUGIN

| 主题 | 位置 |
| --- | --- |
| section 注册与 assemble 兜底 | `lib/sections.mjs:71-118` |
| 身份来源 | `config.mjs:59-70`、`index.mjs:28-32`、`index.mjs:61-66` |
| 8 个原生工具 | `lib/tools.mjs:46-147` |
| L1 召回注入点 | `lib/recall.mjs:44-105` |
| 提示词渲染器 | `lib/prompts.mjs:9-317` |
| 回写过滤（文本哨兵） | `lib/capture.mjs:14-20`、`:60` |
| 写回（L0 + skill 归档） | `lib/capture.mjs:39-60`、`client.mjs:101-106` |
| settings 命名空间 | `lib/settings.mjs:10`、`client.card.tsx:14` |
| 契约测试 | `test/section-registry.test.mjs` |

### PROXY

| 主题 | 位置 |
| --- | --- |
| HTTP 拦截主流程 | `src/handler.ts:1238-1266` |
| pipeline（parse→hook→serialize） | `src/injection/pipeline.ts:80-147` |
| 落点与锚点类型 | `src/injection/types.ts:154-230` |
| 锚点→宿主结构的翻译表 | `src/injection/agents/claude-code/index.ts:38-52`、`agents/codebuddy/profile.ts:27-41` |
| 锚点失败回落 + 已知翻车 | `src/injection/pipeline.ts:340-381`、`:416-424` |
| L1 召回的 prepend 原版实现 | `src/injection/pipeline.ts:448-457` |
| injector 注册表 | `src/injection/index.ts:298-387` |
| session-init 表单 | `src/session/dsh/form.ts:141-260` |
| 身份派生 | `src/handler.ts:1226-1236` |

---

## 11. 复修（2026-09-15 深夜）：L1 注入形态回退 + 主链路硬闸门

这一节修的是线上反馈的两个问题，**优先级高于本文之前的所有相关结论**。

### 11.1 现象

1. **回显串味**：开启召回后发消息，前端把召回块和用户发的话**一起显示在同一条消息里**
   （用户原话："回显的时候移除召回的内容，只在前端上展示用户发送的消息"）。
2. **一直阻塞等待**：改成 prepend 并重启后，发消息触发召回时"会一直阻塞等待
   （看起来像是触发了死循环）"。

### 11.2 日志证据（会话 JSONL + 进程状态）

会话日志在 `~/.dsh/sessions/--<cwd>--/<sessionId>/session.jsonl.zstd`
（`dsh-session-persistence-jsonl`，多 zstd 帧拼接，用 `zstd -dc` 解，Node 的
`zstdDecompressSync` 只解第一帧）。实测证据：

| 证据 | 位置 | 结论 |
| --- | --- | --- |
| `user/message` 正文 = `<tdai_recalled_l1_memories>…` + 真人原话 | `session-<id>…` seq 89000（2026-09-15T15:25:05Z） | prepend **真的被持久化成用户发言**：现象 1 的直接原因 |
| 同一条消息的 `source` 仍是 `{ kind: 'user', rpcId: … }` | 同上 | 结构判据认不出注入部分，回写只能靠文本哨兵 |
| 宿主的 inbox 原始消息（`agent/inbox/spliced` seq 88996）**不含**召回块 | 同上 | 召回块是插件在 pre-step 里加进去的，不是用户输入 |
| `dsh web` 进程 4 分 38 秒内 CPU 仅 9 秒（3.4%）、RSS 351MB | `ps` 于 23:25（另一会话里跑过） | 现象 2 **不是** JS 忙循环，而是在等 I/O |
| 受影响会话的日志在投诉时间点**没有** `agent/inbox/spliced` | `session-<id>…` 只有 header + 3 条 preset 事件 | 那条消息**没进到服务端**（前端/连接层的问题），插件侧无法解释"没有事件" |
| 卡住的时间点正值**手工重启**（新 token 的 `dsh web`），页面是上一进程打开的 | `~/.dsh/restart-helper-111898.log`、`dsh-web.log` | 高度怀疑根因是**页面与旧进程的连接**，与召回无关 |

**结论（不夸大）**：现象 1 由 prepend 直接造成，已修（§11.3）。
现象 2 没有插件侧的忙循环证据，但插件确实有**两条会无限期/反复等待网络**的路径
（§11.4），它们足以制造"像死循环一样一直等"的体验，因此一并加了硬闸门。

### 11.3 修复 A · 注入形态：独立 plugin 消息

`lib/recall.mjs` 的落点从"prepend 进真人消息"改为：

```js
{ id: <uuid>, role: 'user', content: [{ type: 'text', text: block }],
  source: { kind: 'plugin', plugin: 'dsh-tdai-memory-plugin', form: 'notice', summary: 'TDAI L1 召回 4 条（最高分 0.683）' } }
```

插在本轮**真人消息之后**（与 `dsh-session-reference` 的 `additionalContext` 一致），
不追加到末尾。三条收益，全部对应上面那张证据表：

1. 真人消息**一个字节都不动** → 前端气泡干净（`unshift` 之前是把它写进用户发言）；
2. `source.kind === 'plugin'` → `lib/capture.mjs` 按结构整条丢弃，L0 不再需要靠文本猜；
3. 宿主所有"真人发言"判据（`turn-outline` 的 prompt、`titleInput`、
   `lastPromptAt`、客户端按 `rpcId` 清 pending echo）都只认 `source.kind === 'user'`，
   自动忽略这条消息 —— 我们不再污染它们。

前端渲染：客户端把 `kind: 'plugin'` 映射为"上下文注入"角色
（`dsh-client-ui-chat/lib/client.js` 的 `contextProvenance`），`form: 'notice'` 让
折叠行显示 `source.summary`，正文只在展开时出现（`ContextInjectionRow`）。
`summary` 里**只放条数与最高分，不放记忆正文**。

### 11.4 修复 B · 三道硬闸门（禁止无限期等待网络）

读侧对 MemoryCore 的调用全部发生在模型请求之前，原实现有两处会把整轮拖住：

| 位置 | 原行为 | 现行为 |
| --- | --- | --- |
| `agent/pre-step`（召回） | `await assets.ensure()` —— 冷启动时把整包资产加载（meta 面 + 自有/借入 L3/L2 + skill listing + 知识资源，分组串行、每请求 5s 超时）挡在模型请求前；随后再 `await searchL1`，同样无上限 | **不等待**：`peek()` 命中就用（含借入 agent），否则退回自有 agent 立刻检索，同时 `warm()` 后台预热；检索带 `recallTimeoutMs` 硬超时，超时即放弃本轮召回 |
| `SessionAssets.ensure()`（assemble 注入） | 失败即删缓存 → **每一步**都重拉整包资产（网关慢/挂时每步几十秒，看起来像死循环） | 整包加载加**总预算** `assetLoadBudgetMs`（超预算按失败降级，缺块也照常回答）；失败后进入 `assetRetryCooldownMs` **冷却期**，期内一律走降级路径；`refresh()`（`/tdai-sync`）无视冷却期立刻重试 |

`peek()` 仍然只读缓存、绝不发请求，所以同步的 section/context 求值路径不受影响。

### 11.5 护栏测试

| 断言 | 文件 |
| --- | --- |
| 真人消息**逐字段**不变；召回块是独立 `plugin`+`notice` 消息且紧跟其后 | `test/recall.test.mjs` 用例 5 |
| `summary ≤ 120` 字符且不泄露记忆正文（`CONTEXT_SUMMARY_MAX_CHARS`） | 同上 |
| `decision.messages` 为空时**绝不注入**（否则宿主 `length === 0` 的轮次结束判据失效，轮次永不结束） | `test/recall.test.mjs` 用例 5e |
| 资产缓存为空（`warm` 永不落定）时 pre-step 仍在 500ms 内返回并完成召回 | `test/recall.test.mjs` 用例 6 |
| abort 后不检索、检索异常 fail-open | `test/recall.test.mjs` 用例 7/8 |
| 永不返回的网关被总预算封顶 | `test/assets-budget.test.mjs` 用例 1 |
| 失败后冷却期内只打一次网关（模拟同轮 5 步） | `test/assets-budget.test.mjs` 用例 2 |
| 冷却期为 0 时保留老行为；`refresh()` 破冷却；并发幂等；`dispose()` 清失败记录 | `test/assets-budget.test.mjs` 用例 3–6 |
| 存量 prepend 形态的正文仍被按块剥离（历史消息） | `test/capture-filter.test.mjs` 用例 3/3b |

### 11.6 回退方案

若模型把这条独立消息误读成"用户又说了话"（表现为跟召回内容对话），
可把 `form: 'notice'` 换成不声明 `form`（客户端退化为 opaque 折叠行，语义更弱），
或把落点改到 `decision.messages` 末尾（离问题更远）。两者都只改
`lib/recall.mjs` 的 `recalledNotice()` 与一行 `splice`。
