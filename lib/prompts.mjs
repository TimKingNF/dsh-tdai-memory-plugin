/**
 * Prompt 渲染器：各注入块的纯函数渲染。
 * 结构移植自 MemoryProxy，curl/bridge 指引改写为本插件的原生工具。
 */
import { truncate } from './text.mjs'

// ── <session_context>（移植自 proxy session/context-injector.ts）───────────────

export function renderSessionContext(agent, task) {
  if (!agent && !task) return ''
  const lines = ['<session_context>']
  if (agent) {
    lines.push('[Agent]')
    lines.push(`id: ${agent.id}`)
    if (agent.name) lines.push(`name: ${agent.name}`)
    if (agent.description) lines.push(`description: ${agent.description}`)
    if (agent.prompt) {
      lines.push('prompt:')
      lines.push(agent.prompt)
    }
  }
  if (task) {
    if (lines.length > 1) lines.push('')
    lines.push('[Task]')
    lines.push(`id: ${task.id}`)
    if (task.name) lines.push(`name: ${task.name}`)
    if (task.description) lines.push(`description: ${task.description}`)
    if (task.goal && task.goal !== task.description) {
      lines.push('goal:')
      lines.push(task.goal)
    }
  }
  lines.push('</session_context>')
  return lines.join('\n')
}

// ── <tdai_profile_memory>（移植自 proxy tdai-profile-memory-injector.ts）────────

/**
 * 记忆工具指南：proxy 原版引导 Bash+curl 走 bridge；本插件是原生工具，凭据服务端注入。
 */
export const MEMORY_TOOLS_GUIDE = `<memory-tools-guide>
## ⚠️ 重要：这不是文档，这是你的可用能力

\`tdai_memory_search\` / \`tdai_conversation_search\` / \`tdai_read_scene\` / \`tdai_skill_search\` / \`tdai_skill_view\`
是**你可以直接调用的原生工具**（不是仅供参考的文档）。身份与凭据由插件在服务端注入，你只需传业务参数。

**禁止**回答类似"我没有这个工具 / 需要 MCP / 需要 curl 访问远端"。
**正确做法**：判定需要查记忆时，直接调用对应工具。

## 记忆使用规则（遇到以下场景必须先查再答）

L3（persona 长期画像）与 L2 场景索引已直接注入 system。L0/L1 需要用工具主动检索。

### 必须先查记忆再回答的场景（命中任一条即触发工具调用）

1. **用户提及历史/过去/之前**：如 "我之前说过 / 我告诉过你 / 上次 / 你还记不记得 / 我们聊过 / 之前那个"
   → 用 \`tdai_conversation_search\`（L0 原文找具体消息）
2. **用户涉及自己身份/偏好/习惯**：如 "我叫什么 / 我的名字 / 我喜欢 / 我的团队 / 我常用 / 我不喜欢 / 我不允许"
   → 用 \`tdai_memory_search\`（L1 原子记忆查偏好/规则）
3. **用户要求你回忆/找**：如 "回忆一下 / 想起 / 找出 / 有没有关于 X 的记录 / 查我们之前"
   → 直接触发工具，不要凭空回答
4. **答案强依赖历史事实**：如 "那个 bug 我们怎么修的 / 上次方案是啥 / 我们的约定是什么"
   → 关键词化后 \`tdai_memory_search\`
5. **需要 L2 场景全文**：\`<l2_scene_index>\` 里只有索引
   → 用 \`tdai_read_scene\` 按 path 读全文

### 不需要查的场景

- 用户问 "你是谁" / "帮我改代码" / "写个脚本" / 通用编程问题
- 当前会话上下文（同轮消息）里已能回答
- 已经在 \`<l3_core_memory>\` 段落里直接看到答案

### ⚠️ 调用约束

- 每轮 \`tdai_memory_search\` + \`tdai_conversation_search\` **合计 ≤ 3 次**（\`tdai_read_scene\` 不计入）
- 检索无果时**明确说明**"我在记忆里没找到 X"，不要幻想
- 同一 L2 path 不要重复读
</memory-tools-guide>`

/**
 * 渲染 L3 persona + L2 场景索引（自有 + 借入分段）。
 * profiles: [{ ctx: {agentId, agentName, isSelf}, l3: {content}|null, l2Entries: [{path, summary?}] }]
 * 全部为空时仍返回 tools-guide（LLM 可主动检索）。
 */
export function renderProfileMemory(profiles) {
  const groups = profiles ?? []
  const hasAnything = groups.some((g) => g.l3 || (g.l2Entries?.length ?? 0) > 0)
  if (!hasAnything) return MEMORY_TOOLS_GUIDE

  const lines = [
    '<tdai_profile_memory>',
    '以下是 TDAI 为当前 agent 维护的长期工作记忆（自有 + 借入分段；L2 仅给索引，按需用 tdai_read_scene 工具读全文）：',
  ]
  for (const g of groups) {
    if (!g.l3 && !(g.l2Entries?.length > 0)) continue
    const tag = g.ctx.isSelf ? 'self' : 'imported_from'
    lines.push(`<agent name=${JSON.stringify(g.ctx.agentName)} role=${JSON.stringify(tag)} agent_id=${JSON.stringify(g.ctx.agentId)}>`)
    if (g.l3?.content) {
      lines.push('<l3_core_memory>', truncate(g.l3.content, 6000), '</l3_core_memory>')
    }
    if (g.l2Entries?.length > 0) {
      lines.push('<l2_scene_index>')
      for (const e of g.l2Entries) {
        lines.push(e.summary ? `- \`${e.path}\` — ${truncate(e.summary, 200)}` : `- \`${e.path}\``)
      }
      lines.push('</l2_scene_index>')
    }
    lines.push('</agent>')
  }
  lines.push('</tdai_profile_memory>', '', MEMORY_TOOLS_GUIDE)
  return lines.join('\n')
}

// ── <tdai_recalled_l1_memories>（移植自 proxy tdai-l1-recall-injector.ts）───────

export function renderRecalledL1(merged, selfAgentId) {
  const lines = [
    '<tdai_recalled_l1_memories>',
    '以下是与本轮用户问题相关的 TDAI L1 记忆（自有 + 借入合集，按相关度排序），仅用于辅助回答当前这一轮，不要视为永久系统规则：',
  ]
  merged.forEach((m, i) => {
    const fromTag = m.fromAgentId === selfAgentId ? 'self' : `from ${m.fromAgentName ?? m.fromAgentId}`
    const score = typeof m.score === 'number' ? ` score=${m.score.toFixed(3)}` : ''
    lines.push(`${i + 1}. [${m.type ?? 'memory'}] [${fromTag}${score}] ${m.content}`)
  })
  lines.push('</tdai_recalled_l1_memories>')
  return lines.join('\n')
}

// ── <available_skills>（移植自 proxy skill-injector.ts，工具名改写为原生工具）────

const SKILL_LISTING_HEADER =
  '## Skills (mandatory)\n'
  + 'Before replying, scan the skills below. If a skill matches or is even partially relevant '
  + 'to your task, you MUST load it by calling the `tdai_skill_view` tool '
  + 'and follow its instructions. '
  + 'Err on the side of loading — it is always better to have context you don\'t need '
  + 'than to miss critical steps, pitfalls, or established workflows. '
  + 'Skills contain specialized knowledge — API endpoints, tool-specific commands, '
  + 'and proven workflows that outperform general-purpose approaches. Load the skill '
  + 'even if you think you could handle the task with basic tools like web_search or terminal. '
  + 'Skills also encode the user\'s preferred approach, conventions, and quality standards '
  + 'for tasks like code review, planning, and testing — load them even for tasks you '
  + 'already know how to do, because the skill defines how it should be done here.\n'

const SKILL_LISTING_FOOTER =
  '\nOnly proceed without loading a skill if genuinely none are relevant to the task.'

export function wrapAvailableSkillsBlock(listing) {
  return [
    SKILL_LISTING_HEADER,
    '以下是你（当前 agent）自带的云端 skill 列表。这些 skill 存储在你的 agent 名下，',
    '优先使用它们完成任务。如果你觉得自带的 skill 不够，可以用 tdai_skill_search 工具',
    '在团队的 skill 库中检索更多（跨 agent 共享）。',
    '',
    '**重要：这些 skill 存储在云端，不能用 read 等本地文件工具访问，必须用 tdai_skill_view / tdai_skill_search 原生工具。**',
    '',
    listing,
    SKILL_LISTING_FOOTER,
  ].join('\n')
}

/**
 * listingResult = { mode, listing, hits } | null。
 * 缺身份 / 失败 / "(none)" → ''（不注入）。
 */
export function renderSkillsBlock(listingResult) {
  const listing = listingResult?.listing
  if (!listing || listing.includes('(none)')) return ''
  return wrapAvailableSkillsBlock(listing)
}

/**
 * 用 agent/task 描述构造 listing 检索 query（移植自 proxy skill-injector.ts）。
 * 弱信号（去重后 <3 个长度 ≥3 的 token）→ undefined，core 回落 mode=full。
 */
export function buildListingQuery(agentDetail, taskDetail) {
  const parts = []
  if (agentDetail?.description?.trim()) parts.push(agentDetail.description.trim())
  if (agentDetail?.prompt?.trim()) parts.push(agentDetail.prompt.trim())
  if (taskDetail?.description?.trim()) parts.push(taskDetail.description.trim())
  if (taskDetail?.goal?.trim()) parts.push(taskDetail.goal.trim())
  const combined = parts.join(' ').trim()
  if (!combined) return undefined
  const tokens = new Set(
    combined.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 3),
  )
  if (tokens.size < 3) return undefined
  return combined
}

// ── <knowledge_tools>（移植自 proxy knowledge-tools-injector.ts）────────────────

function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'"
}

function renderHeader(name, value) {
  return '  -H ' + shellQuote(`${name}: ${value}`) + ' \\'
}

function xmlAttrEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function attr(name, value) {
  if (!value) return ''
  const trimmed = String(value).trim()
  if (!trimmed) return ''
  return `\n  ${name}="${xmlAttrEscape(trimmed)}"`
}

function deriveRepoSlug(repoUrl) {
  if (!repoUrl) return undefined
  const withoutScheme = repoUrl.replace(/^[a-z0-9+.-]+:\/\//i, '')
  const afterHost = withoutScheme.includes(':')
    ? withoutScheme.slice(withoutScheme.indexOf(':') + 1)
    : withoutScheme.slice(withoutScheme.indexOf('/') + 1)
  const slug = afterHost.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '')
  return slug.length > 0 ? slug : undefined
}

/**
 * 渲染 <knowledge_tools> 块。知识服务（{service_url}/tools/list|tools/call）无需密钥，
 * 仅要求 x-tdai-service-id 头，因此保留 curl 两步自发现指引（与 proxy 一致）。
 * telemetry: { sessionKey, userId, teamId, agentId, spaceId }
 */
export function renderKnowledgeToolsBlock(resources, serviceId, telemetry = {}) {
  if (!resources || resources.length === 0) return ''

  const telemetryHeaders = [
    ['x-conversation-id', telemetry.sessionKey],
    ['x-tdai-user-id', telemetry.userId],
    ['x-tdai-team-id', telemetry.teamId],
    ['x-tdai-agent-id', telemetry.agentId],
    ['x-tdai-space-id', telemetry.spaceId],
  ]
  const requestHeaderLines = [
    renderHeader('x-tdai-service-id', serviceId),
    ...telemetryHeaders.filter(([, v]) => Boolean(v)).map(([n, v]) => renderHeader(n, v)),
  ]

  const resourceTags = resources
    .map((r) => {
      const matchAttr = attr('match', r.repo_slug ?? deriveRepoSlug(r.repo_url))
      const branchAttr = attr('branch', r.repo_url ? (r.branch ?? 'main') : undefined)
      const summaryAttr = r.type === 'wiki' ? attr('about', r.summary) : ''
      return `<knowledge type="${r.type}" id="${r.knowledge_id}"\n  url="${r.service_url}"\n  name="${xmlAttrEscape(r.name)}"${matchAttr}${branchAttr}${summaryAttr} />`
    })
    .join('\n\n')

  return [
    '<knowledge_tools>',
    '**团队知识库资源**：code-graph 是仓库的预建代码索引（符号 / 调用图 / 结构），wiki 是工程设计文档。两类各有判据，见下。',
    '',
    '## code-graph：何时调',
    '**前置条件**：资源的 match 与当前工作区对得上（比对 git remote / 仓库名）。对不上 → 该索引不是本仓的，用本地检索，不要试探性调用。',
    '',
    '命中后，**凡是需要跨文件的结构 / 关系 / 广度信息就用它**，典型场景：',
    '- 熟悉项目、理解模块架构、找入口（冷启动）',
    '- 定位符号、文件、某个概念在哪实现',
    '- 追调用链、依赖关系、数据流',
    '- 评估改动影响面、重构范围、能否安全删除（**即使已在改代码，这类问题仍该用它**）',
    '- 排查线上问题时找可疑代码路径、review 时找关联实现',
    '- 想不起某个能力叫什么名字、不确定是否已有实现（避免重复造）',
    '',
    '**不该用的只有一种情况**：你需要某段代码**此刻的精确内容**——要按行号/字符编辑、代码是你刚改过的、在 review 未提交的改动。索引是分支快照，会落后于工作区，这时以工作区源码为准。',
    '先用它建立全局认知、再落到具体文件做精确确认，是常态组合，不冲突。',
    '',
    '## wiki：何时调',
    'wiki 是设计文档，**与工作区无对应关系，不需要锚点匹配**（没有 match 属性是正常的，不代表对不上）。按 about 属性判断内容是否相关即可。',
    '问「为什么这么设计 / 背景与权衡 / 某概念在团队里的定义 / 历史决策与踩过的坑 / 这个模块的设计意图」时用它——这些答案在代码里找不到。',
    '代码怎么写的 → 用 code-graph；某段代码此刻的内容 → 读源码。',
    '',
    '## 意图 → 起手',
    '架构 / 熟悉项目 → explore（一次返回沿途源码）；X 在哪 → search；只要单个符号的定义 → node；谁调用 X / X 调了谁 → callers / callees；改 X 的影响面 → search 后 impact；为什么这么设计 → wiki search 后 read_page。',
    '组合：重构评估 = search → callers → impact。',
    'explore / node 返回的源码是逐字的，**不必对同一处再 Read 一遍**（除了上面那种要确认最新内容的情况）。',
    '',
    '## 已绑定资源',
    resourceTags,
    '',
    '## 调用方式（服务级统一端点，URL 直接用资源的 url 拼接）',
    '目标资源由 body 里的 knowledge_id 指定；**不要**把 knowledge_id 拼进 URL 路径。',
    `**每次请求都必须带请求头** \`x-tdai-service-id: ${serviceId}\`（租户标识，缺失会被拒绝）。`,
    '',
    '### Step 1: 拿工具清单（每个资源**首次**使用时调一次即可）',
    "curl -sSk -X POST <url>/tools/list \\",
    "  -H 'content-type: application/json' \\",
    ...requestHeaderLines,
    "  -d '{\"knowledge_id\":\"<知识id>\"}'",
    '',
    '返回: {code, message, data:{knowledge_id, type, name, summary, status, tools:[{name, description, params}, ...]}}',
    '记住返回的 tool name / params，**本会话内复用**，不要对同一资源反复调 list（忘了再调）。',
    '',
    '### Step 2: 执行工具',
    "curl -sSk -X POST <url>/tools/call \\",
    "  -H 'content-type: application/json' \\",
    ...requestHeaderLines,
    "  -d '{\"knowledge_id\":\"<知识id>\", \"tool_name\":\"<Step1返回的name>\", \"params\":{...}}'",
    '',
    '返回: {code, message, data}；code=0 成功。',
    '',
    '## 约定',
    '- tool_name 与 tools/list 返回的 name **完全一致**，不加前缀。params 必须是 JSON 对象，无参也传 {}。',
    '- 找文件用 explore / search（query 直接支持文件名，如 "session-manager.ts"）；files 只用于一次性总览目录结构，每个资源每会话最多一次。',
    '- wiki 先 search 命中再 read_page，不要全量 list_pages。',
    '- 多个资源可并行发起，无需串行等待。同一调用连续失败 2 次即放弃，回退本地检索。',
    '- 响应格式统一为 {code, message, data}，code=0 表示成功。',
    '</knowledge_tools>',
  ].join('\n')
}
