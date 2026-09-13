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
    const identity = runtime.identityFor(invocation.agent?.session)
    if (!identity) return renderResult('TDAI memory 未配置完整身份，无法执行。', true)
    try {
      return await handler(identity)
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
    handler: (invocation) => run(invocation, async (identity) => {
      const a = runtime.assets.peek(identity.session_id)
      const cfg = runtime.config
      const lines = [
        `endpoint: ${cfg.endpoint}`,
        `instance: ${cfg.serviceId}  team: ${cfg.teamId}  agent: ${cfg.agentId}`,
        `enabled: ${cfg.enabled}  recall: ${cfg.recallEnabled}  inject: ${cfg.injectionEnabled}  capture: ${cfg.captureEnabled}`,
        `assets: ${a ? `已加载（L2 ${a.profiles?.reduce((n, p) => n + (p.l2Entries?.length ?? 0), 0) ?? 0} 场景，Skill ${a.skills?.hits?.length ?? 0} 条）` : '未加载'}`,
      ]
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
      '只读工具：tdai_memory_search / tdai_conversation_search / tdai_skill_search / tdai_read_scene / tdai_skill_view / tdai_memory_query / tdai_conversation_query / tdai_scenario_ls',
      '配置：在「设置 → 插件」的 TDAI Memory 卡片里切换开关、修改身份。',
    ].join('\n')),
  })
}
