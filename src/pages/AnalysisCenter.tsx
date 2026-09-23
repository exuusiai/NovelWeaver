import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, CirclePause, CirclePlay, FlaskConical, Gauge, Loader2, RefreshCw, RotateCcw, SearchCheck, Sparkles } from 'lucide-react'
import { api, post } from '../api'
import { useProject } from '../project-context'
import type { AnalysisJob, Chapter } from '../types'
import { Badge, Button, LoadingState } from '../components/ui'

interface QualityData {
  metrics: { chapters: number; analyzedCharacters: number; estimatedInputTokens: number; entities: number; evidenceCoverage: number; eventChapterCoverage: number; candidateCount: number; lowConfidenceCount: number; hallucinationRiskCount: number; truncationFailures: number; failedJobs: number; details: Record<string, unknown> }
  failedJobs: Array<{ id: string; message: string; error: string; status: string; stage: string }>
  audits: Array<{ id: string; pass_name: string; metrics: Record<string, number>; disagreements: Array<{ kind: string; label: string; detail: string }>; created_at: string }>
}

export function AnalysisCenter() {
  const { projectId } = useProject()
  const [jobs, setJobs] = useState<AnalysisJob[]>([])
  const [quality, setQuality] = useState<QualityData | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const load = async () => {
    const [jobRows, qualityData] = await Promise.all([api<AnalysisJob[]>(`/api/projects/${projectId}/analysis/jobs`), api<QualityData>(`/api/projects/${projectId}/analysis/quality`)])
    setJobs(jobRows); setQuality(qualityData)
  }
  useEffect(() => { load() }, [projectId])
  useEffect(() => {
    if (!jobs.some((job) => ['queued', 'running', 'paused'].includes(job.status))) return
    const timer = window.setInterval(load, 1400)
    return () => window.clearInterval(timer)
  }, [jobs, projectId])
  const start = async () => { setBusy(true); setNotice(''); try { await post(`/api/projects/${projectId}/analysis/jobs`, { replaceCandidates: true }); await load() } catch (error) { setNotice((error as Error).message) } finally { setBusy(false) } }
  const secondPass = async () => { setBusy(true); setNotice(''); try { await post(`/api/projects/${projectId}/analysis/second-pass`, {}); await load() } catch (error) { setNotice((error as Error).message) } finally { setBusy(false) } }
  const act = async (job: AnalysisJob, action: 'pause' | 'resume' | 'retry') => { setNotice(''); try { await post(`/api/analysis/jobs/${job.id}/${action}`, {}); await load() } catch (error) { setNotice((error as Error).message) } }
  const rewriteSummaries = async () => {
    setNotice('')
    try {
      const chapters = (await api<Chapter[]>(`/api/projects/${projectId}/chapters`)).filter((chapter) => chapter.content.replace(/\s/g, '').length >= 40)
      if (!chapters.length) { setNotice('没有正文足够的章节需要重写摘要。'); return }
      let done = 0; let failed = 0
      for (const chapter of chapters) {
        setNotice(`正在重写章节摘要 ${done + failed + 1}/${chapters.length}：《${chapter.title}》…`)
        try { await post(`/api/chapters/${chapter.id}/summary/rewrite`, {}); done += 1 } catch { failed += 1 }
      }
      setNotice(`摘要重写完成：成功 ${done} 章${failed ? `，失败 ${failed} 章（可再次点击续跑）` : ''}。章节记忆已同步更新。`)
    } catch (error) { setNotice(`无法读取章节：${(error as Error).message}`) }
  }
  const latestAudit = quality?.audits[0]
  return <div className="analysis-page">
    <section className="analysis-hero"><div><span><FlaskConical size={24} /></span><div><h2>文稿分析中心</h2><p>分批执行、断点控制、失败重试与独立质量复核。</p></div></div><div><Button variant="secondary" onClick={rewriteSummaries} disabled={busy}><Sparkles size={15} /> 重写章节摘要</Button><Button variant="secondary" onClick={secondPass} disabled={busy}><SearchCheck size={15} /> 独立二次分析</Button><Button onClick={start} disabled={busy || jobs.some((job) => ['queued', 'running', 'paused'].includes(job.status))}>{busy ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />} 开始完整分析</Button></div></section>
    {notice && <p className="analysis-notice">{notice}</p>}
    {jobs.some((job) => ['queued', 'running'].includes(job.status)) && <LoadingState label="后台任务正在推进；离开本页不会中断" />}
    <section className="quality-grid">
      <QualityCard icon={<Gauge />} value={`${quality?.metrics.evidenceCoverage ?? 0}%`} label="实体证据覆盖" detail={`${quality?.metrics.entities ?? 0} 个实体`} />
      <QualityCard icon={<CheckCircle2 />} value={`${quality?.metrics.eventChapterCoverage ?? 0}%`} label="事件章节关联" detail={`${quality?.metrics.chapters ?? 0} 个章节`} />
      <QualityCard icon={<AlertTriangle />} value={quality?.metrics.hallucinationRiskCount ?? 0} label="高幻觉风险" detail={`${quality?.metrics.candidateCount ?? 0} 个候选待审`} />
      <QualityCard icon={<RotateCcw />} value={quality?.metrics.failedJobs ?? 0} label="失败任务" detail={`${quality?.metrics.truncationFailures ?? 0} 次疑似输出截断`} />
      <QualityCard icon={<FlaskConical />} value={(quality?.metrics.estimatedInputTokens ?? 0).toLocaleString()} label="估算输入 Token" detail="按中文字符近似，实际以服务商账单为准" />
    </section>
    <div className="analysis-grid"><section className="surface job-list"><header><div><h3>分析任务</h3><p>最近 20 次执行记录</p></div><span>{jobs.length} 条</span></header>{jobs.map((job) => <article key={job.id}><div className="job-head"><div><Badge tone={job.status === 'completed' ? 'teal' : job.status === 'failed' || job.status === 'partial' ? 'red' : job.status === 'paused' ? 'amber' : 'blue'}>{statusLabel(job.status)}</Badge><strong>{job.stage === 'second-pass' ? '独立二次分析' : '文稿结构化分析'}</strong></div><time>{new Date(job.created_at).toLocaleString('zh-CN')}</time></div><div className="job-progress"><i style={{ width: `${job.progress}%` }} /></div><p>{job.error || job.message}</p><footer><span>{job.progress}%{job.result?.failures?.length ? ` · ${job.result.failures.length} 个失败批次` : ''}</span><div>{['queued', 'running'].includes(job.status) && <Button variant="ghost" onClick={() => act(job, 'pause')}><CirclePause size={14} /> 暂停</Button>}{job.status === 'paused' && <Button variant="ghost" onClick={() => act(job, 'resume')}><CirclePlay size={14} /> 继续</Button>}{['failed', 'partial'].includes(job.status) && <Button variant="secondary" onClick={() => act(job, 'retry')}><RotateCcw size={14} /> 重试失败章节</Button>}</div></footer></article>)}</section>
      <aside className="surface disagreement-panel"><header><div><h3>二次分析分歧</h3><p>不会自动写入正史</p></div>{latestAudit && <Badge tone="amber">{latestAudit.disagreements.length} 项</Badge>}</header>{latestAudit?.disagreements.length ? latestAudit.disagreements.map((item, index) => <article key={`${item.kind}-${item.label}-${index}`}><Badge>{item.kind === 'missing_entity' ? '遗漏实体' : '遗漏事件'}</Badge><strong>{item.label}</strong><p>{item.detail}</p></article>) : <div className="panel-empty"><SearchCheck size={24} /><p>运行独立二次分析后，在这里审阅与主分析不一致的内容。</p></div>}</aside></div>
  </div>
}

function QualityCard({ icon, value, label, detail }: { icon: React.ReactNode; value: string | number; label: string; detail: string }) { return <article>{icon}<div><strong>{value}</strong><span>{label}</span><p>{detail}</p></div></article> }
function statusLabel(status: string) { return ({ queued: '排队中', running: '分析中', paused: '已暂停', partial: '部分完成', completed: '已完成', failed: '失败' } as Record<string, string>)[status] || status }
