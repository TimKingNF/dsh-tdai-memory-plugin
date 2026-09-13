# 🧠 dsh-tdai-memory-plugin

DeepSeek Harness 的 TencentDB Agent Memory 插件：在 DSH 会话内实现**上下文召回与注入**（读侧），并把每轮对话**旁路回流 MemoryCore** 做持久化（写侧）。

与 [DSH-TDAI-Memory-Adapter](https://github.com/Vocllum/DSH-TDAI-Memory-Adapter) 的关系：本项目在其「自动 recall + turn 捕获 + 只读工具」的骨架上，把 MemoryProxy 的核心记忆能力（L2/L3 注入、自有+借入 L1 召回、Skill/Knowledge 注入、session_context）以 **DSH 进程内原生方式** 移植过来——不需要 MemoryProxy 转发层，凭据不出进程。

## 功能

### 读侧（`enabled` 总开关）

| 能力 | 机制 | 来源 |
| --- | --- | --- |
| `<session_context>` 注入 | system prompt section（agent/task 详情，meta 面 `/v3/meta/agent/get` `/v3/meta/task/get`） | proxy session/context-injector |
| L3 persona + L2 场景索引注入 | `<tdai_profile_memory>` section（`/v3/core/read` + `/v3/scenario/ls`，自有+借入分段） | proxy tdai-profile-memory-injector |
| L1 自动召回 | `agent/pre-step`：清洗 query → 自有+借入并发 `/v3/atomic/search` → score 合并 top-K → `<tdai_recalled_l1_memories>` 随本轮进入 | proxy tdai-l1-recall-injector |
| Skill 目录注入 | `<available_skills>` section（`/v3/skill/listing`，query 由 agent/task 描述构造） | proxy skill-injector |
| Knowledge 工具注入 | `<knowledge_tools>` section（`/v3/knowledge/list`，默认关） | proxy knowledge-tools-injector |

### 只读工具 ×8

- 语义检索：`tdai_memory_search`（L1 原子记忆）、`tdai_conversation_search`（L0 对话原文）、`tdai_skill_search`（团队 Skill）
- 结构化查询：`tdai_memory_query`（L1 按 type/时间/分页）、`tdai_conversation_query`（L0 按 session/时间/分页）
- 资源读取：`tdai_read_scene`（L2 场景全文）、`tdai_scenario_ls`（L2 场景列表）、`tdai_skill_view`（Skill 全文 + manifest）

### Slash 命令 ×4

| 命令 | 作用 |
| --- | --- |
| `/tdai-sync` | 刷新当前会话的记忆资产缓存（session_context / L2L3 / Skill / Knowledge） |
| `/tdai-status` | 查看插件状态（身份、开关、已加载资产） |
| `/tdai-archive` | 立即归档当前会话，触发后台 Skill 提取（对应 proxy 的 `mem:create-skill`） |
| `/tdai-help` | 命令与工具速查 |

### 写侧（`captureEnabled`，独立开关）

- 每轮真人对话结束： `/v3/conversation/add`（L0 短期记忆）+ `/v3/skill/conversation/add`（Skill 归档触发）
- 对齐 proxy：单条 >8192 code units 分片（surrogate 安全）、100 条/批、同 session 串行
- 自动剔除插件注入的召回块，避免污染记忆
- L1/L2/L3 提取由 MemoryCore 后台异步完成

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

- **开关**：总开关、召回、注入、回流，以及各注入块的子开关
- **身份**：MemoryCore 地址、实例 ID、Team / Agent / User / Task ID、User Key

开关即时生效；身份字段变更后**新会话**生效（已有会话的注入缓存不变）。留空文本框 = 回落到 env。

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
export TDAI_MEMORY_ENABLED=true             # 总开关：召回 + 注入 + 工具
export TDAI_MEMORY_CAPTURE_ENABLED=true     # 回流（写侧），独立于总开关
export TDAI_MEMORY_RECALL_ENABLED=true      # L1 自动召回
export TDAI_MEMORY_INJECTION_ENABLED=true   # system prompt 注入总闸
export TDAI_MEMORY_SESSION_CONTEXT_ENABLED=true
export TDAI_MEMORY_PROFILE_MEMORY_ENABLED=true
export TDAI_MEMORY_SKILLS_ENABLED=true
export TDAI_MEMORY_KNOWLEDGE_ENABLED=false  # 团队知识资源注入，默认关

# ── 调参 ──
export TDAI_MEMORY_ENDPOINT=http://127.0.0.1:8420
export TDAI_MEMORY_RECALL_LIMIT=5           # L1 合并 top-K
export TDAI_MEMORY_L2_LIMIT=3               # L2 场景索引条数
export TDAI_MEMORY_TIMEOUT_MS=5000
```

配置优先级：**Web 设置 > env > 内置默认值**。身份不完整时读侧自动停用并告警，写侧不受影响；`TDAI_MEMORY_API_KEY` 只从 env 读取，不写入设置面板。

## 与 MemoryProxy 的差异（有意为之）

- **无代理层**：不转发 LLM 流量，不做限流/计费/存储抽象——那些是 proxy 基础设施，不属于插件职责
- **无 auth/verify**：数据面接受显式身份，meta 面用 `x-tdai-user-key`，静态身份下 verify 不必要
- **无 ACL 过滤**：借入资产来自本人 agent 绑定，单用户场景不做 acl/check（proxy 的 fail-closed 设计面向多用户）
- **工具原生注册**：替代 skill-bridge/memory-bridge 的 curl 方案，serviceToken 不进 prompt
- **无 session-init 表单**：静态身份下跳过 team/agent/task 选择流程

## 开发

```bash
npm install
npm run build:client   # 修改 client.card.tsx 后重新打 client.js
npm test               # 语法检查 + 纯函数冒烟测试
```

## License

MIT
