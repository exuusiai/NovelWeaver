import { z } from 'zod'
import { sql } from '../db.ts'
import { estimateTokens } from '../memory.ts'
import { selectSettings, packContext, type Selection } from '../context-selection.ts'
import { precheckChapter } from '../review.ts'
import {
  chapterEvidence,
  recordEvidence,
  readEvidence,
  recordText,
  type Evidence,
} from '../harness/evidence.ts'
import { contextSchema, checkSchema } from '../harness/schemas.ts'
import { ToolError, type Run, type ToolRegistry, type Check } from '../harness/protocol.ts'
import type { Adapters } from '../harness/adapters.ts'
import { artifactSchema, type Artifact } from './contracts.ts'
import { getTaskProfile } from './profiles.ts'

export function artifactContract(kind: string) {
  const schema = artifactSchema.options.find((option) => option.shape.kind.safeParse(kind).success)
  if (!schema) throw new ToolError('INVALID_INPUT', '产物类型不支持。')
  return z.toJSONSchema(schema)
}
export function taskOfRun(run: Run) {
  if (!run.adaptation) throw new ToolError('NEEDS_CHECK', '需要先解析任务。')
  return run.adaptation.taskSpec
}
function contextOf(run: Run) {
  return contextSchema.parse(run.state.context)
}
export function registerTaskTools(registry: ToolRegistry, adapters: Adapters) {
  registry.capabilities = () => ({
    ...Object.fromEntries(
      ['planner', 'writer', 'reviewer', 'extractor', 'answerer'].map((role) => {
        const generator = adapters.artifacts?.generators[role as 'writer']
        return [role, Boolean(generator && (generator.available?.() ?? true))]
      }),
    ),
    semantic_checker: Boolean(
      adapters.artifacts?.checker && (adapters.artifacts.checker.available?.() ?? true),
    ),
    revision_generator: adapters.generator.modelVersion !== 'unconfigured',
    revision_checker: (adapters.checker.modelVersion ?? adapters.checker.version) !== 'unconfigured',
  })
  registry.register({
    name: 'task.context',
    version: '1.0.0',
    source: 'server/tasks/tools.ts',
    effect: 'read',
    input: z.object({}),
    output: contextSchema,
    async execute(_input, { run }) {
      const task = taskOfRun(run),
        plan = run.adaptation!.plan
      let selection: Selection = {
        items: [],
        evidence: [],
        hits: [],
        excluded: [],
        diagnostics: [],
      }
      if (
        plan.contextPolicy !== 'source' &&
        (plan.contextPolicy !== 'minimal' || task.continuityDepth === 'chapter') &&
        !(task.operation === 'draft' && task.continuityDepth === 'independent')
      )
        selection = await selectSettings(run.projectId, task.goal, task.knowledgeView)
      if (plan.contextPolicy === 'minimal')
        selection.items = selection.items.filter((item) =>
          ['project', 'entity', 'fact', 'relation'].includes(item.kind),
        )
      const chapter = task.chapterId
        ? sql.get<{ content: string; revision: number }>(
            'SELECT content,revision FROM chapters WHERE id=? AND project_id=?',
            task.chapterId,
            run.projectId,
          )
        : undefined
      if (task.chapterId && !chapter) throw new ToolError('NOT_FOUND', '源章节不存在。')
      if (chapter && task.baseRevision !== chapter.revision)
        throw new ToolError('VERSION_CONFLICT', '任务源稿已改变。')
      const source =
        typeof run.request.chapterContent === 'string' ? run.request.chapterContent : (chapter?.content ?? '')
      // Exact source is mandatory for extraction/review; no silent truncation of source or constraints.
      if (source && plan.contextPolicy !== 'minimal') {
        const ev =
          source === chapter?.content && task.chapterId
            ? chapterEvidence(run.projectId, task.chapterId, 0, source.length)
            : recordEvidence(run.projectId, 'input', run.id, source, 'author_input_snapshot')
        selection.evidence.push(ev)
        selection.items.push({
          id: ev.id,
          kind: 'source',
          label: '本次源稿',
          text: `【本次源稿 ${ev.id}】\n${source}`,
          priority: 1000,
          tokens: 0,
          reason: 'required_source',
          evidenceIds: [ev.id],
        })
      }
      const outline =
        run.request.chapterOutline ??
        (task.chapterId
          ? sql.get<{ content: string }>(
              'SELECT content FROM chapter_outlines WHERE chapter_id=?',
              task.chapterId,
            )?.content
          : undefined)
      if (typeof outline === 'string' && outline) {
        const explicit = typeof run.request.chapterOutline === 'string'
        const value = explicit ? outline : recordText(run.projectId, 'chapter_outline', task.chapterId!)!
        const ev = recordEvidence(
          run.projectId,
          explicit ? 'outline_input' : 'chapter_outline',
          explicit ? run.id : task.chapterId!,
          value,
          'author_plan',
          explicit ? null : task.chapterId,
        )
        selection.evidence.push(ev)
        selection.items.push({
          id: 'author-outline',
          kind: 'author',
          label: '作者计划',
          text: `【作者计划 ${ev.id}，角色不可直接表现知晓】${outline}`,
          priority: 950,
          tokens: 0,
          reason: 'explicit_outline',
          evidenceIds: [ev.id],
        })
      }
      if (plan.contextPolicy === 'author') {
        const book = sql.get<{ id: string; content: string }>(
          "SELECT id,content FROM story_outlines WHERE project_id=? AND status='current' ORDER BY version DESC LIMIT 1",
          run.projectId,
        )
        if (book) {
          const ev = recordEvidence(
            run.projectId,
            'book_outline',
            book.id,
            recordText(run.projectId, 'book_outline', book.id)!,
            'author_plan',
          )
          selection.evidence.push(ev)
          selection.items.push({
            id: 'book-outline',
            kind: 'author',
            label: '全书规划',
            text: `【作者计划 ${ev.id}，尚未发生】${book.content}`,
            priority: 900,
            tokens: 0,
            reason: 'author_plan',
            evidenceIds: [ev.id],
          })
        }
      }
      const overhead =
        estimateTokens(
          JSON.stringify({
            task,
            outputSchema: artifactContract(task.artifactType),
          }),
        ) + 256
      const capacity = Math.min(
        plan.budget.contextTokens - overhead,
        run.budget.maxTokens -
          run.costs.inputTokens -
          run.costs.outputTokens -
          run.budget.maxOutputTokens -
          overhead,
      )
      if (capacity < 1) throw new ToolError('BUDGET_EXHAUSTED', '任务与约束已占满输入预算。')
      const packed = packContext(selection, capacity)
      run.state.sourceText = source
      run.state.contextOverhead = {
        tokens: overhead,
        source: 'estimated',
        maxInputTokens: plan.budget.contextTokens,
      }
      const sourceMissing = selection.items.some(
        (i) => i.reason === 'required_source' && packed.report.trimmed.some((t) => t.id === i.id),
      )
      return {
        output: packed,
        status: sourceMissing || (task.operation === 'qa' && !packed.evidence.length) ? 'pending' : 'ok',
      }
    },
  })
  registry.register({
    name: 'draft.plan',
    version: '1.0.0',
    source: 'server/tasks/tools.ts',
    effect: 'read',
    input: z.object({}),
    output: z.object({
      segments: z.number(),
      targetLength: z.unknown(),
      reason: z.string(),
    }),
    execute(_i, { run }) {
      return {
        output: {
          segments: run.adaptation!.plan.segmentCount,
          targetLength: taskOfRun(run).targetLength ?? null,
          reason: '按目标产物和单段输出预算分段；每段读取已生成候选，最终统一检查。',
        },
      }
    },
  })
  registry.register({
    name: 'review.rules',
    version: '1.0.0',
    source: 'server/review.ts:precheckChapter',
    effect: 'read',
    input: z.object({}),
    output: z.object({ issues: z.array(z.unknown()) }),
    execute(_i, { run }) {
      const chapterId = taskOfRun(run).chapterId
      return {
        output: { issues: chapterId ? precheckChapter(chapterId) : [] },
      }
    },
  })
  registry.register({
    name: 'artifact.generate',
    version: '1.0.0',
    source: 'server/tasks/tools.ts',
    effect: 'generate',
    input: z.object({}),
    output: z.object({
      candidateId: z.string().nullable(),
      artifact: artifactSchema.nullable(),
      origin: z.string(),
      segmentsCompleted: z.number(),
      segmentsPlanned: z.number(),
    }),
    estimateInputTokens: (_i, run) => estimateTokens(JSON.stringify(artifactInput(run))) + 256,
    async execute(_i, options) {
      const { run } = options,
        task = taskOfRun(run),
        plan = run.adaptation!.plan
      const role = plan.modelRoles[0],
        generator = adapters.artifacts?.generators[role]
      const prior = (run.state.artifactParts as Artifact[] | undefined) ?? []
      if (prior.length >= plan.segmentCount) throw new ToolError('INVALID_INPUT', '本次候选各段已完成。')
      const input = artifactInput(run)
      if (estimateTokens(JSON.stringify(input)) + 256 > plan.budget.contextTokens)
        throw new ToolError('BUDGET_EXHAUSTED', '生成历史与输入超出容量，请调整分段任务。')
      const result = await generator?.generate(input, options)
      if (!result)
        return {
          status: 'pending',
          output: {
            candidateId: null,
            artifact: null,
            origin: 'unconfigured',
            segmentsCompleted: prior.length,
            segmentsPlanned: plan.segmentCount,
          },
        }
      const artifact = artifactSchema.parse(result.value)
      if (artifact.kind !== plan.outputContract)
        throw new ToolError('INVALID_OUTPUT', '产物与当前任务契约不同。')
      const parts = [...prior, artifact]
      const merged =
        artifact.kind === 'draft'
          ? {
              ...artifact,
              text: parts.map((a) => a.text).join('\n\n'),
              evidenceIds: [...new Set(parts.flatMap((a) => a.evidenceIds))],
            }
          : artifact
      run.state.artifactParts = parts
      delete run.state.artifactVerification
      run.modelVersions[role] = generator!.modelVersion
      return {
        output: {
          candidateId: sql.id(),
          artifact: merged,
          origin: generator!.version,
          segmentsCompleted: parts.length,
          segmentsPlanned: plan.segmentCount,
        },
        usage: result.usage,
      }
    },
  })
  registry.register({
    name: 'artifact.verify',
    version: '1.0.0',
    source: 'server/tasks/tools.ts',
    effect: 'generate',
    input: z.object({}),
    output: z.object({
      candidateId: z.string(),
      program: z.array(checkSchema),
      semantic: z.array(checkSchema),
      status: z.enum(['pass', 'fail', 'pending']),
    }),
    estimateInputTokens: (_i, run) =>
      estimateTokens(
        JSON.stringify({
          task: taskOfRun(run),
          artifact: run.state.artifact,
          context: run.state.context,
        }),
      ) + 256,
    async execute(_i, options) {
      const { run } = options,
        task = taskOfRun(run),
        plan = run.adaptation!.plan
      const candidate = run.state.artifact as {
        candidateId: string
        artifact: Artifact
        segmentsCompleted: number
        segmentsPlanned: number
      }
      if (!candidate?.artifact) throw new ToolError('NEEDS_CHECK', '尚无任务产物。')
      const artifact = artifactSchema.parse(candidate.artifact),
        ctx = contextOf(run)
      const check = (name: string, pass: boolean, detail: string): Check => ({
        name,
        status: pass ? 'pass' : 'fail',
        detail,
        evidenceIds: [],
      })
      const program = [
        check('output_contract', artifact.kind === task.artifactType, '产物类型与任务匹配'),
        check('segments', candidate.segmentsCompleted === candidate.segmentsPlanned, '分段完整性'),
        check(
          'literal_constraints',
          [
            ...task.preserve,
            ...task.constraints.filter((c) => c.type === 'literal').map((c) => c.text),
          ].every((s) => artifact.text.includes(s)),
          '逐字保留与语义保持分开',
        ),
      ]
      if (task.chapterId)
        program.push(
          check(
            'source_revision',
            sql.get<{ revision: number }>(
              'SELECT revision FROM chapters WHERE id=? AND project_id=?',
              task.chapterId,
              run.projectId,
            )?.revision === task.baseRevision,
            '检查源稿版本',
          ),
        )
      if (task.targetLength && ['draft', 'continue'].includes(task.operation)) {
        const size =
          task.targetLength.unit === 'tokens'
            ? estimateTokens(artifact.text)
            : Array.from(artifact.text).length
        program.push(
          check(
            'target_length',
            size >= task.targetLength.value * 0.7 && size <= task.targetLength.value * 1.3,
            '目标长度 70%–130%，明确单位',
          ),
        )
      }
      const ids = [
        ...artifact.evidenceIds,
        ...(artifact.kind === 'findings'
          ? artifact.findings.flatMap((f) => f.evidenceIds)
          : artifact.kind === 'structure'
            ? artifact.events.flatMap((e) => e.evidenceIds)
            : []),
      ]
      const known = new Set(ctx.evidence.map((e) => e.id))
      let valid = ids.every((id) => known.has(id))
      try {
        ctx.evidence.forEach((evidence) => readEvidence(run.projectId, evidence.id))
      } catch {
        valid = false
      }
      program.push(check('evidence_format_and_version', valid, '只校验证据存在、提供范围与版本'))
      if (artifact.kind === 'findings')
        program.push(
          check(
            'finding_location',
            artifact.findings.every(
              (f) =>
                !f.location ||
                (f.location.start < f.location.end &&
                  f.location.end <= String(run.state.sourceText ?? '').length),
            ),
            '问题位置位于当前源稿',
          ),
        )
      if (['answer', 'analysis'].includes(artifact.kind))
        program.push(check('evidence_required', artifact.evidenceIds.length > 0, '事实型回答需要证据'))
      if (artifact.kind === 'structure') {
        const source = String(run.state.sourceText ?? '')
        let end = 0
        const aligned =
          artifact.scenes.every((s) => {
            const ok = s.start === end && s.end > s.start && s.end <= source.length
            end = s.end
            return ok
          }) && end === source.length
        program.push(
          check(
            'source_alignment',
            aligned &&
              new Set(artifact.scenes.map((s) => s.id)).size === artifact.scenes.length &&
              artifact.events.every((e) => artifact.scenes.some((s) => s.id === e.sceneId)),
            '场景覆盖完整原文，事件绑定现存场景',
          ),
        )
      }
      const criteria = [
        ...plan.evaluationSpec,
        ...task.constraints.filter((c) => c.type !== 'literal').map((c) => `constraint:${c.id}`),
      ]
      const result = program.every((c) => c.status === 'pass')
        ? await adapters.artifacts?.checker?.verify({ task, artifact, context: ctx.text, criteria }, options)
        : undefined
      const semantic: Check[] = criteria.map((name) => {
        const found = result?.value.filter((c) => c.name === name)
        return found?.length === 1 && found[0].evidenceIds.every((id) => known.has(id))
          ? found[0]
          : {
              name,
              status: 'pending',
              detail: '缺少独立语义判断或有效证据引用。',
              evidenceIds: [],
            }
      })
      const checks = [...program, ...semantic]
      return {
        output: {
          candidateId: candidate.candidateId,
          program,
          semantic,
          status: checks.some((c) => c.status === 'fail')
            ? 'fail'
            : checks.some((c) => c.status === 'pending')
              ? 'pending'
              : 'pass',
        },
        usage: result?.usage,
      }
    },
  })
  registry.register({
    name: 'episode.finish',
    version: '1.0.0',
    source: 'server/tasks/tools.ts',
    effect: 'read',
    input: z.object({
      candidateId: z.string().optional(),
      reason: z.string().default('candidate_ready'),
    }),
    output: z.object({
      status: z.string(),
      candidateId: z.string().nullable(),
      verificationStatus: z.string(),
    }),
    execute(input, { run }) {
      const revision = run.adaptation?.plan.profileId === 'revision.local'
      const candidate = revision
        ? (run.state.proposal as { candidate?: { id: string } })?.candidate
        : (run.state.artifact as { candidateId?: string })
      const id =
        candidate &&
        ('id' in candidate ? candidate.id : 'candidateId' in candidate ? candidate.candidateId : undefined)
      const verification = (revision ? run.state.verification : run.state.artifactVerification) as
        | { candidateId: string; status: string }
        | undefined
      if (
        !id ||
        (input.candidateId && input.candidateId !== id) ||
        verification?.candidateId !== id ||
        verification.status === 'fail'
      )
        throw new ToolError('VERIFICATION_FAILED', '需要对当前候选完成检查后结束。')
      run.status = revision || verification.status !== 'pass' ? 'paused' : 'completed'
      run.stopReason = revision
        ? 'awaiting_author'
        : verification.status === 'pass'
          ? 'artifact_ready'
          : 'needs_check'
      return {
        output: {
          status: run.stopReason,
          candidateId: id,
          verificationStatus: verification.status,
        },
      }
    },
  })
}
function artifactInput(run: Run) {
  const task = taskOfRun(run),
    plan = run.adaptation!.plan
  const parts = (run.state.artifactParts as Artifact[] | undefined) ?? []
  return {
    task,
    role: getTaskProfile(plan.profileId, plan.profileVersion).modelRole,
    context: contextOf(run).text,
    previous: parts.map((p) => p.text).join('\n\n'),
    segment: parts.length + 1,
    segments: plan.segmentCount,
    outputSchema: artifactContract(task.artifactType),
    diagnostics: {
      rules: run.state['review.rules'],
      impact: run.state['impact.analyze'],
    },
  }
}
