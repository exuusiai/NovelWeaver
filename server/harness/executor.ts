import { z } from 'zod'
import { sql } from '../db.ts'
import { estimateTokens } from '../memory.ts'
import { taskInputSchema } from '../tasks/contracts.ts'
import { resolveTask, hashPlan } from '../tasks/resolve.ts'
import { getTaskProfile } from '../tasks/profiles.ts'
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
  range: z.object({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  }),
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
    .default({
      maxCalls: 24,
      maxTokens: 40000,
      timeoutMs: 30000,
      maxRetries: 1,
      maxOutputTokens: 3000,
    }),
  seed: z.number().int().default(1),
  constraints: taskInputSchema.shape.constraints.optional(),
  feedbackMode: z.enum(['summary', 'fact_diff']).default('summary'),
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
  modelVersion?: string
  chooseNext: (
    observation: PolicyObservation,
    catalog: ReturnType<ToolRegistry['catalog']>,
    options: { signal: AbortSignal },
  ) => Promise<
    ({ tool: string; input: unknown } | { stopReason: string }) & {
      usage?: { inputTokens: number; outputTokens: number }
    }
  >
}
export interface PolicyObservation {
  task: unknown
  original: unknown
  candidate: unknown
  context: unknown
  verification: unknown
  recent: unknown[]
  remainingBudget: { calls: number; tokens: number }
  profileId: string
  randomState: number
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
  'task.context': 'context',
  'artifact.generate': 'artifact',
  'artifact.verify': 'artifactVerification',
}

export class Executor {
  private controllers = new Map<string, AbortController>()
  private locks = new Set<string>()
  private policyRuns = new Set<string>()
  constructor(
    public registry: ToolRegistry,
    public workflows: Workflow[],
  ) {}
  private prepare(input: unknown) {
    const adaptive = typeof input === 'object' && input !== null && ('operation' in input || 'task' in input)
    const incoming = adaptive ? taskInputSchema.parse(input) : runRequest.parse(input)
    const chapter = incoming.chapterId
      ? sql.get<{
          content: string
          revision: number
          pov: string
          story_tick: number | null
        }>(
          'SELECT content,revision,pov,story_tick FROM chapters WHERE id=? AND project_id=?',
          incoming.chapterId,
          incoming.projectId,
        )
      : undefined
    if (adaptive && incoming.chapterId && !chapter)
      throw new ToolError('NOT_FOUND', '章节不存在或不属于项目。')
    if (
      adaptive &&
      incoming.holderId &&
      !sql.get(
        "SELECT id FROM entities WHERE id=? AND project_id=? AND type='character'",
        incoming.holderId,
        incoming.projectId,
      )
    )
      throw new ToolError('NOT_FOUND', '视角身份不存在或不属于当前项目。')
    const adaptation = adaptive
      ? resolveTask(
          {
            ...incoming,
            chapterContent: (incoming as { chapterContent?: string }).chapterContent ?? chapter?.content,
            baseRevision: incoming.baseRevision ?? chapter?.revision,
            pov: incoming.pov || chapter?.pov,
            storyTick: incoming.storyTick ?? chapter?.story_tick ?? undefined,
          },
          this.registry.capabilities(),
        )
      : undefined
    if (
      adaptation?.taskSpec.knowledgeView.audience === 'character' &&
      !adaptation.taskSpec.knowledgeView.holderId &&
      chapter?.pov
    ) {
      const identities = sql.all<{ id: string }>(
        "SELECT id FROM entities WHERE project_id=? AND type='character' AND name=?",
        incoming.projectId,
        chapter.pov,
      )
      if (identities.length === 1) adaptation.taskSpec.knowledgeView.holderId = identities[0].id
      else if (identities.length > 1) {
        adaptation.routeDecision.missing.push('holderId')
        adaptation.routeDecision.status = 'needs_input'
      }
    }
    let request: Record<string, unknown> = {
      ...incoming,
      goal: adaptation?.taskSpec.goal ?? (incoming as { goal?: string }).goal,
    }
    if (adaptation?.plan.profileId === 'revision.local' && chapter) {
      request = runRequest.parse({
        ...incoming,
        chapterContent: undefined,
        goal: adaptation.taskSpec.goal,
        baseRevision: incoming.baseRevision ?? chapter?.revision,
        pov: incoming.pov || chapter?.pov,
        holderId: adaptation.taskSpec.knowledgeView.holderId,
        range: incoming.range ?? {
          start: 0,
          end: chapter?.content.length ?? 0,
        },
      })
      adaptation.taskSpec.range = request.range as {
        start: number
        end: number
      }
      adaptation.taskSpec.baseRevision = request.baseRevision as number
    }
    if (!sql.get('SELECT id FROM projects WHERE id=?', incoming.projectId))
      throw new ToolError('NOT_FOUND', '项目不存在。')
    return { incoming, request, adaptation }
  }
  resolve(input: unknown) {
    const body = input as Record<string, unknown>
    return this.prepare({ ...body, operation: body?.operation }).adaptation!
  }
  create(input: unknown) {
    const { incoming, request, adaptation } = this.prepare(input)
    const run: Run = {
      id: sql.id(),
      taskId: sql.id(),
      projectId: incoming.projectId,
      schemaVersion: SCHEMA_VERSION,
      workflow: adaptation?.plan.workflow ?? 'revision.local',
      workflowVersion: adaptation?.plan.workflowVersion ?? '1.0.0',
      modelVersions: {},
      sourceFamilyId: incoming.sourceFamilyId,
      split: incoming.split,
      dataOrigin: incoming.dataOrigin,
      request,
      initialState: captureProject(incoming.projectId),
      state:
        adaptation && adaptation.plan.profileId !== 'revision.local' ? { task: adaptation.taskSpec } : {},
      steps: [],
      status: 'paused',
      stopReason: adaptation?.routeDecision.status === 'needs_input' ? 'needs_input' : 'created',
      cursor: 0,
      budget: adaptation?.plan.budget ?? runRequest.parse(input).budget,
      costs: emptyCosts(),
      randomState: incoming.seed >>> 0,
      interaction: [{ role: 'author', content: request, at: sql.now() }],
      adoption: [],
      createdAt: sql.now(),
      updatedAt: sql.now(),
      adaptation,
    }
    saveRun(run)
    snapshotRun(run)
    return run
  }
  async call(
    runId: string,
    name: string,
    rawInput: unknown,
    actor: 'author' | 'policy' | 'system' = 'author',
  ): Promise<Observation> {
    if (actor === 'author' && this.policyRuns.has(runId))
      throw new ToolError('VERSION_CONFLICT', '策略正在执行，请先暂停。')
    if (this.locks.has(runId))
      throw new ToolError('VERSION_CONFLICT', '该运行正在执行工具，请等待当前调用结束。')
    this.locks.add(runId)
    const run = getRun(runId)
    const controller = new AbortController()
    this.controllers.set(runId, controller)
    const existingStepCount = run.steps.length
    try {
      if (run.status === 'canceled') throw new ToolError('CANCELED', '运行已取消。')
      if (actor === 'policy' && run.state['episode.finish'])
        throw new ToolError('INVALID_INPUT', 'episode 已结束，请 reset 新任务。')
      if (run.costs.calls >= run.budget.maxCalls) {
        run.status = 'paused'
        run.stopReason = 'budget_exhausted'
        saveRun(run)
        throw new ToolError('BUDGET_EXHAUSTED', '调用次数预算不足。')
      }
      const spec = this.registry.get(name)
      this.assertPlan(run)
      if (run.adaptation) {
        const allowedAuthorWrite =
          actor === 'author' &&
          run.adaptation.plan.profileId === 'revision.local' &&
          [
            'revision.commit',
            'revision.reject',
            'revision.undo',
            'canon.confirm',
            'memory.scope',
            'dependency.link',
          ].includes(name)
        if (!run.adaptation.plan.toolAllowlist.includes(name) && !allowedAuthorWrite)
          throw new ToolError('INVALID_INPUT', '工具不在本次任务许可中。')
        if (
          actor === 'policy' &&
          [
            'task.define',
            'revision.commit',
            'revision.reject',
            'revision.undo',
            'canon.confirm',
            'memory.scope',
            'dependency.link',
          ].includes(name)
        )
          throw new ToolError('INVALID_INPUT', '策略不可调用控制层或作者操作。')
        if (name === 'task.define') {
          const parsedTask = runRequest.parse(rawInput)
          const frozen = runRequest.parse(run.request)
          if (JSON.stringify(parsedTask) !== JSON.stringify(frozen))
            throw new ToolError('INVALID_INPUT', '任务目标和范围已固定。')
        }
        if (['memory.search', 'setting.select'].includes(name)) {
          const proposed = (rawInput as { view?: unknown })?.view
          const frozen = run.adaptation.taskSpec.knowledgeView as unknown as Record<string, unknown>
          if (
            !proposed ||
            Object.keys(proposed).some((key) => (proposed as Record<string, unknown>)[key] !== frozen[key]) ||
            Object.entries(frozen).some(
              ([key, value]) => value !== undefined && (proposed as Record<string, unknown>)[key] !== value,
            )
          )
            throw new ToolError('INVALID_INPUT', '不能改变任务知情范围。')
        }
        if (
          name === 'context.pack' &&
          Number((rawInput as { tokenBudget?: number })?.tokenBudget) >
            run.adaptation.plan.budget.contextTokens
        )
          throw new ToolError('BUDGET_EXHAUSTED', '上下文打包不能扩大任务容量。')
      }
      const parsed = spec.input.safeParse(rawInput)
      if (!parsed.success) throw new ToolError('INVALID_INPUT', parsed.error.message)
      if (spec.effect === 'write' && !writeGuard.safeParse(parsed.data).success)
        throw new ToolError('INVALID_INPUT', '写操作必须提供 baseRevision 和 idempotencyKey。')
      const inputTokens =
        spec.estimateInputTokens?.(parsed.data, run) ?? estimateTokens(JSON.stringify(parsed.data))
      if (
        run.adaptation &&
        spec.effect === 'generate' &&
        inputTokens > run.adaptation.plan.budget.contextTokens
      )
        throw new ToolError('BUDGET_EXHAUSTED', '完整模型输入超出任务输入容量。')
      const outputReservation = spec.effect === 'generate' ? run.budget.maxOutputTokens : 0
      if (
        run.costs.calls >= run.budget.maxCalls ||
        run.costs.inputTokens + run.costs.outputTokens + inputTokens + outputReservation >
          run.budget.maxTokens
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
        run.steps.filter((s) => s.tool === name && JSON.stringify(s.input) === JSON.stringify(parsed.data))
          .length + 1
      // Persist the intent before executing. Interrupted calls remain visible after restart.
      run.interaction.push({
        role: 'tool_request',
        content: { stepId, name, input: parsed.data },
        at: sql.now(),
      })
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
          controller.signal.addEventListener('abort', cancelListener, {
            once: true,
          })
        })
        const result = await Promise.race([
          canceled,
          Promise.resolve().then(() => {
            assertActive(controller.signal)
            return spec.execute(parsed.data, {
              run,
              actor,
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
            : new ToolError(
                controller.signal.aborted ? 'CANCELED' : 'INTERNAL_ERROR',
                (error as Error).message,
              )
        observation = {
          status: 'error',
          error: {
            code: failure.code,
            message: failure.message,
            retryable: failure.retryable,
            details: failure.details,
          },
          changes: [],
          costs: {
            ...emptyCosts(),
            calls: 1,
            inputTokens,
            latencyMs: Date.now() - started,
          },
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
      run.interaction.push({
        role: 'tool_observation',
        content: { stepId, observation },
        at: sql.now(),
      })
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
            run.adoption.push({
              action: name,
              input: parsed.data,
              result: observation.output,
              at: sql.now(),
            })
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
      const failure =
        error instanceof ToolError ? error : new ToolError('INTERNAL_ERROR', (error as Error).message)
      if (run.steps.length !== existingStepCount) throw failure
      const charged = failure.code === 'BUDGET_EXHAUSTED' || failure.code === 'CANCELED' ? 0 : 1
      const costs = {
        ...emptyCosts(),
        calls: charged,
        inputTokens: charged ? estimateTokens(JSON.stringify(rawInput) ?? '') : 0,
      }
      const observation: Observation = {
        status: 'error',
        error: {
          code: failure.code,
          message: failure.message,
          retryable: failure.retryable,
          details: failure.details,
        },
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
        {
          role: 'tool_request',
          content: { stepId: id, name, input: rawInput },
          at: sql.now(),
        },
        {
          role: 'tool_observation',
          content: { stepId: id, observation },
          at: sql.now(),
        },
      )
      saveRun(run)
      return observation
    } finally {
      this.controllers.delete(runId)
      this.locks.delete(runId)
    }
  }
  assertPlan(run: Run) {
    if (!run.adaptation) return
    const { planHash, ...plan } = run.adaptation.plan
    let profile: ReturnType<typeof getTaskProfile>
    try {
      profile = getTaskProfile(plan.profileId, plan.profileVersion)
    } catch {
      throw new ToolError('VERSION_CONFLICT', '任务配置版本不可用，请明确迁移后继续。')
    }
    if (
      hashPlan(plan) !== planHash ||
      JSON.stringify(plan.toolAllowlist) !== JSON.stringify(profile.toolAllowlist) ||
      run.workflow !== plan.workflow ||
      run.workflowVersion !== plan.workflowVersion
    )
      throw new ToolError('VERSION_CONFLICT', '执行计划或任务配置版本不同，请明确迁移后重建任务。')
  }
  observe(id: string): PolicyObservation {
    const run = getRun(id)
    this.assertPlan(run)
    if (!run.adaptation) throw new ToolError('INVALID_INPUT', '策略需要任务配置。')
    const verify = run.state.verification as Record<string, unknown> | undefined
    const rows = verify?.factDiff as Array<{ detail: string; before: unknown; after: unknown }> | undefined
    const feedback = verify ? { ...verify } : null
    if (feedback && run.adaptation.plan.feedbackMode !== 'fact_diff') {
      delete feedback.factDiff
      feedback.factSummary = rows?.map((r) => `${r.detail}；修改前=${r.before}，修改后=${r.after}`).join('\n')
    }
    const context = run.state.context as { text?: string; evidence?: unknown[] } | undefined
    return structuredClone({
      task: run.adaptation.taskSpec,
      original: (run.state.plan as { original?: string })?.original,
      candidate: run.state.proposal ?? run.state.artifact ?? null,
      context: {
        text: context?.text ?? '',
        evidence: context?.evidence ?? (run.state.evidence as { evidence?: unknown[] })?.evidence ?? [],
      },
      verification: feedback ?? run.state.artifactVerification ?? null,
      recent: run.steps.slice(-4).map((s) => ({
        tool: s.tool,
        status: s.observation.status,
        error: s.observation.error,
        output: s.tool === 'revision.verify' ? feedback : s.observation.output,
      })),
      remainingBudget: {
        calls: run.budget.maxCalls - run.costs.calls,
        tokens: run.budget.maxTokens - run.costs.inputTokens - run.costs.outputTokens,
      },
      profileId: run.adaptation.plan.profileId,
      randomState: run.randomState,
    })
  }
  async runPolicy(id: string, policy: ToolPolicy) {
    if (this.policyRuns.has(id)) throw new ToolError('VERSION_CONFLICT', '策略已在运行。')
    let run = getRun(id)
    if (run.adaptation?.plan.profileId !== 'revision.local')
      throw new ToolError('INVALID_INPUT', '首版本策略循环用于局部改稿。')
    if (
      run.status === 'completed' ||
      run.status === 'canceled' ||
      run.adaptation.routeDecision.status === 'needs_input'
    )
      return run
    this.assertPlan(run)
    if (run.state['episode.finish']) return run
    this.policyRuns.add(id)
    try {
      run.status = 'running'
      run.stopReason = ''
      run.modelVersions.policy = policy.modelVersion ?? policy.version
      saveRun(run)
      if (!run.state.plan) {
        for (const tool of ['task.define', 'revision.plan']) {
          const observation = await this.call(
            id,
            tool,
            tool === 'task.define' ? runRequest.parse(run.request) : {},
            'system',
          )
          if (observation.status !== 'ok') throw new ToolError('NEEDS_CHECK', '策略初始化失败。')
        }
      }
      const catalog = this.registry
        .catalog()
        .filter((t) => run.adaptation!.plan.toolAllowlist.includes(t.name) && t.name !== 'task.define')
      while ((run = getRun(id)).status === 'running') {
        const observation = this.observe(id),
          estimatedInput = estimateTokens(
            JSON.stringify({
              observation,
              catalog: catalog.map((t) => ({
                name: t.name,
                inputSchema: t.inputSchema,
              })),
            }),
          )
        if (
          run.costs.calls >= run.budget.maxCalls ||
          estimatedInput > run.adaptation!.plan.budget.contextTokens ||
          run.costs.inputTokens + run.costs.outputTokens + estimatedInput + run.budget.maxOutputTokens >
            run.budget.maxTokens
        )
          throw new ToolError('BUDGET_EXHAUSTED', '策略预算已耗尽。')
        const controller = new AbortController()
        this.controllers.set(id, controller)
        const start = Date.now()
        run.costs.calls++
        run.costs.inputTokens += estimatedInput
        run.state.pendingPolicy = { version: policy.version, estimatedInput }
        saveRun(run)
        let timer: ReturnType<typeof setTimeout> | undefined
        let decision: Awaited<ReturnType<ToolPolicy['chooseNext']>>
        try {
          decision = await Promise.race([
            policy.chooseNext(observation, catalog, {
              signal: controller.signal,
            }),
            new Promise<never>((_resolve, reject) => {
              controller.signal.addEventListener(
                'abort',
                () => reject(new ToolError('CANCELED', '策略调用已取消。')),
                { once: true },
              )
              timer = setTimeout(() => {
                reject(new ToolError('TIMEOUT', '策略调用超时。'))
                controller.abort()
              }, run.budget.timeoutMs)
            }),
          ])
        } finally {
          if (timer) clearTimeout(timer)
          this.controllers.delete(id)
        }
        run = getRun(id)
        run.costs.inputTokens += (decision.usage?.inputTokens ?? estimatedInput) - estimatedInput
        run.costs.outputTokens += decision.usage?.outputTokens ?? estimateTokens(JSON.stringify(decision))
        run.costs.latencyMs += Date.now() - start
        delete run.state.pendingPolicy
        if (run.costs.inputTokens + run.costs.outputTokens > run.budget.maxTokens) {
          run.status = 'paused'
          run.stopReason = 'budget_exhausted'
        }
        run.interaction.push({
          role: 'assistant',
          content: {
            policyVersion: policy.version,
            decision,
            usage: decision.usage ?? null,
          },
          at: sql.now(),
        })
        saveRun(run)
        if (run.status !== 'running') break
        if ('stopReason' in decision) {
          run.status = 'paused'
          run.stopReason = 'policy_stopped'
          saveRun(run)
          break
        }
        await this.call(id, decision.tool, decision.input, 'policy')
      }
    } catch (error) {
      run = getRun(id)
      if (run.status !== 'canceled') {
        run.status = 'paused'
        run.stopReason = error instanceof ToolError ? error.code.toLowerCase() : 'policy_error'
      }
      delete run.state.pendingPolicy
      run.interaction.push({
        role: 'policy_error',
        content: { message: (error as Error).message },
        at: sql.now(),
      })
      saveRun(run)
    } finally {
      this.policyRuns.delete(id)
      snapshotRun(getRun(id))
    }
    return getRun(id)
  }
  control(id: string, action: 'pause' | 'cancel') {
    const run = getRun(id)
    run.status = action === 'pause' ? 'paused' : 'canceled'
    run.stopReason = action === 'pause' ? 'author_paused' : 'author_canceled'
    this.controllers.get(id)?.abort()
    run.interaction.push({
      role: 'author',
      content: { action },
      at: sql.now(),
    })
    saveRun(run)
    return run
  }
  async resume(id: string) {
    let run = getRun(id)
    if (run.status === 'completed' || run.status === 'canceled') return run
    if (run.adaptation?.routeDecision.status === 'needs_input') return run
    this.assertPlan(run)
    if (this.locks.has(id) || run.status === 'running')
      throw new ToolError('VERSION_CONFLICT', '运行正在执行。')
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
          observation = await this.call(id, step.tool, step.input(run), 'system')
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
          observation?.status === 'pending'
            ? 'needs_check'
            : observation?.error?.code.toLowerCase() || 'tool_failed'
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
    if (run.state.pendingPolicy) {
      delete run.state.pendingPolicy
      run.status = 'paused'
      run.stopReason = 'process_interrupted'
      saveRun(run)
    }
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
      run.steps.push({
        ...pending,
        afterRevision: projectRevision(run.projectId),
        observation,
      })
      run.interaction.push({
        role: 'recovery',
        content: { stepId: pending.id, observation },
        at: sql.now(),
      })
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
