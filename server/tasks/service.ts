import { sql } from '../db.ts'
import { createRegistry } from '../harness/tools.ts'
import { Executor } from '../harness/executor.ts'
import { revisionWorkflow, taskWorkflows } from '../harness/workflows.ts'
import { getRun } from '../harness/store.ts'
import type { TaskInput, Artifact } from './contracts.ts'

export const taskExecutor = new Executor(createRegistry(), [revisionWorkflow, ...taskWorkflows])
export async function previewTaskContext(input: TaskInput) {
  const run = taskExecutor.create({ ...input, operation: input.operation })
  if (run.adaptation?.plan.profileId === 'revision.local') {
    return {
      adaptation: run.adaptation,
      report: {
        included: [],
        trimmed: [],
        diagnostics: ['使用局部改稿任务预览'],
      },
      citations: [],
    }
  }
  const result = await taskExecutor.call(run.id, 'task.context', {}, 'system')
  const output = result.output as { report?: unknown; evidence?: unknown[] } | undefined
  return {
    adaptation: run.adaptation,
    report: output?.report ?? {
      included: [],
      trimmed: [],
      diagnostics: [result.error?.message],
    },
    citations: output?.evidence ?? [],
  }
}
export async function runGenerationTask(input: TaskInput) {
  const created = taskExecutor.create({ ...input, operation: input.operation })
  await taskExecutor.resume(created.id)
  const run = getRun(created.id)
  const candidate = run.state.artifact as { candidateId?: string; artifact?: Artifact } | undefined
  const context = run.state.context as
    | {
        text?: string
        evidence?: Array<{
          id: string
          kind: string
          sourceId: string
          chapterId: string | null
          text: string
        }>
        report?: any
      }
    | undefined
  const output = candidate?.artifact
    ? candidate.artifact.text || JSON.stringify(candidate.artifact, null, 2)
    : `本地任务状态：${run.stopReason}。${run.stopReason === 'needs_input' ? '请补充明确的操作目的或来源范围。' : '当前任务缺少可用语义生成器、证据或输入预算；请查看任务计划与检查结果。'}`
  const model = Object.values(run.modelVersions)[0] ?? 'local-rules-v1'
  const generationId = sql.id()
  sql.run(
    'INSERT INTO generations (id,project_id,task_type,input,context_snapshot,output,model,created_at,usage,used) VALUES (?,?,?,?,?,?,?,?,?,?)',
    generationId,
    run.projectId,
    input.task ?? input.operation ?? 'analysis',
    JSON.stringify(input),
    JSON.stringify({
      text: context?.text,
      adaptation: run.adaptation,
      runId: run.id,
    }),
    output,
    model,
    sql.now(),
    JSON.stringify(run.costs),
    -1,
  )
  return {
    generationId,
    runId: run.id,
    output,
    model,
    executionStatus:
      candidate?.artifact && (run.state.artifactVerification as { status?: string })?.status === 'pass'
        ? ('candidate' as const)
        : ('pending' as const),
    verification: run.state.artifactVerification ?? null,
    adaptation: run.adaptation,
    citations: (context?.evidence ?? []).map((e) => ({
      id: e.id,
      sourceType: e.kind,
      sourceId: e.sourceId,
      chapterId: e.chapterId,
      content: e.text,
      summary: e.text.slice(0, 120),
      keywords: '',
      score: 1,
    })),
    contextReport: context?.report ?? {
      tokenBudget: 0,
      estimatedTokens: 0,
      included: [],
      trimmed: [],
      excluded: [],
      truncation: 'none',
      diagnostics: [run.stopReason],
    },
  }
}
