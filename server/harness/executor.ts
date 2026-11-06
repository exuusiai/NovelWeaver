import { z } from 'zod'
import { sql } from '../db.ts'
import { estimateTokens } from '../memory.ts'
import { captureProject, getRun, projectRevision, saveRun, snapshotRun } from './store.ts'
import {
  assertActive,
  emptyCosts,
  SCHEMA_VERSION,
  ToolError,
  writeGuard,
  type Observation,
  type Run,
  type ToolRegistry,
} from './protocol.ts'

export const runRequest = z.object({
  projectId: z.string(),
  chapterId: z.string(),
  baseRevision: z.number().int().positive(),
  goal: z.string().min(1).max(8000),
  range: z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() }),
  pov: z.string().default(''),
  holderId: z.string().optional(),
  storyTick: z.number().int().optional(),
  targetWords: z.number().int().positive().optional(),
  preserve: z.array(z.string()).default([]),
  allowedChanges: z.array(z.string()).default(['措辞', '节奏']),
  evidenceIds: z.array(z.string()).default([]),
  sourceFamilyId: z.string().min(1).default('author-unassigned'),
  split: z.enum(['train', 'validation', 'test']).default('train'),
  dataOrigin: z.enum(['author', 'synthetic']).default('author'),
  budget: z
    .object({
      maxCalls: z.number().int().min(1).max(100).default(24),
      maxTokens: z.number().int().min(1).max(200000).default(40000),
      timeoutMs: z.number().int().min(1).max(120000).default(30000),
      maxRetries: z.number().int().min(0).max(3).default(1),
      maxOutputTokens: z.number().int().min(1).max(16000).default(3000),
    })
    .default({ maxCalls: 24, maxTokens: 40000, timeoutMs: 30000, maxRetries: 1, maxOutputTokens: 3000 }),
  seed: z.number().int().default(1),
})
export interface WorkflowStep {
  tool: string
  input: (run: Run) => unknown
  when?: (run: Run) => boolean
  next?: (run: Run) => number | 'pause' | 'stop'
}
export interface Workflow {
  name: string
  version: string
  steps: WorkflowStep[]
}
// Model policies can implement this contract after server evaluation. The executor
// still enforces registry schemas, budgets and author-controlled write tools.
export interface ToolPolicy {
  version: string
  chooseNext: (
    run: Readonly<Run>,
    catalog: ReturnType<ToolRegistry['catalog']>,
  ) => Promise<{ tool: string; input: unknown } | { stopReason: string }>
}
const keys: Record<string, string> = {
  'task.define': 'task',
  'memory.search': 'memory',
  'setting.select': 'selection',
  'context.pack': 'context',
  'evidence.read': 'evidence',
  'revision.plan': 'plan',
  'revision.propose': 'proposal',
  'revision.verify': 'verification',
  'revision.commit': 'commit',
  'revision.undo': 'undo',
  'revision.reject': 'rejection',
}

export class Executor {
  private controllers = new Map<string, AbortController>()
  private locks = new Set<string>()
  constructor(
    public registry: ToolRegistry,
    public workflows: Workflow[],
  ) {}
  create(input: unknown) {
    const request = runRequest.parse(input)
    if (!sql.get('SELECT id FROM projects WHERE id=?', request.projectId))
      throw new ToolError('NOT_FOUND', '项目不存在。')
    const run: Run = {
      id: sql.id(),
      taskId: sql.id(),
      projectId: request.projectId,
      schemaVersion: SCHEMA_VERSION,
      workflow: 'revision.local',
      workflowVersion: '1.0.0',
      modelVersions: {},
      sourceFamilyId: request.sourceFamilyId,
      split: request.split,
      dataOrigin: request.dataOrigin,
      request,
      initialState: captureProject(request.projectId),
      state: {},
      steps: [],
      status: 'paused',
      stopReason: 'created',
      cursor: 0,
      budget: request.budget,
      costs: emptyCosts(),
      randomState: request.seed >>> 0,
      interaction: [{ role: 'author', content: request, at: sql.now() }],
      adoption: [],
      createdAt: sql.now(),
      updatedAt: sql.now(),
    }
    saveRun(run)
    snapshotRun(run)
    return run
  }
  async call(runId: string, name: string, rawInput: unknown): Promise<Observation> {
    if (this.locks.has(runId)) throw new ToolError('VERSION_CONFLICT', '该运行正在执行工具，请等待当前调用结束。')
    this.locks.add(runId)
    const run = getRun(runId)
    const controller = new AbortController()
    this.controllers.set(runId, controller)
    const existingStepCount = run.steps.length
    try {
      if (run.status === 'canceled') throw new ToolError('CANCELED', '运行已取消。')
      if (run.costs.calls >= run.budget.maxCalls) {
        run.status = 'paused'
        run.stopReason = 'budget_exhausted'
        saveRun(run)
        throw new ToolError('BUDGET_EXHAUSTED', '调用次数预算不足。')
      }
      const spec = this.registry.get(name)
      const parsed = spec.input.safeParse(rawInput)
      if (!parsed.success) throw new ToolError('INVALID_INPUT', parsed.error.message)
      if (spec.effect === 'write' && !writeGuard.safeParse(parsed.data).success)
        throw new ToolError('INVALID_INPUT', '写操作必须提供 baseRevision 和 idempotencyKey。')
      const inputTokens = spec.estimateInputTokens?.(parsed.data, run) ?? estimateTokens(JSON.stringify(parsed.data))
      const outputReservation = spec.effect === 'generate' ? run.budget.maxOutputTokens : 0
      if (
        run.costs.calls >= run.budget.maxCalls ||
        run.costs.inputTokens + run.costs.outputTokens + inputTokens + outputReservation > run.budget.maxTokens
      ) {
        run.status = 'paused'
        run.stopReason = 'budget_exhausted'
        saveRun(run)
        throw new ToolError('BUDGET_EXHAUSTED', '调用次数或 Token 预算不足。')
      }
      const beforeRevision = projectRevision(run.projectId)
      const started = Date.now()
      const stepId = sql.id()
      const attempt =
        run.steps.filter((s) => s.tool === name && JSON.stringify(s.input) === JSON.stringify(parsed.data)).length + 1
      // Persist the intent before executing. Interrupted calls remain visible after restart.
      run.interaction.push({ role: 'tool_request', content: { stepId, name, input: parsed.data }, at: sql.now() })
      run.costs.calls += 1
      run.costs.inputTokens += inputTokens
      run.state.pendingCall = {
        id: stepId,
        tool: name,
        toolVersion: spec.version,
        input: parsed.data,
        attempt,
        startedAt: new Date(started).toISOString(),
        beforeRevision,
        inputTokens,
        effect: spec.effect,
      }
      saveRun(run)
      let timer: ReturnType<typeof setTimeout> | undefined
      let cancelListener: (() => void) | undefined
      let observation: Observation
      try {
        const timed = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new ToolError('TIMEOUT', '工具调用超时。', spec.effect !== 'write'))
            controller.abort()
          }, run.budget.timeoutMs)
        })
        const canceled = new Promise<never>((_, reject) => {
          cancelListener = () => reject(new ToolError('CANCELED', '调用已取消。'))
          controller.signal.addEventListener('abort', cancelListener, { once: true })
        })
        const result = await Promise.race([
          canceled,
          Promise.resolve().then(() => {
            assertActive(controller.signal)
            return spec.execute(parsed.data, {
              run,
              signal: controller.signal,
              maxOutputTokens: Math.min(
                run.budget.maxOutputTokens,
                run.budget.maxTokens - run.costs.inputTokens - run.costs.outputTokens,
              ),
              random: () => {
                run.randomState = (1664525 * run.randomState + 1013904223) >>> 0
                return run.randomState / 4294967296
              },
            })
          }),
          timed,
        ])
        assertActive(controller.signal)
        const checked = spec.output.safeParse(result.output)
        if (!checked.success) throw new ToolError('INVALID_OUTPUT', checked.error.message)
        const outputTokens = result.usage?.outputTokens ?? estimateTokens(JSON.stringify(checked.data))
        const actualInput = result.usage?.inputTokens ?? inputTokens
        observation = {
          status: result.status ?? 'ok',
          output: checked.data,
          changes: result.changes ?? [],
          costs: {
            calls: 1,
            inputTokens: actualInput,
            outputTokens,
            latencyMs: Date.now() - started,
            money: null,
            tokenSource: result.usage ? 'provider' : 'estimated',
          },
        }
      } catch (error) {
        const failure =
          error instanceof ToolError
            ? error
            : new ToolError(controller.signal.aborted ? 'CANCELED' : 'INTERNAL_ERROR', (error as Error).message)
        observation = {
          status: 'error',
          error: {
            code: failure.code,
            message: failure.message,
            retryable: failure.retryable,
            details: failure.details,
          },
          changes: [],
          costs: { ...emptyCosts(), calls: 1, inputTokens, latencyMs: Date.now() - started },
        }
      } finally {
        if (timer) clearTimeout(timer)
        if (cancelListener) controller.signal.removeEventListener('abort', cancelListener)
      }
      const live = getRun(run.id)
      // A control request can arrive during an awaited adapter call.
      if (live.status === 'canceled') {
        run.status = 'canceled'
        run.stopReason = 'author_canceled'
      } else if (live.stopReason === 'author_paused') {
        run.status = 'paused'
        run.stopReason = 'author_paused'
      }
      run.costs.inputTokens += observation.costs.inputTokens - inputTokens
      run.costs.outputTokens += observation.costs.outputTokens
      run.costs.latencyMs += observation.costs.latencyMs
      if (observation.costs.tokenSource === 'provider') run.costs.tokenSource = 'provider'
      delete run.state.pendingCall
      run.steps.push({
        id: stepId,
        tool: name,
        toolVersion: spec.version,
        input: parsed.data,
        attempt,
        startedAt: new Date(started).toISOString(),
        beforeRevision,
        afterRevision: projectRevision(run.projectId),
        observation,
      })
      run.interaction.push({ role: 'tool_observation', content: { stepId, observation }, at: sql.now() })
      if (observation.status !== 'error') {
        run.state[keys[name] ?? name] = observation.output
        if (name === 'revision.commit' || name === 'revision.undo' || name === 'revision.reject') {
          if (
            !run.adoption.some(
              (a) =>
                (a as { input: { idempotencyKey?: string } }).input?.idempotencyKey ===
                (parsed.data as { idempotencyKey?: string }).idempotencyKey,
            )
          ) {
            run.adoption.push({ action: name, input: parsed.data, result: observation.output, at: sql.now() })
            run.status = 'completed'
            run.stopReason =
              name === 'revision.reject'
                ? 'author_rejected'
                : name === 'revision.undo'
                  ? 'author_undone'
                  : 'author_adopted'
          }
        }
      }
      if (run.costs.inputTokens + run.costs.outputTokens > run.budget.maxTokens) {
        run.status = 'paused'
        run.stopReason = 'budget_exhausted'
      }
      saveRun(run)
      return observation
    } catch (error) {
      const failure = error instanceof ToolError ? error : new ToolError('INTERNAL_ERROR', (error as Error).message)
      if (run.steps.length !== existingStepCount) throw failure
      const charged = failure.code === 'BUDGET_EXHAUSTED' || failure.code === 'CANCELED' ? 0 : 1
      const costs = {
        ...emptyCosts(),
        calls: charged,
        inputTokens: charged ? estimateTokens(JSON.stringify(rawInput) ?? '') : 0,
      }
      const observation: Observation = {
        status: 'error',
        error: { code: failure.code, message: failure.message, retryable: failure.retryable, details: failure.details },
        changes: [],
        costs,
      }
      run.costs.calls += costs.calls
      run.costs.inputTokens += costs.inputTokens
      const revision = projectRevision(run.projectId)
      const id = sql.id()
      run.steps.push({
        id,
        tool: name,
        toolVersion: 'rejected-before-execution',
        input: rawInput,
        attempt: 1,
        startedAt: sql.now(),
        beforeRevision: revision,
        afterRevision: revision,
        observation,
      })
      run.interaction.push(
        { role: 'tool_request', content: { stepId: id, name, input: rawInput }, at: sql.now() },
        { role: 'tool_observation', content: { stepId: id, observation }, at: sql.now() },
      )
      saveRun(run)
      return observation
    } finally {
      this.controllers.delete(runId)
      this.locks.delete(runId)
    }
  }
  control(id: string, action: 'pause' | 'cancel') {
    const run = getRun(id)
    run.status = action === 'pause' ? 'paused' : 'canceled'
    run.stopReason = action === 'pause' ? 'author_paused' : 'author_canceled'
    if (action === 'cancel') this.controllers.get(id)?.abort()
    run.interaction.push({ role: 'author', content: { action }, at: sql.now() })
    saveRun(run)
    return run
  }
  async resume(id: string) {
    let run = getRun(id)
    if (run.status === 'completed' || run.status === 'canceled') return run
    if (this.locks.has(id) || run.status === 'running') throw new ToolError('VERSION_CONFLICT', '运行正在执行。')
    const workflow = this.workflows.find((w) => w.name === run.workflow && w.version === run.workflowVersion)
    if (!workflow) throw new ToolError('NOT_FOUND', '工作流版本不可用。')
    run.status = 'running'
    run.stopReason = ''
    saveRun(run)
    while (run.cursor < workflow.steps.length) {
      const step = workflow.steps[run.cursor]
      if (step.when && !step.when(run)) {
        run.cursor++
        saveRun(run)
        continue
      }
      let observation: Observation | undefined
      for (let retry = 0; retry <= run.budget.maxRetries; retry++) {
        try {
          observation = await this.call(id, step.tool, step.input(run))
        } catch (error) {
          run = getRun(id)
          run.status = 'paused'
          run.stopReason = error instanceof ToolError ? error.code.toLowerCase() : 'internal_error'
          saveRun(run)
          return run
        }
        run = getRun(id)
        if (run.status !== 'running') return run
        if (observation.status !== 'error' || !observation.error?.retryable) break
      }
      if (!observation || observation.status !== 'ok') {
        run.status = 'paused'
        run.stopReason =
          observation?.status === 'pending' ? 'needs_check' : observation?.error?.code.toLowerCase() || 'tool_failed'
        saveRun(run)
        snapshotRun(run)
        return run
      }
      const route = step.next?.(run)
      if (route === 'pause' || route === 'stop') {
        run.status = route === 'pause' ? 'paused' : 'completed'
        run.stopReason = route === 'pause' ? 'evidence_insufficient' : 'policy_stopped'
        saveRun(run)
        return run
      }
      run.cursor = typeof route === 'number' ? route : run.cursor + 1
      saveRun(run)
    }
    run.status = 'paused'
    run.stopReason = 'awaiting_author'
    saveRun(run)
    snapshotRun(run)
    return run
  }
}
export function recoverRuns() {
  for (const row of sql.all<{ id: string }>('SELECT id FROM harness_runs')) {
    const run = getRun(row.id)
    if (run.state.pendingCall) {
      const pending = run.state.pendingCall as {
        id: string
        tool: string
        toolVersion: string
        input: unknown
        attempt: number
        startedAt: string
        beforeRevision: string
        inputTokens: number
        effect: string
      }
      const observation: Observation = {
        status: 'error',
        error: {
          code: pending.effect === 'write' ? 'NEEDS_CHECK' : 'TEMPORARY_FAILURE',
          message: '进程在返回观察前中断；写操作可用原幂等标识查询回执。',
          retryable: pending.effect !== 'write',
        },
        changes: [],
        costs: { ...emptyCosts(), calls: 1, inputTokens: pending.inputTokens },
      }
      run.steps.push({ ...pending, afterRevision: projectRevision(run.projectId), observation })
      run.interaction.push({ role: 'recovery', content: { stepId: pending.id, observation }, at: sql.now() })
      delete run.state.pendingCall
      run.status = 'paused'
      run.stopReason = 'process_interrupted'
      saveRun(run)
    } else if (run.status === 'running') {
      run.status = 'paused'
      run.stopReason = 'process_interrupted'
      saveRun(run)
    }
  }
}
