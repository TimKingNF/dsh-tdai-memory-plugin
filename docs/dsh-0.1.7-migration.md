# DSH 0.1.7-rc.1 兼容性审计与迁移记录

> 本文件记录 **0.4.0（钉在 DSH `0.1.2-rc.1`）→ 0.1.7-rc.1** 的兼容性审计结论与迁移决策。
> 审计时间：DSH 升级到 `0.1.7-rc.1` 之后。修复完成前，本文件是**问题清单**；
> 修复完成后，它是**迁移账**（每项标注落地位置与验证方式）。

## 0. 结论速览

| 面 | 结论 |
| --- | --- |
| 读侧主链路（system 注入 / 只读工具） | **可用**，全部服务与事件签名未变 |
| L1 召回的 pre-step 注入 | **硬失败（已修）**：注入消息用了 v3 的 `kind:'plugin'`，v4 格式入库时**直接拒绝整轮**（`本轮运行失败 format v4 message requires a producer-owned source kind`）。见 §3.3 |
| 写侧主链路（L0 回流 / Skill 归档） | **可用**，durable 事件名与形状未变 |
| 知识 skill（`skills.register`） | **可用** |
| slash 命令（`commands.register`） | **可用** |
| Web 设置面板（host 命名空间 + client 卡片） | **失效**：host API 与 client 服务/槽位全被移除，且新模型还要求 `Config` 有 volatile 字段（§1.4） |
| 会话建立时的资产预热 | **静默失效**：`agent/session-start` 事件已不存在 |
| `agent/pre-step` 改写 decision | **契约漂移**：新版要求 spread，现有实现新建对象 |
| 当前程序集 | 审计时**插件根本没被加载**（升级后不在 profile 组合里）；本次已装回并验证 |

审计方法（可复现）：

1. **live inspect**：`cordis_inspect_query` 的 host `Service.listService` / `Event.listEvents` / `Config.listConfigs`
   —— 读的是**运行中 0.1.7-rc.1 自己声明的**服务、事件与 loader entry，是运行时权威。
2. **安装包源码**：`~/.nvm/.../node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-*/lib/**`
   —— 随包发布的 `lib/index.js` 与 `lib/types/**/*.d.ts`（含 JSDoc），是契约权威。
3. **profile 实况**：`~/.dsh/profiles/web/{package.json,cordis.patch.yml}` 与 `node_modules`。

> 浏览器侧 inspect（`platform: "client"`）需要当前页面回传响应，审计期间页面未应答，
> 因此 client 侧结论全部来自**随包发布的 client bundle 与 `.d.ts`**，不依赖浏览器。

## 1. 硬失效：Web 设置面板（三处，host + client 全断）

### 1.1 host：`settings.register()` 已被移除

- 旧实现：`lib/settings.mjs` 调 `settingsCtx.settings.register(NS, schema, { base, applies: 'live' })`，
  返回 scope（`scope.get()` / `scope.watch(cb)`）。
- 0.1.7-rc.1 实况（live inspect，服务 `settings`）：方法只有
  `configure` / `prepareDocument` / `describe` / `update` / `replace` / `mutate`，**没有 `register`**，
  也没有返回 scope 的概念。
- 新版模型（`@deepseek-ai/dsh-settings` JSDoc）：插件**导出 `Config`（schemastery schema）**，
  settings 服务把「active plugin schema」投影成表单；读写由 `describe/update/replace/mutate` 完成，
  命名空间 key 就是**profile patch 的 entry id**。
- 现有后果：`settings.register(...)` 抛 `TypeError`，被自己的 `try/catch` 吞掉，只落一行
  `settings unavailable: ...` 日志；面板命名空间不存在。
- **现场证据**（升级后那次启动的日志，0.4.0 + 0.1.7-rc.1，`~/.dsh/logs/startup-2026-09-25T07-49-06.705Z-*.log`）：

  ```
  { name: 'dsh-tdai-memory-plugin', type: 'warn',
    args: [ '[tdai-memory] settings unavailable: settingsCtx.settings.register is not a function' ] }
  { name: 'dsh-context', type: 'error',
    args: [ TypeError: sctx.settings.register is not a function
              at ... dsh-context/lib/index.js:1726:17 ] }
  ```

  关于同一份日志里的 `dsh-context` 报错：**那是旧构建的残留，不是当前状态**。该日志时间戳为
  07:49（日志文件 `startup-2026-09-25T07-49-06.705Z-*.log`，mtime 15:49 本地 = 07:49 UTC），
  而 profile 里的 `dsh-context` 文件在 08:21 被重装过。当前安装的 `dsh-context@0.56.1`：
  - `lib/index.js` / `lib/client.js` 里 **`settings.register` 出现 0 次**；
  - host 半改用 `typeof settings?.get === 'function'` 的**能力探测**（拿不到就返回 null，不抛）；
  - client 半同时有 `ctx.inject(["settingsScope"], …)` 与 `ctx.inject(["configForms"], …)`
    两条分支，会自适应到新版服务。
  - live loader：`include:dsh-context` → `enabled: true, fiberPhase: "active"`。

  即：**同一个 API 删除确实会打破老三方插件的启动**（这条日志就是证据），但 `dsh-context`
  已经自己修好了，本插件无需为它做任何事。

### 1.2 client：`settingsScope` 服务已被移除

- 旧实现：`client.card.tsx` 声明 `inject = ['settingsScope', 'slots']`，
  组件内 `ctx.settingsScope.bind({ namespace: NS })` 取 `{ getSnapshot, subscribe, mutate }`。
- 0.1.7-rc.1 实况：**整个装机 grep 不到 `settingsScope`** —— 覆盖全部 `@deepseek-ai/dsh-*`
  包、预构建前端 `@deepseek-ai/dsh-web-frontend/dist`、以及 profile 的 `node_modules`。
  唯一命中是 `dsh-context@0.56.1`、`dshmarket@1.65.1` 的客户端**消费**代码
  （`ctx.inject(["settingsScope"], ...)`），没有任何包 provide 它。
- 新版替代：客户端服务 **`configForms`**（`ConfigForms` / `ConfigForm`，见
  `dsh-client-ui-settings/lib/types/client/config-form*.d.ts`）：
  - `ctx.configForms.get(entryId)` → `ConfigForm`：`getSnapshot()` / `subscribe()` /
    `set(field, value)` / `unset(field)` / `mutate(ops, expectedRevision?)`；
  - `snapshot.status: 'loading' | 'ready' | 'unavailable'`、`value` / `base` / `user` /
    `revision` / `writable` / `mode: 'host' | 'memory'`；
  - `ctx.configForms.describe()` 给跨命名空间只读面；`whileServed(nss, register)` 给
    「宿主确实提供该命名空间才挂载页面」的推荐姿势；
  - 另有 `settingsSchema`（纯 schema 内省）与 `ctx.configForms.developerTools`。
- 现有后果：cordis 永远等不到 `settingsScope` → 客户端插件 apply 从不执行 →
  **卡片静默不挂载**（不报错、不占位）。

### 1.3 client：槽位 `settings.plugin.item` 已被移除

- 旧实现：`ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({ name, key }, () => <Card/>))`。
- 0.1.7-rc.1 实况（`dsh-client-ui-settings/lib/types/client/contract/slots.d.ts`）：settings 域槽位为
  `settings.launcher` / `settings.trigger` / `settings.header` / `settings.action` / `settings.close` /
  **`settings.section`** / **`settings.plugins.tab`** / `settings.onboarding` / `settings.general.item`。
  没有 `settings.plugin.item`。
- 语义对照：
  - `settings.section`：list 槽，一个注册项 = 设置面板里的一个导航页；注册选项 `{ id, order, label }`，
    owner props `{ close }`。由 settings 外壳（`dsh-client-ui-settings-general`）声明。
  - `settings.plugins.tab`：list 槽，Plugins 设置分区里的一个 tab；注册选项 `{ id, order, label }`，
    owner props 为空。由 Plugins 分区（`dsh-client-ui-settings-plugins`）在运行时声明，
    官方 `dsh-client-ui-settings-plugin-inventory` 就注册在这里。
- 现有后果：即使服务问题解决，注册也会落在一个没人声明、没人渲染的槽名上。
- **选哪个新槽位（实测结论，走过弯路）**：第一版选了 `settings.plugins.tab`（语义上最接近旧的
  "设置 → 插件"，官方 inventory 也在那），装好后**用户在设置导航里看不到任何东西**，直接反馈
  "没有设置项" —— 二级 tab 藏在「内置插件」里面，等于没有。
  最终改挂 **`settings.section`**：它是设置面板左侧的**顶层导航页**，profile 里的第三方插件
  （`dsh-better-sidebar` / `dsh-workspace-drag` / `dshmarket`）全都用这一个。注册形状照抄
  `dsh-better-sidebar`：

  ```js
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'tdai-memory', order: 200, label: () => 'TDAI Memory',
    inject: () => ({ form, describe, entryId }),
  }, TdaiMemoryCard))
  ```

  并且**不使用 `whileServed` 包一层**：无条件注册让"客户端加载成功但宿主命名空间缺失"变成一条
  **可见的自解释条目**；`whileServed` 会把这种半坏状态藏成"什么都没有"，反而不可诊断。

### 1.4 `describe()` 只收录含 `.volatile()` 字段的 entry —— `Config` 必须按这个约定写

这是整个迁移里**最难从表面看出来**的一环，也是"设置页显示不可用"的真正根因。

- `dsh-settings` 的 `describe()`（`lib/index.js:413`）对每个 loader entry 先算
  `volatileForm(schema)`：对象节点**只保留标了 volatile 的子字段**，一个都没有就返回
  `undefined`，而 `describe()` 对 `undefined` 的 entry **直接跳过**：

  ```js
  const form = volatileForm(schema);
  if (form === void 0) return [];        // ← 没有 volatile 字段 = 这个 entry 不存在
  ...
  const value = projectForm(form, plainConfig(entry.fiber.config));   // 也只投影 volatile 字段
  ```

- 本插件最初**故意一个字段都没标 volatile**（认为"配置变更走重新 apply"更干净），于是：
  `describe()` 里没有 `tdai-memory` → 客户端 `configForms.get('tdai-memory')` 恒为
  `unavailable` → 卡片渲染「设置当前不可用」。
- 正确约定（官方同款）：**volatile == 用户可在设置页编辑的字段**。
  `dsh-client-ui-conversation` 整个 `Config` 只有一个 volatile 字段（Composer Enter 行为）；
  `dsh-agent-default-model` 三个字段全 volatile。部署期配置（如"密钥所在的环境变量名"）
  保持非 volatile，既不进表单、也不受面板写入影响。
- **版本要求**：`.volatile()` 方法本身、以及"校验后为 volatile 字段生成 `{ get() }` 访问器"
  都是 **schemastery 3.18.4** 才有的。插件原先锁的 3.18.2 里：
  - 没有 `.volatile()`（只有 meta 可写）；
  - 即使手写 `meta.volatile = true`，校验结果仍是**普通值**，而 loader 的
    `_commitVolatile` 依赖访问器原地更新 → 面板写入会静默无效。
  所以依赖升到 `^3.18.4`。跨副本安全：volatile 标记是
  `Symbol.for("cosmokit.volatile.write")`（cosmokit 注释明确写着"Identify references across
  ESM/CJS copies of the shared library"），因此插件自带一份 schemastery 也不会和宿主错位。
- **连带语义变化**：volatile 字段变更时 cordis **不会重新 apply 插件**（loader 只调
  `_commitVolatile` 原地更新访问器）。插件侧相应改成"读实时值 + 派生对象惰性重建"：
  `config.mjs` 的 `liveValue()`；`index.mjs` 里 `live()` 按配置签名重建 `client`/`assets`。

## 2. 静默降级：`agent/session-start` 已不存在

- 旧实现：`index.mjs` 监听 `agent/session-start` 预热会话资产。
- 0.1.7-rc.1 实况：live 事件目录里没有它；全部 `@deepseek-ai/dsh-*/lib` grep `session-start` 为 0 处。
  相关事件改为：
  - `agent/created`（**serial**，`payload: { agent, source: SessionStartSource, signal? }`）——
    每个 agent 进入注册表后的初始化点，也是官方 practices 推荐的注册点；
  - `session/created`（emit，`(session)`）——会话发布公告。
- 现有后果：监听永不触发 → 新会话首轮少一次预热。因为 `system-prompt/assemble` 里仍会
  `assets.ensure()`，表现为「每会话第一次稍慢」，不会丢功能。

## 3. 契约漂移（现在能跑，但已违反新版明文约定）

### 3.1 `agent/pre-step` 的 enter decision 需要 spread

- 0.1.7-rc.1 的 `PreStepDecision`：
  `{ kind:'enter'; messages: UserMessage[]; startsRequestSeries?: true }`。
- 官方 practices（`references/practices.md` §Stability）明确：不拥有决策的 waterfall listener
  必须 spread（`{ ...decision, messages }`），否则会丢掉 `startsRequestSeries` 这类字段。
- 现有实现：`lib/recall.mjs` 注入召回块时 `return { kind: 'enter', messages }`（新建对象），
  会吞掉内层 listener 设的 `startsRequestSeries`。同文件另一处兜底反而是 spread 的。

### 3.2 `system-prompt/assemble` 仍可用，但已不被推荐用于改文本

- 0.1.7-rc.1 事件签名未变：`(assembly, context, next)`，`PromptAssembly.sections[]` 仍是
  `{ name, text, interpolate? }`，空段仍被 `renderPrompt()` 丢弃。
- 但官方 practices 写：「不要监听 `system-prompt/assemble` 来增删工具或文本，加提示词文本用
  `ctx.systemPrompt.section()`」。本插件的动态注入**整体**建在 assemble 上（这是为「发 model
  请求前 await 资产」有意做的设计，见 `docs/prompt-injection-redesign.md`）。
- 迁移决策：**保留** assemble 兜底（签名兼容、语义需要 await），但在文件头注明这是
  有意的偏离及其理由，并确保只覆盖自己注册的段。

### 3.3 召回消息的 `source.kind: 'plugin'` 是**硬失败**（不是"类型层漂移"）

- 0.1.7-rc.1 的 `MessageSourceMap` 只有 `user` / `model` / `tool` / `system-prompt`，
  JSDoc 明确「there is no shared catch-all `plugin` kind」：kind 是 merge-extensible 的，
  每个生产方在自己的模块里声明自己的 kind。
- **v4 会话格式对 `'plugin'` 是硬拒绝**（`dsh-session-format-v3-to-v4/lib/index.js:126`）：

  ```js
  if (... || value["kind"] === "plugin") throw new SessionFormatError("format v4 message requires a producer-owned source kind");
  ```

  真机表现（2026-09-25，读侧开关打开后发消息）：
  `本轮运行失败 format v4 message requires a producer-owned source kind` —— **整轮失败**，
  不是渲染问题。这正是 v3→v4 迁移里被废弃的"万能包装"。
- ⚠️ **审计判断错在哪**：只查了 `dsh-session` 的 `assertMessageEventShape`（它对 `user/message`
  只要求 `source.kind` 是非空字符串），就得出"运行时可持久化、客户端可渲染"的结论。
  真正的门在**会话格式层**（`dsh-session-format-v3-to-v4` 的 `assertV4RowAdmission`
  → `source()`），审计时没有覆盖到。教训：一条消息能不能入库，要查的是**格式版校验**，
  不只是事件形状校验。
- **正确的 kind**：同一包的 `producerKind(plugin, role)` 给出旧日志的规范映射 ——
  未知第三方插件 → `` `plugin:${plugin}` ``，且 `rewritePluginSource` 会丢掉旧的 `plugin` 字段。
  宿主自己注入 runtime context 时用的也是生产者身份（`dsh-agent-loop` 的
  `SOURCE = "runtime-context"`）。
- 修复：`lib/recall.mjs` 导出 `SOURCE_KIND = \`plugin:${PLUGIN_NAME}\``，
  注入消息用 `source: { kind: SOURCE_KIND, form: 'notice', summary }`（**不再带 `plugin` 字段**）。
  这样老会话（v3 迁移得到的 kind）与新消息的 kind 完全一致。
- 复核方式（用**真校验器**，不是复刻规则）：

  ```js
  const { assertV4RowAdmission } = await import('@deepseek-ai/dsh-session-format-v3-to-v4')
  assertV4RowAdmission({ type: 'user/message', data: msg })
  // 旧 {kind:'plugin', plugin:…} → REJECT: format v4 message requires a producer-owned source kind
  // 新 {kind:'plugin:dsh-tdai-memory-plugin', …} → PASS
  ```

  测试侧另有护栏（`test/recall.test.mjs`）：kind 必须非空、**不得等于 `'plugin'`**、
  且不得残留 v3 的 `plugin` 字段。

### 3.4 手抄的 `SECTION_ORDERS` 副本已过期

- `test/section-registry.test.mjs` 里抄了一份 DSH 的 order 表（README 已警告需手工同步）。
  相对于 0.1.7-rc.1，它少了 `TOOL_REPORT: 2900`、`TOOL_COMPUTER_USE: 3000`、`MCP_SERVERS: 3100`、
  `TOOLS_SDK: 5000`、`DELIVERABLE_FILE_REFERENCES: 9000`、`STRUCTURED_OUTPUT: 9900`、persona
  prefix/suffix 等，还留着已不存在的 `TOOL_CORDIS: 2500`。
- 好消息：0.1.7-rc.1 的 500–599 带仍无人占，插件用的 **520–523**（section）与
  **560**（context）**继续安全**；`CONTEXT_ORDERS` 目前是 110/115/120。
- 迁移决策：同步副本，并把 `CONTEXT_ORDERS` 也纳入断言。

## 4. 逐项核对通过的部分

| 契约 | 0.1.7-rc.1 实况 | 插件用法 |
| --- | --- | --- |
| `ctx.tools.register` | `register(definition: ToolDefinition)`；`output: { schema, render(args, value) }` 仍必填 | 已提供 `output`，`render(args, value)` 签名正确 |
| `ctx.systemPrompt.section` | `section({ name, order, text: string \| (ctx) => string })`，同层重名抛错 | 4 个段名唯一，order 520–523 |
| `ctx.systemPrompt.context` | `context({ name, order, text })` | `tdai:state` order 560 |
| `system-prompt/assemble` | waterfall `(assembly, context, next)` | 签名一致 |
| `agent/pre-step` | waterfall `(payload: { agent, messages, turn, step, signal }, next)` | payload 形状一致 |
| `ctx.skills.register` | `SkillRegistration = Omit<SkillDefinition,'invocation'\|'provider'> & {…}`；`SkillSource` 含 `'runtime'` | `source:'runtime'` 合法 |
| `ctx.commands.register` | `{ name, description, handler(invocation) }`；`CommandResult = {kind:'success',text?} \| {kind:'error',text}` | 一致 |
| 服务名 | `tools` / `systemPrompt` / `sessions` / `commands` / `skills` / `settings` 均在 | 一致（`settings` 接口已变，见 §1.1） |
| 写侧事件 | `session/event` / `agent/error` / `agent/turn-stopping` / `session/flush` / `session/disposed` 均在，参数形状一致 | 一致 |
| durable 会话事件 | `user/message` / `assistant/message` / `tool/result` / `turn/start` / `step/start` / `turn/end` 未变 | 一致 |
| `SessionHeader` | `origin?: 'subagent'`、`delegationDepth`、`parentSession` 均在 | 一致 |
| 客户端模块格式 | `window.__ModuleLoader__.load({ id: <包名>, factory(require) })`，React 来自模块表 | 一致 |
| `dsh` manifest | `dsh.bundle.patch` 与 `dsh.client.{ platform, inject?, immediately?, external? }` | `{ platform: 'web' }` 合法 |
| patch 方言 | `insert` / `id` / `name` / `inject` / `config` / `!!js` 均支持 | 一致 |

自测状态：`npm test` 26 项全绿，但宿主全是**自己写的 mock**（连 `settings.register` 的假实现
也是 mock 的），因此**不能作为 0.1.7-rc.1 兼容证据**。

## 5. 审计时的程序集状态：插件根本没被加载

- live `Config.listConfigs`：运行中的 host 有 **188 个 loader entry**，含 profile 插件
  `dsh-better-sidebar` / `dsh-context` / `dsh-power-button` / `dshmarket` 等，
  **没有任何 `dsh-tdai-memory-plugin` entry**；按包名过滤返回 `total: 0`。
- `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 与 `cordis.patch.yml` 里都没有它，
  只剩 `node_modules/dsh-tdai-memory-plugin` 一条指向本仓库的 symlink。
- 结论：升级那轮 profile 重建把它从组合里丢掉了 —— 当时是**完全没生效**，不是部分降级。
  （§1.1 的现场日志证明它在升级刚开始时确实被挂载过。）

## 6. 迁移落地（本次修复执行的内容）

| 项 | 决策 | 落地位置 |
| --- | --- | --- |
| host 配置 | 导出 `export const Config`（schemastery），字段沿用现有 config 键名 + `apiKeyEnv`（原先不在 schema 里，靠"未知键被保留"侥幸能用） | `index.mjs`、`lib/settings.mjs` |
| 面板可见性 | **面板上的 19 个字段全部 `.volatile()`**（= "用户可编辑"），部署期 6 个字段保持非 volatile；依赖升到 `@deepseek-ai/schemastery@^3.18.4`（3.18.2 没有 `.volatile()`、也不生成访问器）。新增导出 `VOLATILE_KEYS` / `PATCH_ONLY_KEYS` | `lib/settings.mjs`、`package.json` |
| env 值类型 | **布尔/数字字段用 union 接受字符串**：patch 的 `!!js … ?? ''` 在 env 未设置时给 `''`，裸 `z.boolean()` / `z.natural()` 遇 `''` 直接抛 → 整个 entry 加载失败。归一化仍由 `config.mjs` 的 `boolOpt`/`numOpt` 负责。**不用 `z.transform()`**：其回调会被 `toJSON()` 按源码序列化，客户端 rehydrate 时重新求值，引用外部常量即报 `FALSEY is not defined`（已实测） | `lib/settings.mjs` |
| 自动表单 | 保留自定义设置页，故 host 侧 `settings.configure({ auto: false }, ctx.fiber)`（包在 `child.effect(...)` 里） | `lib/settings.mjs` |
| 配置读取 | volatile 字段是 `{ get() }` 访问器且**不触发重新 apply** → `config.mjs` 加 `liveValue()` 统一取值归一化；`index.mjs` 的 `client`/`assets` 改为**按配置签名惰性重建**（每次读都重新 `resolveConfig()`，签名变了就重建派生对象并丢弃会话资产缓存） | `config.mjs`、`index.mjs` |
| 开机自检 | 启动后查一次 `describe()`，把 `settings: namespace "tdai-memory" served/NOT served` 写进**宿主日志** —— 这一环在客户端只能看到一个笼统的 `unavailable` | `lib/settings.mjs` |
| 身份来源判定 | 改读 `settings.describe()` 里本 entry 的**用户层**：身份键出现在 `user` 才算面板改过（老实现比较"当前值 vs env 值"，改回同值会误判成 env） | `index.mjs`、`lib/settings.mjs` |
| client 卡片 | `inject = ['configForms', 'slots']`；`ctx.configForms.get(ENTRY_ID)` 取代 `settingsScope.bind`；注册到 **`settings.section`**（顶层设置导航页，与 profile 其它第三方插件一致），无条件注册 + 命名空间缺失时渲染自解释说明 | `client.card.tsx`（重建 `client.js`） |
| 密钥字段 | `z.string().role('secret')` 保留；明文跨 wire 就被 redact 删掉，卡片改为"留空 = 不改动"，并从 `describe().secrets` 侧信道显示「已设置」 | `lib/settings.mjs`、`client.card.tsx` |
| 预热事件 | `agent/session-start` → `agent/created`（`payload.agent.session`） | `index.mjs` |
| pre-step | 注入召回块改为 `{ ...decision, messages }` | `lib/recall.mjs` |
| 召回消息来源 | 保留 `form: 'notice'` + `summary` 与 `kind: 'plugin'`（运行时可持久化），把新版 kind 语义写进注释 | `lib/recall.mjs` |
| order 表 | 同步 `SECTION_ORDERS` + `CONTEXT_ORDERS` 到 0.1.7-rc.1，并断言 520–523 / 560 未被占用 | `test/section-registry.test.mjs` |
| 兼容性声明 | README 双语「测试范围」表改钉 `0.1.7-rc.1`，并记录 0.4.0 在 0.1.7-rc.1 上的失效现象 | `README.md`、`README_CN.md`、`CHANGELOG.md` |
| 新增护栏 | ① patch 透传的 env 值必须能通过 `Config` 校验；② pre-step 必须保留 decision 的额外字段；③ 客户端产物不得再含 `settingsScope` / `settings.plugin.item`，必须含 `configForms` / `settings.section`，且不得再出现 `settings.plugins.tab`；④ 命名空间缺失时必须渲染可见的自解释说明；⑤ 不再监听 `agent/session-start`；⑥ **`Config` 的 volatile 投影必须非空、且覆盖面板上的每个字段**（复刻 `volatileForm` 语义），volatile 字段校验后必须是 `{ get() }` 访问器 | `test/load.test.mjs`、`test/recall.test.mjs`、`test/settings-card.test.mjs`、`test/settings-card-render.test.mjs`、`test/subagent.test.mjs`、`test/smoke.test.mjs` |

## 7. 真机验证结果（DSH `0.1.7-rc.1`）

验证方式：`plugin_manager install_bundle` 把本仓库以 `link:` 装进 `web` profile（`application: applied`），
然后在运行中的 host 上读取活状态。

| 验证点 | 结果 |
| --- | --- |
| loader entry | `include:tdai-memory`（patchId `tdai-memory`），`status: "schema"` —— 说明导出的 `Config` 被 settings 服务识别并投影 |
| Config 投影 | `acceptsMissing: true`、`limitations: []`；布尔字段投影为 `boolean \| string \| null` + 默认值，数字字段投影为 `integer(min…max) \| string` + 默认值，`userKey` 带 `"x-cordis": {"role":"secret"}`；patch 的 `!!js` 值以 `$defs/loaderExpression` 分支被接受 |
| 工具注册 | live Tool 目录出现全部 10 个 `tdai_*` 工具（含 2 个知识工具），参数 schema 正确 |
| 工具端到端 | 直接调用 `tdai_scenario_ls`：经 live tool pipeline 派发到本插件的 `execute(args, exec)`，按预期返回「TDAI memory 未启用（总开关关闭或身份未配置）」——证明注册→schema→dispatch→`exec.agent.session` 解析整条链在 0.1.7-rc.1 上可用 |
| 客户端产物 | 页面 `__DSH_BOOT__` 含 `{"id":"dsh-tdai-memory-plugin","url":"plugins/??dsh-tdai-memory-plugin/client.js&rev=…"}`，并被 application 批次脚本实际下发 |
| 客户端产物内容 | 直接从运行中的 server 取该 URL（`HTTP 200`，13231 bytes）：**含 `configForms`，`settingsScope` 出现 0 次** —— 浏览器拿到的是迁移后的产物，不是旧卡片 |
| 自测 | `npm test` 全绿（16 个测试脚本，含新增护栏） |

**未覆盖 / 限制**：浏览器侧 inspect（`platform: "client"`）**会对页面发起一次需要页面应答的查询**，
应答不了就一直挂着，把页面和当轮一起堵住 —— 本次踩过两次，后续一律不再用它做常规诊断，改用
磁盘证据 + 让用户看页面确认。

已确认的是：客户端产物**内容正确且已被下发**（见上表最后两行），注册所依赖的服务与槽位在装机里
确实存在（`configForms` 由 `@deepseek-ai/dsh-client-ui-settings` 提供、`settings.section` 由
`@deepseek-ai/dsh-client-ui-settings-general` 声明，两者都在 boot graph 里），且命名空间键约定已用
官方 settings 页反查确认（官方 `_NS` 等于 profile patch 的 entry id，例如 `agent-loop`、
`web-search-deepseek`）。**注意：客户端半边只随页面加载生效** —— 装完插件后必须刷新页面，
旧页面里没有本插件的客户端条目。
