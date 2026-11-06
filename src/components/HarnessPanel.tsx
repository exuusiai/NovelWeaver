import { useEffect, useState } from 'react'
import { api, post } from '../api'
import type { Chapter } from '../types'
import type { Candidate, Observation, Run, Verification } from '../../server/harness/protocol'
import { Button, Field, Input, Textarea } from './ui'
import { DiffView } from './DiffView'

type Props = {
  projectId: string
  chapter: Chapter
  selection: { start: number; end: number; text: string } | null
  prepare: () => Promise<Chapter | null>
  onChanged: () => Promise<void>
}
const reasonLabel: Record<string, string> = {
  created: '准备执行',
  needs_check: '等待检查',
  awaiting_author: '等待作者采纳',
  author_adopted: '已采纳',
  author_rejected: '已拒绝',
  author_undone: '已撤销',
  author_paused: '已暂停',
  author_canceled: '已取消',
  budget_exhausted: '预算已用完',
  version_conflict: '正文版本冲突',
  timeout: '调用超时',
  process_interrupted: '重启后待恢复',
}
const checkLabel: Record<string, string> = {
  base_revision: '正文版本',
  patch_location: '补丁位置与范围',
  preserve_literals: '逐字保留项',
  target_length: '篇幅',
  citation_format_and_version: '引用与来源版本',
  goal_repair: '修改目标',
  fact_preservation: '事实保持',
  unsupported_additions: '新增内容依据',
  pov: '视角约束',
}
const checkStatus: Record<string, string> = { pass: '通过', fail: '未通过', pending: '待检查' }
const selectionReason: Record<string, string> = {
  stale_source: '来源正文已变化，等待复核',
  future_narrative: '来源在后续章节',
  future_story_time: '来源晚于当前故事时间',
  chapter_scope: '超出指定章节',
  volume_scope: '超出指定卷',
  before_valid_time: '尚未到生效时间',
  after_valid_time: '已超过有效时间',
  entity_identity: '属于其他人物身份',
  author_plan: '作者计划',
  other_character_belief: '其他人物的信念',
  reader_only: '仅读者知情',
  character_knowledge: '当前角色尚未知情',
  unscoped_knowledge: '缺少明确的知情来源',
  endpoint_scope: '关系人物超出范围',
  unlocated_chunk: '旧检索块无法定位原文',
  manual_selection_required: '需作者手动选入',
  legacy_scope_unresolved: '旧资料范围锚点待确认',
  'story_time_unset:narrative_order_only': '尚未填写故事时间，当前按叙事章节限制',
  character_identity_unset: '视角身份待指定',
}
export function HarnessPanel({ projectId, chapter, selection, prepare, onChanged }: Props) {
  const [identities, setIdentities] = useState<Array<{ id: string; name: string; summary: string }>>([])
  const [holder, setHolder] = useState('')
  const [storyTick, setStoryTick] = useState(
    chapter.story_tick === null || chapter.story_tick === undefined ? '' : String(chapter.story_tick),
  )
  const [goal, setGoal] = useState('润色选定正文，改善措辞与节奏，保留人物、物品、事件和视角。')
  const [scope, setScope] = useState<'chapter' | 'selection'>('chapter')
  const [preserve, setPreserve] = useState('')
  const [run, setRun] = useState<Run | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [manual, setManual] = useState('')
  const [acknowledge, setAcknowledge] = useState(false)
  const [note, setNote] = useState('')
  const [rating, setRating] = useState('')
  const candidate = (run?.state.proposal as { candidate?: Candidate } | undefined)?.candidate
  const verification = run?.state.verification as Verification | undefined
  const packed = run?.state.context as
    | {
        report: {
          tokenBudget: number
          estimatedTokens: number
          included: Array<{ id: string; label: string; tokens: number; reason: string }>
          trimmed: Array<{ id: string; label: string; reason: string }>
          excluded: Array<{ id: string; kind: string; reason: string }>
          diagnostics: string[]
        }
      }
    | undefined
  const evidence =
    (
      run?.state.evidence as
        | {
            evidence: Array<{
              id: string
              kind: string
              sourceVersion: string
              text: string
              location: { start: number; end: number } | null
            }>
          }
        | undefined
    )?.evidence ?? []
  const refresh = async (id = run?.id) => {
    if (id) {
      const next = await api<Run>(`/api/harness/runs/${id}`)
      setRun(next)
      return next
    }
    return null
  }
  useEffect(() => {
    let disposed = false
    void api<Array<{ id: string; name: string; summary: string }>>(`/api/projects/${projectId}/entities?type=character`)
      .then((rows) => {
        if (!disposed) {
          setIdentities(rows)
          const matches = rows.filter((r) => r.name === chapter.pov)
          if (matches.length === 1) setHolder(matches[0].id)
        }
      })
      .catch((e) => {
        if (!disposed) setError(e.message)
      })
    void api<Array<{ id: string; chapterId: string }>>(`/api/projects/${projectId}/harness/runs`)
      .then((rows) => {
        const latest = rows.find((r) => r.chapterId === chapter.id)
        if (latest)
          void api<Run>(`/api/harness/runs/${latest.id}`).then((r) => {
            if (!disposed) setRun((current) => current ?? r)
          })
      })
      .catch((e) => {
        if (!disposed) setError(e.message)
      })
    return () => {
      disposed = true
    }
  }, [projectId, chapter.id])
  useEffect(() => {
    if (!run || (run.status !== 'running' && run.stopReason !== 'created')) return
    const timer = window.setInterval(() => {
      void refresh(run.id).catch((e) => setError(e.message))
    }, 600)
    return () => window.clearInterval(timer)
  }, [run?.id, run?.status, run?.stopReason])
  useEffect(() => {
    setSelected(candidate?.patches.map((p) => p.id) ?? [])
    setAcknowledge(false)
  }, [candidate?.id])
  const work = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const call = async (tool: string, input: unknown) => {
    if (!run) throw new Error('请先创建改稿任务。')
    const result = await post<Observation>(`/api/harness/runs/${run.id}/call`, { tool, input })
    await refresh()
    if (result.status === 'error') throw new Error(result.error?.message ?? '工具调用失败。')
    return result
  }
  const start = () =>
    work(async () => {
      const current = await prepare()
      if (!current) throw new Error('正文尚未保存，请先处理保存提示。')
      if (
        scope === 'selection' &&
        (!selection || current.content.slice(selection.start, selection.end) !== selection.text)
      )
        throw new Error('选区已变化，请重新选择正文。')
      const range =
        scope === 'selection' && selection
          ? { start: selection.start, end: selection.end }
          : { start: 0, end: current.content.length }
      const next = await post<Run>('/api/harness/runs', {
        projectId,
        chapterId: current.id,
        baseRevision: current.revision,
        goal,
        range,
        pov: current.pov,
        holderId: holder || undefined,
        storyTick: storyTick === '' ? undefined : Number(storyTick),
        preserve: preserve
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
      })
      setRun(next)
      setManual(current.content.slice(range.start, range.end))
    })
  const verify = () =>
    work(async () => {
      await call('revision.verify', { patchIds: selected })
    })
  const adopt = (ids: string[]) =>
    work(async () => {
      if (!candidate || !run) return
      if (!(await prepare())) throw new Error('正文尚未保存。')
      const checked = await call('revision.verify', { patchIds: ids })
      const result = checked.output as Verification
      if (result.status === 'fail') throw new Error('所选补丁检查失败，请调整候选。')
      if (result.status === 'pending' && !acknowledge) throw new Error('语义检查待完成，请核验后勾选作者确认。')
      await call('revision.commit', {
        baseRevision: candidate.baseRevision,
        idempotencyKey: `adopt-${run.id}-${ids.slice().sort().join('-')}`,
        candidateId: candidate.id,
        patchIds: ids,
        acknowledgePending: acknowledge,
        authorEvaluation: { rating: rating ? Number(rating) : undefined, note },
      })
      await onChanged()
    })
  return (
    <details className="harness-panel" open>
      <summary>一键润色与局部改稿</summary>
      <div className="harness-body">
        <Field label="修改要求">
          <Textarea rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} />
        </Field>
        <Field label="修改范围">
          <select className="input" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
            <option value="chapter">全章</option>
            <option value="selection" disabled={!selection}>
              选中段落{selection ? `（${selection.end - selection.start} 字）` : ''}
            </option>
          </select>
        </Field>
        <Field label="视角身份">
          <select className="input" value={holder} onChange={(e) => setHolder(e.target.value)}>
            <option value="">按当前视角名称匹配</option>
            {identities.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} · {i.summary.slice(0, 30)} · {i.id.slice(-6)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="故事时间刻度（整数，可留空）">
          <Input
            type="number"
            value={storyTick}
            onChange={(e) => setStoryTick(e.target.value)}
            placeholder="与叙事章节顺序分别记录"
          />
        </Field>
        <Field label="逐字保留项（每行一项）">
          <Textarea
            rows={2}
            value={preserve}
            onChange={(e) => setPreserve(e.target.value)}
            placeholder="人物名、关键事实或必须保留的原句"
          />
        </Field>
        <Button onClick={start} disabled={busy || run?.status === 'running' || !chapter.content.length}>
          {busy ? '处理中…' : '生成改稿候选'}
        </Button>
        {error && (
          <p role="alert" className="harness-error">
            {error}
          </p>
        )}
        {run && (
          <>
            <p className="harness-status">
              {run.status === 'running' ? '执行中' : reasonLabel[run.stopReason] || run.stopReason} · {run.costs.calls}/
              {run.budget.maxCalls} 次调用 · {run.costs.inputTokens + run.costs.outputTokens}/{run.budget.maxTokens}{' '}
              Token（估算/服务商记录）
            </p>
            <div className="harness-actions">
              {run.status === 'running' ? (
                <>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      work(async () => {
                        setRun(await post(`/api/harness/runs/${run.id}/control`, { action: 'pause' }))
                      })
                    }
                  >
                    暂停
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      work(async () => {
                        setRun(await post(`/api/harness/runs/${run.id}/control`, { action: 'cancel' }))
                      })
                    }
                  >
                    取消
                  </Button>
                </>
              ) : (
                run.status === 'paused' &&
                !candidate && (
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      work(async () => {
                        setRun(await post(`/api/harness/runs/${run.id}/control`, { action: 'resume' }))
                      })
                    }
                  >
                    继续执行
                  </Button>
                )
              )}
              <a href={`/api/harness/runs/${run.id}/export`} download>
                导出轨迹
              </a>
            </div>
            {!candidate && run.status === 'paused' && run.state.plan && (
              <Field label="作者候选文本">
                <Textarea rows={6} value={manual} onChange={(e) => setManual(e.target.value)} />
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    work(async () => {
                      await call('revision.propose', { manualReplacement: manual })
                      await call('revision.verify', {})
                    })
                  }
                >
                  检查手工候选
                </Button>
              </Field>
            )}
            {candidate && (
              <>
                {candidate.patches.map((p) => (
                  <article className="harness-patch" key={p.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={selected.includes(p.id)}
                        onChange={(e) =>
                          setSelected(e.target.checked ? [...selected, p.id] : selected.filter((id) => id !== p.id))
                        }
                      />{' '}
                      位置 {p.start}–{p.end}
                    </label>
                    <DiffView left={p.original} right={p.replacement} hint="− 原稿 · + 候选" />
                    <p>{p.rationale}</p>
                    <small>{p.evidenceIds.join('、') || '使用任务原文，语义支持见检查结果'}</small>
                  </article>
                ))}
                {verification && (
                  <div className="harness-checks">
                    <strong>程序检查</strong>
                    {verification.program.map((c) => (
                      <p key={c.name} data-status={c.status}>
                        {checkStatus[c.status]} · {checkLabel[c.name] ?? c.name}：{c.detail}
                      </p>
                    ))}
                    <strong>语义判断</strong>
                    {verification.semantic.map((c) => (
                      <p key={c.name} data-status={c.status}>
                        {checkStatus[c.status]} · {checkLabel[c.name] ?? c.name}：{c.detail}
                        {c.evidenceIds.length ? `（${c.evidenceIds.join('、')}）` : ''}
                      </p>
                    ))}
                  </div>
                )}
                {run.status !== 'completed' && (
                  <>
                    <Button variant="secondary" disabled={busy || !selected.length} onClick={verify}>
                      检查所选补丁
                    </Button>
                    <label className="harness-ack">
                      <input type="checkbox" checked={acknowledge} onChange={(e) => setAcknowledge(e.target.checked)} />{' '}
                      我已核验待检查项，确认采纳
                    </label>
                    <Field label="作者评价">
                      <Input
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        placeholder="创作质量评价与采纳理由"
                      />
                      <select className="input" value={rating} onChange={(e) => setRating(e.target.value)}>
                        <option value="">未评分</option>
                        {[1, 2, 3, 4, 5].map((n) => (
                          <option key={n} value={n}>
                            {n} 分
                          </option>
                        ))}
                      </select>
                    </Field>
                    <div className="harness-actions">
                      <Button disabled={busy || !selected.length} onClick={() => adopt(selected)}>
                        采纳所选
                      </Button>
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() => adopt(candidate.patches.map((p) => p.id))}
                      >
                        整体采纳
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          work(async () => {
                            await call('revision.reject', {
                              baseRevision: candidate.baseRevision,
                              idempotencyKey: `reject-${run.id}`,
                              reason: note,
                            })
                          })
                        }
                      >
                        拒绝
                      </Button>
                    </div>
                  </>
                )}
                {run.stopReason === 'author_adopted' && (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      work(async () => {
                        if (!(await prepare())) throw new Error('正文尚未保存。')
                        await call('revision.undo', {
                          baseRevision: (run.state.commit as { revision: number }).revision,
                          idempotencyKey: `undo-${run.id}`,
                        })
                        await onChanged()
                      })
                    }
                  >
                    撤销本次采纳
                  </Button>
                )}
              </>
            )}
            {packed && (
              <details>
                <summary>
                  上下文选择 · {packed.report.estimatedTokens}/{packed.report.tokenBudget} Token
                </summary>
                <strong>入选 {packed.report.included.length} 项</strong>
                {packed.report.included.map((i) => (
                  <p key={i.id}>
                    {i.label} · {i.tokens} Token
                  </p>
                ))}
                <strong>预算裁剪 {packed.report.trimmed.length} 项</strong>
                {packed.report.trimmed.map((i) => (
                  <p key={i.id}>{i.label} · 超出预算，整条目排除</p>
                ))}
                <strong>范围排除 {packed.report.excluded.length} 项</strong>
                {packed.report.excluded.map((i, n) => (
                  <p key={`${i.id}-${n}`}>
                    {i.kind} · {i.id.slice(-8)} · {selectionReason[i.reason] ?? i.reason}
                  </p>
                ))}
                {packed.report.diagnostics.map((d) => (
                  <p key={d}>{selectionReason[d] ?? d}</p>
                ))}
              </details>
            )}
            {!!evidence.length && (
              <details>
                <summary>检查证据 · {evidence.length} 条</summary>
                {evidence.map((e) => (
                  <article key={e.id}>
                    <p>
                      {e.kind === 'chapter' ? '原文' : '设定'} · 版本 {e.sourceVersion.slice(0, 12)}{' '}
                      {e.location ? `· 位置 ${e.location.start}–${e.location.end}` : ''}
                    </p>
                    <pre>{e.text}</pre>
                    <small>{e.id}</small>
                  </article>
                ))}
              </details>
            )}
            <details>
              <summary>执行步骤与证据</summary>
              {run.steps.map((step) => (
                <details key={step.id}>
                  <summary>
                    {step.tool} · {step.observation.status} · {step.observation.costs.latencyMs}ms
                  </summary>
                  <pre>{JSON.stringify(step.observation.error ?? step.observation.output, null, 2)}</pre>
                </details>
              ))}
            </details>
          </>
        )}
      </div>
    </details>
  )
}
