import { useEffect, useMemo, useState } from 'react'
import { Bookmark, BookmarkCheck, BookOpen, Check, ChevronDown, ChevronRight, Eye, FilePlus2, Filter, FolderPlus, ListTree, Loader2, PanelRightClose, Pencil, Pin, PinOff, Save, Sparkles, Target, Trash2, WandSparkles } from 'lucide-react'
import { api, patch, post, remove } from '../api'
import { useProject } from '../project-context'
import type { Chapter, ContextReport, GenerationResult, Volume } from '../types'
import { Badge, Button, EmptyState, Field, IconButton, Input, MarkdownLike, Modal, Textarea } from '../components/ui'

export function WritingStudio() {
  const { projectId } = useProject()
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [volumes, setVolumes] = useState<Volume[]>([])
  const [selectedId, setSelectedId] = useState(sessionStorage.getItem('novelweaver.chapter') || '')
  const [draft, setDraft] = useState<Chapter | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [panelOpen, setPanelOpen] = useState(() => localStorage.getItem('novelweaver.agent.open') !== '0' && window.innerWidth > 640)
  const [panelPinned, setPanelPinned] = useState(() => localStorage.getItem('novelweaver.agent.pinned') !== '0' && window.innerWidth > 860)
  const [prompt, setPrompt] = useState('根据当前细纲，生成下一场景；保持视角和既有设定，不新增未经确认的能力。')
  const [task, setTask] = useState<'chapter_outline' | 'prose'>('chapter_outline')
  const [generating, setGenerating] = useState(false)
  const [result, setResult] = useState<GenerationResult | null>(null)
  const [bookmarkedOnly, setBookmarkedOnly] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [volumeOpen, setVolumeOpen] = useState(false)
  const [volumeForm, setVolumeForm] = useState({ title: '', summary: '' })
  const [editingVolume, setEditingVolume] = useState<Volume | null>(null)
  const [collapsedVolumes, setCollapsedVolumes] = useState<Set<string>>(new Set())
  const [contextReport, setContextReport] = useState<ContextReport | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [workshopStage, setWorkshopStage] = useState('scan')
  const [outlineExpanded, setOutlineExpanded] = useState(true)
  const [outlineEditing, setOutlineEditing] = useState(false)

  const load = async (preferredId = selectedId) => {
    const [rows, volumeRows] = await Promise.all([api<Chapter[]>(`/api/projects/${projectId}/chapters`), api<Volume[]>(`/api/projects/${projectId}/volumes`)])
    setVolumes(volumeRows)
    setChapters(rows)
    const id = rows.some((row) => row.id === preferredId) ? preferredId : rows[0]?.id || ''
    setSelectedId(id); setDraft(rows.find((row) => row.id === id) || null)
  }
  useEffect(() => { load() }, [projectId])
  useEffect(() => { const row = chapters.find((item) => item.id === selectedId); if (row) { setDraft(row); setOutlineEditing(false); sessionStorage.setItem('novelweaver.chapter', row.id) } }, [selectedId])
  useEffect(() => { localStorage.setItem('novelweaver.agent.open', panelOpen ? '1' : '0') }, [panelOpen])
  useEffect(() => { localStorage.setItem('novelweaver.agent.pinned', panelPinned ? '1' : '0') }, [panelPinned])
  useEffect(() => { setContextReport(null) }, [prompt, task, draft?.id])

  const wordCount = useMemo(() => draft?.content.replace(/\s/g, '').length ?? 0, [draft?.content])
  const visibleChapters = useMemo(() => bookmarkedOnly ? chapters.filter((chapter) => Boolean(chapter.bookmarked)) : chapters, [chapters, bookmarkedOnly])
  const volumeGroups = useMemo(() => volumes.map((volume) => ({ volume, chapters: visibleChapters.filter((chapter) => chapter.volume_id === volume.id).sort((a, b) => (a.volume_order_index ?? a.position) - (b.volume_order_index ?? b.position)) })), [volumes, visibleChapters])
  const save = async () => {
    if (!draft) return
    setSaving(true); setSaved(false)
    const next = await patch<Chapter>(`/api/chapters/${draft.id}`, { title: draft.title, content: draft.content, summary: draft.summary, pov: draft.pov, status: draft.status, targetWords: draft.target_words })
    setChapters((rows) => rows.map((row) => row.id === next.id ? next : row)); setDraft(next); setSaving(false); setSaved(true)
    window.setTimeout(() => setSaved(false), 1800)
  }
  const saveDetailedOutline = async () => {
    if (!draft) return
    const next = await patch<Chapter>(`/api/chapters/${draft.id}/outline`, { content: draft.detailed_outline, status: 'active' })
    setChapters((rows) => rows.map((row) => row.id === next.id ? next : row)); setDraft(next); setOutlineEditing(false)
  }
  const addChapter = async () => {
    const row = await post<Chapter>(`/api/projects/${projectId}/chapters`, { title: '未命名章节', content: '', pov: '', targetWords: 3000, afterChapterId: draft?.id || null })
    await load(row.id)
  }
  const addVolume = async () => {
    const volume = await post<Volume>(`/api/projects/${projectId}/volumes`, volumeForm)
    setVolumes((rows) => [...rows, volume]); setVolumeForm({ title: '', summary: '' }); setVolumeOpen(false)
  }
  const saveVolume = async () => {
    if (!editingVolume) return
    const next = await patch<Volume>(`/api/volumes/${editingVolume.id}`, { title: editingVolume.title, summary: editingVolume.summary })
    setVolumes((rows) => rows.map((row) => row.id === next.id ? { ...row, ...next } : row)); setEditingVolume(null)
  }
  const deleteVolume = async () => {
    if (!editingVolume) return
    await remove(`/api/volumes/${editingVolume.id}`); setEditingVolume(null); await load(draft?.id)
  }
  const moveChapter = async (volumeId: string) => {
    if (!draft) return
    const next = await patch<Chapter>(`/api/chapters/${draft.id}/volume`, { volumeId })
    setChapters((rows) => rows.map((row) => row.id === next.id ? next : row)); setDraft(next)
  }
  const updateMark = async (values: { bookmarked?: boolean; importance?: Chapter['importance']; note?: string }) => {
    if (!draft) return
    const next = await patch<Chapter>(`/api/chapters/${draft.id}/mark`, values)
    setChapters((rows) => rows.map((row) => row.id === next.id ? { ...row, bookmarked: next.bookmarked, importance: next.importance, mark_note: next.mark_note } : row))
    setDraft((current) => current?.id === next.id ? { ...current, bookmarked: next.bookmarked, importance: next.importance, mark_note: next.mark_note } : current)
  }
  const deleteChapter = async () => {
    if (!draft) return
    const index = chapters.findIndex((chapter) => chapter.id === draft.id)
    const fallbackId = chapters[index + 1]?.id || chapters[index - 1]?.id || ''
    await remove(`/api/chapters/${draft.id}`); setDeleteOpen(false); await load(fallbackId)
  }
  const generate = async () => {
    if (!draft) return
    setGenerating(true)
    try { setResult(await post<GenerationResult>('/api/ai/generate', { projectId, chapterId: draft.id, task, prompt })) } finally { setGenerating(false) }
  }
  const previewContext = async () => {
    if (!draft) return
    setPreviewing(true)
    try { const response = await post<{ report: ContextReport }>('/api/ai/context', { projectId, chapterId: draft.id, prompt, tokenBudget: 10000 }); setContextReport(response.report) } finally { setPreviewing(false) }
  }
  const workshopPrompts: Record<string, string> = {
    scan: '扫描当前章节前的故事状态，列出本章必须承接的事实、未解决承诺和角色知识边界。',
    motivation: '分析本章出场角色的外在目标、内在需求、隐瞒信息与可接受代价。',
    conflict: '让角色目标发生正面碰撞，设计逐级升级且由既有因果驱动的冲突。',
    scenes: '把本章拆成场景序列，每场写清目标、阻力、信息增量、转折与出场状态。',
    check: '检查细纲中的持有物、角色知识、时间地点、力量规则和正史事实冲突，并给出一次修订建议。',
  }
  const chooseStage = (stage: string) => { setWorkshopStage(stage); setPrompt(workshopPrompts[stage]) }
  const appendResult = () => {
    if (!draft || !result) return
    setDraft({ ...draft, content: `${draft.content}${draft.content ? '\n\n' : ''}${result.output.replace(/^#.*\n/, '')}` })
  }

  if (!chapters.length) return <EmptyState icon={<BookOpen />} title="还没有章节" text="创建第一章后即可开始写作。" action={<Button onClick={addChapter}>创建第一章</Button>} />
  return <div className={`writing-layout ${panelOpen ? 'ai-open' : 'ai-closed'} ${panelPinned ? 'ai-pinned' : 'ai-floating'}`}>
    <aside className="chapter-rail">
      <header><div><strong>卷与章节</strong><span>{bookmarkedOnly ? `${visibleChapters.length}/${chapters.length}` : chapters.length}</span></div><IconButton label="新建卷" onClick={() => setVolumeOpen(true)}><FolderPlus size={16} /></IconButton><IconButton label={bookmarkedOnly ? '显示全部章节' : '仅看书签'} className={bookmarkedOnly ? 'active' : ''} onClick={() => setBookmarkedOnly((value) => !value)}><Filter size={16} /></IconButton><IconButton label={draft ? '在当前章后新建' : '新建章节'} onClick={addChapter}><FilePlus2 size={17} /></IconButton></header>
      <div className="chapter-rail-list volume-tree">{volumeGroups.map(({ volume, chapters: volumeChapters }) => <section key={volume.id} className="volume-group"><div className="volume-row"><button onClick={() => setCollapsedVolumes((current) => { const next = new Set(current); next.has(volume.id) ? next.delete(volume.id) : next.add(volume.id); return next })}>{collapsedVolumes.has(volume.id) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}<div><strong>{volume.title}</strong><small>{volumeChapters.length} 章 · {Number(volume.character_count || 0).toLocaleString()} 字</small></div></button><IconButton label={`编辑${volume.title}`} onClick={() => setEditingVolume({ ...volume })}><Pencil size={13} /></IconButton></div>{!collapsedVolumes.has(volume.id) && volumeChapters.map((chapter) => <button key={chapter.id} className={`${chapter.id === selectedId ? 'active' : ''} importance-${chapter.importance}`} onClick={() => setSelectedId(chapter.id)}><span>{String(chapter.position + 1).padStart(2, '0')}</span><div><strong>{chapter.bookmarked ? <BookmarkCheck size={11} /> : null}{chapter.title}</strong><small>{chapter.content.replace(/\s/g, '').length.toLocaleString()} 字 · {chapter.pov || '未定视角'}{chapter.importance !== 'normal' ? ` · ${chapter.importance === 'critical' ? '关键' : '重要'}` : ''}</small></div><ChevronRight size={15} /></button>)}</section>)}</div>
    </aside>
    <section className="editor-pane">
      {draft && <>
        <header className="editor-toolbar"><div className="crumb">正文 <ChevronRight size={14} /> <span>{draft.title}</span></div><div className="editor-actions"><Badge tone={draft.status === 'revised' ? 'teal' : 'neutral'}>{draft.status === 'revised' ? '已修订' : '草稿'}</Badge><span className="save-state">{saved && <><Check size={14} /> 已保存</>}</span><IconButton label={draft.bookmarked ? '取消书签' : '添加书签'} className={draft.bookmarked ? 'active' : ''} onClick={() => updateMark({ bookmarked: !draft.bookmarked })}>{draft.bookmarked ? <BookmarkCheck size={17} /> : <Bookmark size={17} />}</IconButton><Button variant="secondary" onClick={save} disabled={saving}>{saving ? <Loader2 className="spin" size={15} /> : <Save size={15} />} 保存</Button><IconButton label="删除当前章节" className="danger-icon" onClick={() => setDeleteOpen(true)}><Trash2 size={17} /></IconButton></div></header>
        <div className="editor-meta"><Input className="chapter-title-input" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /><div className="chapter-facts"><label><span>所属卷</span><select className="input" value={draft.volume_id || ''} onChange={(event) => moveChapter(event.target.value)}>{volumes.map((volume) => <option key={volume.id} value={volume.id}>{volume.title}</option>)}</select></label><label><span>视角</span><Input value={draft.pov} onChange={(event) => setDraft({ ...draft, pov: event.target.value })} placeholder="未指定" /></label><label><span>目标</span><div><Target size={14} /><Input type="number" value={draft.target_words} onChange={(event) => setDraft({ ...draft, target_words: Number(event.target.value) })} /></div></label><label><span>重要性</span><select className="input importance-select" value={draft.importance} onChange={(event) => updateMark({ importance: event.target.value as Chapter['importance'] })}><option value="normal">普通</option><option value="important">重要</option><option value="critical">关键</option></select></label><span>{wordCount.toLocaleString()} 字</span></div><Textarea className="summary-input" value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} placeholder="用一两句话记录本章的信息增量和状态变化……" rows={2} /></div>
        {draft.detailed_outline && <section className={`chapter-outline ${outlineExpanded ? 'expanded' : ''}`}><header><button onClick={() => setOutlineExpanded((value) => !value)}>{outlineExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}<ListTree size={15} /><strong>本章细纲</strong><Badge tone="teal">由全书大纲拆分</Badge></button>{outlineExpanded && <Button variant="ghost" onClick={() => setOutlineEditing((value) => !value)}><Pencil size={13} /> {outlineEditing ? '预览' : '编辑'}</Button>}</header>{outlineExpanded && <div>{outlineEditing ? <><Textarea rows={16} value={draft.detailed_outline} onChange={(event) => setDraft({ ...draft, detailed_outline: event.target.value })} /><Button onClick={saveDetailedOutline}><Save size={14} /> 保存细纲</Button></> : <MarkdownLike text={draft.detailed_outline} />}</div>}</section>}
        <Textarea className="manuscript-editor" value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} placeholder="从一个正在发生的动作开始……" spellCheck={false} />
        <footer className="editor-footer"><span>目标完成度 {Math.min(Math.round(wordCount / draft.target_words * 100), 100)}%</span><div className="mini-progress"><i style={{ width: `${Math.min(wordCount / draft.target_words * 100, 100)}%` }} /></div><span>自动保存已开启</span></footer>
      </>}
    </section>
    {panelOpen ? <aside className="ai-panel"><header><div><WandSparkles size={18} /><div><strong>创作 Agent</strong><span>{panelPinned ? '已固定在写作区' : '悬浮面板'}</span></div></div><span className="agent-panel-actions"><IconButton label={panelPinned ? '取消固定助手' : '固定助手'} onClick={() => setPanelPinned((value) => !value)}>{panelPinned ? <Pin size={17} /> : <PinOff size={17} />}</IconButton><IconButton label="收起助手" onClick={() => setPanelOpen(false)}><PanelRightClose size={18} /></IconButton></span></header>
      <div className="agent-context"><span>上下文</span><Badge tone="teal">当前章节</Badge><Badge>人物状态</Badge><Badge>活跃剧情线</Badge><Badge>相关原文</Badge></div>
      <div className="agent-tabs"><button className={task === 'chapter_outline' ? 'active' : ''} onClick={() => setTask('chapter_outline')}>章节细纲</button><button className={task === 'prose' ? 'active' : ''} onClick={() => setTask('prose')}>正文草稿</button></div>
      {task === 'chapter_outline' && <div className="workshop-steps">{[['scan', '扫描'], ['motivation', '动机'], ['conflict', '冲突'], ['scenes', '场景'], ['check', '检查']].map(([value, label], index) => <button key={value} className={workshopStage === value ? 'active' : ''} onClick={() => chooseStage(value)}><span>{index + 1}</span>{label}</button>)}</div>}
      <div className="agent-compose"><Textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={5} /><div className="generation-gate"><Button variant="secondary" onClick={previewContext} disabled={previewing || !prompt.trim()}>{previewing ? <Loader2 className="spin" size={16} /> : <Eye size={16} />} {previewing ? '计算中…' : '预览生成依据'}</Button><Button onClick={generate} disabled={generating || !prompt.trim() || !contextReport}>{generating ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />} {generating ? '正在生成…' : '确认并生成'}</Button></div></div>
      {contextReport && <div className="context-preview"><header><strong>本次生成依据</strong><span>{contextReport.estimatedTokens.toLocaleString()} / {contextReport.tokenBudget.toLocaleString()} tokens</span></header><p>已纳入 {contextReport.included.length} 项；因预算裁剪 {contextReport.trimmed.length} 项。</p><div>{contextReport.included.slice(0, 8).map((item) => <span key={`${item.kind}-${item.label}`}>{item.label}</span>)}</div></div>}
      <div className="agent-result">{result ? <><div className="result-meta"><span>{result.model}</span><span>{result.citations.length} 条记忆证据</span></div><MarkdownLike text={result.output} /><Button variant="secondary" onClick={appendResult}>追加到正文</Button></> : <div className="agent-placeholder"><Sparkles size={22} /><p>生成结果会出现在这里。所有新增事实仍需在审查台确认。</p></div>}</div>
    </aside> : <button className="open-ai-panel" onClick={() => setPanelOpen(true)} title="打开创作 Agent"><Sparkles size={19} /></button>}
    {deleteOpen && draft && <Modal title="删除章节" onClose={() => setDeleteOpen(false)} footer={<><Button variant="ghost" onClick={() => setDeleteOpen(false)}>取消</Button><Button variant="danger" onClick={deleteChapter}><Trash2 size={15} /> 确认删除</Button></>}><div className="delete-confirm"><Trash2 size={24} /><p>将永久删除“<strong>{draft.title}</strong>”及其章节记忆和关联事件。其余章节会自动重新排序。</p></div></Modal>}
    {volumeOpen && <Modal title="新建分卷" onClose={() => setVolumeOpen(false)} footer={<><Button variant="ghost" onClick={() => setVolumeOpen(false)}>取消</Button><Button onClick={addVolume} disabled={!volumeForm.title.trim()}>创建分卷</Button></>}><div className="form-grid"><Field label="卷名"><Input autoFocus value={volumeForm.title} onChange={(event) => setVolumeForm({ ...volumeForm, title: event.target.value })} placeholder="例如：第一卷 雾港来信" /></Field><Field label="卷摘要"><Textarea rows={5} value={volumeForm.summary} onChange={(event) => setVolumeForm({ ...volumeForm, summary: event.target.value })} placeholder="记录本卷核心目标、状态变化与卷末落点" /></Field></div></Modal>}
    {editingVolume && <Modal title="编辑分卷" onClose={() => setEditingVolume(null)} footer={<>{volumes.length > 1 && <Button variant="danger" onClick={deleteVolume}><Trash2 size={14} /> 删除分卷</Button>}<Button variant="ghost" onClick={() => setEditingVolume(null)}>取消</Button><Button onClick={saveVolume} disabled={!editingVolume.title.trim()}>保存</Button></>}><div className="form-grid"><Field label="卷名"><Input value={editingVolume.title} onChange={(event) => setEditingVolume({ ...editingVolume, title: event.target.value })} /></Field><Field label="卷摘要"><Textarea rows={6} value={editingVolume.summary} onChange={(event) => setEditingVolume({ ...editingVolume, summary: event.target.value })} placeholder="卷摘要会优先进入本卷章节的生成上下文" /></Field></div></Modal>}
  </div>
}
