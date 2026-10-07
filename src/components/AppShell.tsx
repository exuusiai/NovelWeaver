import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  BookOpenText, Boxes, BrainCircuit, ChevronDown, CircleGauge, CornerDownLeft,
  FileUp, FlaskConical, GitBranch, ListChecks, Menu, PanelLeftClose, PenLine, Pin, PinOff, Plus, Search, Settings, ShieldCheck, Sparkles,
} from 'lucide-react'
import { useProject } from '../project-context'
import { Button, Input, Modal, Textarea, Field } from './ui'
import { api, post } from '../api'
import type { Project } from '../types'

const nav = [
  ['/', '总览', CircleGauge],
  ['/write', '写作', PenLine],
  ['/plot', '剧情', GitBranch],
  ['/bible', '设定', Boxes],
  ['/memory', '记忆', BrainCircuit],
  ['/analysis', '分析', FlaskConical],
  ['/review', '审查', ShieldCheck],
  ['/settings', '设置', Settings],
] as const

const titles: Record<string, [string, string]> = {
  '/': ['项目总览', '把今天的创作推进到下一步'], '/write': ['章节工作台', '正文、细纲与上下文在同一处协作'],
  '/plot': ['剧情工程', '管理故事时间、叙事顺序与伏笔承诺'], '/bible': ['设定百科', '维护作品正史、候选事实与自定义档案'],
  '/memory': ['叙事记忆', '搜索原文证据并检查上下文召回'],
  '/analysis': ['分析中心', '管理长篇分析任务、质量指标与二次复核'],
  '/review': ['连续性审查', '发现设定漂移、遗漏与待确认事实'], '/settings': ['项目设置', '配置模型、导入导出与项目基线'],
}

export function AppShell() {
  const { projects, projectId, project, setProjectId, reloadProjects } = useProject()
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('novelweaver.sidebar.collapsed') === '1')
  const [pinned, setPinned] = useState(() => localStorage.getItem('novelweaver.sidebar.pinned') !== '0')
  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState({ name: '', genre: '', premise: '', wordGoal: 100000 })
  const [error, setError] = useState('')
  const [modelStatus, setModelStatus] = useState<{ configured: boolean; model: string; verifiedAt?: string; lastProbeError?: string } | null>(null)
  const location = useLocation()
  const navigate = useNavigate()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteQuery, setPaletteQuery] = useState('')
  const [paletteIndex, setPaletteIndex] = useState(0)
  const [title, subtitle] = titles[location.pathname] || ['NovelWeaver', '小说创作工作台']

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setPaletteOpen((open) => !open); setPaletteQuery(''); setPaletteIndex(0) }
      if (event.key === 'Escape') setPaletteOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => { localStorage.setItem('novelweaver.sidebar.collapsed', collapsed ? '1' : '0') }, [collapsed])
  useEffect(() => { localStorage.setItem('novelweaver.sidebar.pinned', pinned ? '1' : '0') }, [pinned])
  useEffect(() => { api<typeof modelStatus>('/api/model').then(setModelStatus).catch(() => setModelStatus(null)) }, [location.pathname])

  const paletteItems = (() => {
    const items: Array<{ key: string; label: string; hint: string; icon: typeof Search; run: () => void }> = []
    const q = paletteQuery.trim()
    if (q) items.push({ key: 'search', label: `在项目记忆中搜索「${q}」`, hint: '记忆实验室', icon: Search, run: () => navigate(`/memory?q=${encodeURIComponent(q)}`) })
    for (const [to, label, Icon] of nav) {
      if (q && !label.includes(q) && !to.includes(q.toLowerCase())) continue
      items.push({ key: `nav-${to}`, label, hint: to === '/' ? '项目总览' : `前往${label}`, icon: Icon, run: () => navigate(to) })
    }
    if (!q) {
      items.push({ key: 'act-import', label: '导入文稿', hint: '总览 · 预览后写入', icon: FileUp, run: () => navigate('/') })
      items.push({ key: 'act-review', label: '运行连续性审查', hint: '审查中心', icon: ListChecks, run: () => navigate('/review') })
      items.push({ key: 'act-write', label: '继续写作', hint: '章节工作台', icon: PenLine, run: () => navigate('/write') })
    }
    return items
  })()

  const runPaletteItem = (index: number) => {
    const item = paletteItems[index]
    if (!item) return
    setPaletteOpen(false)
    item.run()
  }

  const createProject = async () => {
    try {
      const next = await post<Project>('/api/projects', form)
      await reloadProjects(); setProjectId(next.id); setCreateOpen(false)
      setForm({ name: '', genre: '', premise: '', wordGoal: 100000 })
    } catch (caught) { setError((caught as Error).message) }
  }

  return <div className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''} ${pinned ? 'sidebar-pinned' : 'sidebar-floating'}`}>
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><BookOpenText size={19} /></div><div><strong>NovelWeaver</strong><span>叙事创作工作台</span></div></div>
      <div className="project-switcher">
        <label>当前项目</label>
        <div className="project-select-wrap"><select value={projectId} onChange={(event) => setProjectId(event.target.value)}>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><ChevronDown size={15} /></div>
        <button className="new-project" onClick={() => setCreateOpen(true)}><Plus size={15} /> 新建项目</button>
      </div>
      <nav>{nav.map(([to, label, Icon]) => <NavLink key={to} to={to} end={to === '/'} title={label}><Icon size={18} /><span>{label}</span>{label === '审查' && (project?.open_review_count ?? 0) > 0 && <b>{project?.open_review_count}</b>}</NavLink>)}</nav>
      <div className="sidebar-foot"><div className={`model-dot ${modelStatus?.verifiedAt ? '' : 'warning'}`} /><span>{modelStatus?.verifiedAt ? modelStatus.model : modelStatus?.configured ? 'API 未连通' : '本地规则模式'}</span><button className="sidebar-pin" onClick={() => setPinned((value) => !value)} title={pinned ? '取消固定左侧栏' : '固定左侧栏'}>{pinned ? <Pin size={15} /> : <PinOff size={15} />}</button></div>
    </aside>
    <main className="main-area">
      <header className="topbar">
        <button className="collapse-button" onClick={() => setCollapsed((value) => !value)} title={collapsed ? '展开侧栏' : '收起侧栏'}>{collapsed ? <Menu size={19} /> : <PanelLeftClose size={19} />}</button>
        <div className="page-heading"><h1>{title}</h1><p>{subtitle}</p></div>
        <div className="top-actions"><button className="command-search" onClick={() => { setPaletteOpen(true); setPaletteQuery(''); setPaletteIndex(0) }}><Search size={16} /><span>搜索项目记忆</span><kbd>⌘ K</kbd></button><button className={`ai-status ${modelStatus?.verifiedAt ? '' : 'warning'}`} title={modelStatus?.lastProbeError || ''}><Sparkles size={15} /> {modelStatus?.verifiedAt ? `${modelStatus.model} 已连接` : modelStatus?.configured ? 'API 未连通' : '本地规则模式'}</button></div>
      </header>
      <div className="page-container">{projectId ? <Outlet /> : <div className="no-project"><BookOpenText size={34} /><h2>先创建一个故事项目</h2><p>从零构思，或创建后导入已有文稿。</p><Button onClick={() => setCreateOpen(true)}>创建项目</Button></div>}</div>
    </main>
    {paletteOpen && <div className="palette-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setPaletteOpen(false) }}>
      <section className="palette" role="dialog" aria-modal="true" aria-label="命令面板">
        <div className="palette-input"><Search size={16} /><input
          autoFocus value={paletteQuery} placeholder="搜索记忆、跳转页面或执行操作…"
          onChange={(event) => { setPaletteQuery(event.target.value); setPaletteIndex(0) }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') { event.preventDefault(); setPaletteIndex((index) => Math.min(index + 1, paletteItems.length - 1)) }
            else if (event.key === 'ArrowUp') { event.preventDefault(); setPaletteIndex((index) => Math.max(index - 1, 0)) }
            else if (event.key === 'Enter') { event.preventDefault(); runPaletteItem(paletteIndex) }
          }} /><kbd>Esc</kbd></div>
        <div className="palette-list">{paletteItems.length ? paletteItems.map((item, index) => (
          <button key={item.key} className={index === paletteIndex ? 'active' : ''} onMouseEnter={() => setPaletteIndex(index)} onClick={() => runPaletteItem(index)}>
            <item.icon size={16} /><span>{item.label}</span><small>{item.hint}</small>{index === paletteIndex && <CornerDownLeft size={13} />}
          </button>)) : <p className="palette-empty">没有匹配的命令或页面</p>}</div>
        <footer><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>↵</kbd> 执行</span><span><kbd>Esc</kbd> 关闭</span></footer>
      </section>
    </div>}
    {createOpen && <Modal title="创建小说项目" onClose={() => setCreateOpen(false)} footer={<><Button variant="ghost" onClick={() => setCreateOpen(false)}>取消</Button><Button onClick={createProject} disabled={!form.name.trim()}>创建并进入</Button></>}>
      <div className="form-grid"><Field label="项目名称"><Input autoFocus value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：雾港纪事" /></Field><Field label="题材"><Input value={form.genre} onChange={(event) => setForm({ ...form, genre: event.target.value })} placeholder="奇幻、悬疑、科幻……" /></Field><Field label="目标字数"><Input type="number" value={form.wordGoal} onChange={(event) => setForm({ ...form, wordGoal: Number(event.target.value) })} /></Field><Field label="核心命题"><Textarea value={form.premise} onChange={(event) => setForm({ ...form, premise: event.target.value })} placeholder="一句话描述主角、目标、阻力与独特设定" rows={4} /></Field></div>{error && <p className="form-error">{error}</p>}
    </Modal>}
  </div>
}
