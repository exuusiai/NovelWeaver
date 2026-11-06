import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import type { Server } from 'node:http'
import { app } from './index.ts'
import { setupFixture } from '../eval/harness-fixture.ts'
import { taskFixture } from '../eval/task-scenarios.ts'
import { getRun } from './harness/store.ts'
import { recordEvidence } from './harness/evidence.ts'
import { runRequest } from './harness/executor.ts'
import { sql } from './db.ts'
import type { Verification } from './harness/protocol.ts'
let server: Server,
  base = ''
beforeAll(async () => {
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>((r) => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => {
  await new Promise<void>((r, reject) => server.close((e) => (e ? reject(e) : r())))
})
async function request<T = Record<string, any>>(path: string, body?: unknown) {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, data: (await response.json()) as T }
}
describe('任务适配 HTTP 契约', () => {
  it('公开配置和能力不会泄露凭证', async () => {
    const profiles = await request('/api/tasks/profiles'),
      caps = await request('/api/tasks/capabilities')
    expect(profiles.data.length).toBeGreaterThanOrEqual(7)
    expect(caps.data.writer).toBe(false)
    expect(JSON.stringify(caps)).not.toContain('apiKey')
  })
  it('预览和实际运行使用同一计划', async () => {
    const f = setupFixture(),
      input = {
        projectId: f.projectId,
        operation: 'review',
        goal: '检查铜钥匙',
        chapterId: f.chapters[0].id,
      }
    const plan = await request('/api/tasks/resolve', input),
      run = await request('/api/tasks/runs', input)
    expect(plan.status).toBe(200)
    expect(run.status).toBe(202)
    expect(run.data.adaptation.plan).toEqual(plan.data.plan)
    expect(run.data.adaptation.taskSpec).toEqual(plan.data.taskSpec)
  })
  it('未知目的保留 needs_input，非法输入返回 400', async () => {
    const f = setupFixture()
    const r = await request('/api/tasks/resolve', {
      projectId: f.projectId,
      goal: '处理一下',
    })
    expect(r.data.routeDecision.status).toBe('needs_input')
    expect((await request('/api/tasks/resolve', {})).status).toBe(400)
  })
  it('同步和SSE使用同一计划并明确待配置状态', async () => {
    const f = setupFixture(),
      input = {
        projectId: f.projectId,
        operation: 'draft',
        goal: '写一篇独立故事',
      }
    const sync = await request('/api/ai/generate', input)
    const stream = await fetch(base + '/api/ai/generate/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    const events = (await stream.text())
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice(6)))
    const done = events.find((e) => e.type === 'done')
    expect(done.adaptation.plan).toEqual(sync.data.adaptation.plan)
    expect(done.executionStatus).toBe('pending')
    expect(sync.data.output).toContain('本地任务状态')
  })
  it('只读任务不能通过旧调用API写正文或确认正史', async () => {
    const f = setupFixture(),
      created = await request('/api/tasks/runs', {
        projectId: f.projectId,
        operation: 'review',
        goal: '只检查',
        chapterId: f.chapters[0].id,
      })
    const denied = await request(`/api/harness/runs/${created.data.id}/call`, {
      tool: 'revision.commit',
      input: { baseRevision: 1, idempotencyKey: 'forbidden-author-api' },
    })
    expect(denied.data.status).toBe('error')
    expect(denied.data.error.code).toBe('INVALID_INPUT')
  })
  it('导出携带路由和profile信息，策略观察不含数据库快照', async () => {
    const f = setupFixture(),
      created = await request('/api/tasks/runs', {
        projectId: f.projectId,
        operation: 'draft',
        goal: '独立故事',
      })
    const observed = await request(`/api/tasks/runs/${created.data.id}/observe`)
    expect(observed.data.initialState).toBeUndefined()
    const response = await fetch(base + `/api/tasks/runs/${created.data.id}/export`)
    expect(response.headers.get('content-type')).toContain('application/x-ndjson')
    const record = JSON.parse(await response.text())
    expect(record.adaptation.routerVersion).toBeTruthy()
    expect(record.adaptation.plan.planHash).toBeTruthy()
  })
  it('旧改稿面板的运行列表不会加载审查或提取任务', async () => {
    const f = setupFixture()
    const created = await request('/api/tasks/runs', {
      projectId: f.projectId,
      operation: 'review',
      goal: '只检查',
      chapterId: f.chapters[0].id,
    })
    const list = await request<Array<{ id: string }>>(`/api/projects/${f.projectId}/harness/runs`)
    expect(list.data.some((row) => row.id === created.data.id)).toBe(false)
    expect(list.data.some((row) => row.id === f.run.id)).toBe(true)
  })
})
describe('约束与异常行为', () => {
  it('其他运行的未保存输入不能作为当前任务证据读取', async () => {
    const f = taskFixture()
    const source = f.executor.create(f.input('draft', { chapterContent: '尚未保存的作者草稿' }))
    const evidence = recordEvidence(f.projectId, 'input', source.id, '尚未保存的作者草稿', 'input_snapshot')
    const current = f.executor.create(f.input('revise'))
    await f.executor.call(current.id, 'task.define', runRequest.parse(current.request), 'system')
    const result = await f.executor.call(current.id, 'evidence.read', { evidenceIds: [evidence.id] })
    expect(result.error?.code).toBe('STALE_EVIDENCE')
    expect(JSON.stringify(result)).not.toContain('尚未保存的作者草稿')
  })
  it('结构提取采用作者分析视角，不被同名人物阻塞', async () => {
    const f = setupFixture(),
      resolved = await request('/api/tasks/resolve', {
        projectId: f.projectId,
        chapterId: f.chapters[0].id,
        operation: 'extract',
        goal: '提取事件与场景',
      })
    expect(resolved.data.routeDecision.status).toBe('ready')
    expect(resolved.data.taskSpec.knowledgeView.audience).toBe('author')
  })
  it('指定视角身份必须属于当前项目', async () => {
    const f = setupFixture(),
      other = setupFixture()
    const resolved = await request('/api/tasks/resolve', {
      projectId: f.projectId,
      chapterId: f.chapters[0].id,
      holderId: other.entityA,
      operation: 'continue',
      goal: '续写',
    })
    expect(resolved.status).toBe(404)
  })
  it('作者规划在生成后变化会使验证失败', async () => {
    const f = taskFixture(),
      id = sql.id()
    sql.run(
      "INSERT INTO story_outlines (id,project_id,title,content,version,status,created_at,updated_at) VALUES (?,?,?,?,1,'current',?,?)",
      id,
      f.projectId,
      '规划',
      '保留灯塔',
      sql.now(),
      sql.now(),
    )
    const r = f.executor.create(f.input('outline'))
    await f.executor.call(r.id, 'task.context', {})
    await f.executor.call(r.id, 'artifact.generate', {})
    sql.run('UPDATE story_outlines SET content=? WHERE id=?', '拆除灯塔', id)
    const result = await f.executor.call(r.id, 'artifact.verify', {})
    expect((result.output as Verification).status).toBe('fail')
  })
  it('未知语义约束保持待核验，不能仅凭四项总评通过', async () => {
    const f = taskFixture(),
      r = await f.executor.resume(
        f.executor.create(
          f.input('revise', {
            constraints: [{ id: 'owner', type: 'semantic', text: '钥匙仍由陆宁持有' }],
          }),
        ).id,
      )
    const verification = r.state.verification as {
      status: string
      semantic: Array<{ name: string; status: string }>
    }
    expect(verification.status).toBe('pending')
    expect(verification.semantic.find((c) => c.name === 'constraint:owner')?.status).toBe('pending')
  })
  it('策略选择超时后可恢复，成本与错误有记录', async () => {
    const f = taskFixture(),
      r = f.executor.create(
        f.input('revise', {
          budget: {
            timeoutMs: 10,
            maxCalls: 50,
            maxTokens: 150000,
            contextTokens: 16000,
          },
        }),
      )
    const stopped = await f.executor.runPolicy(r.id, {
      version: 'slow.v1',
      chooseNext: async () => new Promise(() => {}),
    })
    expect(stopped.stopReason).toBe('timeout')
    expect(stopped.state.pendingPolicy).toBeUndefined()
    expect(stopped.costs.inputTokens).toBeGreaterThan(0)
  })
  it('策略终止不能伪装候选成功', async () => {
    const f = taskFixture(),
      r = f.executor.create(f.input('revise'))
    const stopped = await f.executor.runPolicy(r.id, {
      version: 'stop.v1',
      chooseNext: async () => ({ stopReason: 'no_evidence' }),
    })
    expect(stopped.stopReason).toBe('policy_stopped')
    expect(stopped.status).toBe('paused')
    expect(stopped.adoption).toHaveLength(0)
  })
  it('目标与保留项在执行开始后不可替换', async () => {
    const f = taskFixture(),
      r = f.executor.create(f.input('revise'))
    const observation = await f.executor.call(r.id, 'task.define', {
      ...runRequest.parse(r.request),
      goal: '新目标',
    })
    expect(observation.error?.code).toBe('INVALID_INPUT')
    expect(getRun(r.id).request.goal).toBe(f.input('revise').goal)
  })
})
