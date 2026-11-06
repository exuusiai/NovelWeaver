import { z } from 'zod'
import { db, sql } from '../db.ts'
import { packContext, selectSettings } from '../context-selection.ts'
import { estimateTokens } from '../memory.ts'
import { bindSources, memoryScope, setMemoryScope, sourceBindings, visibilityReason } from '../provenance.ts'
import { contentHash, rebuildChapterMemory, saveChapterHistory } from '../routes/helpers.ts'
import { defaultAdapters, type Adapters } from './adapters.ts'
import { chapterEvidence, digest, readEvidence, type Evidence } from './evidence.ts'
import { registerTaskTools } from '../tasks/tools.ts'
import {
  assertActive,
  ToolError,
  ToolRegistry,
  writeGuard,
  type Candidate,
  type Check,
  type Patch,
  type Run,
  type Task,
  type ToolContext,
  type Verification,
} from './protocol.ts'
import {
  candidateSchema,
  patchSchema,
  contextSchema,
  evidenceSchema,
  exclusionSchema,
  rangeSchema,
  scopeSchema,
  selectionSchema,
  taskSchema,
  verificationSchema,
  viewSchema,
} from './schemas.ts'

export function getChapter(projectId: string, chapterId: string) {
  const chapter = sql.get<{
    id: string
    project_id: string
    title: string
    content: string
    summary: string
    revision: number
    pov: string
    story_tick: number | null
  }>('SELECT * FROM chapters WHERE id=? AND project_id=?', chapterId, projectId)
  if (!chapter) throw new ToolError('NOT_FOUND', '章节不存在或不属于当前项目。')
  return chapter
}
const taskOf = (run: Run) => taskSchema.parse(run.state.task)
export const candidateOf = (run: Run): Candidate => {
  const proposal = run.state.proposal as { candidate?: Candidate } | undefined
  if (!proposal?.candidate) throw new ToolError('NEEDS_CHECK', '请先生成或填写候选补丁。')
  return proposal.candidate
}
const viewOf = (task: Task) => ({
  chapterId: task.chapterId,
  audience: 'character' as const,
  holderId: task.holderId,
  storyTick: task.storyTick,
})
export function applyPatches(content: string, patches: Patch[], range: { start: number; end: number }) {
  let previousEnd = -1
  const ordered = [...patches].sort((a, b) => a.start - b.start)
  if (!patches.length || new Set(patches.map((p) => p.id)).size !== patches.length)
    throw new ToolError('INVALID_INPUT', '补丁为空或 ID 重复。')
  for (const patch of ordered) {
    if (
      patch.start < range.start ||
      patch.end > range.end ||
      patch.end <= patch.start ||
      patch.start < previousEnd ||
      content.slice(patch.start, patch.end) !== patch.original
    )
      throw new ToolError('VERSION_CONFLICT', '补丁位置、范围或原文不匹配。')
    previousEnd = patch.end
  }
  let output = content
  for (const patch of ordered.reverse())
    output = output.slice(0, patch.start) + patch.replacement + output.slice(patch.end)
  return output
}
function selectedPatches(candidate: Candidate, ids?: string[]) {
  if (!ids) return candidate.patches
  if (
    !ids.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !candidate.patches.some((p) => p.id === id))
  )
    throw new ToolError('INVALID_INPUT', '采纳的补丁 ID 无效。')
  return candidate.patches.filter((p) => ids.includes(p.id))
}
function taskEvidence(run: Run): Evidence[] {
  const context = run.state.context as { evidence?: Evidence[] } | undefined
  const read = run.state.evidence as { evidence?: Evidence[] } | undefined
  return [
    ...new Map([...(context?.evidence ?? []), ...(read?.evidence ?? [])].map((e) => [e.id, e])).values(),
  ]
}
function validEvidence(run: Run, task: Task, ids: string[]) {
  for (const id of ids) {
    const evidence = readEvidence(run.projectId, id)
    if (['input', 'outline_input'].includes(evidence.kind) && evidence.sourceId !== run.id)
      throw new ToolError('STALE_EVIDENCE', '不能读取其他任务的私有输入快照。')
    const reason = visibilityReason(
      run.projectId,
      evidence.kind,
      evidence.sourceId,
      run.adaptation?.taskSpec.knowledgeView ?? viewOf(task),
      evidence.chapterId,
    )
    if (reason) throw new ToolError('STALE_EVIDENCE', `证据超出任务范围：${reason}`, false, { id })
  }
}
function ownedRecord(projectId: string, kind: string, id: string) {
  const table: Record<string, string> = {
    entity: 'entities',
    relation: 'relations',
    fact: 'story_facts',
    event: 'events',
    summary: 'chapters',
    chapter: 'chapters',
    foreshadowing: 'foreshadowing',
  }
  if (!table[kind] || !sql.get(`SELECT id FROM ${table[kind]} WHERE id=? AND project_id=?`, id, projectId))
    throw new ToolError('NOT_FOUND', '设定记录不存在或不属于当前项目。')
  return table[kind]
}
function idempotent<T>(
  context: ToolContext,
  tool: string,
  input: { idempotencyKey: string; baseRevision: number },
  mutation: () => T,
): T {
  const hash = digest([tool, context.run.id, input])
  return db.transaction(() => {
    assertActive(context.signal)
    const receipt = sql.get<{ fingerprint: string; result: string }>(
      'SELECT * FROM harness_receipts WHERE project_id=? AND idempotency_key=?',
      context.run.projectId,
      input.idempotencyKey,
    )
    if (receipt) {
      if (receipt.fingerprint !== hash)
        throw new ToolError('IDEMPOTENCY_CONFLICT', '幂等标识已用于不同请求。')
      return JSON.parse(receipt.result) as T
    }
    const task = taskOf(context.run)
    if (getChapter(context.run.projectId, task.chapterId).revision !== input.baseRevision)
      throw new ToolError('VERSION_CONFLICT', '正文版本已变化，请重新规划。')
    const result = mutation()
    sql.run(
      'INSERT INTO harness_receipts VALUES (?, ?, ?, ?)',
      context.run.projectId,
      input.idempotencyKey,
      hash,
      JSON.stringify(result),
    )
    return result
  })()
}
const commitSchema = z.object({
  chapterId: z.string(),
  revision: z.number(),
  historyId: z.string(),
  appliedPatchIds: z.array(z.string()),
  before: z.object({
    title: z.string(),
    content: z.string(),
    summary: z.string(),
  }),
})
const pendingChecks = ['goal_repair', 'fact_preservation', 'unsupported_additions', 'pov']

export function createRegistry(adapters: Adapters = defaultAdapters()) {
  const registry = new ToolRegistry()
  const register: ToolRegistry['register'] = (spec) => registry.register(spec)
  register({
    name: 'task.define',
    version: '1.0.0',
    source: 'server/routes/chapters.ts',
    effect: 'read',
    input: taskSchema.omit({ id: true, projectId: true }),
    output: taskSchema,
    execute(input, { run }) {
      const chapter = getChapter(run.projectId, input.chapterId)
      if (chapter.revision !== input.baseRevision) throw new ToolError('VERSION_CONFLICT', '任务基于旧稿。')
      if (input.range.end > chapter.content.length || input.range.end <= input.range.start)
        throw new ToolError('INVALID_INPUT', '修改范围超出正文。')
      if (input.holderId) ownedRecord(run.projectId, 'entity', input.holderId)
      const identities = input.holderId
        ? []
        : sql.all<{ id: string }>(
            "SELECT id FROM entities WHERE project_id=? AND type='character' AND name=?",
            run.projectId,
            input.pov,
          )
      if (!input.holderId && identities.length > 1)
        throw new ToolError('NEEDS_CHECK', '存在同名视角人物，请指定 holderId。')
      const task = {
        ...input,
        holderId: input.holderId ?? identities[0]?.id,
        id: run.taskId,
        projectId: run.projectId,
      }
      validEvidence(run, task, input.evidenceIds)
      return { output: task }
    },
  })
  register({
    name: 'memory.search',
    version: '1.0.0',
    source: 'server/memory.ts:searchMemory',
    effect: 'read',
    input: z.object({
      query: z.string(),
      limit: z.number().int().min(1).max(100).default(12),
      view: viewSchema,
    }),
    output: z.object({
      evidence: z.array(evidenceSchema),
      excluded: z.array(exclusionSchema),
      retrievalBasis: z.string(),
    }),
    async execute(input, { run }) {
      const selection = await selectSettings(run.projectId, input.query, input.view)
      const hitSources = new Set(selection.hits.map((h) => h.sourceId))
      return {
        output: {
          evidence: selection.evidence
            .filter((e) => e.kind === 'chapter' || hitSources.has(e.sourceId))
            .slice(0, input.limit),
          excluded: selection.excluded,
          retrievalBasis: 'lexical/vector gate + source version + identity + narrative/story time + audience',
        },
      }
    },
  })
  register({
    name: 'setting.select',
    version: '1.0.0',
    source: 'server/context-selection.ts',
    effect: 'read',
    input: z.object({ query: z.string(), view: viewSchema }),
    output: selectionSchema,
    async execute(input, { run }) {
      return {
        output: await selectSettings(run.projectId, input.query, input.view),
      }
    },
  })
  register({
    name: 'context.pack',
    version: '1.0.0',
    source: 'server/context-selection.ts',
    effect: 'read',
    input: z.object({ tokenBudget: z.number().int().positive().max(50000) }),
    output: contextSchema,
    execute(input, { run }) {
      const selection = selectionSchema.parse(run.state.selection)
      return { output: packContext(selection, input.tokenBudget) }
    },
  })
  register({
    name: 'evidence.read',
    version: '1.0.0',
    source: 'server/harness/evidence.ts',
    effect: 'read',
    input: z.object({
      evidenceIds: z.array(z.string()),
      location: rangeSchema.optional(),
    }),
    output: z.object({
      evidence: z.array(evidenceSchema),
      missing: z.array(z.string()),
    }),
    execute(input, { run }) {
      const task = taskOf(run)
      const ids = [...new Set(input.evidenceIds)]
      validEvidence(run, task, ids)
      const evidence = ids.map((id) => readEvidence(run.projectId, id))
      if (input.location)
        evidence.push(
          chapterEvidence(run.projectId, task.chapterId, input.location.start, input.location.end),
        )
      return {
        output: { evidence, missing: [] },
        status: evidence.length ? 'ok' : 'pending',
      }
    },
  })
  const planSchema = z.object({
    taskId: z.string(),
    baseRevision: z.number(),
    goal: z.string(),
    range: rangeSchema,
    preserve: z.array(z.string()),
    allowedChanges: z.array(z.string()),
    evidenceIds: z.array(z.string()),
    original: z.string(),
  })
  register({
    name: 'revision.plan',
    version: '1.0.0',
    source: 'server/harness/tools.ts',
    effect: 'read',
    input: z.object({}),
    output: planSchema,
    execute(_input, { run }) {
      const task = taskOf(run)
      const chapter = getChapter(run.projectId, task.chapterId)
      if (chapter.revision !== task.baseRevision)
        throw new ToolError('VERSION_CONFLICT', '规划时正文版本已变化。')
      const evidenceIds = [...new Set([...task.evidenceIds, ...taskEvidence(run).map((e) => e.id)])]
      validEvidence(run, task, evidenceIds)
      return {
        output: {
          taskId: task.id,
          baseRevision: task.baseRevision,
          goal: task.goal,
          range: task.range,
          preserve: task.preserve,
          allowedChanges: task.allowedChanges,
          evidenceIds,
          original: chapter.content.slice(task.range.start, task.range.end),
        },
      }
    },
  })
  register({
    name: 'revision.propose',
    version: '1.0.0',
    source: 'server/harness/adapters.ts',
    effect: 'generate',
    estimateInputTokens: (_input, run) =>
      estimateTokens(
        JSON.stringify({
          task: run.state.task,
          plan: run.state.plan,
          evidence: taskEvidence(run),
        }),
      ) + 350,
    input: z
      .object({
        manualReplacement: z.string().optional(),
        patches: z.array(patchSchema).min(1).max(100).optional(),
        parentCandidateId: z.string().optional(),
        rationale: z.string().default('作者手工候选'),
      })
      .refine((i) => !(i.patches && i.manualReplacement !== undefined), '不能同时提供补丁和整段替换'),
    output: z.object({
      candidate: candidateSchema.nullable(),
      reason: z.string(),
    }),
    async execute(input, context) {
      const { run } = context
      const task = taskOf(run)
      const chapter = getChapter(run.projectId, task.chapterId)
      planSchema.parse(run.state.plan)
      if (chapter.revision !== task.baseRevision)
        throw new ToolError('VERSION_CONFLICT', '生成时正文版本已变化。')
      const original = chapter.content.slice(task.range.start, task.range.end)
      const previous = (run.state.proposal as { candidate?: Candidate } | undefined)?.candidate
      if (input.parentCandidateId && previous?.id !== input.parentCandidateId)
        throw new ToolError('VERSION_CONFLICT', '父候选不是当前候选。')
      if (context.actor === 'policy' && !input.patches)
        throw new ToolError('INVALID_INPUT', '策略须直接提交补丁。')
      const generatorModel = adapters.generator.modelVersion
      const result = input.patches
        ? { value: input.patches, usage: undefined }
        : input.manualReplacement === undefined
          ? await adapters.generator.propose({ task, original, evidence: taskEvidence(run) }, context)
          : {
              value: [
                {
                  id: 'manual-1',
                  ...task.range,
                  original,
                  replacement: input.manualReplacement,
                  rationale: input.rationale,
                  evidenceIds: task.evidenceIds,
                },
              ],
            }
      assertActive(context.signal)
      const origin =
        context.actor === 'policy'
          ? 'policy'
          : input.patches || input.manualReplacement !== undefined
            ? 'author'
            : 'adapter'
      run.modelVersions.generator =
        origin === 'adapter'
          ? generatorModel
          : origin === 'policy'
            ? (run.modelVersions.policy ?? 'external-policy')
            : 'author'
      if (!result)
        return {
          output: {
            candidate: null,
            reason: '语义生成器未配置，可填写候选文本后检查。',
          },
          status: 'pending',
        }
      const candidate: Candidate = {
        id: sql.id(),
        taskId: task.id,
        chapterId: task.chapterId,
        baseRevision: task.baseRevision,
        patches: result.value,
        generator: origin === 'adapter' ? adapters.generator.version : origin,
        modelVersion: run.modelVersions.generator,
        origin,
        parentCandidateId: previous?.id,
      }
      applyPatches(chapter.content, candidate.patches, task.range)
      validEvidence(
        run,
        task,
        candidate.patches.flatMap((p) => p.evidenceIds),
      )
      delete run.state.verification
      return {
        output: { candidate, reason: '候选补丁已定位，等待检查与作者采纳。' },
        usage: result.usage,
      }
    },
  })
  register({
    name: 'revision.verify',
    version: '1.0.0',
    source: 'server/harness/adapters.ts',
    effect: 'generate',
    estimateInputTokens: (_input, run) =>
      estimateTokens(
        JSON.stringify({
          task: run.state.task,
          candidate: candidateOf(run),
          chapter: getChapter(run.projectId, taskOf(run).chapterId).content,
          evidence: taskEvidence(run),
        }),
      ) + 500,
    input: z.object({
      patchIds: z.array(z.string()).optional(),
      candidateId: z.string().optional(),
    }),
    output: verificationSchema,
    async execute(input, context) {
      const { run } = context
      const task = taskOf(run)
      const candidate = candidateOf(run)
      if (input.candidateId && input.candidateId !== candidate.id)
        throw new ToolError('VERSION_CONFLICT', '候选已更新。')
      const chapter = getChapter(run.projectId, task.chapterId)
      const checkerModel = adapters.checker.modelVersion ?? adapters.checker.version
      const patches = selectedPatches(candidate, input.patchIds)
      const check = (name: string, ok: boolean, detail: string): Check => ({
        name,
        status: ok ? 'pass' : 'fail',
        detail,
        evidenceIds: [],
      })
      const program: Check[] = [
        check('base_revision', chapter.revision === candidate.baseRevision, '正文版本比较'),
      ]
      let after = chapter.content
      try {
        after = applyPatches(chapter.content, patches, task.range)
        program.push(check('patch_location', true, '精确 UTF16 位置、原文、范围与非重叠检查'))
      } catch (error) {
        program.push(check('patch_location', false, (error as Error).message))
      }
      program.push(
        check(
          'preserve_literals',
          [
            ...task.preserve,
            ...(task.constraints ?? []).filter((c) => c.type === 'literal').map((c) => c.text),
          ].every((s) => after.includes(s)),
          '逐字保留项；语义保持单独记录',
        ),
      )
      program.push(
        check(
          'target_length',
          !task.targetWords || after.length <= task.targetWords * 1.3,
          '目标篇幅上限 130%',
        ),
      )
      try {
        validEvidence(run, task, [...task.evidenceIds, ...patches.flatMap((p) => p.evidenceIds)])
        program.push(check('citation_format_and_version', true, '证据 ID 存在、版本与范围有效'))
      } catch (error) {
        program.push(check('citation_format_and_version', false, (error as Error).message))
      }
      const expectedChecks = [
        ...pendingChecks,
        ...(task.constraints ?? []).filter((c) => c.type !== 'literal').map((c) => `constraint:${c.id}`),
      ]
      let semantic: Check[] = expectedChecks.map((name) => ({
        name,
        status: 'pending',
        detail: '语义检查器未配置，等待模型或作者核验。',
        evidenceIds: [],
      }))
      let usage: { inputTokens: number; outputTokens: number } | undefined
      if (program.every((c) => c.status === 'pass')) {
        const result = await adapters.checker.verify(
          {
            task,
            candidate: { ...candidate, patches },
            before: chapter.content,
            after,
            evidence: taskEvidence(run),
          },
          context,
        )
        assertActive(context.signal)
        if (result) {
          usage = result.usage
          const known = new Set(taskEvidence(run).map((e) => e.id))
          semantic = expectedChecks.map((name) => {
            const checks = result.value.filter((c) => c.name === name)
            const value = checks.length === 1 ? checks[0] : undefined
            if (!value || value.evidenceIds.some((id) => !known.has(id)))
              return {
                name,
                status: 'pending' as const,
                detail: '检查项缺失、重复或引用未提供的证据。',
                evidenceIds: [],
              }
            try {
              validEvidence(run, task, value.evidenceIds)
              return value
            } catch {
              return {
                name,
                status: 'pending' as const,
                detail: '语义检查所引证据已失效。',
                evidenceIds: value.evidenceIds,
              }
            }
          })
        }
      }
      const checks = [...program, ...semantic]
      const output: Verification & { patchIds: string[] } = {
        candidateId: candidate.id,
        patchIds: patches.map((p) => p.id).sort(),
        program,
        semantic,
        author: null,
        status: checks.some((c) => c.status === 'fail')
          ? 'fail'
          : checks.some((c) => c.status === 'pending')
            ? 'pending'
            : 'pass',
        checkerVersion: adapters.checker.version,
        factDiff: [
          ...task.preserve.map((text, i) => ({
            id: `literal-${i}`,
            before: chapter.content.includes(text),
            after: after.includes(text),
            status: after.includes(text) ? ('pass' as const) : ('fail' as const),
            detail: text,
          })),
          ...(task.constraints ?? []).map((c) => ({
            id: c.id,
            before: c.type === 'literal' ? chapter.content.includes(c.text) : null,
            after: c.type === 'literal' ? after.includes(c.text) : null,
            status:
              c.type === 'literal'
                ? after.includes(c.text)
                  ? ('pass' as const)
                  : ('fail' as const)
                : (semantic.find((check) => check.name === `constraint:${c.id}`)?.status ??
                  ('pending' as const)),
            detail: c.text,
          })),
        ],
      }
      run.modelVersions.checker = checkerModel
      return { output, usage }
    },
  })
  register({
    name: 'revision.commit',
    version: '1.0.0',
    source: 'server/routes/helpers.ts',
    effect: 'write',
    input: writeGuard.extend({
      candidateId: z.string(),
      patchIds: z.array(z.string()).min(1),
      acknowledgePending: z.boolean().default(false),
      authorEvaluation: z.object({
        rating: z.number().int().min(1).max(5).optional(),
        note: z.string().default(''),
      }),
    }),
    output: commitSchema,
    execute(input, context) {
      const beforeRevision = getChapter(context.run.projectId, taskOf(context.run).chapterId).revision
      const output = idempotent(context, 'revision.commit', input, () => {
        const { run } = context
        const task = taskOf(run)
        const candidate = candidateOf(run)
        if (candidate.id !== input.candidateId || candidate.baseRevision !== input.baseRevision)
          throw new ToolError('VERSION_CONFLICT', '候选版本不匹配。')
        const patches = selectedPatches(candidate, input.patchIds)
        const verification = verificationSchema.parse(run.state.verification)
        if (
          verification.candidateId !== candidate.id ||
          JSON.stringify(verification.patchIds) !== JSON.stringify(patches.map((p) => p.id).sort())
        )
          throw new ToolError('VERIFICATION_FAILED', '请先检查本次选择的补丁组合。')
        if (
          verification.status === 'fail' ||
          (verification.status === 'pending' && !input.acknowledgePending)
        )
          throw new ToolError('VERIFICATION_FAILED', '检查失败，或语义待检查尚未由作者明确确认。')
        validEvidence(run, task, [
          ...task.evidenceIds,
          ...patches.flatMap((p) => p.evidenceIds),
          ...verification.semantic.flatMap((c) => c.evidenceIds),
        ])
        const chapter = getChapter(run.projectId, task.chapterId)
        const content = applyPatches(chapter.content, patches, task.range)
        if (!task.preserve.every((s) => content.includes(s)))
          throw new ToolError('VERIFICATION_FAILED', '保留项在采纳前检查失败。')
        saveChapterHistory(chapter)
        const historyId = sql.get<{ id: string }>(
          'SELECT id FROM chapter_history WHERE chapter_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
          chapter.id,
        )!.id
        sql.run(
          "UPDATE chapters SET content=?,summary='',content_hash=?,analyzed_hash='',updated_at=? WHERE id=?",
          content,
          contentHash(content),
          sql.now(),
          chapter.id,
        )
        rebuildChapterMemory(run.projectId, chapter.id, chapter.title, content, '')
        sql.run('UPDATE projects SET updated_at=? WHERE id=?', sql.now(), run.projectId)
        verification.author = input.authorEvaluation
        run.state.verification = verification
        return {
          chapterId: chapter.id,
          revision: getChapter(run.projectId, chapter.id).revision,
          historyId,
          appliedPatchIds: patches.map((p) => p.id),
          before: {
            title: chapter.title,
            content: chapter.content,
            summary: chapter.summary,
          },
        }
      })
      return {
        output,
        changes:
          beforeRevision === getChapter(context.run.projectId, output.chapterId).revision
            ? []
            : [
                {
                  kind: 'chapter',
                  id: output.chapterId,
                  before: beforeRevision,
                  after: getChapter(context.run.projectId, output.chapterId).revision,
                },
              ],
      }
    },
  })
  register({
    name: 'revision.undo',
    version: '1.0.0',
    source: 'server/routes/chapters.ts:history',
    effect: 'write',
    input: writeGuard,
    output: z.object({ chapterId: z.string(), revision: z.number() }),
    execute(input, context) {
      const beforeRevision = getChapter(context.run.projectId, taskOf(context.run).chapterId).revision
      const output = idempotent(context, 'revision.undo', input, () => {
        const commit = commitSchema.parse(context.run.state.commit)
        if (commit.revision !== input.baseRevision)
          throw new ToolError('VERSION_CONFLICT', '采纳后正文已变化，需从历史手动恢复。')
        const chapter = getChapter(context.run.projectId, commit.chapterId)
        saveChapterHistory(chapter)
        sql.run(
          "UPDATE chapters SET title=?,content=?,summary=?,content_hash=?,analyzed_hash='',updated_at=? WHERE id=?",
          commit.before.title,
          commit.before.content,
          commit.before.summary,
          contentHash(commit.before.content),
          sql.now(),
          chapter.id,
        )
        rebuildChapterMemory(
          context.run.projectId,
          chapter.id,
          commit.before.title,
          commit.before.content,
          commit.before.summary,
        )
        return {
          chapterId: chapter.id,
          revision: getChapter(context.run.projectId, chapter.id).revision,
        }
      })
      return {
        output,
        changes:
          beforeRevision === getChapter(context.run.projectId, output.chapterId).revision
            ? []
            : [
                {
                  kind: 'chapter',
                  id: output.chapterId,
                  before: beforeRevision,
                  after: getChapter(context.run.projectId, output.chapterId).revision,
                },
              ],
      }
    },
  })
  register({
    name: 'revision.reject',
    version: '1.0.0',
    source: 'author',
    effect: 'write',
    input: writeGuard.extend({ reason: z.string().default('') }),
    output: z.object({ rejected: z.boolean(), candidateId: z.string() }),
    execute(input, context) {
      return {
        output: idempotent(context, 'revision.reject', input, () => ({
          rejected: true,
          candidateId: candidateOf(context.run).id,
        })),
      }
    },
  })
  register({
    name: 'memory.scope',
    version: '1.0.0',
    source: 'author',
    effect: 'write',
    input: writeGuard.extend({
      kind: z.enum(['entity', 'relation', 'fact', 'event', 'summary', 'chapter', 'foreshadowing']),
      itemId: z.string(),
      metadata: scopeSchema,
    }),
    output: z.object({ updated: z.boolean() }),
    execute(input, context) {
      const before = memoryScope(input.kind, input.itemId)
      const output = idempotent(context, 'memory.scope', input, () => {
        ownedRecord(context.run.projectId, input.kind, input.itemId)
        for (const id of input.metadata.chapterIds ?? []) getChapter(context.run.projectId, id)
        for (const id of [
          ...(input.metadata.entityIds ?? []),
          ...(input.metadata.knownBy ?? []),
          ...(input.metadata.holderId ? [input.metadata.holderId] : []),
        ])
          ownedRecord(context.run.projectId, 'entity', id)
        setMemoryScope(context.run.projectId, input.kind, input.itemId, input.metadata)
        return { updated: true }
      })
      return {
        output,
        changes:
          digest(before) === digest(memoryScope(input.kind, input.itemId))
            ? []
            : [
                {
                  kind: input.kind,
                  id: input.itemId,
                  before,
                  after: memoryScope(input.kind, input.itemId),
                },
              ],
      }
    },
  })
  register({
    name: 'canon.confirm',
    version: '1.0.0',
    source: 'author',
    effect: 'write',
    input: writeGuard.extend({
      kind: z.enum(['entity', 'relation', 'fact']),
      itemId: z.string(),
      sourceChapterIds: z.array(z.string()).min(1),
      sourceRevisions: z.record(z.string(), z.number().int().positive()),
      note: z.string().min(1),
    }),
    output: z.object({ confirmed: z.boolean(), itemId: z.string() }),
    execute(input, context) {
      return {
        output: idempotent(context, 'canon.confirm', input, () => {
          const table = ownedRecord(context.run.projectId, input.kind, input.itemId)
          for (const id of input.sourceChapterIds)
            if (getChapter(context.run.projectId, id).revision !== input.sourceRevisions[id])
              throw new ToolError('VERSION_CONFLICT', '正史确认的来源版本已变化。')
          bindSources(input.kind, input.itemId, input.sourceChapterIds)
          sql.run(`UPDATE ${table} SET canon_status='canon',updated_at=? WHERE id=?`, sql.now(), input.itemId)
          return { confirmed: true, itemId: input.itemId }
        }),
      }
    },
  })
  register({
    name: 'dependency.link',
    version: '1.0.0',
    source: 'author',
    effect: 'write',
    input: writeGuard.extend({
      sourceKind: z.enum(['chapter', 'entity', 'fact', 'event', 'relation', 'foreshadowing']),
      sourceId: z.string(),
      targetChapterId: z.string(),
      relation: z.string().min(1),
      evidenceIds: z.array(z.string()).min(1),
    }),
    output: z.object({ linkId: z.string() }),
    execute(input, context) {
      return {
        output: idempotent(context, 'dependency.link', input, () => {
          ownedRecord(context.run.projectId, input.sourceKind, input.sourceId)
          getChapter(context.run.projectId, input.targetChapterId)
          input.evidenceIds.forEach((id) => readEvidence(context.run.projectId, id))
          const linkId = digest([
            context.run.projectId,
            input.sourceKind,
            input.sourceId,
            input.targetChapterId,
            input.relation,
          ])
          sql.run(
            'INSERT OR REPLACE INTO harness_dependencies VALUES (?,?,?,?,?,?,?)',
            linkId,
            context.run.projectId,
            input.sourceKind,
            input.sourceId,
            input.targetChapterId,
            input.relation,
            JSON.stringify(input.evidenceIds),
          )
          return { linkId }
        }),
      }
    },
  })
  registry.register({
    name: 'revision.preview',
    version: '1.0.0',
    source: 'server/harness/tools.ts',
    effect: 'read',
    input: z.object({ candidateId: z.string().optional() }),
    output: z.object({
      candidateId: z.string(),
      before: z.string(),
      after: z.string(),
      patches: z.array(patchSchema),
    }),
    execute(input, { run }) {
      const task = taskOf(run),
        candidate = candidateOf(run),
        chapter = getChapter(run.projectId, task.chapterId)
      if (
        candidate.baseRevision !== chapter.revision ||
        (input.candidateId && input.candidateId !== candidate.id)
      )
        throw new ToolError('VERSION_CONFLICT', '候选或正文已更新。')
      const after = applyPatches(chapter.content, candidate.patches, task.range)
      const delta = candidate.patches.reduce((n, p) => n + p.replacement.length - p.original.length, 0)
      return {
        output: {
          candidateId: candidate.id,
          before: chapter.content.slice(task.range.start, task.range.end),
          after: after.slice(task.range.start, task.range.end + delta),
          patches: candidate.patches,
        },
      }
    },
  })
  registerImpactAndCompact(registry, adapters)
  registerTaskTools(registry, adapters)
  return registry
}

function registerImpactAndCompact(registry: ToolRegistry, adapters: Adapters) {
  registry.register({
    name: 'impact.analyze',
    version: '1.0.0',
    source: 'server/provenance.ts',
    effect: 'read',
    input: z.object({ chapterId: z.string() }),
    output: z.object({
      affected: z.array(
        z.object({
          chapterId: z.string(),
          certainty: z.enum(['certain', 'needs_review']),
          relation: z.string(),
          evidenceIds: z.array(z.string()),
        }),
      ),
    }),
    execute(input, { run }) {
      getChapter(run.projectId, input.chapterId)
      const affected: Array<{
        chapterId: string
        certainty: 'certain' | 'needs_review'
        relation: string
        evidenceIds: string[]
      }> = []
      const explicit = sql.all<{
        target_chapter_id: string
        relation: string
        evidence_ids: string
      }>(
        `SELECT * FROM harness_dependencies WHERE project_id=? AND (source_id=? OR source_id IN (SELECT item_id FROM source_bindings WHERE chapter_id=?))`,
        run.projectId,
        input.chapterId,
        input.chapterId,
      )
      explicit.forEach((row) =>
        affected.push({
          chapterId: row.target_chapter_id,
          certainty: 'certain',
          relation: row.relation,
          evidenceIds: JSON.parse(row.evidence_ids),
        }),
      )
      const shadows = sql.all<{ payoff_chapter_id: string; title: string }>(
        'SELECT payoff_chapter_id,title FROM foreshadowing WHERE project_id=? AND setup_chapter_id=? AND payoff_chapter_id IS NOT NULL',
        run.projectId,
        input.chapterId,
      )
      shadows.forEach((row) =>
        affected.push({
          chapterId: row.payoff_chapter_id,
          certainty: 'certain',
          relation: `伏笔回收：${row.title}`,
          evidenceIds: [],
        }),
      )
      const participants = sql
        .all<{
          participants: string
        }>(
          'SELECT participants FROM events WHERE project_id=? AND chapter_id=?',
          run.projectId,
          input.chapterId,
        )
        .flatMap((e) => JSON.parse(e.participants) as string[])
      for (const event of sql.all<{
        chapter_id: string
        participants: string
        id: string
        title: string
      }>(
        'SELECT chapter_id,participants,id,title FROM events WHERE project_id=? AND chapter_id IS NOT NULL AND chapter_id<>?',
        run.projectId,
        input.chapterId,
      )) {
        if ((JSON.parse(event.participants) as string[]).some((id) => participants.includes(id)))
          affected.push({
            chapterId: event.chapter_id,
            certainty: 'needs_review',
            relation: `共享参与者：${event.title}`,
            evidenceIds: [],
          })
      }
      return {
        output: {
          affected: [
            ...new Map(
              affected.map((item) => [`${item.chapterId}:${item.certainty}:${item.relation}`, item]),
            ).values(),
          ],
        },
      }
    },
  })
  registry.register({
    name: 'memory.compact',
    version: '1.0.0',
    source: 'server/context-selection.ts',
    effect: 'generate',
    estimateInputTokens: (_input, run) => estimateTokens(JSON.stringify(run.state.selection ?? {})) + 200,
    input: z.object({
      tokenBudget: z.number().int().positive(),
      view: viewSchema,
      useCompressor: z.boolean().default(false),
    }),
    output: z.object({
      text: z.string(),
      evidenceIds: z.array(z.string()),
      report: contextSchema.shape.report,
      compressor: z.string(),
      status: z.enum(['packed', 'pending', 'compressed']),
    }),
    async execute(input, context) {
      const selection = await selectSettings(context.run.projectId, '', input.view)
      for (const item of selection.items) {
        const tags = memoryScope(item.kind, item.id).tags ?? []
        if (tags.length || ['fact', 'event', 'foreshadowing', 'entity'].includes(item.kind))
          item.priority += 20
      }
      const packed = packContext(selection, input.tokenBudget)
      let text = packed.text
      let ids = packed.evidence.map((e) => e.id)
      let status: 'packed' | 'pending' | 'compressed' = 'packed'
      if (input.useCompressor) {
        if (!adapters.compressor) status = 'pending'
        else {
          const result = await adapters.compressor.compact(
            { text, evidenceIds: ids, tokenBudget: input.tokenBudget },
            context,
          )
          assertActive(context.signal)
          if (
            estimateTokens(result.text) > input.tokenBudget ||
            result.evidenceIds.some((id) => !ids.includes(id))
          )
            throw new ToolError('INVALID_OUTPUT', '压缩结果超出预算或引用范围。')
          text = result.text
          ids = result.evidenceIds
          status = 'compressed'
        }
      }
      return {
        output: {
          text,
          evidenceIds: ids,
          report: packed.report,
          compressor: adapters.compressor?.version ?? 'deterministic-pack.v1',
          status,
        },
        status: status === 'pending' ? 'pending' : 'ok',
      }
    },
  })
}
