# 设计材料包 · ds-bot × dsh-tdai-memory-plugin


> 📎 **历史过程记录（2026-10-22 标记）**：非实施方案，仅作证据与过程留存。
> 实施规格见 [minimal.md](./minimal.md) 与 [minimal.agents.md](./minimal.agents.md)。
> **这是给设计者的输入，不是结论。**
> 主干材料是 `docs/ds-bot-alignment-evidence.zh-CN.md`（下称「底本」，9 节）。本文补底本没有、但本次设计必需的事实，并显式列出已知张力。
>
> 置信度沿用底本约定：**【实测】/【代码】/【文档】/【推测】**。凡【推测】不得当事实引用。
>
> **修订记录**：v1 曾把「L2/L3 是实例级单文件」当作结论；**v2 经本机容器实测更正——L2/L3 是按 `team + agent` 隔离的**。P1、P5 已重写。读到 v1 结论的，以本版为准。

---

## P0. 怎么用这份材料

1. 先读底本，重点 §2（会话级实测）、§5（本插件契约）、§6（三处冲突）。
2. 再读本文 P1–P4 拿补充事实。
3. **P0.5 是本次设计的目标，不可改写**；P5 是必须正面处理的张力，没有标准答案。
4. 本文不含任何实现建议。

---

## P0.5 本次设计的目标（用户给定）

> 让每个 Bot 对应独立的 agent，拥有独立的 L2、L3 记忆；user 可以都是同一个人。

拆成三条可检验的要求：

1. **一个 ds-bot 的 Bot ↔ 一个 tdai 的 agent**，稳定对应。
2. **L2（scene_blocks）/ L3（persona.md）按 Bot 独立**——不同 Bot 各有场景块与画像，互不覆盖。
3. **user 维度共用**——同一个人的 L0/L1 仍属于这个 user，只是分散到不同 agent 名下。

外加一条来自底本 §1 的既有约束：**tdai 只沉淀人为介入的部分，不沉淀 agent 的自动化行为。**

---

## P1. tdai 的隔离粒度：L2/L3 确实按 `team + agent` 分

### P1.1 两套目录：实例根 vs per-agent profile（【实测】本机容器）

本机 `tdai-memory-core` 容器挂载卷 `/data/tdai-memory`，实际结构：

```
/data/tdai-memory/
├── conversations/{YYYY-MM-DD}.jsonl     L0 原始对话（按天）
├── records/{YYYY-MM-DD}.jsonl           L1 记录（按天）
├── scene_blocks/                        空目录（旧布局残留，实际未使用）
├── profiles/
│   └── team:<teamId>|agent:<agentId>/   ← 目录名经 URL 编码
│       ├── persona.md                   L3 画像（本机 21,237 B）
│       ├── scene_blocks/*.md            L2 场景块（本机 14 个）
│       └── .metadata/{checkpoint.json, scene_index.json}
├── instances/default/
├── metadata/tdai_metadata_default/
├── skills/、skill_buffer/
└── vectors.db（61 MB）
```

**关键**：L0/L1 落在实例根的按天 JSONL；**L2/L3 落在 `profiles/team:<T>|agent:<A>/` 下**，目录名把 team 与 agent 都编进去了。

【实测】当前只有一个 profile 目录，对应本机唯一的 team+agent；里面 `persona.md` 与 14 个场景块（个人健康-睡眠与身心状态.md、技术开发-记忆插件项目.md 等）。

> 复现：`docker exec tdai-memory-core ls /data/tdai-memory/profiles/`

### P1.2 四层的归属维度（修正版）

| 层 | 落盘位置 | 归属维度 | 证据 |
| --- | --- | --- | --- |
| L0 | `conversations/{date}.jsonl` | team + user + agent + session（**行内字段**，文件不分） | 【代码】`l0-recorder.ts`；【实测】目录 |
| L1 | `records/{date}.jsonl` + sqlite `l1_records` | 同上；表内有 `agent_id TEXT NOT NULL DEFAULT 'default'` 与索引 `idx_l1_team_agent_updated` | 【代码】`store/sqlite.ts:637,673` |
| **L2** | `profiles/team:<T>\|agent:<A>/scene_blocks/*.md` | **team + agent** | 【实测】+【文档】SDK |
| **L3** | `profiles/team:<T>\|agent:<A>/persona.md` | **team + agent** | 【实测】+【文档】SDK |
| Asset（chat_memory 等） | 元数据 + `skills/` 等 | **team + agent** | 【文档】`chat_memory-{team}-agt-{agent}` |

### P1.3 SDK 文档口径

【文档】`sdk/memory-core/typescript/README_CN.md:26-30`：

- 构造时要求 `teamId` / `agentId` / `userId` 三元组，避免写入或查询串到其它团队 / Agent / 用户。
- 不传 sessionId 或 `withIsolation({ sessionId: null })` 时，**L0/L1 按 `(team, agent, user)` 跨 session 聚合**。
- **L2/L3 是 team+agent 级 profile，不消费 `sessionId`**。

与 P1.1 实测一致。v1 依据的「路径里没有 agent」来自 `StoragePaths` 的相对路径定义（`MemoryCore/src/core/storage/types.ts:240-263`），那是**相对于 profile 目录**的相对路径，不是实例根。

### P1.4 chat_memory 资产 ID 与两种「绑定」语义

【文档】

```
chat_memory-{team_id}-agt-{agent_id}
例：chat_memory-team-323mppflgu-agt-323mkuwnyn
```

一条 `(team, agent)` → 一个稳定资产 → 承载该资产下的 L0/L1/L2/L3。

**两种「绑定」语义，必须拆开**：

1. **默认归属**：运行时按当前 agent 读自身 L2/L3。
2. **额外挂载**：一个 agent 可借入**其他** agent 的 chat_memory 资产（Fixed Binding / Loadout），读取时**标记来源 agent**，不把对方记忆伪装成自己的。所以「按 agent 绑定」≠「只能看到自己的记忆」。

### P1.5 一个最常被理解错的点

**不是每条 L0 各抽一套 L1→L3。** 是后台按隔离条件**聚合多条 L0 后异步蒸馏**：L1 满 5 轮或 session idle 600 秒触发（P1.6），L2 在 L1 之后，L3 在 L2 之后且全局串行。

含义：**新建一个 agent 后，它的 L2/L3 从零开始长**，不会自动继承主 agent 已有的 14 个场景块与 21 KB 画像。

### P1.6 管道参数

| 参数 | 默认值 | 位置 |
| --- | --- | --- |
| `everyNConversations` | 5 | `MemoryCore/src/config.ts:583` |
| `l1IdleTimeoutSeconds` | 600 | `config.ts:585` |
| L1 预热退避 | 1 → 2 → 4 → 8 → … → everyN | `utils/pipeline-manager.ts:57-58` |
| L2 | per-session 向下 timer，冷会话不发 | `pipeline-manager.ts:18-23` |
| L3 | L2 完成后入队，全局 `concurrency=1` | `pipeline-manager.ts:26` |
| 存储后端 | `sqlite`（默认）或 `tcvdb` | `config.ts:498-499` |

---

## P2. Agent 与资产的元数据契约

### P2.1 AgentEntity

【文档】`v3-api-memorycore-doc.md:855-880`

```
{ agent_id, team_id, owner_user_id, name, description?, prompt?,
  visibility, status, created_at, updated_at, metadata_json }
```

- 建 Agent 请求体：`team_id`、`owner_user_id`、`name`、`description?`、`prompt?`、`visibility?`、`status?`、`metadata_json?`
- 唯一性：`team_id + agent_id`（`MemoryCore/README_CN.md:202`）
- **`prompt` 字段存在**：Agent 可带一段自己的 prompt（与 ds-bot 的 Bot `instructions` 同性质）
- Agent 是纯元数据实体，Core 不托管不调度（`MemoryCore/README_CN.md:9`）

### P2.2 AssetEntity

【文档】同文件 `:925-940`

```
{ asset_id, team_id, asset_type(skill|llm_wiki|code_graph|chat_memory), name,
  description?, owner_user_id, source_type, source_ref?, version, visibility,
  status, confidence?, expires_at?, last_used_at?, usage_count,
  content_ref?, created_at, updated_at, metadata_json }
```

### P2.3 Loadout（agent-fixed-asset）

【文档】同文件 `:942-960`

```
POST /agent-fixed-asset/set
  { agent_id, bindings: [{ asset_id, asset_type, injection_mode?, priority?, created_by }] }
```

- `set` 是**全量覆盖**
- `list-with-detail`：`agent_id`、`apply_visibility_filter?`、`touch_usage?`
- `summary-by-agents`：`agent_ids`(1–100 去重)、`asset_id?`
- 【代码】`injection_mode ∈ direct | summary | tool | reference`（`metadata/router/v3-meta-schemas.ts:14`）

### P2.4 ACL

【文档】同文件 `:962-985`：`subject_type ∈ user|team_role|agent`；`permission ∈ read|write|delete|assign|share|use`；`effect ∈ allow|deny`；判定顺序 资源→owner→成员→visibility→角色默认→ACL→deny；一期 allow-only（`metadata/service/permission-checker.ts:1-12`）。

---

## P3. ds-bot 的装配点与时序

### P3.1 `ensureCapabilities` 的 7 个调用点

【代码】`ds-bot/src/host/capabilities.js:402` 定义：

| 调用点 | 时机 |
| --- | --- |
| `delivery.js:88` | **每条 Bot 间消息投递前** |
| `channel.js:279,297` | UI 通道（建 Bot / 改 Bot 后） |
| `groups.js:188,212` | 群聊创建 / 成员变更 |
| `parts.js:659` | **新 part 建立后** |

装配是按需触发、分散的，不是每轮钩子。

### P3.2 capability 三类

【代码】`capabilities.js:20-40`：`kind ∈ mcp|skill|pack`；`pack` 展开为 `items[]`；名字小写字母、数字、单连字符、≤32 字符，`github` 保留。

### P3.3 Bot 记录字段

【实测】`~/.dsh/bot/state.json`：

```
{ id, name, role, color, avatar, instructions, createdAt, createdBy,
  capabilities[], model, appliedModel, permission }
```

- 【实测】**无 `effort` / `appliedEffort`**（effort 通道见底本 §3.4）
- 【代码】`instructions` 进 system prompt 的 `# Your identity` 段（`prompt.js:70`）

---

## P4. DSH 会话头里可区分的信息

### P4.1 SessionHeader 字段

【代码】`dsh-session/lib/types/types.d.ts:72,82,88`

```ts
readonly parentSession?: SessionId
readonly origin?: 'subagent'
readonly delegationDepth?: number
```

### P4.2 四类会话的可区分性

| 会话类型 | `origin` | `delegationDepth` | `parentSession` |
| --- | --- | --- | --- |
| 用户自己的会话 | 无 | 0 | 无 |
| 子代理会话 | `subagent` | >0 | 有 |
| **Bot 会话** | **无** | **0** | **无** |
| **群聊 room 会话** | 无 | 0 | 无 |

**Bot 与用户会话在会话头上不可区分。** 要认出 Bot，只能靠外部映射（ds-bot 的 `state.json` roster、`cwd`、sessionId 前缀），或由 ds-bot 主动写入标记。

### P4.3 会话级策略是持久事件

【实测】`subagent/model-selection-policy` 作为会话事件 `append` 持久化（`dsh-tool-subagent/lib/index.js:290-292`），**会话创建后不随配置刷新**。本次实测撞到：当前会话固化的白名单只有两条 DeepSeek 路由，新增的 `openai-codex/gpt-5.6-terra` 用不了，必须新开会话。

---

## P5. 六条设计张力（只陈述，不解决）

1. **目标已成立一半。** L2/L3 的 per-agent 隔离是 tdai 现成能力（P1.1、P1.3）。真正缺的是**插件侧的按会话切换身份**：当前插件是「一个 dsh 进程一个 TDAI 身份」（底本 §5.1），且「多身份不做」是 `prompt-injection-redesign.md:489` 记录过的**已否决决策**。
2. **新 agent 冷启动。** P1.5：新建 agent 的 L2/L3 从零长，不继承主 agent 已有的 14 个场景块、21 KB 画像。每个 Bot 都要走一遍「5 轮 / 600 秒 → L1 → L2 → L3」，且 L3 全局串行。
3. **认不出 Bot 会话（P4.2）。** 任何「按会话映射 agent」的方案，第一步都得先解决「这个 session 是哪个 Bot 的」。DSH 会话头不给答案。
4. **人 / 机词汇表不重合。** ds-bot 的 `source.kind ∈ {bot, user, user-question-reply, ds-bot-time-context, schedule, …}`；tdai 只认 `user` 或缺省（底本 §5.4）。中间没有映射表。
5. **群聊归谁。** 一个 room session 里多个 Bot 发言，而 L2/L3 是 per-agent 的。room 的记忆落进哪个 agent？还是单独一个「room agent」？
6. **装配点分散（P3.1）。** 若 Loadout 要按 agent 装配，挂在哪一处、要不要补每轮钩子，是设计选择；`capabilities` 现有语义是「挂上/摘下工具」，而 tdai 的 `injection_mode` 有四种形态。

---

## P6. 复现命令

```bash
# P1.1 本机真实目录结构（实测）
docker exec tdai-memory-core ls -la /data/tdai-memory
docker exec tdai-memory-core ls -la '/data/tdai-memory/profiles/team%3A<teamId>%7Cagent%3A<agentId>'

# P1.3 SDK 口径
sed -n '24,32p' /mnt/d/workspace/github/TencentDB-Agent-Memory/sdk/memory-core/typescript/README_CN.md

# P1.2 sqlite 里的 agent_id 列
grep -n "agent_id TEXT\|idx_l1_team_agent" \
  /mnt/d/workspace/github/TencentDB-Agent-Memory/MemoryCore/src/core/store/sqlite.ts

# P1.6 管道参数与存储后端
sed -n '583,585p;498,499p' /mnt/d/workspace/github/TencentDB-Agent-Memory/MemoryCore/src/config.ts

# P2 元数据契约
sed -n '855,985p' /mnt/d/workspace/github/TencentDB-Agent-Memory/MemoryCore/v3-api-memorycore-doc.md

# P3.1 装配点
grep -rn "ensureCapabilities" /mnt/d/workspace/github/DeepSeek-Bot/ds-bot/src

# P4.1 会话头字段
grep -n "parentSession?\|origin?\|delegationDepth?" \
  $DSH_INSTALL/node_modules/@deepseek-ai/dsh-session/lib/types/types.d.ts
```

---

## P7. 诚实缺口

1. **新建 agent 时 L2/L3 目录由谁创建**：未读到显式创建逻辑，推测首次写入时懒建。
2. **切换 agent_id 后，同一 session 的 L0 写到新 agent 名下**还是被拒（IsolationContext 是否校验 agent 与 session 的一致性）：未实测。
3. **`profiles/` 目录名里的 team/agent 做了 URL 编码**（`%3A` / `%7C`），含特殊字符的 agent_id 下是否安全：未验证。
4. **实例根下的 `scene_blocks/` 空目录**是旧布局残留还是 fallback 路径：未确认。
5. **L2/L3「不继承」是从管道逻辑推断**（P1.5），未做「新建 agent 后是否复用已有场景块」的实测。
6. **`persona-trigger` 的 5 个触发条件只读了 P1、P2 两条**，后三条未逐条确认。
7. **本机 memory-core 镜像版本**（`agentmemory/memory-core:latest`）与本地源码是否一致，未核对。

> 设计者若方案依赖上述任一条，必须写「依赖缺口 N」，并给出该条不成立时的退路。
