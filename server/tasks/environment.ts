import { db, sql } from '../db.ts'
import { captureProject, getRun, restoreProject, saveRun, snapshotRun } from '../harness/store.ts'
import { ToolError, type Run } from '../harness/protocol.ts'
import type { Executor } from '../harness/executor.ts'
import { runRequest } from '../harness/executor.ts'
import type { TaskInput } from './contracts.ts'

type ProjectSnapshot = ReturnType<typeof captureProject>
export class TaskEnvironment {
  private runId?: string
  constructor(
    private executor: Executor,
    private source: ProjectSnapshot,
    private evaluator?: (run: Readonly<Run>) => unknown,
  ) {
    if (process.env.NOVELWEAVER_DATA_DIR !== ':memory:' && process.env.NOVELWEAVER_REPLAY_ISOLATED !== '1')
      throw new ToolError('INVALID_INPUT', '环境操作需要隔离数据库。')
  }
  async reset(input: TaskInput) {
    const ids = new Map<string, string>([[this.source.projectId, sql.id()]])
    for (const rows of Object.values(this.source.tables))
      for (const row of rows) if (typeof row.id === 'string') ids.set(row.id, sql.id())
    const jsonColumns = new Set([
      'data',
      'metadata',
      'participants',
      'evidence',
      'evidence_ids',
      'locator',
      'input',
      'context_snapshot',
      'usage',
      'result',
    ])
    const remap = (value: unknown, key = ''): any => {
      if (typeof value === 'string') {
        if (key === 'sourceFamilyId') return value
        if (ids.has(value) && /(^id$|Id$|_id$|Ids$|_ids$|^knownBy$|^participants$|^evidence$)/.test(key))
          return ids.get(value)
        if (jsonColumns.has(key) && /^[\[{]/.test(value)) {
          try {
            return JSON.stringify(remap(JSON.parse(value), key))
          } catch {
            /* ordinary text */
          }
        }
        return value
      }
      if (Array.isArray(value)) return value.map((v) => remap(v, key))
      if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remap(v, k)]))
      return value
    }
    const clone = remap(this.source) as ProjectSnapshot
    // Project-level mutation runs transactionally; each reset has distinct project and record IDs.
    db.transaction(() => restoreProject(clone))()
    const request = remap(input) as TaskInput
    request.projectId = clone.projectId
    const created = this.executor.create({
      ...request,
      operation: request.operation,
    })
    this.runId = created.id
    if (
      created.adaptation?.plan.profileId === 'revision.local' &&
      created.adaptation.routeDecision.status === 'ready'
    ) {
      for (const tool of ['task.define', 'revision.plan']) {
        const result = await this.executor.call(
          created.id,
          tool,
          tool === 'task.define' ? runRequest.parse(created.request) : {},
          'system',
        )
        if (result.status !== 'ok')
          throw new ToolError('NEEDS_CHECK', '环境初始化未通过。', false, result.error)
      }
    }
    return this.observe()
  }
  private id() {
    if (!this.runId) throw new ToolError('INVALID_INPUT', '先 reset 环境。')
    return this.runId
  }
  async step(action: { tool: string; input: unknown }) {
    const observation = await this.executor.call(this.id(), action.tool, action.input, 'policy')
    return { observation, state: this.observe() }
  }
  observe() {
    return this.executor.observe(this.id())
  }
  snapshot() {
    return snapshotRun(getRun(this.id()))
  }
  restore(snapshot: ReturnType<typeof snapshotRun>) {
    const current = getRun(this.id())
    if (snapshot.run.id !== current.id || snapshot.database.projectId !== current.projectId)
      throw new ToolError('INVALID_INPUT', '只能恢复本环境的快照；新分支请独立 reset。')
    this.executor.assertPlan(snapshot.run)
    restoreProject(snapshot.database)
    saveRun(snapshot.run)
    return this.observe()
  }
  evaluate() {
    return this.evaluator
      ? this.evaluator(structuredClone(getRun(this.id())))
      : {
          status: 'unscored',
          detail: '请注入独立评测器；工具自检不作为训练金标准。',
        }
  }
}
