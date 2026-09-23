import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, BookOpen, Boxes, Download, FileUp, GitBranch, Lightbulb, ListChecks, ListRestart, Loader2, Plus, RefreshCw, Scissors, ShieldAlert, Sparkles, Trash2 } from 'lucide-react'
import { api, patch, post, upload } from '../api'
import { useProject } from '../project-context'
import type { Chapter, ImportPreviewChapter, Project, ProjectStats } from '../types'
import { Badge, Button, Input, Modal, Textarea } from '../components/ui'

export function Dashboard() {
  const { projectId, reloadProjects } = useProject()
  const [project, setProject] = useState<Project | null>(null)
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [importing, setImporting] = useState(false)
  const [notice, setNotice] = useState('')
  const [cleaning, setCleaning] = useState(false)
  const [preview, setPreview] = useState<{ id: string; filename: string; chapters: ImportPreviewChapter[]; diagnostics: { warnings: string[] } } | null>(null)
  const [stats, setStats] = useState<ProjectStats | null>(null)
  const [splitCursors, setSplitCursors] = useState<Record<number, number>>({})
  const fileRef = useRef<HTMLInputElement>(null)
  const replaceRef = useRef(false)
  const navigate = useNavigate()

  const load = async () => {
    const [projectRow, chapterRows, statsRow] = await Promise.all([
      api<Project>(`/api/projects/${projectId}`),
      api<Chapter[]>(`/api/projects/${projectId}/chapters`),
      api<ProjectStats>(`/api/projects/${projectId}/stats`).catch(() => null),
    ])
    setProject(projectRow); setChapters(chapterRows); setStats(statsRow)
  }
  useEffect(() => { load() }, [projectId])

  const previewFile = async (file?: File) => {
    if (!file) return
    setImporting(true); setNotice('正在解析文稿并准备章节边界预览…')
    try {
      const result = await upload<{ id: string; filename: string; chapters: ImportPreviewChapter[]; diagnostics: { warnings: string[] } }>(`/api/projects/${projectId}/import/preview`, file)
      setPreview(result); setNotice(`已识别 ${result.chapters.length} 个章节。请在预览中确认标题与边界后再导入。`)
    } catch (caught) { setNotice((caught as Error).message); replaceRef.current = false } finally { setImporting(false); if (fileRef.current) fileRef.current.value = '' }
  }
  const commitPreview = async () => {
    if (!preview) return
    setImporting(true); setNotice('正在写入确认后的章节，并创建后台分析任务…')
    try {
      await patch(`/api/projects/${projectId}/import/previews/${preview.id}`, { chapters: preview.chapters })
      const result = await post<{ chapters: number; analysisJobId: string }>(`/api/projects/${projectId}/import/previews/${preview.id}/commit`, { replace: replaceRef.current })
      setPreview(null); setNotice(`已导入 ${result.chapters} 个章节；分析任务已进入后台，可在“分析中心”查看、暂停或重试。`); replaceRef.current = false
      await Promise.all([load(), reloadProjects()])
    } catch (caught) { setNotice((caught as Error).message) } finally { setImporting(false) }
  }
  const updatePreviewChapter = (index: number, values: Partial<ImportPreviewChapter>) => { if (preview) setPreview({ ...preview, chapters: preview.chapters.map((chapter, itemIndex) => itemIndex === index ? { ...chapter, ...values } : chapter) }) }
  const removePreviewChapter = (index: number) => { if (preview) setPreview({ ...preview, chapters: preview.chapters.filter((_, itemIndex) => itemIndex !== index).map((chapter, position) => ({ ...chapter, position })) }) }
  const mergePreviewChapter = (index: number) => { if (!preview || index === 0) return; const next = [...preview.chapters]; next[index - 1] = { ...next[index - 1], content: `${next[index - 1].content}\n\n${next[index].content}` }; next.splice(index, 1); setPreview({ ...preview, chapters: next.map((chapter, position) => ({ ...chapter, position })) }) }
  const splitPreviewChapter = (index: number) => { if (!preview) return; const chapter = preview.chapters[index]; const cursor = splitCursors[index] || Math.floor(chapter.content.length / 2); if (cursor <= 0 || cursor >= chapter.content.length) return; const next = [...preview.chapters]; next.splice(index, 1, { ...chapter, content: chapter.content.slice(0, cursor).trim() }, { ...chapter, title: `${chapter.title}（续）`, content: chapter.content.slice(cursor).trim() }); setPreview({ ...preview, chapters: next.map((item, position) => ({ ...item, position })) }) }
  const deduplicate = async () => {
    setCleaning(true); setNotice('正在检查已导入章节的空白与重复正文…')
    try {
      const result = await post<{ removed: number; empty: number; duplicates: number }>(`/api/projects/${projectId}/chapters/deduplicate`, {})
      setNotice(result.removed ? `清理完成：移除 ${result.empty} 个空章节、${result.duplicates} 个重复章节。手写草稿未改动。` : '检查完成，没有发现需要清理的已导入章节。')
      await Promise.all([load(), reloadProjects()])
    } catch (caught) { setNotice(`清理失败：${(caught as Error).message}`) } finally { setCleaning(false) }
  }

  const metrics = project?.metrics
  const progress = metrics ? Math.min(Math.round(metrics.characters / Math.max(project.word_goal, 1) * 100), 100) : 0
  const downloadManuscript = (format: string) => { window.location.href = `/api/projects/${projectId}/export/manuscript?format=${format}` }
  return <div className="dashboard-page">
    <section className="project-brief">
      <div><div className="eyebrow"><Badge tone="teal">{project?.status === 'completed' ? '已完结' : '创作中'}</Badge><span>{project?.genre || '未设置题材'}</span></div><h2>{project?.name}</h2><p>{project?.premise || '还没有写下故事的核心命题。'}</p></div>
      <div className="project-progress"><div className="progress-label"><span>全书进度</span><strong>{progress}%</strong></div><div className="progress-track"><i style={{ width: `${progress}%` }} /></div><small>{(metrics?.characters ?? 0).toLocaleString()} / {project?.word_goal.toLocaleString()} 字符</small></div>
    </section>

    {notice && <div className="notice-bar">{importing || cleaning ? <Loader2 className="spin" size={17} /> : <Lightbulb size={17} />}<span>{notice}</span></div>}

    <section className="metric-grid">
      <Metric icon={<BookOpen />} value={metrics?.chapters ?? 0} label="章节" detail={`${chapters.filter((row) => row.status === 'draft').length} 篇草稿`} />
      <Metric icon={<Boxes />} value={metrics?.entities ?? 0} label="设定条目" detail="人物、地点与体系" />
      <Metric icon={<GitBranch />} value={metrics?.events ?? 0} label="剧情事件" detail={`${metrics?.open_foreshadowing ?? 0} 个伏笔待回收`} />
      <Metric icon={<ShieldAlert />} value={metrics?.open_reviews ?? 0} label="待处理审查" detail="连续性与正史状态" tone={(metrics?.open_reviews ?? 0) > 0 ? 'warn' : ''} />
    </section>

    {stats && <section className="surface stats-band"><header><div><h3>写作统计</h3><p>生成采纳率是本工具的核心质量信号；Token 校准随 API 使用逐步积累。</p></div></header>
      <div className="stats-grid">
        <StatCard value={stats.generations.total.toLocaleString()} label="生成次数" detail={`采纳 ${stats.generations.appended} · 丢弃 ${stats.generations.discarded}`} />
        <StatCard value={stats.generations.acceptanceRate === null ? '待数据' : `${stats.generations.acceptanceRate}%`} label="生成采纳率" detail="被追加进正文的生成占比" />
        <StatCard value={stats.reviews.resolutionRate === null ? '—' : `${stats.reviews.resolutionRate}%`} label="审查解决率" detail={`${stats.reviews.resolved} 已解决 / ${stats.reviews.open} 待处理`} />
        <StatCard value={stats.historyVersions.toLocaleString()} label="历史版本" detail="正文变更自动留档" />
        <StatCard value={stats.tokenCalibration ? `×${stats.tokenCalibration.avgRatio}` : '待数据'} label="Token 校准系数" detail={stats.tokenCalibration ? `真实/估算，${stats.tokenCalibration.samples} 个样本` : '配置模型并生成后积累'} />
      </div>
    </section>}

    <div className="dashboard-columns">
      <section className="surface recent-work"><header><div><h3>继续创作</h3><p>最近编辑的章节</p></div><Button variant="ghost" onClick={() => navigate('/write')}>查看全部 <ArrowRight size={15} /></Button></header>
        <div className="chapter-list-compact">{chapters.slice(-4).reverse().map((chapter) => <button key={chapter.id} onClick={() => { sessionStorage.setItem('novelweaver.chapter', chapter.id); navigate('/write') }}><span className="chapter-index">{String(chapter.position + 1).padStart(2, '0')}</span><div><strong>{chapter.title}</strong><p>{chapter.summary || '暂无摘要'}</p></div><Badge tone={chapter.status === 'revised' ? 'teal' : 'neutral'}>{chapter.status === 'revised' ? '已修订' : chapter.status === 'imported' ? '已导入' : '草稿'}</Badge></button>)}</div>
      </section>

      <section className="surface today-plan"><header><div><h3>建议下一步</h3><p>根据项目状态生成</p></div><Sparkles size={18} /></header>
        <div className="next-actions">
          <Action icon={<Plus />} title="完善下一章细纲" text="先确定场景目标、信息增量和结尾钩子" onClick={() => navigate('/write')} />
          <Action icon={<ListChecks />} title="审阅事实摘要" text="确认候选事实并保留原文来源" onClick={() => navigate('/memory')} />
          <Action icon={<ShieldAlert />} title="运行连续性检查" text="确认角色知识、事件时间和未回收伏笔" onClick={() => navigate('/review')} />
        </div>
      </section>
    </div>

    <section className="surface import-zone"><div className="import-icon"><FileUp size={24} /></div><div><h3>导入与文稿分析</h3><p>先预览并调整章节边界，再写入项目；确认后分析任务会在后台运行。</p></div><input ref={fileRef} type="file" accept=".txt,.md,.markdown,.docx,.epub,.pdf" hidden onChange={(event) => previewFile(event.target.files?.[0])} /><Button variant="secondary" onClick={deduplicate} disabled={cleaning || importing}>{cleaning ? <Loader2 className="spin" size={15} /> : <ListRestart size={15} />} {cleaning ? '检查中…' : '清理重复章节'}</Button><Button variant="secondary" onClick={() => navigate('/analysis')}><RefreshCw size={15} /> 分析中心</Button>{project?.imported ? <Button variant="secondary" onClick={() => { replaceRef.current = true; fileRef.current?.click() }} disabled={importing || cleaning}>替换导入</Button> : null}<Button variant="secondary" onClick={() => { replaceRef.current = false; fileRef.current?.click() }} disabled={importing || cleaning}>{importing ? '正在解析…' : '追加文稿'}</Button></section>

    <section className="surface import-zone export-zone"><div className="import-icon"><Download size={24} /></div><div><h3>导出稿件</h3><p>按卷与章节顺序导出正文；JSON 备份包含全部设定、剧情与记忆数据。</p></div><Button variant="secondary" onClick={() => downloadManuscript('txt')}>TXT</Button><Button variant="secondary" onClick={() => downloadManuscript('md')}>Markdown</Button><Button variant="secondary" onClick={() => downloadManuscript('docx')}>Word（DOCX）</Button><Button variant="secondary" onClick={() => downloadManuscript('epub')}>EPUB</Button><Button variant="secondary" onClick={() => { window.location.href = `/api/projects/${projectId}/export` }}>JSON 备份</Button></section>
    {preview && <Modal title={`导入预览 · ${preview.filename}`} onClose={() => { setPreview(null); replaceRef.current = false }} footer={<><span className="preview-total">{preview.chapters.length} 章 · {preview.chapters.reduce((sum, chapter) => sum + chapter.content.length, 0).toLocaleString()} 字符</span><Button variant="ghost" onClick={() => { setPreview(null); replaceRef.current = false }}>取消</Button><Button onClick={commitPreview} disabled={importing || !preview.chapters.length}>{importing ? <Loader2 className="spin" size={15} /> : <FileUp size={15} />} 确认导入</Button></>}><div className="import-preview-list">{preview.diagnostics.warnings.length > 0 && <p className="preview-warning">{preview.diagnostics.warnings.join('')}</p>}{preview.chapters.map((chapter, index) => <article key={`${index}-${chapter.position}`}><header><span>{String(index + 1).padStart(2, '0')}</span><Input value={chapter.title} onChange={(event) => updatePreviewChapter(index, { title: event.target.value })} /><div>{index > 0 && <Button variant="ghost" title="并入上一章" onClick={() => mergePreviewChapter(index)}>合并</Button>}<Button variant="ghost" title="在光标处拆分" onClick={() => splitPreviewChapter(index)}><Scissors size={14} /></Button><Button variant="ghost" title="移除此章" onClick={() => removePreviewChapter(index)}><Trash2 size={14} /></Button></div></header><Textarea rows={6} value={chapter.content} onSelect={(event) => setSplitCursors({ ...splitCursors, [index]: event.currentTarget.selectionStart })} onChange={(event) => updatePreviewChapter(index, { content: event.target.value })} /></article>)}</div></Modal>}
  </div>
}

function Metric({ icon, value, label, detail, tone = '' }: { icon: React.ReactNode; value: number; label: string; detail: string; tone?: string }) {
  return <div className={`metric-card ${tone}`}><div className="metric-icon">{icon}</div><div><strong>{value.toLocaleString()}</strong><span>{label}</span><p>{detail}</p></div></div>
}

function StatCard({ value, label, detail }: { value: string; label: string; detail: string }) {
  return <div className="stat-card"><strong>{value}</strong><span>{label}</span><p>{detail}</p></div>
}

function Action({ icon, title, text, onClick }: { icon: React.ReactNode; title: string; text: string; onClick: () => void }) {
  return <button onClick={onClick}><span>{icon}</span><div><strong>{title}</strong><p>{text}</p></div><ArrowRight size={16} /></button>
}
