/**
 * Slash 命令注册（对应 MemoryProxy 的 mem: 命令族）。
 *
 * 命令名直接注册为不带斜杠的小写标识，如 `/tdai-sync`、`/tdai-status`。
 * 处理函数返回 { kind: 'success' | 'error', text }，由 dispatching UI 直接渲染。
 */
import { cleanUserQuery } from './text.mjs'
import { lastWrittenTasks, forgetWrittenTask } from './tools.mjs'

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
    handler: (invocation) => run(invocation, async (identity, session) => {
      const sessionId = identity.session_id
      await runtime.assets.refresh(sessionId, runtime.readPolicyFor?.(session))
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
      // 子 agent 会话按能力面降级：这里解释清楚"为什么开着开关却少了某些段"。
      const subagent = runtime.isSubagent?.(session) === true
      const policy = runtime.readPolicyFor?.(session)
        ?? { identity: true, memory: true, skills: true, knowledge: true }
      const on = (v) => (v ? '开' : '关')
      const l3 = a?.profiles?.filter((p) => p.l3?.content).length ?? 0
      const l2 = a?.profiles?.reduce((n, p) => n + (p.l2Entries?.length ?? 0), 0) ?? 0
      // 写进 <session_context> 的 [Role] / [Rules]：只报字符数与是否配置，
      // **不打印正文**（可能很长，而且命令输出会被贴进对话与日志里）。
      const roleChars = String(a?.agentDetail?.rolePrompt ?? '').length
      const rulesChars = String(a?.agentDetail?.rulesPrompt ?? '').length
      const lines = [
        `endpoint: ${cfg.endpoint}`,
        `身份来源: ${runtime.identitySource()}（一个 dsh 进程只对应一个 TDAI 身份）`,
        `  instance: ${cfg.serviceId}  team: ${cfg.teamId}  agent: ${cfg.agentId}  user: ${cfg.userId}  task: ${cfg.taskId || '（未配置）'}`,
        `开关: 读侧总开关=${cfg.enabled}（recall=${cfg.recallEnabled} 上限 ${cfg.recallLimit} 条 / skill 召回=${cfg.skillsEnabled} 上限 ${cfg.skillRecallLimit} 条 分数闸门 ${cfg.skillRecallMinScore || '不设'} / inject=${cfg.injectionEnabled} / 工具）、Agent 人格注入=${cfg.agentPromptEnabled}（保留原 persona 行=${cfg.agentPromptKeepBase}）、回流=${cfg.captureEnabled}（写侧独立）、待办写入=${cfg.taskWriteEnabled}（写侧独立，另需 User Key）`,
        `资产: ${a ? `已加载（L3 画像 ${l3} 段 / L2 索引 ${l2} 条 / 角色 prompt ${roleChars > 0 ? `${roleChars} 字符` : '未配置'} + 规则 prompt ${rulesChars > 0 ? `${rulesChars} 字符` : '未配置'} / 知识资源 ${a.knowledge?.length ?? 0} 个）` : '未加载（首次进入会话时拉取）'}`,
        `子 agent 开关: 全量继承读侧=${cfg.subagentInjectionEnabled} / 回流=${cfg.subagentCaptureEnabled}（读写侧独立）`,
        `本会话能力面: 身份=${on(policy.identity)} 记忆=${on(policy.memory)} 云端 skill 召回=${on(policy.skills)} 知识库与工具=${on(policy.knowledge)}`,
        `本会话: ${subagent ? `子 agent 会话（depth ${session?.header?.delegationDepth ?? '?'}，parent ${session?.header?.parentSession ?? '?'}）`
          : '顶层会话'}`,
      ]
      // ds-bot 识别结果（方案 §2 第 10 步）：skill= / write= 打的是**有效值**，
      // 即已经在 sessionPolicy() 里与全局 enabled / skillsEnabled / captureEnabled
      // 做过 AND 的结果，不是面板上的配置值。这样"开关开着却没生效"（总闸关、
      // 全局闸关）能在一行里看出来，而不是让人猜。
      const dsbot = runtime.dsbotStatus?.(session)
      if (dsbot) {
        const flag = (v) => (v ? 'on' : 'off')
        lines.push(`dsbot=${dsbot.kind} skill=${flag(dsbot.skillInject)} write=${flag(dsbot.writeback)}`
          + ` bot=${dsbot.botId || '-'} room=${dsbot.roomId || '-'} ledger=${dsbot.ledgerPath}`)
      }
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
    name: 'tdai-task-undo',
    description: '撤销本会话最近写入的待办 task（物理删除；可带 task_id 指定某一条）',
    handler: (invocation) => run(invocation, async (identity) => {
      if (!runtime.taskWriteEnabled?.()) {
        return renderResult('待办写入未启用：在「设置 → TDAI Memory」页打开「待办写入 task」。', true)
      }
      if (!runtime.hasUserKey?.()) {
        return renderResult('未配置 User Key（sk-mem-…）：meta 面的 task 读写需要它。', true)
      }
      // 显式给了 id 就用它；没给就退到「本会话最近写入的那一条」。
      // 用户说的是"撤销上一条"，不该要求他记住 task-xxxxxxxxxx。
      //
      // ⚠️ 必须先把命令名本身摘掉：`/tdai-task-undo` 里就含 `task-undo` 这段，
      // 直接在整个 rawInput 上匹配 `task-[0-9a-z]+` 会把它当成显式 id（实测踩过，
      // 症状是"最近一条"兜底永不生效，删的永远是一个不存在的 task-undo）。
      // 再要求 id ≥6 位随机串（真实形态 `task-` + 10~12 位），双保险。
      const arg = cleanUserQuery(invocation.rawInput).replace(/\/?tdai-task-undo/i, ' ').trim()
      const explicit = arg.match(/task-[0-9a-z]{6,}/i)?.[0]
      const target = explicit || lastWrittenTasks(identity.session_id)[0]?.task_id
      if (!target) {
        return renderResult('本会话没有记录到写入过的 task。'
          + '要删更早的，请带 id：/tdai-task-undo task-xxxxxxxxxx，或去 MemoryPanel 里删。', true)
      }
      const result = await runtime.client.metaDeleteTasks([target])
      const failed = Array.isArray(result?.failed) ? result.failed : []
      if (failed.length > 0) return renderResult(`删除失败：${JSON.stringify(failed)}`, true)
      forgetWrittenTask(identity.session_id, target)
      return renderResult(`✅ 已删除 task：${target}`)
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
      '  /tdai-task-undo [task_id]  撤销本会话最近写入的待办 task（物理删除）',
      '  /tdai-help     本帮助',
      '',
      '只读工具（10 个）：',
      '  记忆：tdai_memory_search / tdai_memory_query / tdai_conversation_search /',
      '        tdai_conversation_query / tdai_read_scene / tdai_scenario_ls',
      '  Skill：tdai_skill_search / tdai_skill_view',
      '  团队知识：tdai_knowledge_tools（列工具）/ tdai_knowledge_call（执行查询）',
      '           工具名与参数见 tdai-team-knowledge skill 正文，或先调 tdai_knowledge_tools',
      '',
      '写侧工具（4 个，需打开「待办写入 task」，另需 User Key）：',
      '  待办：tdai_task_add（你明确说「记一下」时写入）/ tdai_task_list /',
      '        tdai_task_update / tdai_task_delete',
      '',
      '配置：在「设置 → TDAI Memory」页里切换开关、修改身份。',
    ].join('\n')),
  })
}
