/**
 * Slash 命令注册（对应 MemoryProxy 的 mem: 命令族）。
 *
 * 命令名直接注册为不带斜杠的小写标识，如 `/tdai-sync`、`/tdai-status`。
 * 处理函数返回 { kind: 'success' | 'error', text }，由 dispatching UI 直接渲染。
 */
import { cleanUserQuery } from './text.mjs'

function renderResult(text, isError = false) {
  return { kind: isError ? 'error' : 'success', text }
}

export function registerCommands(ctx, runtime) {
  const run = async (invocation, handler) => {
    const session = invocation.agent?.session
    const identity = runtime.identityFor(session)
    if (!identity) return renderResult('TDAI memory 未配置完整身份，无法执行。', true)
    try {
      return await handler(identity, session)
    } catch (error) {
      runtime.log(`command failed: ${error.message}`)
      return renderResult(`执行失败：${error.message}`, true)
    }
  }

  ctx.commands.register({
    name: 'tdai-sync',
    description: '刷新当前会话的记忆资产缓存（session_context / L2L3 / Skill / Knowledge）',
    handler: (invocation) => run(invocation, async (identity) => {
      const sessionId = identity.session_id
      await runtime.assets.refresh(sessionId)
      const a = runtime.assets.peek(sessionId)
      const skillsCount = a?.skills?.hits?.length ?? 0
      const l2Count = a?.profiles?.reduce((n, p) => n + (p.l2Entries?.length ?? 0), 0) ?? 0
      return renderResult(`✅ 已刷新。L2 场景 ${l2Count} 条，Skill ${skillsCount} 条。`)
    }),
  })

  ctx.commands.register({
    name: 'tdai-status',
    description: '查看当前记忆插件状态（身份、开关、已加载资产）',
    handler: (invocation) => run(invocation, async (identity, session) => {
      const a = runtime.assets.peek(identity.session_id)
      const cfg = runtime.config
      // 子 agent 会话默认降级：这里解释清楚"为什么明明开着开关却什么都没注入"。
      const subagent = runtime.isSubagent?.(session) === true
      const readAllowed = runtime.readSideAllowedFor?.(session) !== false
      const l3 = a?.profiles?.filter((p) => p.l3?.content).length ?? 0
      const l2 = a?.profiles?.reduce((n, p) => n + (p.l2Entries?.length ?? 0), 0) ?? 0
      const lines = [
        `endpoint: ${cfg.endpoint}`,
        `身份来源: ${runtime.identitySource()}（一个 dsh 进程只对应一个 TDAI 身份）`,
        `  instance: ${cfg.serviceId}  team: ${cfg.teamId}  agent: ${cfg.agentId}  user: ${cfg.userId}  task: ${cfg.taskId || '（未配置）'}`,
        `开关: 读侧总开关=${cfg.enabled}（recall=${cfg.recallEnabled} 上限 ${cfg.recallLimit} 条 / inject=${cfg.injectionEnabled} / 工具）、回流=${cfg.captureEnabled}（写侧独立）`,
        `资产: ${a ? `已加载（L3 画像 ${l3} 段 / L2 索引 ${l2} 条 / 知识资源 ${a.knowledge?.length ?? 0} 个）` : '未加载（首次进入会话时拉取）'}`,
        `子 agent: 继承注入=${cfg.subagentInjectionEnabled}（读侧）/ 回流=${cfg.subagentCaptureEnabled}（写侧）`,
        `本会话: ${subagent ? `子 agent 会话（depth ${session?.header?.delegationDepth ?? '?'}，parent ${session?.header?.parentSession ?? '?'}）`
          + (readAllowed ? ' —— 按配置继承读侧' : ' —— 读侧已降级（不注入 / 不召回）') : '顶层会话'}`,
      ]
      // 知识资源逐个列出，并标出工具清单是否预取成功
      // （预取成功 → 工具名会写进 tdai-team-knowledge skill 正文，模型无需自发现）
      const knowledge = a?.knowledge ?? []
      if (knowledge.length > 0) {
        lines.push('知识资源：')
        for (const k of knowledge) {
          const n = Array.isArray(k.tools) ? k.tools.length : 0
          lines.push(`  - ${k.knowledge_id}（${k.type}）${k.name}${n > 0 ? ` — 工具清单已预取（${n} 个）` : ' — 工具清单未取到'}`)
        }
      }
      const missing = runtime.missingIdentityFields?.() ?? []
      if (missing.length > 0) lines.push(`⚠️ 身份不完整，缺：${missing.join(', ')}（读侧已停用）`)
      return renderResult(lines.join('\n'))
    }),
  })

  ctx.commands.register({
    name: 'tdai-archive',
    description: '立即归档当前会话的 Skill 提取缓冲（触发后台 skill 抽取）',
    handler: (invocation) => run(invocation, async (identity) => {
      const result = await runtime.client.forceArchive(identity, cleanUserQuery(invocation.rawInput))
      if (result?.status === 'empty') return renderResult('⚠️ 当前会话暂无可归档内容。')
      return renderResult(`✅ 已触发归档${result?.status ? `（${result.status}）` : ''}，后台正在提取 Skill。`)
    }),
  })

  ctx.commands.register({
    name: 'tdai-help',
    description: '查看 TDAI Memory 插件命令与工具说明',
    handler: () => renderResult([
      '可用命令：',
      '  /tdai-sync     刷新当前会话的记忆资产缓存',
      '  /tdai-status   查看插件状态与已加载资产',
      '  /tdai-archive  立即归档当前会话，触发 Skill 提取',
      '  /tdai-help     本帮助',
      '',
      '只读工具（10 个）：',
      '  记忆：tdai_memory_search / tdai_memory_query / tdai_conversation_search /',
      '        tdai_conversation_query / tdai_read_scene / tdai_scenario_ls',
      '  Skill：tdai_skill_search / tdai_skill_view',
      '  团队知识：tdai_knowledge_tools（列工具）/ tdai_knowledge_call（执行查询）',
      '           工具名与参数见 tdai-team-knowledge skill 正文，或先调 tdai_knowledge_tools',
      '',
      '配置：在「设置 → TDAI Memory」页里切换开关、修改身份。',
    ].join('\n')),
  })
}
