import { useEffect, useState } from 'react'
import { api, post } from '../api'
import { Button, Field, Input, Textarea } from './ui'
import type { Chapter } from '../types'
import type { Run } from '../../server/harness/protocol'
import type { TaskResolution, Operation } from '../../server/tasks/contracts'

const choices: Array<[Operation, string]> = [
  ['draft', '独立故事 / 场景'],
  ['continue', '章节续写'],
  ['outline', '全书大纲'],
  ['chapter_outline', '本章细纲'],
  ['setting', '设定候选'],
  ['plot', '剧情候选'],
  ['revise', '局部改稿'],
  ['review', '一致性审查'],
  ['extract', '结构提取'],
  ['qa', '项目问答'],
]
const missingLabels: Record<string, string> = {
  operation: '操作目的',
  goal: '任务要求',
  chapterId: '当前章节',
  sourceText: '待分析正文',
  holderId: '视角人物身份',
}
export function TaskPanel({ projectId, chapter }: { projectId: string; chapter: Chapter | null }) {
  const [operation, setOperation] = useState<Operation>('draft')
  const [goal, setGoal] = useState('写一个围绕选择与代价的独立场景。')
  const [holder, setHolder] = useState('')
  const [identities, setIdentities] = useState<Array<{ id: string; name: string; summary: string }>>([])
  useEffect(() => {
    let alive = true
    setHolder('')
    void api<Array<{ id: string; name: string; summary: string }>>(
      `/api/projects/${projectId}/entities?type=character`,
    )
      .then((rows) => {
        if (!alive) return
        setIdentities(rows)
        const matching = rows.filter((row) => row.name === chapter?.pov)
        if (matching.length === 1) setHolder(matching[0].id)
      })
      .catch((error) => {
        if (alive) setError(error.message)
      })
    return () => {
      alive = false
    }
  }, [projectId, chapter?.id, chapter?.pov])
  const [storyScale, setScale] = useState('unspecified'),
    [structure, setStructure] = useState('unspecified'),
    [target, setTarget] = useState('')
  const [plan, setPlan] = useState<TaskResolution | null>(null),
    [run, setRun] = useState<Run | null>(null)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [edited, setEdited] = useState(false)
  useEffect(() => {
    setPlan(null)
    setRun(null)
    setError('')
  }, [projectId, chapter?.id])
  useEffect(() => {
    setPlan(null)
    setEdited(true)
  }, [operation, goal, storyScale, structure, target, holder, chapter?.content])
  useEffect(() => {
    if (!run || (run.status !== 'running' && run.stopReason !== 'created')) return
    const timer = setInterval(() => {
      void api<Run>(`/api/tasks/runs/${run.id}`)
        .then(setRun)
        .catch((e) => setError(e.message))
    }, 500)
    return () => clearInterval(timer)
  }, [run?.id, run?.status, run?.stopReason])
  const request = () => ({
    projectId,
    operation,
    goal,
    storyScale,
    narrativeStructure: structure,
    ...(['continue', 'chapter_outline', 'review', 'extract', 'qa', 'revise'].includes(operation) && chapter
      ? {
          chapterId: chapter.id,
          chapterContent: chapter.content,
          chapterOutline: chapter.detailed_outline,
          baseRevision: chapter.revision,
          pov: chapter.pov,
          holderId: holder || undefined,
          storyTick: chapter.story_tick ?? undefined,
        }
      : {}),
    targetLength: target ? { value: Number(target), unit: 'characters' } : undefined,
  })
  const act = async (start: boolean) => {
    if (start && operation === 'revise') {
      document.getElementById('revision-panel')?.scrollIntoView({ behavior: 'smooth' })
      return
    }
    setBusy(true)
    setError('')
    try {
      const resolved = await post<TaskResolution>('/api/tasks/resolve', request())
      setPlan(resolved)
      if (start && resolved.routeDecision.status === 'ready') {
        setRun(await post<Run>('/api/tasks/runs', request()))
        setEdited(false)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const artifact = (run?.state.artifact as { artifact?: { text: string } } | undefined)?.artifact
  const verification = run?.state.artifactVerification as { status: string } | undefined
  return (
    <details className="task-panel" open>
      <summary>
        <strong>选择创作任务</strong>
      </summary>
      <Field label="这次要做什么">
        <select value={operation} onChange={(e) => setOperation(e.target.value as Operation)}>
          {choices.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="要求">
        <Textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={3} />
      </Field>
      {chapter && ['continue', 'qa'].includes(operation) && (
        <Field label="视角人物（同名时请选择）">
          <select value={holder} onChange={(event) => setHolder(event.target.value)}>
            <option value="">按当前章节视角匹配</option>
            {identities.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name} · {person.summary}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="task-options">
        <Field label="作品规模">
          <select value={storyScale} onChange={(e) => setScale(e.target.value)}>
            <option value="unspecified">未指定</option>
            <option value="short">短篇</option>
            <option value="medium">中篇</option>
            <option value="long">长篇</option>
          </select>
        </Field>
        <Field label="目标字数，可留空">
          <Input type="number" min="1" value={target} onChange={(e) => setTarget(e.target.value)} />
        </Field>
      </div>
      <Field label="叙事形态">
        <select value={structure} onChange={(e) => setStructure(e.target.value)}>
          <option value="unspecified">未指定</option>
          <option value="single">单中心</option>
          <option value="ensemble">群像</option>
          <option value="episodic">单元式</option>
          <option value="relay">接力</option>
          <option value="open">开放探索</option>
        </select>
      </Field>
      <div className="task-options">
        <Button variant="ghost" onClick={() => void act(false)} disabled={busy}>
          查看任务计划
        </Button>
        <Button onClick={() => void act(true)} disabled={busy || run?.status === 'running'}>
          {operation === 'revise' ? '使用下方选区改稿' : '执行任务'}
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
      {plan && (
        <div className="task-plan">
          <strong>{plan.plan.label}</strong>
          <p>
            范围：
            {plan.taskSpec.targetScope === 'project'
              ? '当前项目'
              : plan.taskSpec.targetScope === 'selection'
                ? '选中段落'
                : '当前章节'}{' '}
            · 产物：
            {choices.find(([v]) => v === plan.taskSpec.operation)?.[1] ?? plan.taskSpec.artifactType}
          </p>
          {plan.routeDecision.missing.length > 0 && (
            <p>
              需要补充：
              {plan.routeDecision.missing.map((name) => missingLabels[name] ?? '任务参数').join('、')}
            </p>
          )}
          {plan.taskSpec.requiredCapabilities.some((role) => !plan.capabilitySnapshot[role]) && (
            <p>生成或检查能力尚未配置，可以先查看任务计划。</p>
          )}
          <details>
            <summary>流程与证据范围</summary>
            <pre>{JSON.stringify(plan, null, 2)}</pre>
          </details>
        </div>
      )}
      {run && (
        <div className="task-plan">
          <p>
            {edited ? '要求已变化，下面保留上一次任务结果。' : ''}任务状态：
            {run.stopReason === 'artifact_ready'
              ? '候选已完成'
              : run.stopReason === 'needs_check'
                ? '等待语义能力、证据或作者检查'
                : run.stopReason === 'created' || run.status === 'running'
                  ? '执行中'
                  : run.stopReason}
          </p>
          {artifact && (
            <>
              <p>
                检查：
                {verification?.status === 'pass'
                  ? '通过'
                  : verification?.status === 'fail'
                    ? '未通过'
                    : '待核验'}
                ；候选尚未写入正文或正史。
              </p>
              <pre className="task-output">{artifact.text || JSON.stringify(artifact, null, 2)}</pre>
              <Button
                variant="ghost"
                onClick={() =>
                  void navigator.clipboard.writeText(artifact.text || JSON.stringify(artifact, null, 2))
                }
              >
                复制候选
              </Button>
            </>
          )}
          <details>
            <summary>查看执行记录</summary>
            <pre>
              {JSON.stringify(
                {
                  adaptation: run.adaptation,
                  steps: run.steps,
                  verification,
                  costs: run.costs,
                },
                null,
                2,
              )}
            </pre>
          </details>
        </div>
      )}
    </details>
  )
}
