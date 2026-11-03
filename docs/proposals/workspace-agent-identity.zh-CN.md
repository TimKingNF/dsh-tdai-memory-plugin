# 工作区身份覆盖（多工作区多 Agent）设计与交互方案

> 状态：已落地（未发版）
> 代码入口：`config.mjs` 的 `identityForWorkspace()`、`lib/settings.mjs` 的
> `workspaceAgents*`、`client.card.tsx` 的「身份与工作区」Tab。
> 目标读者：后续维护插件的人、要配置多 Agent 的使用者。

## 1. 要解决的问题

插件原来是**进程级静态身份**：一个 DSH 进程只有一组
`instance / team / agent / user`。实际使用里同一个 DSH 进程会打开多个工作区
（`/repo/a`、`/repo/b`…），它们往往对应不同的 TDAI agent（不同角色 prompt、
不同 L2/L3 画像、不同知识绑定）。原来的唯一办法是开多个 DSH 进程，或者每次手动改
面板——前者重，后者容易忘、且改完影响所有工作区。

本方案要做的只有一件事：

> **按会话的工作目录（`session.header.cwd`）选择 Agent / Team；没有匹配规则的会话，
> 继续使用默认身份。**

不做的事：

- 不改 `userId` / `serviceId` / `userKey` / `taskId`：用户维度仍共用同一个人。
- 不做按 session id、按 Bot、按模型的路由：那是另一类需求（Bot 侧的身份/记忆本来就恒关）。
- 不在服务端校验 agent 是否存在：TDAI agent 由 MemoryCore 管理，插件只负责把
  team/agent 放进请求；写错时由服务端返回错误，面板给使用提示。

## 2. 语义（必须逐条实现，别在调用点另做判断）

| 条件 | 结果 |
| --- | --- |
| `workspaceAgentsEnabled = false` | 一律默认身份 |
| 总开关开，但会话没有 `cwd` | 默认身份 |
| 总开关开，`cwd` 规范化后没有命中规则 | 默认身份 |
| 命中规则，`teamId` / `agentId` 都填了 | 覆盖这两个字段 |
| 命中规则，只填 `agentId` | team 用默认，agent 用规则 |
| 命中规则，只填 `teamId` | agent 用默认，team 用规则 |
| 规则里两个字段都为空 | 该条规则被归一化阶段丢弃，等价于没配 |
| 默认身份缺字段、命中规则补全了 | 该会话读侧可用（`identityComplete` 按有效身份判） |
| 默认身份缺字段、未命中规则 | 该会话读侧不可用，写侧不受影响 |

判定的**唯一入口**是 `config.mjs`：

```js
identityForWorkspace(cfg, cwd)
// → { cfg: 有效配置, rule: 命中的规则 | undefined }
```

`runtime.configFor(session)` / `runtime.identityFor(session)` /
`runtime.readEnabledFor(session)` 都从它派生；调用点不得自己按 `cwd` 匹配，
也不得直接把 `cfg.agentId` 当成“当前会话的 agent”。

### 2.1 为什么按路径，而不是 Workspace 的 uuid

- DSH 的 workspace 归属由会话 `header.cwd` 决定；同一个目录可能被多个入口创建，
  也可能没有登记成 Workspace 记录。路径是会话本来就有的、无需额外 RPC 的事实。
- Workspace 的 `title` 只用于面板显示；路径变了（目录移动）需要用户更新规则，
  这是显式行为，不在热路径上做 `realpath` 猜测（目录暂时不存在时不该静默失配）。

### 2.2 路径规范化

`normalizeWorkspacePath()` 只做轻量归一，不碰文件系统：

- `path.resolve`（相对路径按插件进程 cwd 解析）；
- 去掉末尾分隔符（根路径除外）；
- Windows 下转小写（大小写不敏感）。

不做 `realpath`：这一步在 pre-step / assemble 热路径上，且目录可能暂时被移动；
DSH Workspace 记录里存的是 canonical path，面板选择工作区时拿到的已经是规范路径。
手填路径的边界由轻量归一兜住。

## 3. 配置模型

```jsonc
{
  "workspaceAgentsEnabled": false,      // 默认关：升级后行为不变
  "workspaceAgents": [
    {
      "workspace": "/mnt/d/workspace/github/dsh-tdai-memory-plugin",
      "title": "dsh-tdai-memory-plugin", // 仅显示
      "teamId": "team-xxx",              // 留空 = 默认 team
      "agentId": "agt-xxx"               // 留空 = 默认 agent
    }
  ]
}
```

字段位置：

- `Config` schema：`lib/settings.mjs`；
- 运行时归一：`config.mjs` 的 `normalizeWorkspaceAgents()`（空串 / JSON 字符串 /
  数组三种形态都接受；坏条目丢弃；同路径后者覆盖前者）；
- 面板整表替换：`{ op:'set', path:['workspaceAgents'], value:[…] }`。
  数组节点整体标 `.volatile()`（settings 的 `volatileForm` 不递归 array）。

env 形态（可选，JSON 字符串）：

```bash
export TDAI_MEMORY_WORKSPACE_AGENTS_ENABLED=true
export TDAI_MEMORY_WORKSPACE_AGENTS='[{"workspace":"/repo/a","teamId":"team-a","agentId":"agt-a"}]'
```

## 4. 交互方案

### 4.1 顶层：4 个 Tab

旧版把所有开关、身份、Bot 参数堆在一页，内容多且没有层次。新版按使用场景拆成 4 个 Tab：

| Tab | 内容 |
| --- | --- |
| 读侧 | 读侧总开关、L1 召回 + 条数、云端 skill 召回 + 条数/分数、System prompt 注入 + 各注入段 |
| 写侧 | 对话回流、待办写入、子 agent 回写 |
| Bot 与子 agent | ds-bot 总闸、Bot skill 注入 / 回写、群聊蒸馏（高级参数默认收起）、子 agent 读侧继承 |
| 身份与工作区 | 默认身份、**工作区 Agent**、知识服务地址改写 / Task ID |

Tab 只改变**可见区域**，不改变保存语义：底部「放弃修改 / 保存」仍对整个草稿生效。

### 4.2 分组：原生 `<details>` 折叠

每个 Tab 内按分组折叠：

- 常用分组默认展开（读侧召回、注入、写侧回流、ds-bot 总闸、身份、工作区）；
- 高级参数默认收起（群聊窗口 / token / 超时 / 蒸馏模型 / 台账路径）。

好处：首屏只看到当前 Tab 的常用项；高级参数仍在同一页，展开即见，不需要记忆路径。
原生 `<details>` 不依赖 JS，窄屏 / 键盘 / 读屏都能用。

### 4.3 工作区 Agent 的交互

位置：`身份与工作区` Tab → `工作区 Agent` 分组。

1. **总开关**「按工作区覆盖 Agent / Team」（默认关）。
   - 关：列表仍显示（灰显），方便先配好再打开；下方说明「当前未启用：所有工作区都使用默认身份」。
2. **规则列表**，每条一张小卡：
   - 标题（Workspace title，没有则取路径最后一段）+ 完整路径；
   - Team ID 输入框，placeholder = `默认 <team>`；留空即回落；
   - Agent ID 输入框，placeholder = `默认 <agent>`；留空即回落；
   - 「移除」按钮。
3. **添加行**：
   - 输入框带 `list="tdai-workspace-options"`，下拉项来自设置页标准 props
     `useWorkspaces`（已登记工作区，显示 title）；没有该 props 时退化为手填绝对路径；
   - 「添加」按钮 / 回车添加；空路径、**非绝对路径**、重复路径都就地提示、不入表；
   - 判重按 `workspacePathKey()`（与运行期 `normalizeWorkspacePath()` 同口径：去尾分隔符、
     折叠 `.`/`..`、win32 小写）—— `/repo/a/` 与 `/repo/a` 算同一条，否则存下去会被
     运行期的"后者覆盖前者"静默吃掉一条；
   - 添加后先插入空 Team/Agent 行，用户再填；两栏都空的行保存时丢弃。
4. **状态提示**：
   - 顶部状态行：`读侧开 · 写侧开 · 工作区覆盖开（N 条）`；
   - 默认身份缺字段时，顶部直接点名（`默认身份缺 teamId/agentId`），读侧分组内另有解释：
     工作区覆盖补全缺失字段的会话仍可用。
5. **保存**：
   - 规则表随底部「保存」一起提交（整表）；
   - 保存前做一次纯函数归一：去空行、去两栏都空的行、非绝对路径报错、等价路径（按上面的
     判重键，而非原始字符串）重复报错并阻止保存；
   - 「放弃修改」恢复当前生效值。

### 4.4 横向溢出修复（旧版问题的根因与改法）

旧版根因：开关/数字项的 label 与长 hint 被塞进同一个 `white-space: nowrap` 的行，
身份字段的 hint 也挂在 label 同一行。内容宽度由最长 hint 决定，超过设置面板内容列
就出现横向滚动条。

改法：

- 每个开关改成**上下结构**：第一行 checkbox + 标签，第二行 hint；hint
  `overflow-wrap:anywhere`，不再 `nowrap`；
- 数字项同样：标签 + 输入框一行，hint 下一行；
- 输入框 `width:100%; min-width:0; max-width:100%; box-sizing:border-box`；
- 根容器 / 所有 flex/grid 容器加 `min-width:0`；
- 长路径、模型名、默认地址统一允许任意位置换行；
- 只有 Tab 按钮保留 `nowrap`（短标签，不会撑破）。

验收：设置面板只出现纵向滚动条；拉窄窗口时 hint 换行而不是出现横向滚动条。

## 5. 运行时链路（改代码时看这张表）

```
agent/created ──► runtime.readEnabledFor(session)
                  runtime.configFor(session) ──► effective cfg
                  assets.warm(sessionId, policy, cfg)

agent/pre-step ──► cfg = configFor(session)
                   readEnabledFor(session)
                   assets.warm(..., cfg)
                   searchL1 / searchSkills 用 cfg.teamId / cfg.agentId

system-prompt/assemble ──► cfg = configFor(session)
                           assets.ensure(sessionId, policy, cfg)
                           renderers 用 cfg（identity / 开关）

tools / commands / capture ──► identityFor(session)
                                └─ 工具上下文只有 { id } 时，index.mjs 用
                                   ctx.sessions.get(id) 补 header.cwd
```

`SessionAssets` 的缓存 key 带 `teamId|agentId`：同一个 SessionAssets 实例服务整个进程，
不同工作区传入不同身份时，旧 agent 的画像不能当成新身份的资产返回。

`/tdai-status` 新增：

- `身份来源: workspace（工作区覆盖：<path>）` 或 `env` / `settings`；
- `工作区: <cwd>（覆盖总开关=开/关，规则 N 条）`；
- `身份：... team=... agent=...` 打印的是**有效值**。

## 6. 边界与风险

| 风险 | 处理 |
| --- | --- |
| 目录移动 / 改名后规则失配 | 路径是显式配置；失配回落默认身份，不静默套用别的 agent。`/tdai-status` 会打印当前 cwd 与命中规则，便于排查。 |
| 同一个工作区配了两条规则 | 面板按 `workspacePathKey()`（与运行期同口径）判重并在保存时拦截，`/repo/a/` 与 `/repo/a` 也算同一条；env / 手改配置文件由 `normalizeWorkspaceAgents()` 后者覆盖前者。 |
| 规则只填了 team，agent 留空 | 允许：agent 回落默认。只填 agent 同理。两栏都空的行丢弃。 |
| 手填相对路径 | 面板直接拦住（提示"必须是绝对路径"）。运行期 `path.resolve` 会按插件进程 cwd 解析，相对路径永远匹配不上会话 cwd，属于静默失效。 |
| 默认身份不完整 | 读侧按有效身份判；未命中规则的会话仍不可用。面板告警点名缺项，并说明工作区覆盖例外。 |
| User Key 跨 team | User Key 仍是全局一份；跨 team 使用时需确认它在该 team 有效（面板有提示）。 |
| 服务端 agent 不存在 | 插件不做存在性校验；请求会按服务端错误返回。面板提示“Agent 必须已存在于该 Team 下”。 |
| 子 agent / Bot 会话 | 子会话继承父会话 cwd，通常命中同一规则；Bot 会话的身份/记忆本来就恒关（`lib/dsbot.mjs`），覆盖不会改变那部分策略。 |
| 热更新 | volatile 字段不会重新 apply；`runtime.configFor` 每次按实时配置解析，面板改完新会话立即生效。规则表变化会改变 `live()` 的配置签名，整份 `SessionAssets` 随之重建（所有会话的资产缓存一起失效、下一轮重载）；缓存 key 里的身份只是并发加载时的第二道防线。 |

## 7. 回滚

把「按工作区覆盖 Agent / Team」关掉即可：`workspaceAgentsEnabled=false` 时
所有会话走默认身份，规则表保留但不起作用。也可以清空规则表。两者都不需要重启进程。

## 8. 验收 / 测试

- `test/workspace-agents.test.mjs`：路径归一、规则归一（数组 / JSON / 空串 / 坏条目 /
  同路径后者覆盖）、总开关关闭、全量与部分覆盖、未命中回落、覆盖补全默认身份、
  service/user/task 不被覆盖。
- `test/assets-budget.test.mjs`：同一会话切换有效身份时资产必须重载，不能复用旧 agent；
  晚到的失败不得踢掉已成功的新资产、也不得把会话盖进冷却期。
- `test/settings-card.test.mjs`：新字段进 schema、volatile 投影、规则表保存归一；
  判重键与运行期 `normalizeWorkspacePath()` 逐条对齐、等价路径拦截、绝对路径校验、
  `boolOn` 的 env 字符串口径；client.js 与重新构建的产物逐字节一致。
- `test/settings-card-render.test.mjs`：4 个 Tab、折叠分组、置灰矩阵、工作区列表 /
  占位回落 / datalist、env 字符串开关的显示、横向溢出修复、secret 侧信道、不可用自解释。
- `test/load.test.mjs`：`apply()` 到 `/tdai-status` 的接线；裸会话（只有 `sessionId`）
  与 store 补 cwd 后的身份解析。
- `npm test` 全量通过；`node build-card.mjs` 重新生成 `client.js`。

## 9. 相关文件

| 文件 | 作用 |
| --- | --- |
| `config.mjs` | `normalizeWorkspacePath` / `normalizeWorkspaceAgents` / `workspaceBindingFor` / `identityForWorkspace` |
| `lib/settings.mjs` | `workspaceAgentsEnabled` / `workspaceAgents` schema、SCHEMA_KEYS / VOLATILE_KEYS |
| `index.mjs` | `configFor(session)` / `readEnabledFor(session)` / `identityFor(session)` / `workspaceBindingFor(session)` |
| `lib/assets.mjs` | `ensure/warm/refresh(..., cfg)`；缓存 key 带身份 |
| `lib/recall.mjs` / `lib/sections.mjs` / `lib/tools.mjs` / `lib/commands.mjs` | 会话级 cfg / 读侧判定 / 状态输出 |
| `client.card.tsx` | Tab、折叠分组、工作区规则表、横向溢出修复 |
| `cordis.patch.yml` | env 透传（`TDAI_MEMORY_WORKSPACE_AGENTS*`） |
