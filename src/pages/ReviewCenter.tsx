import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, CircleAlert, Clock3, EyeOff, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react'
import { api, patch, post } from '../api'
import { useProject } from '../project-context'
import type { ReviewIssue } from '../types'
import { Badge, Button } from '../components/ui'

export function ReviewCenter() {
  const { projectId, reloadProjects } = useProject()
  const [issues, setIssues] = useState<ReviewIssue[]>([])
  const [filter, setFilter] = useState('open')
  const [running, setRunning] = useState(false)
  const load = () => api<ReviewIssue[]>(`/api/projects/${projectId}/reviews`).then(setIssues)
  useEffect(() => { load() }, [projectId])
  const run = async () => { setRunning(true); await post(`/api/projects/${projectId}/reviews/run`, {}); await Promise.all([load(), reloadProjects()]); setRunning(false) }
  const update = async (id: string, status: 'resolved' | 'ignored') => { await patch(`/api/reviews/${id}`, { status }); load(); reloadProjects() }
  const visible = useMemo(() => issues.filter((issue) => filter === 'all' || issue.status === filter), [issues, filter])
  const summary = { high: issues.filter((x) => x.status === 'open' && x.severity === 'high').length, medium: issues.filter((x) => x.status === 'open' && x.severity === 'medium').length, low: issues.filter((x) => x.status === 'open' && x.severity === 'low').length }

  return <div className="review-page">
    <section className="review-hero"><div><span className="review-shield"><ShieldCheck size={25} /></span><div><h2>作品连续性状态</h2><p>规则引擎检查正史状态、章节结构、时间线、人物参与和伏笔生命周期。</p></div></div><Button onClick={run} disabled={running}><RefreshCw className={running ? 'spin' : ''} size={16} /> {running ? '正在检查…' : '重新运行审查'}</Button></section>
    <section className="review-summary"><article><TriangleAlert size={20} /><strong>{summary.high}</strong><div><span>高风险</span><p>可能破坏核心连续性</p></div></article><article><CircleAlert size={20} /><strong>{summary.medium}</strong><div><span>需确认</span><p>信息缺失或正史未定</p></div></article><article><Clock3 size={20} /><strong>{summary.low}</strong><div><span>建议项</span><p>可在后续创作中完善</p></div></article><article><CheckCircle2 size={20} /><strong>{issues.filter((x) => x.status === 'resolved').length}</strong><div><span>已解决</span><p>本轮已完成处理</p></div></article></section>
    <section className="surface issue-list"><header><div className="segmented"><button className={filter === 'open' ? 'active' : ''} onClick={() => setFilter('open')}>待处理</button><button className={filter === 'resolved' ? 'active' : ''} onClick={() => setFilter('resolved')}>已解决</button><button className={filter === 'ignored' ? 'active' : ''} onClick={() => setFilter('ignored')}>有意为之</button><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部</button></div><span>{visible.length} 条</span></header><div>{visible.map((issue) => <article key={issue.id} className={`issue severity-${issue.severity}`}><span className="issue-icon">{issue.severity === 'high' ? <TriangleAlert /> : <CircleAlert />}</span><div className="issue-main"><div><Badge tone={issue.severity === 'high' ? 'red' : issue.severity === 'medium' ? 'amber' : 'neutral'}>{severityLabel(issue.severity)}</Badge><Badge>{categoryLabel(issue.category)}</Badge></div><h3>{issue.title}</h3><p>{issue.description}</p><small>证据对象：{issue.evidence.length} 个 · {new Date(issue.created_at).toLocaleString('zh-CN')}</small></div>{issue.status === 'open' && <div className="issue-actions"><Button variant="secondary" onClick={() => update(issue.id, 'resolved')}><CheckCircle2 size={15} /> 已处理</Button><Button variant="ghost" onClick={() => update(issue.id, 'ignored')}><EyeOff size={15} /> 有意为之</Button></div>}</article>)}</div>{!visible.length && <div className="review-empty"><ShieldCheck size={30} /><h3>当前筛选下没有问题</h3><p>运行一次审查，或切换到其他状态。</p></div>}</section>
  </div>
}

function severityLabel(value: string) { return value === 'high' ? '高风险' : value === 'medium' ? '需确认' : '建议' }
function categoryLabel(value: string) { return ({ canon: '正史', timeline: '时间线', logic: '逻辑', pov: '视角', structure: '章节', foreshadowing: '伏笔', 'fact-conflict': '事实冲突' } as Record<string, string>)[value] || value }
