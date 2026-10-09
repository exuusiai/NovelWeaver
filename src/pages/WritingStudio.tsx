import { useEffect, useMemo, useRef, useState } from 'react'
import { Bookmark, BookmarkCheck, BookOpen, Check, ChevronDown, Copy, ChevronLeft, ChevronRight, Eye, FilePlus2, Filter, FolderPlus, History, ListTree, Loader2, PanelRightClose, Pencil, Pin, PinOff, RotateCcw, Save, ShieldAlert, Sparkles, Target, Trash2, WandSparkles } from 'lucide-react'
import { api, patch, post, remove } from '../api'
import { useNavigate } from 'react-router-dom'
import { useProject } from '../project-context'
import type { Chapter, ChapterHistory, ContextReport, GenerationResult, PrecheckIssue, Volume } from '../types'
import { Badge, Button, EmptyState, Field, IconButton, Input, MarkdownLike, Modal, Textarea } from '../components/ui'

const snapshotOf = (chapter: Chapter) => JSON.stringify([chapter.title, chapter.content, chapter.summary, chapter.pov, chapter.status, chapter.target_words, chapter.detailed_outline || ''])
const cleanGeneratedProse = (output: string) => output
  .replace(/^#.*\n/, '')
  .replace(/\s*\[R\d+\]/g, '')
  .replace(/[ \t]{2,}/g, ' ')
const variantLabel = (index: number) => `版本 ${String.fromCharCode(65 + index)}`

export function WritingStudio() {
  const { projectId } = useProject()
  const navigate = useNavigate()
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [volumes, setVolumes] = useState<Volume[]>([])
  const [selectedId, setSelectedId] = useState(sessionStorage.getItem('novelweaver.chapter') || '')
  const [draft, setDraft] = useState<Chapter | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [autosave, setAutosave] = useState<'saved' | 'pending' | 'saving' | 'error' | 'copied'>('saved')
  const [panelOpen, setPanelOpen] = useState(() => localStorage.getItem('novelweaver.agent.open') !== '0' && window.innerWidth > 640)
  const [panelPinned, setPanelPinned] = useState(() => localStorage.getItem('novelweaver.agent.pinned') !== '0' && window.innerWidth > 860)
  const [prompt, setPrompt] = useState('根据当前细纲，生成下一场景；保持视角和既有设定，不新增未经确认的能力。')
  const [task, setTask] = useState<'chapter_outline' | 'prose'>('chapter_outline')
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState('')
  const [variants, setVariants] = useState<GenerationResult[]>([])
  const [activeVariant, setActiveVariant] = useState(0)
  const [precheckIssues, setPrecheckIssues] = useState<PrecheckIssue[] | null>(null)
  const [summarizing, setSummarizing] = useState(false)
  const [summaryNotice, setSummaryNotice] = useState('')
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
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyRows, setHistoryRows] = useState<ChapterHistory[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  const draftRef = useRef<Chapter | null>(null)
  const savedSnapshotRef = useRef('')
  const saveRefRef = useRef<() => Promise<boolean>>(() => Promise.resolve(false))
  const errorSnapshotRef = useRef('')
  const savingRef = useRef(false)

  const selectChapter = async (id: string) => {
    if (id === selectedId) return
    // 切章前先把未保存内容落盘；失败则留在本章并明确提示，绝不静默丢弃
    if (draftRef.current && snapshotOf(draftRef.current) !== savedSnapshotRef.current) {
      const ok = await save()
      if (!ok) { setAdoptionNotice('本章保存失败，未切换章节——内容仍在本页，请点「保存」重试。'); return }
    }
    savedSnapshotRef.current = ''; setAutosave('pending')
    setSelectedId(id); setVariants([]); setActiveVariant(0)
  }
  const applyDraft = (row: Chapter) => {
    draftRef.current = row
    savedSnapshotRef.current = snapshotOf(row)
    errorSnapshotRef.current = ''
    setAutosave('saved')
    setDraft(row)
  }
  // 本地草稿镜像：保存成功前，正文持续写入 localStorage——保存失败、跨页、
  // 甚至浏览器崩溃，都能从这里恢复。保存成功后镜像即清除。
  const mirrorKey = (chapterId: string) => `novelweaver.draft.${chapterId}`
  const writeMirror = (chapter: Chapter) => {
    try { localStorage.setItem(mirrorKey(chapter.id), JSON.stringify({ title: chapter.title, content: chapter.content, summary: chapter.summary, savedAt: new Date().toISOString() })) } catch { /* 存储满时静默 */ }
  }
  const readMirror = (chapterId: string) => {
    try { return JSON.parse(localStorage.getItem(mirrorKey(chapterId)) || 'null') as { title?: string; content?: string; summary?: string; savedAt?: string } | null } catch { return null }
  }
  const clearMirror = (chapterId: string) => { try { localStorage.removeItem(mirrorKey(chapterId)) } catch { /* ignore */ } }
  const [localDraftNotice, setLocalDraftNotice] = useState<{ savedAt?: string; restore: () => void } | null>(null)

  const discardDraft = () => { draftRef.current = null; savedSnapshotRef.current = ''; errorSnapshotRef.current = ''; setDraft(null) }

  const load = async (preferredId = selectedId) => {
    const [rows, volumeRows] = await Promise.all([api<Chapter[]>(`/api/projects/${projectId}/chapters`), api<Volume[]>(`/api/projects/${projectId}/volumes`)])
    if (draftRef.current && snapshotOf(draftRef.current) !== savedSnapshotRef.current) void save()
    setVolumes(volumeRows)
    setChapters(rows)
    const id = rows.some((row) => row.id === preferredId) ? preferredId : rows[0]?.id || ''
    setSelectedId(id)
    const row = rows.find((item) => item.id === id) || null
    if (row) applyDraft(row); else discardDraft()
  }
  useEffect(() => { load() }, [projectId])
  useEffect(() => { draftRef.current = draft }, [draft])
  useEffect(() => {
    const row = chapters.find((item) => item.id === selectedId)
    if (row) {
      if (draftRef.current && snapshotOf(draftRef.current) !== savedSnapshotRef.current) void save()
      applyDraft(row)
      setOutlineEditing(false)
      sessionStorage.setItem('novelweaver.chapter', row.id)
      // 保存失败/未保存时留下的本地草稿镜像：提示作者恢复
      const mirror = readMirror(row.id)
      if (mirror && mirror.content && mirror.content !== row.content) {
        setLocalDraftNotice({ savedAt: mirror.savedAt, restore: () => {
          setDraft((current) => current && current.id === row.id ? { ...current, title: mirror.title || current.title, content: mirror.content || current.content, summary: mirror.summary || current.summary } : current)
          setLocalDraftNotice(null)
        } })
      } else setLocalDraftNotice(null)
    }
  }, [selectedId])
  useEffect(() => { localStorage.setItem('novelweaver.agent.open', panelOpen ? '1' : '0') }, [panelOpen])
  useEffect(() => { localStorage.setItem('novelweaver.agent.pinned', panelPinned ? '1' : '0') }, [panelPinned])
  useEffect(() => { setContextReport(null); setPrecheckIssues(null) }, [prompt, task, draft?.id])
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (draftRef.current && snapshotOf(draftRef.current) !== savedSnapshotRef.current) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  const wordCount = useMemo(() => draft?.content.replace(/\s/g, '').length ?? 0, [draft?.content])
  const chapterIndex = chapters.findIndex((chapter) => chapter.id === selectedId)
  const prevChapter = chapterIndex > 0 ? chapters[chapterIndex - 1] : null
  const nextChapter = chapterIndex >= 0 && chapterIndex < chapters.length - 1 ? chapters[chapterIndex + 1] : null
  const visibleChapters = useMemo(() => bookmarkedOnly ? chapters.filter((chapter) => Boolean(chapter.bookmarked)) : chapters, [chapters, bookmarkedOnly])
  const volumeGroups = useMemo(() => volumes.map((volume) => ({ volume, chapters: visibleChapters.filter((chapter) => chapter.volume_id === volume.id).sort((a, b) => (a.volume_order_index ?? a.position) - (b.volume_order_index ?? b.position)) })), [volumes, visibleChapters])

  const save = async (): Promise<boolean> => {
    const current = draftRef.current
    if (!current || savingRef.current) return false
    savingRef.current = true
    setSaving(true); setSaved(false); setAutosave('saving')
    // 快照统一走 snapshotOf（与自动保存判定同一函数），否则保存成功后仍被
    // 判定为有未保存更改，造成重复保存与提示失真
    const payload = { title: current.title, content: current.content, summary: current.summary, pov: current.pov, status: current.status, targetWords: current.target_words, detailedOutline: current.detailed_outline || '' }
    const snapshot = snapshotOf({ ...current, ...payload } as Chapter)
    const previousSnapshot = savedSnapshotRef.current
    savedSnapshotRef.current = snapshot
    try {
      const next = await patch<Chapter>(`/api/chapters/${current.id}`, payload)
      // 请求期间可能已切换/修改章节：只有同一章节且内容仍等于已保存快照时才合并
      if (draftRef.current?.id !== current.id) { savedSnapshotRef.current = previousSnapshot; return true }
      clearMirror(current.id)
      setChapters((rows) => rows.map((row) => row.id === next.id ? { ...row, content: next.content } : row))
      setDraft((row) => row && row.id === next.id && snapshotOf(row) === snapshot ? { ...row, ...next } : row)
      errorSnapshotRef.current = ''
      setSaved(true); setAutosave('saved')
      window.setTimeout(() => setSaved(false), 1800)
      return true
    } catch {
      savedSnapshotRef.current = previousSnapshot
      errorSnapshotRef.current = snapshot
      setAutosave('error')
      return false
    } finally {
      savingRef.current = false; setSaving(false)
    }
  }
  useEffect(() => { saveRefRef.current = save })

  // 站内跨页（设定/剧情/分析…）卸载写作页时：有未保存内容立即落盘。
  // 异步保存不依赖组件存活（patch 已发出即会完成），镜像也已在编辑时写入。
  useEffect(() => () => {
    if (draftRef.current && snapshotOf(draftRef.current) !== savedSnapshotRef.current) void saveRefRef.current()
  }, [])

  // 站内跨页（设定/剧情/分析…）卸载写作页时：有未保存内容立即落盘。
  // 异步保存不依赖组件存活（patch 已发出即会完成），镜像也已在编辑时写入。
  const mountedRef = useRef(true)
  useEffect(() => () => {
    mountedRef.current = false
    if (draftRef.current && snapshotOf(draftRef.current) !== savedSnapshotRef.current) void saveRefRef.current()
  }, [])

  useEffect(() => {
    if (!draft) return
    const snapshot = snapshotOf(draft)
    if (snapshot === savedSnapshotRef.current) { setAutosave('saved'); clearMirror(draft.id); return }
    writeMirror(draft)
    if (snapshot === errorSnapshotRef.current) { setAutosave('error'); return }
    setAutosave('pending')
    const timer = window.setTimeout(() => { void save() }, 2500)
    return () => window.clearTimeout(timer)
  }, [draft])

  const saveDetailedOutline = async () => {
    if (!draft) return
    const next = await patch<Chapter>(`/api/chapters/${draft.id}/outline`, { content: draft.detailed_outline, status: 'active' })
    // 只合并细纲字段，避免服务端整章对象覆盖未保存的正文
    setChapters((rows) => rows.map((row) => row.id === next.id ? { ...row, detailed_outline: next.detailed_outline, status: next.status } : row))
    setDraft((current) => current?.id === next.id ? { ...current, detailed_outline: next.detailed_outline, status: next.status } : current)
    setOutlineEditing(false)
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
    // 只合并卷字段：响应里的正文是服务端版本，可能不含自动保存前刚输入的内容
    setChapters((rows) => rows.map((row) => row.id === next.id ? { ...row, volume_id: next.volume_id, volume_order_index: next.volume_order_index } : row))
    setDraft((current) => current?.id === next.id ? { ...current, volume_id: next.volume_id, volume_order_index: next.volume_order_index } : current)
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
    const slot = variants.length
    if (slot >= 3) { setGenerateError('最多保留 3 个对比版本；请先丢弃不需要的版本。'); return }
    setGenerating(true); setGenerateError('')
    setVariants((current) => [...current, { output: '', model: '', citations: [], chapterId: draft.id, task }])
    setActiveVariant(slot)
    try {
      const response = await fetch('/api/ai/generate/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 传递编辑快照：未保存正文 + 当前细纲，保证"AI 真正读了我的细纲"
        body: JSON.stringify({ projectId, chapterId: draft.id, task, prompt, chapterContent: draft.content, chapterOutline: draft.detailed_outline || undefined, scope: 'upto' }),
      })
      if (!response.ok || !response.body) {
        const detail = await response.json().catch(() => null) as { error?: string } | null
        throw new Error(detail?.error || `请求失败：${response.status}`)
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let finished = false
      while (!finished) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          let event: { type: string; text?: string; generationId?: string; output?: string; model?: string; citations?: GenerationResult['citations']; contextReport?: GenerationResult['contextReport']; message?: string }
          try { event = JSON.parse(line.slice(6)) } catch { continue }
          if (event.type === 'delta' && event.text) {
            const text = event.text
            setVariants((current) => current.map((item, index) => index === slot ? { ...item, output: item.output + text } : item))
          } else if (event.type === 'done') {
            setVariants((current) => current.map((item, index) => index === slot ? { generationId: event.generationId, output: event.output || '', model: event.model || '', citations: event.citations || [], contextReport: event.contextReport, chapterId: draft.id, task } : item))
            finished = true
          } else if (event.type === 'error') throw new Error(event.message || '生成失败。')
        }
      }
    } catch (error) {
      setVariants((current) => current.filter((item, index) => !(index === slot && !item.output.trim())))
      setActiveVariant((current) => Math.min(current, Math.max(variants.length - 1, 0)))
      setGenerateError((error as Error).message)
    } finally {
      setGenerating(false)
    }
  }
  const previewContext = async () => {
    if (!draft) return
    setPreviewing(true)
    try {
      const [context, precheck] = await Promise.all([
        // 与实际生成完全同一份编辑快照：未保存正文 + 当前细纲 + upto 视角
        post<{ report: ContextReport }>('/api/ai/context', { projectId, chapterId: draft.id, prompt, tokenBudget: 10000, chapterContent: draft.content, chapterOutline: draft.detailed_outline || undefined, scope: 'upto' }),
        api<{ issues: PrecheckIssue[] }>(`/api/chapters/${draft.id}/precheck`).catch(() => ({ issues: [] as PrecheckIssue[] })),
      ])
      previewSnapshotRef.current = snapshotOf({ ...draft, content: draft.content } as Chapter); setContextReport(context.report); setPrecheckIssues(precheck.issues)
    } finally { setPreviewing(false) }
  }
  const rewriteSummary = async () => {
    if (!draft) return
    setSummarizing(true); setSummaryNotice('')
    try {
      const next = await post<Chapter>(`/api/chapters/${draft.id}/summary/rewrite`, {})
      const hadUnsaved = draftRef.current && snapshotOf(draftRef.current) !== savedSnapshotRef.current
      if (hadUnsaved) {
        // 有未保存正文时只合并摘要字段，不用服务端整章覆盖本地编辑
        setChapters((rows) => rows.map((row) => row.id === next.id ? { ...row, summary: next.summary } : row))
        setDraft((current) => current?.id === next.id ? { ...current, summary: next.summary } : current)
        setSummaryNotice('摘要已重写（正文有未保存修改，已保留你的本地版本，请手动保存）。')
      } else {
        setChapters((rows) => rows.map((row) => row.id === next.id ? next : row))
        applyDraft(next)
        setSummaryNotice('摘要已由模型重写，章节记忆同步更新。')
      }
    } catch (error) { setSummaryNotice((error as Error).message) } finally { setSummarizing(false) }
  }
  const workshopPrompts: Record<string, string> = {
    scan: '扫描当前章节前的故事状态，列出本章必须承接的事实、未解决承诺和角色知识边界。',
    motivation: '分析本章出场角色的外在目标、内在需求、隐瞒信息与可接受代价。',
    conflict: '让角色目标发生正面碰撞，设计逐级升级且由既有因果驱动的冲突。',
    scenes: '把本章拆成场景序列，每场写清目标、阻力、信息增量、转折与出场状态。',
    check: '检查细纲中的持有物、角色知识、时间地点、力量规则和正史事实冲突，并给出一次修订建议。',
  }
  const chooseStage = (stage: string) => { setWorkshopStage(stage); setPrompt(workshopPrompts[stage]) }
  const currentResult = variants[activeVariant] || null
  const sendFeedback = (generationId: string | undefined, action: 'appended' | 'discarded') => {
    if (generationId) void post(`/api/generations/${generationId}/feedback`, { action }).catch(() => undefined)
  }
  const [adoptionNotice, setAdoptionNotice] = useState<string | null>(null)
  // 预览依据与编辑内容的一致性：作者改字后预览即过期，清空旧报告防止误信
  const previewSnapshotRef = useRef('')
  useEffect(() => {
    if (contextReport && previewSnapshotRef.current && snapshotOf(draftRef.current || ({ content: '' } as Chapter)) !== previewSnapshotRef.current) {
      setContextReport(null)
      previewSnapshotRef.current = ''
    }
  }, [draft, contextReport])
  // 采纳后自动预检：对比采纳前后的规则检查差异，把"这次生成引入了什么问题"变成即时反馈
  const appendResult = async () => {
    if (!draft || !currentResult?.output.trim()) return
    const before = await api<{ issues: Array<{ title: string }> }>(`/api/chapters/${draft.id}/precheck`).catch(() => ({ issues: [] }))
    const merged = `${draft.content}${draft.content ? '\n\n' : ''}${cleanGeneratedProse(currentResult.output)}`
    const payload = { title: draft.title, content: merged, summary: draft.summary, pov: draft.pov, status: draft.status, targetWords: draft.target_words }
    let savedOk = false
    try {
      const next = await patch<Chapter>(`/api/chapters/${draft.id}`, payload)
      setDraft((row) => row && row.id === next.id ? { ...row, ...next } : row)
      setChapters((rows) => rows.map((row) => row.id === next.id ? next : row))
      savedOk = true
    } catch {
      // 保存失败：内容并入本地状态避免丢失，但绝不报告"已保存"——
      // 作者以为落盘而实际没有是最危险的状态
      setDraft({ ...draft, content: merged })
    }
    sendFeedback(currentResult.generationId, 'appended')
    if (!savedOk) {
      setAdoptionNotice(`追加内容已放入编辑器，但保存到服务端失败（${'网络或服务异常'}）。请点工具栏「保存」重试后再离开本页，否则内容可能丢失。`)
      return
    }
    const after = await api<{ issues: Array<{ title: string }> }>(`/api/chapters/${draft.id}/precheck`).catch(() => ({ issues: [] }))
    const beforeTitles = new Set(before.issues.map((issue) => issue.title))
    const added = after.issues.filter((issue) => !beforeTitles.has(issue.title))
    setAdoptionNotice(added.length
      ? `已追加到正文并保存；预检新增 ${added.length} 个提示：${added.slice(0, 3).map((issue) => issue.title).join('；')}${added.length > 3 ? ' 等' : ''}。`
      : '已追加到正文并保存；预检无新增提示。')
  }
  const discardVariants = () => {
    variants.forEach((item) => sendFeedback(item.generationId, 'discarded'))
    setVariants([]); setActiveVariant(0)
  }
  const openHistory = async () => {
    if (!draft) return
    setHistoryOpen(true); setHistoryLoading(true)
    try { setHistoryRows(await api<ChapterHistory[]>(`/api/chapters/${draft.id}/history`)) } finally { setHistoryLoading(false) }
  }
  const restoreHistory = async (historyId: string) => {
    if (!draft) return
    const next = await post<Chapter>(`/api/chapters/${draft.id}/history/${historyId}/restore`, {})
    setChapters((rows) => rows.map((row) => row.id === next.id ? next : row))
    applyDraft(next)
    setHistoryOpen(false)
  }

  if (!chapters.length) return <EmptyState icon={<BookOpen />} title="还没有章节" text="创建第一章后即可开始写作。" action={<Button onClick={addChapter}>创建第一章</Button>} />
  return <div className={`writing-layout ${panelOpen ? 'ai-open' : 'ai-closed'} ${panelPinned ? 'ai-pinned' : 'ai-floating'}`}>
    <aside className="chapter-rail">
      <header><div><strong>卷与章节</strong><span>{bookmarkedOnly ? `${visibleChapters.length}/${chapters.length}` : chapters.length}</span></div><IconButton label="新建卷" onClick={() => setVolumeOpen(true)}><FolderPlus size={16} /></IconButton><IconButton label={bookmarkedOnly ? '显示全部章节' : '仅看书签'} className={bookmarkedOnly ? 'active' : ''} onClick={() => setBookmarkedOnly((value) => !value)}><Filter size={16} /></IconButton><IconButton label={draft ? '在当前章后新建' : '新建章节'} onClick={addChapter}><FilePlus2 size={17} /></IconButton></header>
      <div className="chapter-rail-list volume-tree">{volumeGroups.map(({ volume, chapters: volumeChapters }) => <section key={volume.id} className="volume-group"><div className="volume-row"><button onClick={() => setCollapsedVolumes((current) => { const next = new Set(current); next.has(volume.id) ? next.delete(volume.id) : next.add(volume.id); return next })}>{collapsedVolumes.has(volume.id) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}<div><strong>{volume.title}</strong><small>{volumeChapters.length} 章 · {Number(volume.character_count || 0).toLocaleString()} 字</small></div></button><IconButton label={`编辑${volume.title}`} onClick={() => setEditingVolume({ ...volume })}><Pencil size={13} /></IconButton></div>{!collapsedVolumes.has(volume.id) && volumeChapters.map((chapter) => <button key={chapter.id} className={`${chapter.id === selectedId ? 'active' : ''} importance-${chapter.importance}`} onClick={() => void selectChapter(chapter.id)}><span>{String(chapter.position + 1).padStart(2, '0')}</span><div><strong>{chapter.bookmarked ? <BookmarkCheck size={11} /> : null}{chapter.title}</strong><small>{chapter.content.replace(/\s/g, '').length.toLocaleString()} 字 · {chapter.pov || '未定视角'}{chapter.importance !== 'normal' ? ` · ${chapter.importance === 'critical' ? '关键' : '重要'}` : ''}</small></div><ChevronRight size={15} /></button>)}</section>)}</div>
    </aside>
    <section className="editor-pane">
      {draft && <>
        <header className="editor-toolbar"><div className="crumb">正文 <ChevronRight size={14} /> <span>{draft.title}</span></div><div className="chapter-nav-mobile"><IconButton label="新建章节" onClick={addChapter}><FilePlus2 size={16} /></IconButton><IconButton label="上一章" disabled={!prevChapter} onClick={() => prevChapter && void selectChapter(prevChapter.id)}><ChevronLeft size={16} /></IconButton><select value={draft.id} onChange={(event) => void selectChapter(event.target.value)} aria-label="跳转章节">{chapters.map((chapter) => <option key={chapter.id} value={chapter.id}>{String(chapter.position + 1).padStart(2, '0')} {chapter.title}</option>)}</select><IconButton label="下一章" disabled={!nextChapter} onClick={() => nextChapter && void selectChapter(nextChapter.id)}><ChevronRight size={16} /></IconButton></div><div className="editor-actions"><Badge tone={draft.status === 'revised' ? 'teal' : 'neutral'}>{draft.status === 'revised' ? '已修订' : '草稿'}</Badge>{draft.content_hash && draft.analyzed_hash && draft.content_hash !== draft.analyzed_hash && <button className="stale-chip" onClick={() => navigate('/analysis')} title="本章正文已修改，人物/事件/事实仍基于旧稿；到分析中心重新分析后解除">分析基于旧稿</button>}<span className="save-state">{saved && <><Check size={14} /> 已保存</>}</span><IconButton label="历史版本" onClick={openHistory}><History size={17} /></IconButton><IconButton label={draft.bookmarked ? '取消书签' : '添加书签'} className={draft.bookmarked ? 'active' : ''} onClick={() => updateMark({ bookmarked: !draft.bookmarked })}>{draft.bookmarked ? <BookmarkCheck size={17} /> : <Bookmark size={17} />}</IconButton><Button variant="secondary" onClick={save} disabled={saving}>{saving ? <Loader2 className="spin" size={15} /> : <Save size={15} />} 保存</Button><IconButton label="删除当前章节" className="danger-icon" onClick={() => setDeleteOpen(true)}><Trash2 size={17} /></IconButton></div></header>
        <div className="editor-meta">{localDraftNotice && <div className="local-draft-notice"><span>检测到 {localDraftNotice.savedAt ? new Date(localDraftNotice.savedAt).toLocaleString('zh-CN') : ''} 保存失败时留下的本地草稿（与服务器正文不同）。</span><Button variant="secondary" onClick={localDraftNotice.restore}>恢复本地草稿</Button><Button variant="ghost" onClick={() => { if (draft) { clearMirror(draft.id); } setLocalDraftNotice(null) }}>丢弃</Button></div>}<Input className="chapter-title-input" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /><div className="chapter-facts"><label><span>所属卷</span><select className="input" value={draft.volume_id || ''} onChange={(event) => moveChapter(event.target.value)}>{volumes.map((volume) => <option key={volume.id} value={volume.id}>{volume.title}</option>)}</select></label><label><span>视角</span><Input value={draft.pov} onChange={(event) => setDraft({ ...draft, pov: event.target.value })} placeholder="未指定" /></label><label><span>目标</span><div><Target size={14} /><Input type="number" value={draft.target_words} onChange={(event) => setDraft({ ...draft, target_words: Number(event.target.value) })} /></div></label><label><span>重要性</span><select className="input importance-select" value={draft.importance} onChange={(event) => updateMark({ importance: event.target.value as Chapter['importance'] })}><option value="normal">普通</option><option value="important">重要</option><option value="critical">关键</option></select></label><span>{wordCount.toLocaleString()} 字</span></div><div className="summary-row"><Textarea className="summary-input" value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} placeholder="用一两句话记录本章的信息增量和状态变化……" rows={2} /><Button variant="secondary" className="summary-ai" onClick={rewriteSummary} disabled={summarizing || !draft.content.trim()} title="用模型重写本章摘要">{summarizing ? <Loader2 className="spin" size={14} /> : <Sparkles size={14} />} AI 摘要</Button></div>{summaryNotice && <p className="summary-notice">{summaryNotice}</p>}</div>
        {<section className={`chapter-outline ${outlineExpanded || !draft.detailed_outline ? 'expanded' : ''}`}><header><button onClick={() => setOutlineExpanded((value) => !value)}>{outlineExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}<ListTree size={15} /><strong>本章细纲</strong>{draft.detailed_outline ? <Badge tone="teal">由全书大纲拆分</Badge> : <Badge tone="amber">还没有细纲</Badge>}</button>{outlineExpanded && <Button variant="ghost" onClick={() => setOutlineEditing((value) => !value)}><Pencil size={13} /> {outlineEditing ? '预览' : '编辑'}</Button>}{!draft.detailed_outline && !outlineEditing && <Button variant="ghost" onClick={() => setOutlineEditing(true)}><Pencil size={13} /> 手写细纲</Button>}</header>{outlineExpanded && <div>{(outlineEditing || !draft.detailed_outline) ? <><Textarea rows={16} value={draft.detailed_outline} onChange={(event) => setDraft({ ...draft, detailed_outline: event.target.value })} placeholder="先手写构思，或用右侧创作 Agent 生成——写好后点保存细纲。" /><Button onClick={saveDetailedOutline}><Save size={14} /> 保存细纲</Button></> : <MarkdownLike text={draft.detailed_outline} />}</div>}</section>}
        <Textarea className="manuscript-editor" value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} placeholder="从一个正在发生的动作开始……" spellCheck={false} />
        <footer className="editor-footer"><span>目标完成度 {Math.min(Math.round(wordCount / draft.target_words * 100), 100)}%</span><div className="mini-progress"><i style={{ width: `${Math.min(wordCount / draft.target_words * 100, 100)}%` }} /></div><span>{autosave === 'saving' || saving ? '自动保存中…' : autosave === 'pending' ? '有未保存更改' : autosave === 'error' ? '自动保存失败' : autosave === 'copied' ? '正文已复制到剪贴板' : '已自动保存'}</span>{autosave === 'error' && <><Button variant="secondary" onClick={() => void save()}><RotateCcw size={13} /> 立即重试保存</Button><Button variant="ghost" onClick={() => { void navigator.clipboard?.writeText(draft.content); setAutosave('copied') }} title="把本章全文复制到剪贴板，防止丢失"><Copy size={13} /> 复制正文</Button></>}</footer>
      </>}
    </section>
    {panelOpen ? <aside className="ai-panel"><header><div><WandSparkles size={18} /><div><strong>创作 Agent</strong><span>{panelPinned ? '已固定在写作区' : '悬浮面板'}</span></div></div><span className="agent-panel-actions"><IconButton label={panelPinned ? '取消固定助手' : '固定助手'} onClick={() => setPanelPinned((value) => !value)}>{panelPinned ? <Pin size={17} /> : <PinOff size={17} />}</IconButton><IconButton label="收起助手" onClick={() => setPanelOpen(false)}><PanelRightClose size={18} /></IconButton></span></header>
      <div className="agent-context"><span>上下文</span><Badge tone="teal">当前章节</Badge><Badge>人物状态</Badge><Badge>活跃剧情线</Badge><Badge>相关原文</Badge></div>
      <div className="agent-tabs"><button className={task === 'chapter_outline' ? 'active' : ''} onClick={() => setTask('chapter_outline')}>章节细纲</button><button className={task === 'prose' ? 'active' : ''} onClick={() => setTask('prose')}>正文草稿</button></div>
      {task === 'chapter_outline' && <div className="workshop-steps">{[['scan', '扫描'], ['motivation', '动机'], ['conflict', '冲突'], ['scenes', '场景'], ['check', '检查']].map(([value, label], index) => <button key={value} className={workshopStage === value ? 'active' : ''} onClick={() => chooseStage(value)}><span>{index + 1}</span>{label}</button>)}</div>}
      <div className="agent-compose"><Textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={5} /><div className="generation-gate"><Button variant="secondary" onClick={previewContext} disabled={previewing || !prompt.trim()}>{previewing ? <Loader2 className="spin" size={16} /> : <Eye size={16} />} {previewing ? '计算中…' : '预览生成依据'}</Button><Button onClick={generate} disabled={generating || !prompt.trim() || !contextReport}>{generating ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />} {generating ? '正在生成…' : variants.length ? `再生成一版（${variantLabel(variants.length)}）` : '确认并生成'}</Button></div>{generateError && <p className="generate-error">{generateError}</p>}</div>
      {precheckIssues && precheckIssues.length > 0 && <div className="precheck-box"><header><ShieldAlert size={14} /><strong>生成前提示（{precheckIssues.length}）</strong></header><ul>{precheckIssues.slice(0, 3).map((issue, index) => <li key={index}><strong>{issue.title}</strong><span>{issue.description}</span></li>)}</ul>{precheckIssues.length > 3 && <small>其余 {precheckIssues.length - 3} 条可在审查中心查看。提示不阻止生成。</small>}</div>}
      {contextReport && <div className="context-preview"><header><strong>本次生成依据</strong><span>{contextReport.estimatedTokens.toLocaleString()} / {contextReport.tokenBudget.toLocaleString()} tokens</span></header><p>已纳入 {contextReport.included.length} 项；因预算裁剪 {contextReport.trimmed.length} 项。</p><div>{contextReport.included.slice(0, 8).map((item) => <span key={`${item.kind}-${item.label}`}>{item.label}</span>)}</div></div>}
      <div className="agent-result">{currentResult ? <>
        {variants.length > 1 && <div className="variant-tabs">{variants.map((item, index) => <button key={index} className={index === activeVariant ? 'active' : ''} onClick={() => setActiveVariant(index)}>{variantLabel(index)}</button>)}<Button variant="ghost" className="variant-clear" onClick={discardVariants} disabled={generating}>丢弃全部</Button></div>}
        <div className="result-meta"><span>{currentResult.model || (generating ? '正在生成…' : '')}</span><span>{currentResult.citations.length} 条记忆证据</span></div>
        <MarkdownLike text={currentResult.output || (generating ? '…' : '')} citations={currentResult.citations} />
        {currentResult.task === 'chapter_outline' || task === 'chapter_outline' ? <Button variant="secondary" disabled={generating || !currentResult.output.trim()} onClick={() => { if (!draft) return; const cleaned = cleanGeneratedProse(currentResult.output); setDraft({ ...draft, detailed_outline: cleaned }); setOutlineEditing(true); setAdoptionNotice('已放入「本章细纲」编辑框，确认无误后点保存细纲落盘。') }}>放入「本章细纲」</Button> : <Button variant="secondary" onClick={appendResult} disabled={generating || !currentResult.output.trim() || currentResult.chapterId !== draft?.id} title={currentResult.chapterId !== draft?.id ? '该结果属于其他章节，切换回去再采纳' : ''}>追加「{variantLabel(activeVariant)}」到正文</Button>}
        {adoptionNotice && <p className={`adoption-notice ${adoptionNotice.includes('保存到服务端失败') ? 'error' : ''}`}>{adoptionNotice}</p>}
      </> : <div className="agent-placeholder"><Sparkles size={22} /><p>生成结果会出现在这里。可生成多个版本并排对比，再挑选追加。所有新增事实仍需在审查台确认。</p></div>}</div>
    </aside> : <button className="open-ai-panel" onClick={() => setPanelOpen(true)} title="打开创作 Agent"><Sparkles size={19} /></button>}
    {deleteOpen && draft && <Modal title="删除章节" onClose={() => setDeleteOpen(false)} footer={<><Button variant="ghost" onClick={() => setDeleteOpen(false)}>取消</Button><Button variant="danger" onClick={deleteChapter}><Trash2 size={15} /> 确认删除</Button></>}><div className="delete-confirm"><Trash2 size={24} /><p>将永久删除“<strong>{draft.title}</strong>”及其章节记忆和关联事件。其余章节会自动重新排序。</p></div></Modal>}
    {historyOpen && draft && <Modal title="历史版本" onClose={() => setHistoryOpen(false)} footer={<Button variant="ghost" onClick={() => setHistoryOpen(false)}>关闭</Button>}><div className="history-list">{historyLoading ? <p className="history-empty"><Loader2 className="spin" size={15} /> 正在读取历史版本…</p> : historyRows.length === 0 ? <p className="history-empty">还没有历史版本。正文发生实际变更并保存后会自动留档，每章最多保留 50 个版本；恢复前会先把当前内容存为新版本。</p> : historyRows.map((item) => <article key={item.id}><div><strong>{item.title}</strong><small>{new Date(item.created_at).toLocaleString()} · {item.word_count.toLocaleString()} 字</small><p>{item.preview}{item.preview.length >= 120 ? '…' : ''}</p></div><Button variant="secondary" onClick={() => restoreHistory(item.id)}><RotateCcw size={14} /> 恢复</Button></article>)}</div></Modal>}
    {volumeOpen && <Modal title="新建分卷" onClose={() => setVolumeOpen(false)} footer={<><Button variant="ghost" onClick={() => setVolumeOpen(false)}>取消</Button><Button onClick={addVolume} disabled={!volumeForm.title.trim()}>创建分卷</Button></>}><div className="form-grid"><Field label="卷名"><Input autoFocus value={volumeForm.title} onChange={(event) => setVolumeForm({ ...volumeForm, title: event.target.value })} placeholder="例如：第一卷 雾港来信" /></Field><Field label="卷摘要"><Textarea rows={5} value={volumeForm.summary} onChange={(event) => setVolumeForm({ ...volumeForm, summary: event.target.value })} placeholder="记录本卷核心目标、状态变化与卷末落点" /></Field></div></Modal>}
    {editingVolume && <Modal title="编辑分卷" onClose={() => setEditingVolume(null)} footer={<>{volumes.length > 1 && <Button variant="danger" onClick={deleteVolume}><Trash2 size={14} /> 删除分卷</Button>}<Button variant="ghost" onClick={() => setEditingVolume(null)}>取消</Button><Button onClick={saveVolume} disabled={!editingVolume.title.trim()}>保存</Button></>}><div className="form-grid"><Field label="卷名"><Input value={editingVolume.title} onChange={(event) => setEditingVolume({ ...editingVolume, title: event.target.value })} /></Field><Field label="卷摘要"><Textarea rows={6} value={editingVolume.summary} onChange={(event) => setEditingVolume({ ...editingVolume, summary: event.target.value })} placeholder="卷摘要会优先进入本卷章节的生成上下文" /></Field></div></Modal>}
  </div>
}
