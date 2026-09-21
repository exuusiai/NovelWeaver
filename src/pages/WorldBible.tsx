import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, BookMarked, Bot, Building2, CircleUserRound, GitMerge, Globe2, History, LibraryBig, MapPinned, Plus, RotateCcw, Save, ScrollText, Search, Sparkles, Split, Swords, WandSparkles } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { api, patch, post } from '../api'
import { useProject } from '../project-context'
import type { Entity, EntityEdit, GenerationResult } from '../types'
import { Badge, Button, Field, Input, MarkdownLike, Modal, Textarea } from '../components/ui'

const types = [
  ['all', '全部', LibraryBig], ['character', '人物', CircleUserRound], ['location', '地点', MapPinned], ['faction', '势力', Building2],
  ['system', '体系', WandSparkles], ['item', '物品', Swords], ['world', '世界', Globe2], ['term', '术语', ScrollText],
] as const

type FieldSpec = { key: string; label: string; multiline?: boolean; hint?: string }
const schemas: Record<string, Array<{ title: string; fields: FieldSpec[] }>> = {
  character: [
    { title: '身份与称谓', fields: [['fullName', '完整姓名'], ['aliases', '普通别称与称谓'], ['narrativeIdentities', '独立叙事身份'], ['role', '叙事角色'], ['pronouns', '性别与代词'], ['age', '年龄'], ['birth', '出生信息'], ['species', '种族'], ['occupation', '职业'], ['faction', '阵营与归属']].map(field) },
    { title: '外观与身体', fields: [['appearance', '整体外貌', true], ['distinguishingMarks', '辨识特征'], ['clothing', '衣着风格'], ['health', '身体状态'], ['possessions', '标志物与持有物']].map(field) },
    { title: '心理驱动', fields: [['personality', '性格'], ['desire', '外在欲望'], ['need', '内在需求'], ['fear', '核心恐惧'], ['flaw', '致命缺陷'], ['falseBelief', '错误信念'], ['bottomLine', '道德底线'], ['secret', '秘密', true]].map(field) },
    { title: '能力与表达', fields: [['strengths', '优势'], ['weaknesses', '弱点'], ['abilities', '能力'], ['knowledge', '知识边界', true], ['voice', '语言风格', true], ['mannerisms', '习惯动作']].map(field) },
    { title: '经历与弧光', fields: [['background', '背景经历', true], ['trauma', '创伤与影响', true], ['arc', '人物弧与阶段', true], ['relationships', '关键关系', true], ['identityExposure', '身份暴露状态'], ['status', '当前状态']].map(field) },
  ],
  location: [
    { title: '空间与环境', fields: [['geography', '地理位置'], ['terrain', '地貌'], ['climate', '气候与季节'], ['districts', '区域划分'], ['landmarks', '地标'], ['access', '进入条件'], ['transport', '交通方式'], ['hazards', '自然与人为危险']].map(field) },
    { title: '人口与秩序', fields: [['population', '人口规模'], ['species', '族群构成'], ['governance', '治理者'], ['law', '法律与禁忌'], ['economy', '经济活动'], ['resources', '资源与物产'], ['security', '治安与防卫']].map(field) },
    { title: '文化与叙事', fields: [['culture', '文化价值观', true], ['language', '语言'], ['religion', '信仰'], ['customs', '风俗节庆', true], ['food', '饮食'], ['architecture', '建筑风格'], ['history', '历史沿革', true], ['currentConflict', '当前矛盾', true], ['sceneUse', '剧情用途', true]].map(field) },
  ],
  faction: [
    { title: '组织基线', fields: [['type', '组织类型'], ['ideology', '理念与信条'], ['goal', '公开目标'], ['hiddenGoal', '真实目标'], ['leader', '领袖'], ['headquarters', '总部'], ['status', '当前状态']].map(field) },
    { title: '结构与运作', fields: [['hierarchy', '层级结构', true], ['ranks', '职级与称号'], ['recruitment', '招募与加入'], ['members', '重要成员'], ['resources', '资源'], ['methods', '行事方式'], ['laws', '内部规则与惩罚', true]].map(field) },
    { title: '势力关系', fields: [['territory', '控制区域'], ['allies', '盟友'], ['enemies', '敌对方'], ['reputation', '外界评价'], ['internalConflict', '内部矛盾', true], ['history', '组织历史', true]].map(field) },
  ],
  system: [
    { title: '体系原理', fields: [['category', '体系类别'], ['source', '力量来源'], ['principles', '基本原理', true], ['tiers', '等级与进阶'], ['acquisition', '获得方式'], ['training', '训练方式'], ['activation', '发动条件']].map(field) },
    { title: '能力与平衡', fields: [['abilities', '能力范围', true], ['cost', '使用代价'], ['limitations', '硬性限制', true], ['counters', '克制手段'], ['exceptions', '例外与漏洞'], ['failure', '失败后果']].map(field) },
    { title: '载体与社会', fields: [['artifacts', '相关媒介与物品'], ['users', '已知使用者'], ['institutions', '管理机构'], ['socialImpact', '社会影响', true], ['history', '体系历史', true]].map(field) },
  ],
  item: [
    { title: '物品基线', fields: [['category', '物品类别'], ['owner', '当前持有者'], ['creator', '制造者'], ['origin', '来源'], ['appearance', '外观'], ['material', '材质'], ['location', '当前位置'], ['status', '当前状态']].map(field) },
    { title: '规则与意义', fields: [['function', '功能', true], ['activation', '使用条件'], ['limitations', '限制'], ['cost', '代价'], ['history', '流转历史', true], ['symbolism', '象征意义'], ['relatedEntities', '关联角色与势力']].map(field) },
  ],
  world: [
    { title: '自然基线', fields: [['era', '时代'], ['calendar', '历法与时间'], ['geography', '地理格局', true], ['cosmology', '宇宙观'], ['species', '种族与生态'], ['resources', '关键资源']].map(field) },
    { title: '社会结构', fields: [['politics', '政治格局'], ['law', '法律秩序'], ['economy', '经济与贸易'], ['religion', '宗教信仰'], ['technology', '技术水平'], ['transport', '交通通信'], ['languages', '语言文字'], ['education', '教育与知识']].map(field) },
    { title: '生活与历史', fields: [['customs', '社会习俗', true], ['dailyLife', '日常生活', true], ['conflicts', '核心冲突', true], ['history', '历史纪元', true]].map(field) },
  ],
  term: [
    { title: '术语档案', fields: [['definition', '精确定义', true], ['aliases', '别称与旧称'], ['category', '所属领域'], ['usage', '使用语境', true], ['origin', '词源与由来'], ['firstAppearance', '首次出现'], ['relatedTerms', '关联术语'], ['misconceptions', '常见误解', true]].map(field) },
  ],
}

function field(row: Array<string | boolean>): FieldSpec { return { key: String(row[0]), label: String(row[1]), multiline: Boolean(row[2]) } }
function initialData(type: string) { return Object.fromEntries((schemas[type] || []).flatMap((group) => group.fields).map(({ key }) => [key, ''])) }

type DuplicateSuggestion = { leftId: string; leftName: string; rightId: string; rightName: string; reason: string }

export function WorldBible() {
  const { projectId } = useProject()
  const [entities, setEntities] = useState<Entity[]>([])
  const [type, setType] = useState('all')
  const [selectedId, setSelectedId] = useState('')
  const [draft, setDraft] = useState<Entity | null>(null)
  const [query, setQuery] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState({ type: 'character', name: '', summary: '' })
  const [aiOpen, setAiOpen] = useState(false)
  const [aiPrompt, setAiPrompt] = useState('补全当前设定档案，只使用项目正史和原文证据，未知项留空。')
  const [result, setResult] = useState<GenerationResult | null>(null)
  const [correctionOpen, setCorrectionOpen] = useState(false)
  const [correctionMode, setCorrectionMode] = useState<'rename' | 'merge' | 'split'>('rename')
  const [correctionName, setCorrectionName] = useState('')
  const [mergeSourceId, setMergeSourceId] = useState('')
  const [linkAsIdentity, setLinkAsIdentity] = useState(false)
  const [edits, setEdits] = useState<EntityEdit[]>([])
  const [duplicateSuggestions, setDuplicateSuggestions] = useState<DuplicateSuggestion[]>([])
  const navigate = useNavigate()
  const load = async () => { const [rows, suggestions] = await Promise.all([api<Entity[]>(`/api/projects/${projectId}/entities`), api<DuplicateSuggestion[]>(`/api/projects/${projectId}/entities/duplicate-suggestions`)]); setEntities(rows); setDuplicateSuggestions(suggestions); const id = rows.some((row) => row.id === selectedId) ? selectedId : rows[0]?.id || ''; setSelectedId(id); setDraft(rows.find((row) => row.id === id) || null) }
  useEffect(() => { load() }, [projectId])
  useEffect(() => { const entity = entities.find((row) => row.id === selectedId); if (entity) setDraft(structuredClone(entity)) }, [selectedId, entities])
  const filtered = useMemo(() => entities.filter((entity) => (type === 'all' || entity.type === type) && (!query || `${entity.name}${entity.summary}`.toLowerCase().includes(query.toLowerCase()))), [entities, type, query])
  const createEntity = async () => { const entity = await post<Entity>(`/api/projects/${projectId}/entities`, { ...form, data: initialData(form.type), canonStatus: 'canon' }); setEntities([...entities, entity]); setSelectedId(entity.id); setCreateOpen(false); setForm({ type: 'character', name: '', summary: '' }) }
  const save = async () => { if (!draft) return; const entity = await patch<Entity>(`/api/entities/${draft.id}`, { name: draft.name, type: draft.type, summary: draft.summary, data: draft.data, canonStatus: draft.canon_status, confidence: draft.confidence }); setEntities((rows) => rows.map((row) => row.id === entity.id ? entity : row)); setDraft(entity) }
  const updateData = (key: string, value: unknown) => { if (draft) setDraft({ ...draft, data: { ...draft.data, [key]: value } }) }
  const addField = () => { if (!draft) return; let index = 1; while (`自定义字段${index}` in draft.data) index += 1; setDraft({ ...draft, data: { ...draft.data, [`自定义字段${index}`]: '' } }) }
  const changeType = (next: string) => { if (!draft) return; setDraft({ ...draft, type: next, data: { ...initialData(next), ...draft.data } }) }
  const generateSetting = async () => { setResult(await post<GenerationResult>('/api/ai/generate', { projectId, task: 'setting', prompt: `${draft?.name || ''}：${aiPrompt}` })) }
  const openCorrection = async () => { if (!draft) return; setCorrectionName(draft.name); setMergeSourceId(entities.find((entity) => entity.id !== draft.id)?.id || ''); setLinkAsIdentity(false); setEdits(await api<EntityEdit[]>(`/api/projects/${projectId}/entity-edits`)); setCorrectionOpen(true) }
  const reviewDuplicate = async (suggestion: DuplicateSuggestion) => { const target = entities.find((entity) => entity.id === suggestion.leftId); if (!target) return; setSelectedId(target.id); setDraft(structuredClone(target)); setCorrectionMode('merge'); setCorrectionName(target.name); setMergeSourceId(suggestion.rightId); setLinkAsIdentity(false); setEdits(await api<EntityEdit[]>(`/api/projects/${projectId}/entity-edits`)); setCorrectionOpen(true) }
  const applyCorrection = async () => {
    if (!draft || !correctionName.trim()) return
    if (correctionMode === 'rename') await post(`/api/entities/${draft.id}/rename`, { name: correctionName, aliases: [] })
    else if (correctionMode === 'merge') await post(`/api/projects/${projectId}/entities/merge`, { targetId: draft.id, sourceIds: [mergeSourceId] })
    else await post(`/api/entities/${draft.id}/split`, { name: correctionName, type: draft.type, summary: '', aliases: [], linkAsIdentity })
    setCorrectionOpen(false); await load()
  }
  const undoEdit = async (editId: string) => { await post(`/api/entity-edits/${editId}/undo`, {}); setEdits(await api<EntityEdit[]>(`/api/projects/${projectId}/entity-edits`)); await load() }
  const predefined = new Set((schemas[draft?.type || ''] || []).flatMap((group) => group.fields.map((item) => item.key)))

  return <div className="bible-layout"><section className="bible-browser surface"><header><div><BookMarked size={19} /><div><h2>设定百科</h2><span>{entities.length} 条记录</span></div></div><Button onClick={() => setCreateOpen(true)}><Plus size={15} /> 新建</Button></header><div className="type-tabs">{types.map(([value, label, Icon]) => <button key={value} className={type === value ? 'active' : ''} onClick={() => setType(value)}><Icon size={15} /> {label}<span>{value === 'all' ? entities.length : entities.filter((row) => row.type === value).length}</span></button>)}</div><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称或摘要…" />{duplicateSuggestions.length > 0 && <button className="duplicate-banner" onClick={() => reviewDuplicate(duplicateSuggestions[0])}><AlertTriangle size={15} /><span><strong>{duplicateSuggestions.length} 组疑似重复人物</strong><small>{duplicateSuggestions[0].leftName} / {duplicateSuggestions[0].rightName}，点击审阅</small></span></button>}<div className="entity-list">{filtered.map((entity) => <button key={entity.id} className={selectedId === entity.id ? 'active' : ''} onClick={() => setSelectedId(entity.id)}><span className={`entity-avatar type-${entity.type}`}>{entity.name.slice(0, 1)}</span><div><strong>{entity.name}</strong><p>{entity.summary || '暂无摘要'}</p></div><span className={`canon-dot ${entity.canon_status}`} title={entity.canon_status} /></button>)}</div></section>
    <section className="entity-editor surface">{draft ? <><header><div><Badge tone={draft.canon_status === 'canon' ? 'teal' : 'amber'}>{draft.canon_status === 'canon' ? '正史' : draft.canon_status === 'candidate' ? '候选' : draft.canon_status}</Badge><span>{labelType(draft.type)}档案 · 更新于 {new Date(draft.updated_at).toLocaleDateString('zh-CN')}</span></div><div><Button variant="ghost" onClick={() => navigate(`/memory?q=${encodeURIComponent(draft.name)}`)}><Search size={15} /> 查看原文证据</Button><Button variant="secondary" onClick={openCorrection}><GitMerge size={15} /> 实体纠错</Button><Button variant="secondary" onClick={() => setAiOpen(true)}><Sparkles size={15} /> AI 补全</Button><Button onClick={save}><Save size={15} /> 保存</Button></div></header><div className="entity-form"><div className="entity-title-row"><Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /><select className="input" value={draft.type} onChange={(event) => changeType(event.target.value)}>{types.filter(([value]) => value !== 'all').map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select className="input" value={draft.canon_status} onChange={(event) => setDraft({ ...draft, canon_status: event.target.value })}><option value="canon">正史</option><option value="candidate">候选</option><option value="rumor">传闻</option><option value="branch">分支</option><option value="deprecated">废弃</option></select></div><Field label="核心摘要"><Textarea rows={4} value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} /></Field>
      <section className="schema-group card-context-settings"><div className="custom-fields-heading"><div><h3>上下文策略</h3><p>控制资料卡何时进入生成上下文</p></div></div><div className="custom-fields"><label><span>作用范围</span><select className="input" value={displayValue(draft.data.contextScope) || 'project'} onChange={(event) => updateData('contextScope', event.target.value)}><option value="project">全书</option><option value="volume">当前卷</option><option value="chapter">指定章节附近</option><option value="manual">仅手动引用</option></select></label><label><span>上下文优先级（0-100）</span><Input type="number" min={0} max={100} value={Number(draft.data.contextPriority ?? 50)} onChange={(event) => updateData('contextPriority', Number(event.target.value))} /></label><label className="identity-option card-pin"><input type="checkbox" checked={draft.data.pinned === true || draft.data.pinned === 'true'} onChange={(event) => updateData('pinned', event.target.checked)} /><span><strong>固定到生成上下文</strong><small>在预算允许时优先注入这张资料卡。</small></span></label><label><span>最后引用章节</span><Input value={displayValue(draft.data.lastReferencedChapter)} onChange={(event) => updateData('lastReferencedChapter', event.target.value)} placeholder="可选，用于人工追踪" /></label></div></section>
      {(schemas[draft.type] || []).map((group) => <section className="schema-group" key={group.title}><div className="custom-fields-heading"><div><h3>{group.title}</h3><p>{labelType(draft.type)}专用档案字段</p></div></div><div className="custom-fields">{group.fields.map((item) => <label key={item.key}><span>{item.label}</span>{item.multiline ? <Textarea rows={3} value={displayValue(draft.data[item.key])} onChange={(event) => updateData(item.key, event.target.value)} /> : <Input value={displayValue(draft.data[item.key])} onChange={(event) => updateData(item.key, event.target.value)} />}</label>)}</div></section>)}
      <div className="custom-fields-heading"><div><h3>自定义字段</h3><p>保留题材特有信息</p></div><Button variant="ghost" onClick={addField}><Plus size={14} /> 添加字段</Button></div><div className="custom-fields">{Object.entries(draft.data).filter(([key]) => !predefined.has(key) && !['evidence', 'source', 'contextScope', 'contextPriority', 'pinned', 'lastReferencedChapter'].includes(key)).map(([key, value]) => <label key={key}><span>{key}</span><Input value={displayValue(value)} onChange={(event) => updateData(key, event.target.value)} /></label>)}</div><div className="source-panel"><h3>来源与记忆治理</h3><div><span>事实置信度</span><div className="confidence"><i style={{ width: `${draft.confidence * 100}%` }} /></div><strong>{Math.round(draft.confidence * 100)}%</strong></div><p>{Array.isArray(draft.data.evidence) ? `原文证据：${draft.data.evidence.join('；')}` : '手动条目或尚未记录原文证据。'} 候选不会静默升级为正史。</p></div></div></> : <div className="entity-none"><BookMarked size={28} /><p>选择一条设定查看详情</p></div>}</section>
    {createOpen && <Modal title="新建设定" onClose={() => setCreateOpen(false)} footer={<><Button variant="ghost" onClick={() => setCreateOpen(false)}>取消</Button><Button onClick={createEntity} disabled={!form.name}>创建</Button></>}><div className="form-grid"><Field label="类型"><select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>{types.filter(([value]) => value !== 'all').map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field label="名称"><Input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field><Field label="摘要"><Textarea rows={4} value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} /></Field></div></Modal>}
    {aiOpen && <Modal title="AI 设定工坊" onClose={() => setAiOpen(false)} footer={<><Button variant="ghost" onClick={() => setAiOpen(false)}>关闭</Button><Button onClick={generateSetting}><Bot size={15} /> 生成候选</Button></>}><Field label="创作要求"><Textarea rows={4} value={aiPrompt} onChange={(event) => setAiPrompt(event.target.value)} /></Field>{result && <MarkdownLike text={result.output} />}</Modal>}
    {correctionOpen && draft && <Modal title="实体纠错与修订历史" onClose={() => setCorrectionOpen(false)} footer={<><Button variant="ghost" onClick={() => setCorrectionOpen(false)}>取消</Button><Button onClick={applyCorrection} disabled={!correctionName.trim() || (correctionMode === 'merge' && !mergeSourceId)}>{correctionMode === 'rename' ? '确认重命名' : correctionMode === 'merge' ? '确认合并' : '确认拆分'}</Button></>}><div className="correction-tabs"><button className={correctionMode === 'rename' ? 'active' : ''} onClick={() => { setCorrectionMode('rename'); setCorrectionName(draft.name) }}><History size={14} /> 重命名</button><button className={correctionMode === 'merge' ? 'active' : ''} onClick={() => { setCorrectionMode('merge'); setCorrectionName(draft.name) }}><GitMerge size={14} /> 合并别名</button><button className={correctionMode === 'split' ? 'active' : ''} onClick={() => { setCorrectionMode('split'); setCorrectionName('') }}><Split size={14} /> 拆分实体</button></div>{correctionMode === 'merge' ? <><Field label="保留为"><Input value={draft.name} disabled /></Field><Field label="合并此条目"><select className="input" value={mergeSourceId} onChange={(event) => setMergeSourceId(event.target.value)}>{entities.filter((entity) => entity.id !== draft.id).map((entity) => <option key={entity.id} value={entity.id}>{entity.name} · {labelType(entity.type)}</option>)}</select></Field><p className="correction-note">关联记录和普通别称将迁移到“{draft.name}”，原条目会被移除；操作可撤销。</p></> : <><Field label={correctionMode === 'rename' ? '新规范名称' : '拆出的新实体名称'}><Input value={correctionName} onChange={(event) => setCorrectionName(event.target.value)} /></Field>{correctionMode === 'split' && <label className="identity-option"><input type="checkbox" checked={linkAsIdentity} onChange={(event) => setLinkAsIdentity(event.target.checked)} /><span><strong>保留为同一人的独立身份</strong><small>两个档案都保留，并记录“同一人的不同身份”关系，供后续功能使用。</small></span></label>}</>}<section className="edit-history"><h3>最近修订</h3>{edits.filter((edit) => !edit.undone).slice(0, 6).map((edit) => <article key={edit.id}><div><strong>{edit.action === 'rename' ? '重命名' : edit.action === 'merge' ? '实体合并' : '实体拆分'}</strong><small>{new Date(edit.created_at).toLocaleString('zh-CN')}</small></div><Button variant="ghost" onClick={() => undoEdit(edit.id)}><RotateCcw size={14} /> 撤销</Button></article>)}</section></Modal>}
  </div>
}

function displayValue(value: unknown) { return Array.isArray(value) ? value.join('、') : String(value ?? '') }
function labelType(type: string) { return ({ character: '人物', location: '地点', faction: '势力', system: '体系', item: '物品', world: '世界', term: '术语' } as Record<string, string>)[type] || type }
