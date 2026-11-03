/**
 * 工作区身份覆盖的纯函数测试（多工作区多 agent）。
 *
 * 语义只有一条链：workspaceAgentsEnabled + workspaceAgents → identityForWorkspace(cfg, cwd)。
 * 这里把「默认回落 / 开关关闭 / 路径规范化 / 部分覆盖 / 坏数据」全部钉死，
 * 避免 UI 看起来配了、运行时却用默认身份（或反过来）。
 *
 * 运行：node test/workspace-agents.test.mjs
 */
import assert from 'node:assert'
import {
  normalizeWorkspaceAgents,
  normalizeWorkspacePath,
  workspaceBindingFor,
  identityForWorkspace,
  identityComplete,
  resolveConfig,
} from '../config.mjs'

const BASE = {
  serviceId: 'default', teamId: 'team-default', agentId: 'agt-default', userId: 'usr', userKey: '',
  workspaceAgentsEnabled: true,
  workspaceAgents: [
    { workspace: '/mnt/d/repo/a/', title: 'Repo A', teamId: 'team-a', agentId: 'agt-a' },
    { workspace: '/mnt/d/repo/b', title: 'Repo B', agentId: 'agt-b' },
    { workspace: '/mnt/d/repo/c', title: 'Repo C', teamId: 'team-c' },
  ],
}

// ── 1) 路径规范化：只做同一路径不同写法的归一 ───────────────────────────────
{
  assert.equal(normalizeWorkspacePath('/mnt/d/repo/a/'), '/mnt/d/repo/a')
  assert.equal(normalizeWorkspacePath('/mnt/d/repo/a//'), '/mnt/d/repo/a')
  assert.equal(normalizeWorkspacePath('/mnt/d/repo/../repo/a'), '/mnt/d/repo/a')
  assert.equal(normalizeWorkspacePath(''), '')
  assert.equal(normalizeWorkspacePath('   '), '')
  assert.equal(normalizeWorkspacePath(undefined), '')
  assert.equal(normalizeWorkspacePath('/'), '/')
}

// ── 2) 规则表归一化：空串 / JSON 字符串 / 数组；坏条目丢弃；同路径后者覆盖 ──
{
  assert.deepEqual(normalizeWorkspaceAgents(undefined), [])
  assert.deepEqual(normalizeWorkspaceAgents(''), [])
  assert.deepEqual(normalizeWorkspaceAgents('not json'), [])
  assert.deepEqual(normalizeWorkspaceAgents({}), [])
  assert.deepEqual(
    normalizeWorkspaceAgents('[{"workspace":"/a/","teamId":"t","agentId":"a"}]'),
    [{ workspace: '/a', title: '', teamId: 't', agentId: 'a' }],
    'JSON 字符串（env 形态）应被接受',
  )
  assert.deepEqual(
    normalizeWorkspaceAgents([
      { workspace: '/a', teamId: 't1', agentId: 'a1' },
      { workspace: '/a/', teamId: 't2', agentId: 'a2' },
      { workspace: '', teamId: 't', agentId: 'a' },
      { workspace: '/b' },
      { workspace: '/c', teamId: '  ', agentId: '  ' },
      null,
    ]),
    [{ workspace: '/a', title: '', teamId: 't2', agentId: 'a2' }],
    '同路径后者覆盖；无覆盖字段 / 无路径的条目丢弃',
  )
}

// ── 3) resolveConfig：默认关；字符串开关也能解析 ────────────────────────────
{
  const off = resolveConfig({ ...BASE, workspaceAgentsEnabled: undefined })
  assert.equal(off.workspaceAgentsEnabled, false, '默认必须关，升级后行为不变')
  assert.equal(off.workspaceAgents.length, 3, '开关关着也归一化规则，面板要能回显')
  assert.equal(
    identityForWorkspace(off, '/mnt/d/repo/a').cfg.agentId,
    'agt-default',
    '总开关关闭 → 一律默认身份',
  )

  const on = resolveConfig({ ...BASE, workspaceAgentsEnabled: 'true' })
  assert.equal(on.workspaceAgentsEnabled, true, 'env 字符串 "true" 应生效')
  const fromJson = resolveConfig({ ...BASE, workspaceAgents: '[{"workspace":"/x","agentId":"ax"}]' })
  assert.deepEqual(fromJson.workspaceAgents, [{ workspace: '/x', title: '', teamId: '', agentId: 'ax' }])
}

// ── 4) 命中规则：全量覆盖 / 只覆盖 agent / 只覆盖 team / 未命中回默认 ────────
{
  const cfg = resolveConfig(BASE)

  const a = identityForWorkspace(cfg, '/mnt/d/repo/a')
  assert.equal(a.cfg.teamId, 'team-a')
  assert.equal(a.cfg.agentId, 'agt-a')
  assert.equal(a.rule.workspace, '/mnt/d/repo/a', '返回命中的规则，状态页要展示')

  const b = identityForWorkspace(cfg, '/mnt/d/repo/b/')
  assert.equal(b.cfg.teamId, 'team-default', '规则没填 team → 回落默认 team')
  assert.equal(b.cfg.agentId, 'agt-b')

  const c = identityForWorkspace(cfg, '/mnt/d/repo/c')
  assert.equal(c.cfg.teamId, 'team-c')
  assert.equal(c.cfg.agentId, 'agt-default', '规则没填 agent → 回落默认 agent')

  for (const cwd of ['/mnt/d/other', '', undefined, null]) {
    const miss = identityForWorkspace(cfg, cwd)
    assert.equal(miss.cfg.teamId, 'team-default', `未命中 (${cwd}) 应回落默认 team`)
    assert.equal(miss.cfg.agentId, 'agt-default', `未命中 (${cwd}) 应回落默认 agent`)
    assert.equal(miss.rule, undefined)
  }

  assert.equal(workspaceBindingFor(cfg, '/mnt/d/repo/a')?.agentId, 'agt-a')
  assert.equal(workspaceBindingFor(cfg, '/mnt/d/other'), undefined)
}

// ── 5) 覆盖补全缺失的默认身份：readEnabled 的判定基础 ───────────────────────
{
  const cfg = resolveConfig({
    ...BASE,
    teamId: '',
    agentId: '',
  })
  assert.equal(identityComplete(cfg), false, '默认身份不完整')
  const hit = identityForWorkspace(cfg, '/mnt/d/repo/a')
  assert.equal(identityComplete(hit.cfg), true, '工作区规则补全 team + agent 后应完整')
  const miss = identityForWorkspace(cfg, '/mnt/d/other')
  assert.equal(identityComplete(miss.cfg), false, '未命中工作区仍然不完整')
}

// ── 6) 不覆盖服务 / 用户 / task：用户维度共用同一个人 ───────────────────────
{
  const cfg = resolveConfig({ ...BASE, taskId: 'task-x' })
  const hit = identityForWorkspace(cfg, '/mnt/d/repo/a').cfg
  assert.equal(hit.serviceId, 'default')
  assert.equal(hit.userId, 'usr')
  assert.equal(hit.taskId, 'task-x')
}

console.log('workspace agents tests passed: 默认关 / 路径归一 / 规则归一 / 全量与部分覆盖 / 补全身份 / 未命中回落')
