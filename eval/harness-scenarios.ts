import assert from 'node:assert/strict'
import { z } from 'zod'
import { db, sql } from '../server/db.ts'
import { assembleContext, searchMemory } from '../server/memory.ts'
import { selectSettings } from '../server/context-selection.ts'
import { compareFactValues } from '../server/review.ts'
import { getChapter } from '../server/harness/tools.ts'
import { readEvidence } from '../server/harness/evidence.ts'
import { getRun, exportRun, replaySnapshot, restoreProject, saveRun, snapshotRun } from '../server/harness/store.ts'
import { defaultAdapters } from '../server/harness/adapters.ts'
import { recoverRuns, Executor } from '../server/harness/executor.ts'
import { ToolError, type Candidate, type Run, type Verification } from '../server/harness/protocol.ts'
import { contentHash, rebuildChapterMemory } from '../server/routes/helpers.ts'
import { bindSources, setMemoryScope } from '../server/provenance.ts'
import { fixtureAdapters, setupFixture, story } from './harness-fixture.ts'

type Fixture = ReturnType<typeof setupFixture>
const view = (f: Fixture, chapter = 0) => ({
  chapterId: f.chapters[chapter].id,
  audience: 'character' as const,
  holderId: f.entityA,
  storyTick: f.chapters[chapter].storyTick,
  entityIds: [f.entityA],
})
const candidate = (r: Run) => (r.state.proposal as { candidate: Candidate }).candidate
const mustCall = async (f: Fixture, tool: string, input: unknown) => {
  const obs = await f.executor.call(f.run.id, tool, input)
  assert.equal(obs.status, 'ok', JSON.stringify(obs.error))
  return obs
}
const commitInput = (f: Fixture, r: Run, ids = candidate(r).patches.map((p) => p.id)) => ({
  baseRevision: candidate(r).baseRevision,
  candidateId: candidate(r).id,
  patchIds: ids,
  idempotencyKey: `commit-${f.run.id}`,
  authorEvaluation: { rating: 4, note: '合成 fixture 已核验。' },
})
function edit(f: Fixture, content: string) {
  db.transaction(() => {
    sql.run(
      "UPDATE chapters SET content=?,summary='',content_hash=?,analyzed_hash='',updated_at=? WHERE id=?",
      content,
      contentHash(content),
      sql.now(),
      f.chapters[0].id,
    )
    rebuildChapterMemory(f.projectId, f.chapters[0].id, f.chapters[0].title, content, '')
  })()
}
export const harnessScenarios: Array<{ id: string; name: string; run: () => Promise<Run | void> }> = [
  {
    id: 'H01',
    name: '同名人物按实体 ID 与来源隔离',
    async run() {
      const f = setupFixture()
      const selection = await selectSettings(f.projectId, '陆宁 钥匙', view(f, 1))
      const text = selection.items.map((i) => i.text).join('\n')
      assert(text.includes('铜钥匙'))
      assert(!text.includes('银钥匙'))
      assert(!text.includes('红盒'))
      assert(selection.excluded.some((e) => e.id === f.entityB))
    },
  },
  {
    id: 'H02',
    name: '未来秘密不进入前章角色上下文，缓存隔离',
    async run() {
      const f = setupFixture()
      const full = await searchMemory(f.projectId, '雾灯密码', 20, f.chapters[0].id)
      assert(full.some((h) => h.content.includes('雾灯密码是七')))
      const early = await searchMemory(f.projectId, '雾灯密码', 20, f.chapters[0].id, { excludeFuture: true })
      assert(!early.some((h) => h.content.includes('雾灯密码是七')))
      const context = await assembleContext(f.projectId, '陆宁调查蓝盒', f.chapters[0].id)
      for (const phrase of story.golden.forbiddenEarly) assert(!context.text.includes(phrase))
      assert(!context.text.includes('结尾烧毁灯塔'))
      assert(!context.text.includes('盒中没有密信') || context.text.includes('/belief'))
    },
  },
  {
    id: 'H03',
    name: '倒叙与章节重排分别遵守故事时间和叙事顺序',
    async run() {
      const f = setupFixture()
      const flashback = await selectSettings(f.projectId, '铜钥匙', view(f, 2))
      assert(!flashback.items.some((i) => i.id === f.factId))
      assert(flashback.excluded.some((e) => e.reason === 'future_story_time'))
      sql.run('UPDATE chapters SET position=0 WHERE id=?', f.chapters[3].id)
      const reordered = await selectSettings(f.projectId, '雾灯密码', view(f))
      assert(!reordered.items.some((i) => i.id === f.secretId))
      assert(!reordered.items.some((i) => i.text.includes('雾灯密码是七')))
    },
  },
  {
    id: 'H04',
    name: '前文改动清理旧摘要、事实、检索块与引用',
    async run() {
      const f = setupFixture()
      readEvidence(f.projectId, f.evidence.id)
      edit(f, '陆宁把铜钥匙放进绿盒。')
      assert.throws(() => readEvidence(f.projectId, f.evidence.id), { code: 'STALE_EVIDENCE' })
      const selection = await selectSettings(f.projectId, '蓝盒', view(f))
      assert(!selection.items.some((i) => i.id === f.factId))
      assert.equal(getChapter(f.projectId, f.chapters[0].id).summary, '')
      assert(selection.excluded.some((i) => i.id === f.factId && i.reason === 'stale_source'))
      const chunks = sql.all<{ content: string; summary: string }>(
        'SELECT content,summary FROM memory_chunks WHERE chapter_id=?',
        f.chapters[0].id,
      )
      assert(chunks.every((c) => !c.content.includes('蓝盒') && !c.summary.includes('蓝盒')))
      edit(f, '陆宁把铜钥匙放进绿盒。\n\n\n雨落下来。')
      const fresh = await selectSettings(f.projectId, '陆宁', view(f))
      assert(fresh.evidence.some((e) => e.kind === 'chapter' && e.text.includes('\n\n\n')))
      fresh.evidence.filter((e) => e.kind === 'chapter').forEach((e) => readEvidence(f.projectId, e.id))
    },
  },
  {
    id: 'H05',
    name: '润色闭环修复目标、保留事实并记录作者评价',
    async run() {
      const f = setupFixture()
      const ready = await f.executor.resume(f.run.id)
      assert.equal(ready.stopReason, 'awaiting_author')
      assert.equal((ready.state.verification as Verification).status, 'pass')
      await mustCall(f, 'revision.commit', commitInput(f, ready))
      const chapter = getChapter(f.projectId, f.chapters[0].id)
      assert(!chapter.content.includes('非常非常'))
      assert(chapter.content.includes('铜钥匙'))
      assert(chapter.content.includes('蓝盒'))
      const final = getRun(f.run.id)
      assert.equal(final.adoption.length, 1)
      assert.equal((final.state.verification as Verification).author?.rating, 4)
      assert(final.steps.every((s) => s.beforeRevision && s.afterRevision))
      return final
    },
  },
  {
    id: 'H06',
    name: '证据不足与语义未配置保留待检查，采纳须显式确认',
    async run() {
      const adapters = fixtureAdapters()
      adapters.checker = defaultAdapters().checker
      const f = setupFixture(adapters)
      const ready = await f.executor.resume(f.run.id)
      assert.equal((ready.state.verification as Verification).status, 'pending')
      const blocked = await f.executor.call(f.run.id, 'revision.commit', commitInput(f, ready))
      assert.equal(blocked.error?.code, 'VERIFICATION_FAILED')
      await mustCall(f, 'revision.commit', { ...commitInput(f, ready), acknowledgePending: true })
      const noGenerator = setupFixture(defaultAdapters())
      const pending = await noGenerator.executor.resume(noGenerator.run.id)
      assert.equal(pending.stopReason, 'needs_check')
      assert.equal((pending.state.proposal as { candidate: unknown }).candidate, null)
      const check = await noGenerator.executor.call(noGenerator.run.id, 'evidence.read', { evidenceIds: [] })
      assert.equal(check.status, 'pending')
      return getRun(f.run.id)
    },
  },
  {
    id: 'H07',
    name: '补丁版本冲突阻止覆盖',
    async run() {
      const f = setupFixture()
      const ready = await f.executor.resume(f.run.id)
      edit(f, f.chapters[0].content + '作者新增了一句话。')
      const result = await f.executor.call(f.run.id, 'revision.commit', commitInput(f, ready))
      assert.equal(result.error?.code, 'VERSION_CONFLICT')
      assert(getChapter(f.projectId, f.chapters[0].id).content.endsWith('作者新增了一句话。'))
    },
  },
  {
    id: 'H08',
    name: '暂时失败有限恢复，持续失败在上限停止',
    async run() {
      const f = setupFixture()
      let calls = 0
      f.executor.registry.register({
        name: 'fixture.flaky',
        version: '1',
        source: 'synthetic',
        effect: 'read',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        execute() {
          calls++
          if (calls === 1) throw new ToolError('TEMPORARY_FAILURE', 'fixture transient', true)
          return { output: { ok: true } }
        },
      })
      const workflow = {
        name: 'revision.local',
        version: '1.0.0',
        steps: [{ tool: 'fixture.flaky', input: () => ({}) }],
      }
      const executor = new Executor(f.executor.registry, [workflow])
      const run = await executor.resume(f.run.id)
      assert.equal(calls, 2)
      assert.equal(run.steps.length, 2)
      assert.equal(run.stopReason, 'awaiting_author')
      assert.equal(run.steps[0].observation.error?.retryable, true)
      const f2 = setupFixture()
      let failures = 0
      f2.executor.registry.register({
        name: 'fixture.down',
        version: '1',
        source: 'synthetic',
        effect: 'read',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        execute() {
          failures++
          throw new ToolError('TEMPORARY_FAILURE', 'fixture still down', true)
        },
      })
      const stopped = await new Executor(f2.executor.registry, [
        { ...workflow, steps: [{ tool: 'fixture.down', input: () => ({}) }] },
      ]).resume(f2.run.id)
      assert.equal(failures, 2)
      assert.equal(stopped.stopReason, 'temporary_failure')
    },
  },
  {
    id: 'H09',
    name: '重复采纳幂等且不同请求重用标识时报错',
    async run() {
      const f = setupFixture()
      const ready = await f.executor.resume(f.run.id)
      const input = commitInput(f, ready)
      const first = await mustCall(f, 'revision.commit', input)
      const count = sql.get<{ n: number }>(
        'SELECT COUNT(*) n FROM chapter_history WHERE chapter_id=?',
        f.chapters[0].id,
      )!.n
      const second = await mustCall(f, 'revision.commit', input)
      assert.deepEqual(first.output, second.output)
      assert.equal(
        sql.get<{ n: number }>('SELECT COUNT(*) n FROM chapter_history WHERE chapter_id=?', f.chapters[0].id)!.n,
        count,
      )
      assert.equal(getRun(f.run.id).adoption.length, 1)
      const conflict = await f.executor.call(f.run.id, 'revision.commit', {
        ...input,
        authorEvaluation: { note: '不同请求' },
      })
      assert.equal(conflict.error?.code, 'IDEMPOTENCY_CONFLICT')
      await mustCall(f, 'revision.undo', {
        baseRevision: getChapter(f.projectId, f.chapters[0].id).revision,
        idempotencyKey: `undo-${f.run.id}`,
      })
      const repeated = await mustCall(f, 'revision.commit', input)
      assert.equal(repeated.changes.length, 0)
      assert.equal(getRun(f.run.id).stopReason, 'author_undone')
      assert.equal(getChapter(f.projectId, f.chapters[0].id).content, f.chapters[0].content)
      return getRun(f.run.id)
    },
  },
  {
    id: 'H10',
    name: '撤销恢复正文与检索记忆，旧派生事实保持待复核',
    async run() {
      const f = setupFixture()
      const ready = await f.executor.resume(f.run.id)
      await mustCall(f, 'revision.commit', commitInput(f, ready))
      const revision = getChapter(f.projectId, f.chapters[0].id).revision
      await mustCall(f, 'revision.undo', { baseRevision: revision, idempotencyKey: `undo-${f.run.id}` })
      assert.equal(getChapter(f.projectId, f.chapters[0].id).content, f.chapters[0].content)
      assert(
        sql
          .all<{ content: string }>('SELECT content FROM memory_chunks WHERE chapter_id=?', f.chapters[0].id)
          .some((c) => c.content === f.chapters[0].content),
      )
      assert.throws(() => readEvidence(f.projectId, f.evidence.id), { code: 'STALE_EVIDENCE' })
      assert(
        sql.get<{ validity: string }>('SELECT validity FROM source_bindings WHERE item_id=?', f.factId)!.validity ===
          'stale',
      )
    },
  },
  {
    id: 'H11',
    name: '部分采纳按所选补丁组合重新检查',
    async run() {
      const f = setupFixture()
      const ready = await f.executor.resume(f.run.id)
      const blocked = await f.executor.call(f.run.id, 'revision.commit', commitInput(f, ready, ['p1']))
      assert.equal(blocked.error?.code, 'VERIFICATION_FAILED')
      await mustCall(f, 'revision.verify', { patchIds: ['p1'] })
      await mustCall(f, 'revision.commit', commitInput(f, ready, ['p1']))
      const text = getChapter(f.projectId, f.chapters[0].id).content
      assert(!text.includes('非常非常'))
      assert(text.includes('缓慢地慢慢'))
      return getRun(f.run.id)
    },
  },
  {
    id: 'H12',
    name: '快照恢复交互、数据库、预算和随机状态；回放零工具执行',
    async run() {
      const f = setupFixture()
      const ready = await f.executor.resume(f.run.id)
      const snapshot = snapshotRun(ready)
      const replay = replaySnapshot(snapshot.id)
      assert.deepEqual(replay.run, ready)
      assert.equal(replay.remainingBudget.calls, ready.budget.maxCalls - ready.costs.calls)
      await mustCall(f, 'revision.commit', commitInput(f, ready))
      restoreProject(snapshot.database)
      saveRun(snapshot.run)
      assert.equal(getChapter(f.projectId, f.chapters[0].id).content, f.chapters[0].content)
      f.executor.registry.register({
        name: 'fixture.random',
        version: '1',
        source: 'synthetic',
        effect: 'read',
        input: z.object({}),
        output: z.object({ value: z.number() }),
        execute(_input, context) {
          return { output: { value: context.random() } }
        },
      })
      const first = await mustCall(f, 'fixture.random', {})
      saveRun(snapshot.run)
      const second = await mustCall(f, 'fixture.random', {})
      assert.deepEqual(first.output, second.output)
      const exported = exportRun(getRun(f.run.id))
      for (const field of [
        'taskId',
        'sourceFamilyId',
        'split',
        'schemaVersion',
        'initialState',
        'goal',
        'constraints',
        'steps',
        'outcome',
        'costs',
        'verification',
        'adoption',
      ])
        assert(field in exported)
      assert.equal(exported.dataOrigin, 'synthetic')
      assert.equal(exported.sourceFamilyId, story.sourceFamilyId)
    },
  },
  {
    id: 'H13',
    name: '超时、取消、暂停恢复与预算均有停止原因',
    async run() {
      const f = setupFixture()
      const registerSlow = (name: string) =>
        f.executor.registry.register({
          name,
          version: '1',
          source: 'synthetic',
          effect: 'read',
          input: z.object({}),
          output: z.object({ ok: z.boolean() }),
          async execute(_input, context) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 40)
              context.signal.addEventListener(
                'abort',
                () => {
                  clearTimeout(timer)
                  resolve()
                },
                { once: true },
              )
            })
            return { output: { ok: true } }
          },
        })
      registerSlow('fixture.slow')
      let r = getRun(f.run.id)
      r.budget.timeoutMs = 5
      saveRun(r)
      const timeout = await f.executor.call(f.run.id, 'fixture.slow', {})
      assert.equal(timeout.error?.code, 'TIMEOUT')
      r = getRun(f.run.id)
      r.budget.timeoutMs = 200
      saveRun(r)
      const pending = f.executor.call(f.run.id, 'fixture.slow', {})
      f.executor.control(f.run.id, 'cancel')
      const canceled = await pending
      assert.equal(canceled.error?.code, 'CANCELED')
      assert.equal(getRun(f.run.id).status, 'canceled')
      const f2 = setupFixture()
      f2.executor.control(f2.run.id, 'pause')
      const resumed = await f2.executor.resume(f2.run.id)
      assert.equal(resumed.stopReason, 'awaiting_author')
      const f3 = setupFixture()
      r = getRun(f3.run.id)
      r.budget.maxCalls = 1
      saveRun(r)
      const budget = await f3.executor.resume(f3.run.id)
      assert.equal(budget.stopReason, 'budget_exhausted')
      assert.equal(budget.costs.calls, 1)
    },
  },
  {
    id: 'H14',
    name: '显式跨章依赖与预算压缩保留来源',
    async run() {
      const f = setupFixture()
      await f.executor.resume(f.run.id)
      const impact = await mustCall(f, 'impact.analyze', { chapterId: f.chapters[0].id })
      assert(
        (impact.output as { affected: Array<{ chapterId: string; certainty: string }> }).affected.some(
          (c) => c.chapterId === f.chapters[3].id && c.certainty === 'certain',
        ),
      )
      const compact = await mustCall(f, 'memory.compact', { tokenBudget: 300, view: view(f) })
      const value = compact.output as { text: string; evidenceIds: string[]; report: { estimatedTokens: number } }
      assert(value.report.estimatedTokens <= 300)
      assert(value.evidenceIds.length)
      assert(!value.text.includes('雾灯密码是七'))
      value.evidenceIds.forEach((id) => readEvidence(f.projectId, id))
    },
  },
  {
    id: 'H15',
    name: '否定、对象、时间变化不按字符串包含判为兼容',
    async run() {
      assert.equal(compareFactValues('持有铜钥匙', '不再持有铜钥匙'), 'different')
      assert.equal(compareFactValues('蓝盒', '蓝盒里是红盒'), 'needs_review')
      assert.equal(compareFactValues('巫师。', '巫师'), 'equal')
      const f = setupFixture()
      setMemoryScope(f.projectId, 'fact', f.factId, {
        audience: 'world',
        validFromTick: 10,
        validToTick: 15,
        entityIds: [f.entityA],
      })
      const selection = await selectSettings(f.projectId, '铜钥匙', { ...view(f, 3), storyTick: 20 })
      assert(!selection.items.some((i) => i.id === f.factId))
      assert(selection.excluded.some((i) => i.id === f.factId && i.reason === 'after_valid_time'))
    },
  },
  {
    id: 'H16',
    name: '作者明确确认正史后重绑当前来源',
    async run() {
      const f = setupFixture()
      await f.executor.resume(f.run.id)
      edit(f, f.chapters[0].content + '窗内亮着灯。')
      const rev = getChapter(f.projectId, f.chapters[0].id).revision
      await mustCall(f, 'canon.confirm', {
        baseRevision: rev,
        idempotencyKey: `canon-${f.run.id}`,
        kind: 'fact',
        itemId: f.factId,
        sourceChapterIds: [f.chapters[0].id],
        sourceRevisions: { [f.chapters[0].id]: rev },
        note: '作者复核铜钥匙仍在蓝盒。',
      })
      assert.equal(
        sql.get<{ validity: string }>('SELECT validity FROM source_bindings WHERE item_id=?', f.factId)!.validity,
        'current',
      )
      assert.equal(
        sql.get<{ canon_status: string }>('SELECT canon_status FROM story_facts WHERE id=?', f.factId)!.canon_status,
        'canon',
      )
      const selection = await selectSettings(f.projectId, '铜钥匙', view(f))
      assert(selection.items.some((i) => i.id === f.factId))
    },
  },
  {
    id: 'H17',
    name: '输入输出 Schema 错误有轨迹，写工具须有版本和幂等字段',
    async run() {
      const f = setupFixture()
      const invalid = await f.executor.call(f.run.id, 'task.define', { chapterId: f.chapters[0].id })
      assert.equal(invalid.error?.code, 'INVALID_INPUT')
      assert.equal(getRun(f.run.id).steps.length, 1)
      f.executor.registry.register({
        name: 'fixture.bad-output',
        version: '1',
        source: 'synthetic',
        effect: 'read',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        execute() {
          return { output: { ok: 'bad' as unknown as boolean } }
        },
      })
      const output = await f.executor.call(f.run.id, 'fixture.bad-output', {})
      assert.equal(output.error?.code, 'INVALID_OUTPUT')
      f.executor.registry.register({
        name: 'fixture.unsafe-write',
        version: '1',
        source: 'synthetic',
        effect: 'write',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        execute() {
          throw new Error('must never execute')
        },
      })
      const write = await f.executor.call(f.run.id, 'fixture.unsafe-write', {})
      assert.equal(write.error?.code, 'INVALID_INPUT')
      const unknown = await f.executor.call(f.run.id, 'missing.tool', {})
      assert.equal(unknown.error?.code, 'NOT_FOUND')
      assert.equal(getRun(f.run.id).steps.length, 4)
    },
  },
  {
    id: 'H18',
    name: '进程中断补全观察记录并保留已消耗预算',
    async run() {
      const f = setupFixture()
      const run = getRun(f.run.id)
      run.status = 'running'
      run.costs.calls = 1
      run.costs.inputTokens = 12
      run.state.pendingCall = {
        id: 'interrupted-1',
        tool: 'fixture.read',
        toolVersion: '1',
        input: {},
        attempt: 1,
        startedAt: sql.now(),
        beforeRevision: 'before',
        inputTokens: 12,
        effect: 'read',
      }
      saveRun(run)
      recoverRuns()
      const recovered = getRun(f.run.id)
      assert.equal(recovered.stopReason, 'process_interrupted')
      assert.equal(recovered.steps[0].observation.error?.code, 'TEMPORARY_FAILURE')
      assert.equal(recovered.costs.calls, 1)
      assert.equal(recovered.state.pendingCall, undefined)
      assert(recovered.interaction.some((m) => m.role === 'recovery'))
    },
  },
  {
    id: 'H19',
    name: '模型漏检或无依据引用保留待检查',
    async run() {
      const adapters = fixtureAdapters()
      adapters.checker = {
        version: 'fixture.incomplete',
        async verify() {
          return {
            value: [
              {
                name: 'goal_repair',
                status: 'pass',
                detail: 'unavailable evidence',
                evidenceIds: ['missing-evidence'],
              },
            ],
          }
        },
      }
      const f = setupFixture(adapters)
      const ready = await f.executor.resume(f.run.id)
      const verification = ready.state.verification as Verification
      assert.equal(verification.status, 'pending')
      assert.equal(verification.semantic.length, 4)
      assert(verification.semantic.every((c) => c.status === 'pending'))
    },
  },
  {
    id: 'H20',
    name: '检索证据不足时执行一次补查，同名视角需指定身份',
    async run() {
      const f = setupFixture()
      const run = f.executor.create({ ...f.request, goal: 'zzzz-no-evidence' })
      const ready = await f.executor.resume(run.id)
      const searches = ready.steps.filter((s) => s.tool === 'memory.search')
      assert.equal(searches.length, 2)
      assert.equal((searches[0].observation.output as { evidence: unknown[] }).evidence.length, 0)
      assert((searches[1].observation.output as { evidence: unknown[] }).evidence.length > 0)
      const ambiguous = f.executor.create({ ...f.request, holderId: undefined })
      const stopped = await f.executor.resume(ambiguous.id)
      assert.equal(stopped.stopReason, 'needs_check')
      assert.equal(stopped.steps[0].observation.error?.code, 'NEEDS_CHECK')
    },
  },
]
