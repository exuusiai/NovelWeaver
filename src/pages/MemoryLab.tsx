import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { BookOpenCheck, BrainCircuit, Check, ChevronRight, Database, ExternalLink, FileText, ListChecks, Loader2, Search, Sparkles, X } from 'lucide-react'
import { api, patch, post } from '../api'
import { useProject } from '../project-context'
import type { GenerationResult, SearchHit, StoryFact } from '../types'
import { Badge, Button, LoadingState, MarkdownLike, Textarea } from '../components/ui'

export function MemoryLab() {
  const { projectId } = useProject()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const [query, setQuery] = useState(params.get('q') || '第七码头与林澈失踪有什么关系？')
  const [results, setResults] = useState<SearchHit[]>([])
  const [selected, setSelected] = useState<SearchHit | null>(null)
  const [answer, setAnswer] = useState<GenerationResult | null>(null)
  const [searching, setSearching] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [error, setError] = useState('')
  const [facts, setFacts] = useState<StoryFact[]>([])
  const loadFacts = () => api<StoryFact[]>(`/api/projects/${projectId}/facts`).then(setFacts)
  const runSearch = async () => { setSearching(true); setError(''); try { const chapterId = sessionStorage.getItem('novelweaver.chapter') || ''; const data = await api<{ results: SearchHit[] }>(`/api/projects/${projectId}/search?q=${encodeURIComponent(query)}${chapterId ? `&chapterId=${encodeURIComponent(chapterId)}` : ''}`); setResults(data.results); setSelected(data.results[0] || null) } catch (caught) { setError((caught as Error).message) } finally { setSearching(false) } }
  useEffect(() => { const incoming = params.get('q'); if (incoming) setQuery(incoming) }, [params])
  useEffect(() => { runSearch(); loadFacts() }, [projectId, params])
  const ask = async () => { setThinking(true); setAnswer(null); setError(''); try { setAnswer(await post<GenerationResult>('/api/ai/generate', { projectId, task: 'analysis', prompt: query })) } catch (caught) { setError((caught as Error).message) } finally { setThinking(false) } }
  const setFactStatus = async (fact: StoryFact, canonStatus: StoryFact['canon_status']) => { const next = await patch<StoryFact>(`/api/facts/${fact.id}`, { canonStatus }); setFacts((rows) => rows.map((row) => row.id === next.id ? { ...row, ...next } : row)) }

  return <div className="memory-page">
    <section className="memory-search surface"><header><div><BrainCircuit size={20} /><div><h2>记忆检索实验室</h2><p>精确词、语义线索、实体关系与时间范围联合召回</p></div></div><Badge tone="teal">可追溯</Badge></header><div className="memory-query"><Search size={19} /><Textarea value={query} onChange={(event) => setQuery(event.target.value)} rows={2} /><Button onClick={runSearch} disabled={searching || thinking}>{searching ? <Loader2 className="spin" size={15} /> : <Search size={15} />} {searching ? '检索中…' : '检索'}</Button><Button variant="secondary" onClick={ask} disabled={thinking || searching || !query.trim()}>{thinking ? <Loader2 className="spin" size={15} /> : <Sparkles size={15} />} {thinking ? '思考中…' : '生成笔记'}</Button></div>{searching && <LoadingState label="正在搜索章节、设定与事件证据" />}{thinking && <LoadingState label="正在召回证据并整理 Markdown 笔记" />}{error && <p className="form-error memory-error">{error}</p>}{answer && <div className="memory-answer"><div className="answer-head"><Sparkles size={16} /><strong>基于记忆的分析笔记</strong><span>{answer.model}</span></div><MarkdownLike text={answer.output} /></div>}</section>
    <div className="memory-grid"><section className="surface memory-results"><header><div><h3>召回结果</h3><p>{results.length} 个证据片段</p></div><span>相关度</span></header>{results.map((hit, index) => <button key={hit.id} className={selected?.id === hit.id ? 'active' : ''} onClick={() => setSelected(hit)}><span className="result-rank">R{index + 1}</span><div><div><Badge>{hit.sourceType === 'chapter' ? '原文' : '设定'}</Badge>{hit.path && <Badge tone={hit.path === 'vector' ? 'blue' : 'teal'}>{hit.path === 'vector' ? '向量召回' : '词法召回'}</Badge>}<strong>{hit.summary || '记忆片段'}</strong></div><p>{hit.content.slice(0, 150)}{hit.content.length > 150 ? '…' : ''}</p><small>{hit.reason || hit.keywords}</small></div><span className="score">{Math.round(hit.score * 100)}%</span><ChevronRight size={15} /></button>)}</section>
      <aside className="surface evidence-view"><header><h3>证据详情</h3><BookOpenCheck size={18} /></header>{selected ? <><div className="evidence-meta"><span><FileText size={14} /> {selected.sourceType}</span><span><Database size={14} /> {selected.chapterId ? '章节记忆' : '结构化记忆'}</span>{selected.path && <span>{selected.path === 'vector' ? '向量语义通道' : '词法混合通道'}</span>}{typeof selected.chapterDistance === 'number' && <span>距当前章 {selected.chapterDistance} 章</span>}</div><blockquote>{selected.content}</blockquote><div className="evidence-foot"><strong>为什么召回</strong><p>{selected.reason || `命中关键词：${selected.keywords || '语义相关'}`}。结果同时考虑全文相关度、信息重要度与章节距离。</p>{selected.chapterId && <Button variant="secondary" onClick={() => { sessionStorage.setItem('novelweaver.chapter', selected.chapterId!); navigate('/write') }}><ExternalLink size={14} /> 打开原文章节</Button>}</div></> : <p>选择一个检索结果查看原始证据。</p>}</aside></div>
    <section className="surface fact-ledger"><header><div><ListChecks size={18} /><div><h3>事实摘要</h3><p>候选事实需人工确认后才作为正史优先注入</p></div></div><Badge tone="amber">{facts.filter((fact) => fact.canon_status === 'candidate').length} 待确认</Badge></header><div>{facts.length ? facts.slice(0, 40).map((fact) => <article key={fact.id} className={fact.canon_status}><div><Badge tone={fact.canon_status === 'canon' ? 'teal' : fact.canon_status === 'candidate' ? 'amber' : 'neutral'}>{fact.canon_status === 'canon' ? '正史' : fact.canon_status === 'candidate' ? '候选' : '废弃'}</Badge><strong>{fact.subject}</strong><span>{fact.predicate}</span></div><p>{fact.value}</p><small>{fact.source_chapter_title || '全局资料'}{fact.evidence ? ` · ${fact.evidence}` : ''}</small>{fact.canon_status === 'candidate' && <footer><Button variant="ghost" onClick={() => setFactStatus(fact, 'deprecated')}><X size={14} /> 废弃</Button><Button variant="secondary" onClick={() => setFactStatus(fact, 'canon')}><Check size={14} /> 确认为正史</Button></footer>}</article>) : <p className="fact-empty">分析文稿后，事件和状态变化会在这里形成可追溯的事实候选。</p>}</div></section>
    <section className="memory-architecture"><article><span>01</span><div><strong>原文证据</strong><p>章节与片段保留稳定引用</p></div></article><i /><article><span>02</span><div><strong>分层摘要</strong><p>场景、章节、卷与全书</p></div></article><i /><article><span>03</span><div><strong>正史事实</strong><p>事实、事件、角色状态与来源</p></div></article><i /><article><span>04</span><div><strong>上下文组装</strong><p>按任务预算动态装配</p></div></article></section>
  </div>
}
