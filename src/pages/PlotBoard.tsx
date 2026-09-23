import { useEffect, useMemo, useState } from 'react'
import { BookOpenCheck, CalendarClock, Check, ChevronLeft, ChevronRight, CircleDot, Compass, Edit3, Flag, GitBranch, History, ListTree, Loader2, Plus, RefreshCw, Rows3, Save, Sparkles, Split, WandSparkles } from 'lucide-react'
import { api, patch, post } from '../api'
import { useProject } from '../project-context'
import type { Foreshadowing, GenerationResult, OutlineDecomposition, Plotline, StoryEvent, StoryOutline } from '../types'
import { Badge, Button, Field, Input, LoadingState, MarkdownLike, Modal, Textarea } from '../components/ui'

type PlotData = { plotlines: Plotline[]; events: StoryEvent[]; foreshadowing: Foreshadowing[] }
type StoryMode = 'single' | 'ensemble' | 'episodic' | 'shifting' | 'mosaic' | 'exploratory'

const storyModes: Array<{ value: StoryMode; label: string; text: string }> = [
  { value: 'single', label: '单核推进', text: '围绕一个相对稳定的目标或核心人物持续升级' },
  { value: 'ensemble', label: '群像交织', text: '多个角色各有目标，彼此行动共同改变局势' },
  { value: 'episodic', label: '单元串联', text: '每个单元相对独立，由固定场域、角色或主题连接' },
  { value: 'shifting', label: '主线转移', text: '关注中心会更替，旧目标的后果推动新目标接管' },
  { value: 'mosaic', label: '多中心拼图', text: '不同视角提供局部真相，整体意义逐渐显现' },
  { value: 'exploratory', label: '探索式结构', text: '暂不预设终点，以发现、变化与阶段性选择推进' },
]

const guideSteps = [
  { title: '选择故事形态', text: '先确定叙事如何持续运转，不要求一定存在唯一主线。' },
  { title: '建立叙事支点', text: '明确读者期待什么，以及什么能在目标变化后维持连续性。' },
  { title: '设计驱动力更替', text: '规划阶段目标如何产生、失效、转移或彼此接力。' },
  { title: '构建压力网络', text: '让人物、环境、制度和信息差共同制造变化。' },
  { title: '确定节奏与收束', text: '决定按卷、阶段或单元组织，以及开放或闭合到什么程度。' },
]

const initialGuide = {
  mode: 'shifting' as StoryMode,
  synopsis: '', focus: '', promise: '', continuity: '', shifts: '', rhythm: '', opposition: '', stakes: '', ending: '', constraints: '',
}

export function PlotBoard() {
  const { projectId, project } = useProject()
  const [data, setData] = useState<PlotData>({ plotlines: [], events: [], foreshadowing: [] })
  const [outlines, setOutlines] = useState<StoryOutline[]>([])
  const [selectedOutlineId, setSelectedOutlineId] = useState('')
  const [outlineDraft, setOutlineDraft] = useState('')
  const [outlineEditing, setOutlineEditing] = useState(false)
  const [outlineInstruction, setOutlineInstruction] = useState('')
  const [view, setView] = useState<'timeline' | 'lanes' | 'board'>('timeline')
  const [eventOpen, setEventOpen] = useState(false)
  const [plotOpen, setPlotOpen] = useState(false)
  const [eventForm, setEventForm] = useState({ title: '', summary: '', storyTime: '', plotlineId: '', location: '' })
  const [plotForm, setPlotForm] = useState({ name: '', type: 'main', summary: '' })
  const [generating, setGenerating] = useState(false)
  const [refining, setRefining] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [analysisNotice, setAnalysisNotice] = useState('')
  const [guideOpen, setGuideOpen] = useState(false)
  const [guideStep, setGuideStep] = useState(0)
  const [guideGenerating, setGuideGenerating] = useState(false)
  const [guideResult, setGuideResult] = useState<GenerationResult | null>(null)
  const [guide, setGuide] = useState(initialGuide)
  const [guideSuggestion, setGuideSuggestion] = useState('')
  const [guideNotes, setGuideNotes] = useState<Record<number, string>>({})
  const [decomposing, setDecomposing] = useState(false)
  const [applyingPlan, setApplyingPlan] = useState(false)
  const [decomposition, setDecomposition] = useState<OutlineDecomposition | null>(null)
  const [decompositionOpen, setDecompositionOpen] = useState(false)
  const [decompositionNotice, setDecompositionNotice] = useState('')

  const activeOutline = useMemo(() => outlines.find((item) => item.id === selectedOutlineId) || outlines[0], [outlines, selectedOutlineId])
  const mode = storyModes.find((item) => item.value === guide.mode) || storyModes[0]

  const load = async () => {
    const [plot, outlineRows] = await Promise.all([
      api<PlotData>(`/api/projects/${projectId}/plot`),
      api<StoryOutline[]>(`/api/projects/${projectId}/outlines`),
    ])
    setData(plot); setOutlines(outlineRows)
    const preferred = outlineRows.find((item) => item.status === 'current') || outlineRows[0]
    setSelectedOutlineId((current) => outlineRows.some((item) => item.id === current) ? current : preferred?.id || '')
  }

  useEffect(() => { load() }, [projectId])
  useEffect(() => { if (activeOutline) setOutlineDraft(activeOutline.content) }, [activeOutline?.id])

  const addEvent = async () => { await post(`/api/projects/${projectId}/events`, { ...eventForm, plotlineId: eventForm.plotlineId || null, participants: [], status: 'planned' }); setEventOpen(false); setEventForm({ title: '', summary: '', storyTime: '', plotlineId: '', location: '' }); load() }
  const addPlotline = async () => { await post(`/api/projects/${projectId}/plotlines`, plotForm); setPlotOpen(false); setPlotForm({ name: '', type: 'main', summary: '' }); load() }

  const storeOutline = async (result: GenerationResult, title: string, sourcePrompt: string, parentId?: string | null, status: StoryOutline['status'] = 'current') => {
    const saved = await post<StoryOutline>(`/api/projects/${projectId}/outlines`, { title, content: result.output, sourcePrompt, parentId, status })
    setOutlines((rows) => [saved, ...rows.map((item) => status === 'current' && item.status === 'current' ? { ...item, status: 'archived' as const } : item)])
    setSelectedOutlineId(saved.id); setOutlineDraft(saved.content); setOutlineEditing(false)
    return saved
  }

  const generateOutline = async () => {
    const premise = project?.premise?.trim()
    setGenerating(true)
    const prompt = `依据项目剧情梗概直接生成一份可以继续修改的全书大纲。\n\n剧情梗概：${premise || '项目尚未填写完整梗概，请结合现有项目资料形成合理候选。'}\n\n先判断适合的故事形态，不要默认唯一主角、固定主线或三幕式。输出必须包含：故事形态判断、核心读者承诺、叙事驱动力、按卷/阶段/单元展开的大纲、各阶段关注中心与状态变化、剧情线更替或汇流方式、关键人物/群体弧、伏笔与回收、结局方向、仍需作者决定的假设。内容要具体到可继续拆分章节。`
    try { await storeOutline(await post<GenerationResult>('/api/ai/generate', { projectId, task: 'outline', prompt }), '由项目梗概生成的全书大纲', prompt) } finally { setGenerating(false) }
  }

  const refineOutline = async () => {
    if (!activeOutline || !outlineInstruction.trim()) return
    setRefining(true)
    const prompt = `在保留有效内容的前提下，根据作者要求补全或修订现有大纲。不要只给建议，直接输出修订后的完整大纲。不得强行加入唯一主角或固定主线。\n\n【作者要求】\n${outlineInstruction}\n\n【当前大纲 v${activeOutline.version}】\n${outlineDraft}`
    try {
      await storeOutline(await post<GenerationResult>('/api/ai/generate', { projectId, task: 'outline', prompt }), `大纲修订：${outlineInstruction.slice(0, 28)}`, prompt, activeOutline.id, 'candidate')
      setOutlineInstruction('')
    } finally { setRefining(false) }
  }

  const saveOutline = async () => {
    if (!activeOutline || !outlineDraft.trim()) return
    const saved = await patch<StoryOutline>(`/api/outlines/${activeOutline.id}`, { content: outlineDraft })
    setOutlines((rows) => rows.map((item) => item.id === saved.id ? saved : item)); setOutlineEditing(false)
  }

  const makeCurrent = async () => {
    if (!activeOutline) return
    const saved = await patch<StoryOutline>(`/api/outlines/${activeOutline.id}`, { status: 'current' })
    setOutlines((rows) => rows.map((item) => item.id === saved.id ? saved : item.status === 'current' ? { ...item, status: 'archived' } : item))
  }

  const decomposeCurrentOutline = async () => {
    if (!activeOutline) return
    setDecomposing(true); setDecompositionNotice('')
    try {
      const response = await post<{ plan: OutlineDecomposition; elapsedMs: number }>(`/api/outlines/${activeOutline.id}/decompose`, {})
      setDecomposition(response.plan); setDecompositionOpen(true)
      setDecompositionNotice(`并行拆分完成，用时 ${(response.elapsedMs / 1000).toFixed(1)} 秒。写入前可检查全部剧情线和章节。`)
    } catch (caught) { setDecompositionNotice(`拆分失败：${(caught as Error).message}`) } finally { setDecomposing(false) }
  }

  const applyDecomposition = async () => {
    if (!activeOutline || !decomposition) return
    setApplyingPlan(true)
    try {
      const result = await post<{ plotlines: number; events: number; volumes: number; chapters: number; skippedChapters: number; removedStaleChapters: number; removedVolumes: number }>(`/api/outlines/${activeOutline.id}/apply-decomposition`, { plan: decomposition })
      setDecompositionOpen(false); await load()
      setDecompositionNotice(`已写入 ${result.plotlines} 条新剧情线、${result.events} 个事件、${result.volumes} 个分卷和 ${result.chapters} 章细纲${result.skippedChapters ? `；跳过 ${result.skippedChapters} 个已有章节，正文全部保留` : ''}${result.removedStaleChapters ? `；清理 ${result.removedStaleChapters} 个未写作的旧规划章节${result.removedVolumes ? `和 ${result.removedVolumes} 个空卷` : ''}` : ''}。`)
    } catch (caught) { setDecompositionNotice(`写入失败：${(caught as Error).message}`) } finally { setApplyingPlan(false) }
  }

  const analyzeManuscript = async () => {
    setAnalyzing(true); setAnalysisNotice('')
    try {
      const result = await post<{ entities: unknown[]; events: unknown[]; plotlines: unknown[]; relations: unknown[] }>(`/api/projects/${projectId}/analyze`, { replaceCandidates: true })
      await load(); setAnalysisNotice(`同步完成：生成 ${result.plotlines.length} 条剧情线、${result.events.length} 个事件；事实摘要已进入候选区。`)
    } catch (caught) { setAnalysisNotice(`同步失败：${(caught as Error).message}`) } finally { setAnalyzing(false) }
  }

  const openGuide = () => {
    setGuide((current) => ({ ...current, synopsis: current.synopsis || project?.premise || '' }))
    setGuideStep(0); setGuideSuggestion(''); setGuideResult(null); setGuideOpen(true)
  }

  const stepMaterial = () => {
    if (guideStep === 0) return `故事形态：${mode.label}\n梗概：${guide.synopsis}`
    if (guideStep === 1) return `关注中心：${guide.focus}\n读者承诺：${guide.promise}\n连续性支点：${guide.continuity}`
    if (guideStep === 2) return `驱动力更替：${guide.shifts}\n组织节奏：${guide.rhythm}`
    if (guideStep === 3) return `压力网络：${guide.opposition}\n代价与风险：${guide.stakes}`
    return `收束方向：${guide.ending}\n硬性约束：${guide.constraints}`
  }

  const autocompleteStep = async () => {
    setGuideGenerating(true); setGuideSuggestion('')
    const prompt = `你正在协助作者完成五步创作向导的第 ${guideStep + 1} 步“${guideSteps[guideStep].title}”。作品采用“${mode.label}”：${mode.text}。\n项目梗概：${guide.synopsis || project?.premise || '尚未确定'}\n当前填写：\n${stepMaterial()}\n\n请主动补全空白并把模糊表述改成可执行候选。给出 2-3 个有明显差异的选择，再明确推荐一项及理由。不要要求必须有唯一主角或始终不变的主线；不要只提出问题。输出只聚焦本步。`
    try { setGuideSuggestion((await post<GenerationResult>('/api/ai/generate', { projectId, task: 'plot', prompt })).output) } finally { setGuideGenerating(false) }
  }

  const generateGuide = async () => {
    setGuideGenerating(true); setGuideResult(null)
    const notes = Object.entries(guideNotes).map(([index, text]) => `第 ${Number(index) + 1} 步补充：${text}`).join('\n')
    const prompt = `把以下五步构思整理成具体、可编辑、可继续扩展的故事方案。故事形态为“${mode.label}”，不得套用唯一主角或固定主线。必须输出：叙事引擎、阶段/卷/单元结构、每阶段关注中心、驱动力更替规则、关键事件候选、人物或群体状态变化、伏笔承诺、收束方式、风险检查、需要作者确认的假设。信息不足处主动给出合理候选并标记为假设。\n\n梗概：${guide.synopsis}\n关注中心：${guide.focus}\n读者承诺：${guide.promise}\n连续性支点：${guide.continuity}\n驱动力更替：${guide.shifts}\n节奏组织：${guide.rhythm}\n压力网络：${guide.opposition}\n代价与风险：${guide.stakes}\n收束方向：${guide.ending}\n硬性约束：${guide.constraints}\n${notes}`
    try { setGuideResult(await post<GenerationResult>('/api/ai/generate', { projectId, task: 'outline', prompt })) } finally { setGuideGenerating(false) }
  }

  const adoptGuide = async () => {
    if (!guideResult) return
    await storeOutline(guideResult, `${mode.label}创作方案`, '五步创作向导', null, 'current')
    setGuideOpen(false)
  }

  const typeLabel = (type: string) => ({ main: '主线', subplot: '支线', character: '人物弧', mystery: '谜团', romance: '感情线', framework: '叙事框架' }[type] || type)

  return <div className="plot-page">
    <section className="plotline-strip"><div className="section-heading"><div><h2>剧情线</h2><p>主线、支线、阶段目标与人物弧可以并存和更替</p></div><div className="section-actions"><Button variant="secondary" onClick={openGuide}><Compass size={15} /> 分步创作向导</Button><Button variant="secondary" onClick={analyzeManuscript} disabled={analyzing}>{analyzing ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />} {analyzing ? '正在同步…' : '从文稿同步'}</Button><Button variant="secondary" onClick={() => setPlotOpen(true)}><Plus size={15} /> 新建剧情线</Button></div></div>{analyzing && <LoadingState label="正在分批提取事件、剧情线与事实摘要" />}{analysisNotice && <p className="analysis-notice">{analysisNotice}</p>}<div className="plotline-cards">{data.plotlines.map((plot) => <article key={plot.id} style={{ '--plot-color': plot.color } as React.CSSProperties}><div><GitBranch size={17} /><Badge tone={plot.status === 'candidate' ? 'amber' : 'neutral'}>{plot.status === 'candidate' ? '候选' : typeLabel(plot.type)}</Badge></div><h3>{plot.name}</h3><p>{plot.summary}</p><span>{data.events.filter((event) => event.plotline_id === plot.id).length} 个事件</span></article>)}</div></section>

    <section className="surface outline-workbench">
      <header><div><BookOpenCheck size={18} /><div><h2>全书大纲</h2><p>{activeOutline ? `已保存 ${outlines.length} 个版本，可继续补全或回退` : '可以直接从项目剧情梗概生成，不要求先建立剧情线'}</p></div></div><div>{activeOutline && <select className="input outline-version" value={activeOutline.id} onChange={(event) => setSelectedOutlineId(event.target.value)}>{outlines.map((item) => <option key={item.id} value={item.id}>v{item.version} · {item.title}{item.status === 'current' ? '（当前）' : item.status === 'candidate' ? '（候选）' : ''}</option>)}</select>}{activeOutline && <Button variant="secondary" onClick={() => setOutlineEditing((value) => !value)}><Edit3 size={14} /> {outlineEditing ? '预览' : '编辑'}</Button>}<Button onClick={generateOutline} disabled={generating}>{generating ? <Loader2 className="spin" size={15} /> : <Sparkles size={15} />} {activeOutline ? '从梗概重建' : '从梗概生成大纲'}</Button></div></header>
      {generating && <LoadingState label="正在判断故事形态并搭建完整大纲" />}
      {activeOutline ? <div className="outline-workspace"><div className="outline-document">{outlineEditing ? <><Textarea rows={24} value={outlineDraft} onChange={(event) => setOutlineDraft(event.target.value)} /><Button onClick={saveOutline} disabled={outlineDraft === activeOutline.content}><Save size={14} /> 保存本版</Button></> : <MarkdownLike text={outlineDraft} />}</div><aside><div className="outline-status"><Badge tone={activeOutline.status === 'current' ? 'teal' : activeOutline.status === 'candidate' ? 'amber' : 'neutral'}>{activeOutline.status === 'current' ? '当前采用' : activeOutline.status === 'candidate' ? '候选版本' : '历史版本'}</Badge><span>版本 v{activeOutline.version}</span></div>{activeOutline.status !== 'current' && <Button variant="secondary" onClick={makeCurrent}><Check size={14} /> 设为当前版</Button>}<Field label="继续完善这一版" hint="例如：拆成四卷；强化第二阶段群像冲突；保留开放结局"><Textarea rows={7} value={outlineInstruction} onChange={(event) => setOutlineInstruction(event.target.value)} placeholder="描述要补全、扩写、替换或检查的内容……" /></Field><Button onClick={refineOutline} disabled={refining || !outlineInstruction.trim()}>{refining ? <Loader2 className="spin" size={14} /> : <WandSparkles size={14} />} {refining ? '正在修订…' : '生成修订版本'}</Button><div className="outline-next-step"><strong>下一步：拆成可写结构</strong><p>并行生成剧情线、分卷、章节和逐章细纲，确认后再写入。</p><Button variant="secondary" onClick={decomposeCurrentOutline} disabled={decomposing}>{decomposing ? <Loader2 className="spin" size={14} /> : <Split size={14} />} {decomposing ? '正在并行拆分…' : '拆分剧情线与细纲'}</Button></div><div className="version-note"><History size={14} /><p>每次 AI 修订都会创建新版本，不覆盖原稿。确认后再设为当前版。</p></div></aside></div> : !generating && <div className="outline-empty"><div><strong>梗概已经足够作为第一步</strong><p>{project?.premise || '先在项目设置中填写剧情梗概，系统也可以根据现有资料提出候选。'}</p></div><Button onClick={generateOutline}><Sparkles size={15} /> 生成第一版</Button></div>}
      {decompositionNotice && <p className="decomposition-notice">{decompositionNotice}</p>}
    </section>

    <div className="plot-toolbar"><div className="segmented"><button className={view === 'timeline' ? 'active' : ''} onClick={() => setView('timeline')}><CalendarClock size={15} /> 时间轴</button><button className={view === 'lanes' ? 'active' : ''} onClick={() => setView('lanes')}><Rows3 size={15} /> 多轨线</button><button className={view === 'board' ? 'active' : ''} onClick={() => setView('board')}><CircleDot size={15} /> 状态看板</button></div><div><Button variant="secondary" onClick={() => setEventOpen(true)}><Plus size={15} /> 添加事件</Button></div></div>
    <div className="plot-content-grid">
      <section className="surface event-surface">{view === 'timeline' ? <div className="timeline">{data.events.map((event, index) => { const plot = data.plotlines.find((item) => item.id === event.plotline_id); return <article key={event.id}><div className="timeline-axis"><span>{index + 1}</span><i /></div><div className="event-card"><header><div><Badge tone={event.status === 'written' ? 'teal' : 'amber'}>{event.status === 'written' ? '已写' : '计划'}</Badge>{plot && <span className="plot-tag" style={{ color: plot.color }}>{plot.name}</span>}</div><time>{event.story_time || '时间待定'}</time></header><h3>{event.title}</h3><p>{event.summary || '暂无事件摘要。'}</p><footer>{event.location && <span>{event.location}</span>}<span>{event.participants.length} 名参与者</span></footer></div></article> })}</div> : view === 'lanes' ? <div className="plot-lanes">{[...data.plotlines, { id: '', name: '未归线事件', type: 'subplot', summary: '', color: '#89918f', status: 'active' }].map((plotline) => { const events = data.events.filter((event) => (event.plotline_id || '') === plotline.id); if (!events.length) return null; return <section key={plotline.id || 'unassigned'}><header style={{ borderColor: plotline.color }}><strong>{plotline.name}</strong><span>{events.length} 个节点</span></header><div>{events.map((event) => <article key={event.id}><i style={{ background: plotline.color }} /><time>{event.story_time || `#${event.narrative_order}`}</time><strong>{event.title}</strong><p>{event.summary}</p><small>{event.participants.join('、') || '参与者待定'}</small></article>)}</div></section> })}</div> : <div className="event-board">{['planned', 'written', 'revealed'].map((status) => <div key={status}><header>{status === 'planned' ? '计划中' : status === 'written' ? '已写入' : '已揭示'} <span>{data.events.filter((event) => event.status === status).length}</span></header>{data.events.filter((event) => event.status === status).map((event) => <article key={event.id}><strong>{event.title}</strong><p>{event.summary}</p></article>)}</div>)}</div>}</section>
      <aside className="plot-side"><section className="surface foreshadow-panel"><header><div><Flag size={17} /><h3>伏笔与承诺</h3></div><Badge tone="amber">{data.foreshadowing.filter((item) => item.status !== 'resolved').length} 待回收</Badge></header>{data.foreshadowing.map((item) => <article key={item.id}><div><span className={`foreshadow-status ${item.status}`} /><strong>{item.title}</strong></div><p>{item.notes}</p><small>{item.status === 'developing' ? '正在强化' : item.status === 'resolved' ? '已回收' : '等待回收'}</small></article>)}</section></aside>
    </div>

    {eventOpen && <Modal title="添加剧情事件" onClose={() => setEventOpen(false)} footer={<><Button variant="ghost" onClick={() => setEventOpen(false)}>取消</Button><Button onClick={addEvent} disabled={!eventForm.title}>添加事件</Button></>}><div className="form-grid two"><Field label="事件名称"><Input value={eventForm.title} onChange={(e) => setEventForm({ ...eventForm, title: e.target.value })} /></Field><Field label="故事时间"><Input value={eventForm.storyTime} onChange={(e) => setEventForm({ ...eventForm, storyTime: e.target.value })} placeholder="例如：霜潮月·初五" /></Field><Field label="所属剧情线"><select className="input" value={eventForm.plotlineId} onChange={(e) => setEventForm({ ...eventForm, plotlineId: e.target.value })}><option value="">未绑定</option>{data.plotlines.map((plot) => <option key={plot.id} value={plot.id}>{plot.name}</option>)}</select></Field><Field label="地点"><Input value={eventForm.location} onChange={(e) => setEventForm({ ...eventForm, location: e.target.value })} /></Field><Field label="事件摘要"><Textarea rows={4} value={eventForm.summary} onChange={(e) => setEventForm({ ...eventForm, summary: e.target.value })} /></Field></div></Modal>}
    {plotOpen && <Modal title="新建剧情线" onClose={() => setPlotOpen(false)} footer={<><Button variant="ghost" onClick={() => setPlotOpen(false)}>取消</Button><Button onClick={addPlotline} disabled={!plotForm.name}>创建</Button></>}><div className="form-grid"><Field label="名称"><Input value={plotForm.name} onChange={(e) => setPlotForm({ ...plotForm, name: e.target.value })} /></Field><Field label="类型"><select className="input" value={plotForm.type} onChange={(e) => setPlotForm({ ...plotForm, type: e.target.value })}><option value="main">主线</option><option value="subplot">支线</option><option value="character">人物弧</option><option value="mystery">谜团</option><option value="romance">感情线</option><option value="framework">阶段框架</option></select></Field><Field label="核心问题"><Textarea rows={4} value={plotForm.summary} onChange={(e) => setPlotForm({ ...plotForm, summary: e.target.value })} /></Field></div></Modal>}
    {decompositionOpen && decomposition && <Modal title="审阅大纲拆分" onClose={() => !applyingPlan && setDecompositionOpen(false)} footer={<><Button variant="ghost" onClick={() => setDecompositionOpen(false)} disabled={applyingPlan}>取消</Button><Button onClick={applyDecomposition} disabled={applyingPlan}>{applyingPlan ? <Loader2 className="spin" size={15} /> : <Check size={15} />} {applyingPlan ? '正在写入…' : '确认写入项目'}</Button></>}><div className="decomposition-preview"><p className="decomposition-note">写入时：已写正文的章节一律保留并按标题沿用；仍未写作的旧规划章节会被新细纲替换。重画剧情线不会丢失任何已完成的文字。</p><section><header><GitBranch size={16} /><strong>{decomposition.plotlines.length} 条剧情线</strong><span>{decomposition.plotlines.reduce((sum, item) => sum + item.events.length, 0)} 个关键事件</span></header>{decomposition.plotlines.map((plotline) => <article key={plotline.name}><div><i style={{ background: plotline.color || '#13766f' }} /><strong>{plotline.name}</strong><Badge>{typeLabel(plotline.type)}</Badge></div><p>{plotline.summary}</p><small>{plotline.events.map((event) => event.title).join(' · ')}</small></article>)}</section><section><header><ListTree size={16} /><strong>{decomposition.volumes.length} 个分卷</strong><span>{decomposition.volumes.reduce((sum, item) => sum + item.chapters.length, 0)} 章细纲</span></header>{decomposition.volumes.map((volume) => <article key={volume.title}><div><strong>{volume.title}</strong><Badge tone="teal">{volume.chapters.length} 章</Badge></div><p>{volume.summary}</p><ol>{volume.chapters.map((chapter) => <li key={chapter.title}><strong>{chapter.title}</strong><span>{chapter.pov || '多视角/未指定'} · {chapter.scenes.length} 场</span><p>{chapter.summary}</p></li>)}</ol></article>)}</section></div></Modal>}

    {guideOpen && <Modal title="五步创作向导" onClose={() => setGuideOpen(false)} footer={<><Button variant="ghost" onClick={() => setGuideOpen(false)}>关闭</Button>{guideStep > 0 && !guideResult && <Button variant="secondary" onClick={() => { setGuideStep((value) => value - 1); setGuideSuggestion('') }}><ChevronLeft size={14} /> 上一步</Button>}{guideStep < guideSteps.length - 1 && !guideResult && <Button onClick={() => { setGuideStep((value) => value + 1); setGuideSuggestion('') }}>下一步 <ChevronRight size={14} /></Button>}{guideStep === guideSteps.length - 1 && !guideResult && <Button onClick={generateGuide} disabled={guideGenerating}>{guideGenerating ? <Loader2 className="spin" size={15} /> : <Sparkles size={15} />} 生成完整方案</Button>}{guideResult && <Button onClick={adoptGuide}><Check size={15} /> 采纳为当前大纲</Button>}</>}><div className="creative-guide"><nav className="guide-progress">{guideSteps.map((step, index) => <button key={step.title} className={`${index === guideStep ? 'active' : ''} ${index < guideStep ? 'done' : ''}`} onClick={() => { setGuideStep(index); setGuideSuggestion(''); setGuideResult(null) }}><span>{index < guideStep ? <Check size={12} /> : index + 1}</span><strong>{step.title}</strong></button>)}</nav>{guideResult ? <section className="guide-final"><header><div><strong>完整创作方案</strong><p>先作为候选审阅，采纳后进入大纲版本管理。</p></div><Badge tone="amber">尚未采纳</Badge></header><MarkdownLike text={guideResult.output} /></section> : <GuideStage guideStep={guideStep} guide={guide} setGuide={setGuide} mode={mode} suggestion={guideSuggestion} notes={guideNotes} setNotes={setGuideNotes} generating={guideGenerating} autocomplete={autocompleteStep} setSuggestion={setGuideSuggestion} />}</div></Modal>}
  </div>
}

function GuideStage({ guideStep, guide, setGuide, mode, suggestion, notes, setNotes, generating, autocomplete, setSuggestion }: {
  guideStep: number
  guide: typeof initialGuide
  setGuide: (value: typeof initialGuide) => void
  mode: { value: StoryMode; label: string; text: string }
  suggestion: string
  notes: Record<number, string>
  setNotes: (value: Record<number, string>) => void
  generating: boolean
  autocomplete: () => void
  setSuggestion: (value: string) => void
}) {
  return <div className="guide-stage"><header><span>第 {guideStep + 1} 步</span><h3>{guideSteps[guideStep].title}</h3><p>{guideSteps[guideStep].text}</p></header>
    {guideStep === 0 && <><div className="story-mode-grid">{storyModes.map((item) => <button key={item.value} className={guide.mode === item.value ? 'active' : ''} onClick={() => setGuide({ ...guide, mode: item.value })}><strong>{item.label}</strong><span>{item.text}</span></button>)}</div><Field label="剧情梗概" hint="一段话即可；AI 会主动提出缺失的结构候选"><Textarea rows={6} value={guide.synopsis} onChange={(event) => setGuide({ ...guide, synopsis: event.target.value })} /></Field></>}
    {guideStep === 1 && <div className="guide-grid"><Field label="关注中心" hint="可以是人物、群体、地点、案件、时代或反复出现的问题"><Textarea rows={4} value={guide.focus} onChange={(event) => setGuide({ ...guide, focus: event.target.value })} /></Field><Field label="读者承诺" hint="读者持续翻页，是为了获得哪类体验或答案？"><Textarea rows={4} value={guide.promise} onChange={(event) => setGuide({ ...guide, promise: event.target.value })} /></Field><Field label="连续性支点" hint="当主线或主角变化时，什么让故事仍像同一部小说？"><Textarea rows={4} value={guide.continuity} onChange={(event) => setGuide({ ...guide, continuity: event.target.value })} /></Field></div>}
    {guideStep === 2 && <div className="guide-grid"><Field label="驱动力如何更替" hint="写出旧目标失效、新目标接管或多线互相接力的方式"><Textarea rows={5} value={guide.shifts} onChange={(event) => setGuide({ ...guide, shifts: event.target.value })} /></Field><Field label="组织节奏" hint="按卷、阶段、案件、地点、视角轮换或时间周期"><Textarea rows={5} value={guide.rhythm} onChange={(event) => setGuide({ ...guide, rhythm: event.target.value })} /></Field></div>}
    {guideStep === 3 && <div className="guide-grid"><Field label="压力网络" hint="人物对立、制度、环境、时间、资源和信息差都可以成为阻力"><Textarea rows={5} value={guide.opposition} onChange={(event) => setGuide({ ...guide, opposition: event.target.value })} /></Field><Field label="代价与风险" hint="每一阶段结束后，哪些状态必须不可逆地改变？"><Textarea rows={5} value={guide.stakes} onChange={(event) => setGuide({ ...guide, stakes: event.target.value })} /></Field></div>}
    {guideStep === 4 && <div className="guide-grid"><Field label="收束方向" hint="可选择汇流、接力完成、循环闭合、主题回答或开放延展"><Textarea rows={5} value={guide.ending} onChange={(event) => setGuide({ ...guide, ending: event.target.value })} /></Field><Field label="不可违背的约束" hint="例如不设终极反派、不揭示全部真相、每卷更换视角"><Textarea rows={5} value={guide.constraints} onChange={(event) => setGuide({ ...guide, constraints: event.target.value })} /></Field></div>}
    <div className="guide-ai"><div><strong>Agent 补全</strong><p>AI 会依据“{mode.label}”和项目资料主动给出具体候选，不要求先填满所有内容。</p></div><Button variant="secondary" onClick={autocomplete} disabled={generating}>{generating ? <Loader2 className="spin" size={14} /> : <WandSparkles size={14} />} AI 补全本步</Button></div>
    {generating && <LoadingState label={`正在补全“${guideSteps[guideStep].title}”`} />}
    {suggestion && <section className="guide-suggestion"><MarkdownLike text={suggestion} /><Button variant="secondary" onClick={() => { setNotes({ ...notes, [guideStep]: suggestion }); setSuggestion('') }}><Check size={14} /> 采纳为本步补充</Button></section>}
    {notes[guideStep] && <Field label="已采纳的本步补充" hint="可以继续人工修改"><Textarea rows={7} value={notes[guideStep]} onChange={(event) => setNotes({ ...notes, [guideStep]: event.target.value })} /></Field>}
  </div>
}
