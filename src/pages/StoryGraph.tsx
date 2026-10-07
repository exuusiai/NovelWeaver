import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Background, Controls, Handle, MiniMap, Position, ReactFlow, type Edge, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react'
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force'
import { Focus, Link2, Loader2, Network, Plus, RefreshCw, Search, SlidersHorizontal, X } from 'lucide-react'
import { api, post } from '../api'
import { useProject } from '../project-context'
import type { Chapter, Entity, Foreshadowing, Plotline, Relation, StoryEvent } from '../types'
import { Badge, Button, Field, IconButton, Input, LoadingState, Modal } from '../components/ui'

const nodeColors: Record<string, string> = { character: '#14746f', location: '#58718f', faction: '#a45b36', system: '#735b8e', item: '#8a7441' }
const modes = [
  ['characters', '人物关系', ['character']],
  ['factions', '势力关系', ['faction']],
  ['locations', '地点关联', ['location']],
  ['events', '事件因果', []],
  ['foreshadowing', '伏笔网络', []],
] as const

// 四向隐形锚点：ReactFlow 默认把边汇到节点中心，枢纽节点的十几条线会全部重叠；
// 让每条边从"朝向对方的边侧"进出，扇形自然展开。
const anchorHandleStyle = { visibility: 'hidden' as const, width: 2, height: 2, border: 'none', background: 'transparent', minWidth: 0, minHeight: 0 }
const anchorPositions = [['t', Position.Top], ['r', Position.Right], ['b', Position.Bottom], ['l', Position.Left]] as const

function AnchorNode({ data }: NodeProps) {
  return <>
    {anchorPositions.map(([id, position]) => <Handle key={`s-${id}`} type="source" id={id} position={position} style={anchorHandleStyle} isConnectable={false} />)}
    {anchorPositions.map(([id, position]) => <Handle key={`t-${id}`} type="target" id={id} position={position} style={anchorHandleStyle} isConnectable={false} />)}
    {(data as { label: ReactNode }).label}
  </>
}

const nodeTypes = { entity: AnchorNode }

type LayoutNode = SimulationNodeDatum & { id: string }
type LayoutLink = SimulationLinkDatum<LayoutNode> & { relation: Relation }

function forcePositions(entities: Entity[], relations: Relation[], anchors?: Map<string, { x: number; y: number }>) {
  if (!entities.length) return new Map<string, { x: number; y: number }>()
  const radius = Math.max(220, entities.length * 22)
  const nodes: LayoutNode[] = entities.map((entity, index) => ({ id: entity.id, x: Math.cos(index / entities.length * Math.PI * 2) * radius, y: Math.sin(index / entities.length * Math.PI * 2) * radius }))
  const links: LayoutLink[] = relations.map((relation) => ({ source: relation.from_entity_id, target: relation.to_entity_id, relation }))
  const simulation = forceSimulation(nodes)
    .force('link', forceLink<LayoutNode, LayoutLink>(links).id((node) => node.id).distance((link) => link.relation.type === 'same_person' ? 280 : 225).strength(anchors?.size ? .42 : .5))
    .force('charge', forceManyBody().strength(entities.length > 35 ? -1250 : -900))
    .force('center', forceCenter(0, 0))
    .force('collision', forceCollide<LayoutNode>().radius(132).strength(.98))
    .stop()
  if (anchors?.size) {
    // 分簇引力：成员被拉向各自家族/势力的圆周锚点，跨族边自然拉长变稀疏
    simulation
      .force('groupX', forceX<LayoutNode>((node) => anchors.get(node.id)?.x ?? 0).strength(.34))
      .force('groupY', forceY<LayoutNode>((node) => anchors.get(node.id)?.y ?? 0).strength(.34))
  }
  for (let tick = 0; tick < 240; tick += 1) simulation.tick()
  return new Map(nodes.map((node) => [node.id, { x: (node.x || 0) + 640, y: (node.y || 0) + 430 }]))
}

const groupPalette = ['#14746f', '#a45b36', '#496982', '#735b8e', '#8a7441', '#3d7048', '#9b4a6e', '#5b7a9e']

interface GroupMeta { id: string; name: string; color: string; memberCount: number }
interface GroupResult { assignment: Map<string, { groupId: string; name: string; color: string }>; meta: GroupMeta[] }

// 家族/势力分组：人物经 member 关系挂到的组织实体。家族常被分析器标为 location
// （如首无的秘守家/二守家），所以 location 也算合法锚点；少于 2 名成员的组不成簇。
function resolveGroups(entities: Entity[], relations: Relation[]): GroupResult {
  const entityById = new Map(entities.map((entity) => [entity.id, entity]))
  const members = new Map<string, Set<string>>()
  for (const relation of relations) {
    if (relation.type !== 'member') continue
    const from = entityById.get(relation.from_entity_id)
    const to = entityById.get(relation.to_entity_id)
    if (!from || !to || from.type !== 'character' || !['faction', 'location'].includes(to.type)) continue
    const set = members.get(to.id) ?? new Set<string>()
    set.add(from.id)
    members.set(to.id, set)
  }
  const qualified = [...members.entries()].filter(([, set]) => set.size >= 2)
    .sort((a, b) => (entityById.get(a[0])?.name || '').localeCompare(entityById.get(b[0])?.name || ''))
  if (qualified.length < 2) return { assignment: new Map(), meta: [] }
  const meta: GroupMeta[] = qualified.slice(0, groupPalette.length).map(([id, set]) => ({ id, name: entityById.get(id)?.name || id, color: groupPalette[qualified.findIndex((entry) => entry[0] === id) % groupPalette.length], memberCount: set.size }))
  const assignment = new Map<string, { groupId: string; name: string; color: string }>()
  for (const group of meta) {
    for (const memberId of members.get(group.id) ?? []) {
      if (!assignment.has(memberId)) assignment.set(memberId, { groupId: group.id, name: group.name, color: group.color })
    }
  }
  return { assignment, meta }
}

function neighborIds(origin: string, relations: Relation[], hops: 1 | 2) {
  const visible = new Set([origin])
  let frontier = new Set([origin])
  for (let depth = 0; depth < hops; depth += 1) {
    const next = new Set<string>()
    relations.forEach((relation) => {
      if (frontier.has(relation.from_entity_id)) next.add(relation.to_entity_id)
      if (frontier.has(relation.to_entity_id)) next.add(relation.from_entity_id)
    })
    next.forEach((id) => visible.add(id)); frontier = next
  }
  return visible
}

export function StoryGraph() {
  const { projectId } = useProject()
  const navigate = useNavigate()
  const [entities, setEntities] = useState<Entity[]>([])
  const [relations, setRelations] = useState<Relation[]>([])
  const [plot, setPlot] = useState<{ plotlines: Plotline[]; events: StoryEvent[]; foreshadowing: Foreshadowing[] }>({ plotlines: [], events: [], foreshadowing: [] })
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [mode, setMode] = useState<(typeof modes)[number][0]>('characters')
  const [scope, setScope] = useState<'review' | 'canon'>('review')
  const [open, setOpen] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [analysisNotice, setAnalysisNotice] = useState('')
  const [query, setQuery] = useState('')
  const [focusId, setFocusId] = useState('')
  const [hops, setHops] = useState<1 | 2>(1)
  const [hideIsolated, setHideIsolated] = useState(true)
  const [minStrength, setMinStrength] = useState(0)
  const [selectedNodeId, setSelectedNodeId] = useState('')
  const [selectedRelationId, setSelectedRelationId] = useState('')
  const [flow, setFlow] = useState<ReactFlowInstance | null>(null)
  const [form, setForm] = useState({ fromEntityId: '', toEntityId: '', type: 'alliance', label: '', sentiment: 'neutral', strength: 50 })

  const load = async () => {
    const [graphData, plotData, chapterRows] = await Promise.all([
      api<{ entities: Entity[]; relations: Relation[] }>(`/api/projects/${projectId}/graph`),
      api<typeof plot>(`/api/projects/${projectId}/plot`),
      api<Chapter[]>(`/api/projects/${projectId}/chapters`),
    ])
    setEntities(graphData.entities); setRelations(graphData.relations); setPlot(plotData); setChapters(chapterRows)
  }
  useEffect(() => { load() }, [projectId])

  const groupResult = useMemo(
    () => mode === 'characters' ? resolveGroups(entities, relations) : { assignment: new Map<string, { groupId: string; name: string; color: string }>(), meta: [] as GroupMeta[] },
    [entities, relations, mode])
  const allowed = modes.find(([key]) => key === mode)?.[2] || ['character']
  const baseEntities = useMemo(() => entities.filter((entity) => allowed.includes(entity.type as never) && (scope === 'review' ? ['canon', 'candidate'].includes(entity.canon_status) : entity.canon_status === 'canon')), [entities, allowed, scope])
  const searchResults = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return []
    return baseEntities.filter((entity) => `${entity.name} ${displayValue(entity.data?.aliases)} ${entity.summary}`.toLowerCase().includes(needle)).slice(0, 8)
  }, [baseEntities, query])

  const graph = useMemo(() => {
    if (mode === 'events') {
      const visible = [...plot.events].sort((a, b) => a.narrative_order - b.narrative_order)
      const nodes: Node[] = visible.map((event, index) => ({ id: event.id, position: { x: (index % 4) * 250, y: Math.floor(index / 4) * 150 }, data: { label: <div className="graph-node graph-event"><span>{index + 1}</span><div><strong>{event.title}</strong><small>{event.story_time || '时间待定'}</small></div></div> }, style: graphStyle('#496982') }))
      const edges: Edge[] = visible.slice(0, -1).map((event, index) => { const next = visible[index + 1]; const line = event.plotline_id && event.plotline_id === next.plotline_id ? plot.plotlines.find((item) => item.id === event.plotline_id) : undefined; return { id: `sequence-${event.id}`, source: event.id, target: next.id, type: 'smoothstep', label: line?.name || '叙事顺序', style: { stroke: line?.color || '#89918f', strokeWidth: line ? 2 : 1.2, strokeDasharray: line ? undefined : '5 4' }, labelStyle: { fontSize: 9, fill: line?.color || '#68706e' } } })
      return { nodes, edges }
    }
    if (mode === 'foreshadowing') {
      const chapterIds = new Set(plot.foreshadowing.flatMap((item) => [item.setup_chapter_id, item.payoff_chapter_id]).filter(Boolean))
      const relatedChapters = chapters.filter((chapter) => chapterIds.has(chapter.id))
      const chapterNodes: Node[] = relatedChapters.map((chapter, index) => ({ id: chapter.id, position: { x: 40, y: index * 130 }, data: { label: <div className="graph-node"><span style={{ background: '#58718f' }}>章</span><div><strong>{chapter.title}</strong><small>章节</small></div></div> }, style: graphStyle('#58718f') }))
      const clueNodes: Node[] = plot.foreshadowing.map((item, index) => ({ id: item.id, position: { x: 420, y: index * 150 + 30 }, data: { label: <div className="graph-node"><span style={{ background: item.status === 'resolved' ? '#14746f' : '#9b7429' }}>伏</span><div><strong>{item.title}</strong><small>{item.status === 'resolved' ? '已回收' : '待回收'}</small></div></div> }, style: graphStyle(item.status === 'resolved' ? '#14746f' : '#9b7429') }))
      const edges: Edge[] = plot.foreshadowing.flatMap((item) => [...(item.setup_chapter_id ? [{ id: `${item.id}-setup`, source: item.setup_chapter_id, target: item.id, type: 'smoothstep', label: '埋设', style: { stroke: '#9b7429' } } as Edge] : []), ...(item.payoff_chapter_id ? [{ id: `${item.id}-payoff`, source: item.id, target: item.payoff_chapter_id, type: 'smoothstep', label: '回收', style: { stroke: '#14746f' } } as Edge] : [])])
      return { nodes: [...chapterNodes, ...clueNodes], edges }
    }

    const baseIds = new Set(baseEntities.map((entity) => entity.id))
    let visibleRelations = relations.filter((relation) => baseIds.has(relation.from_entity_id) && baseIds.has(relation.to_entity_id) && relation.strength >= minStrength)
    let visible = baseEntities
    if (focusId && baseIds.has(focusId)) {
      const neighbors = neighborIds(focusId, visibleRelations, hops)
      visible = visible.filter((entity) => neighbors.has(entity.id))
    } else if (hideIsolated) {
      const connected = new Set(visibleRelations.flatMap((relation) => [relation.from_entity_id, relation.to_entity_id]))
      visible = visible.filter((entity) => connected.has(entity.id))
    }
    const ids = new Set(visible.map((entity) => entity.id))
    visibleRelations = visibleRelations.filter((relation) => ids.has(relation.from_entity_id) && ids.has(relation.to_entity_id))
    const anchors = new Map<string, { x: number; y: number }>()
    if (groupResult.meta.length >= 2) {
      const clusterRadius = Math.max(560, visible.length * 26)
      groupResult.meta.forEach((group, index) => {
        const angle = (index / groupResult.meta.length) * Math.PI * 2 - Math.PI / 2
        const anchor = { x: Math.cos(angle) * clusterRadius, y: Math.sin(angle) * clusterRadius }
        for (const [memberId, membership] of groupResult.assignment) {
          if (membership.groupId === group.id && ids.has(memberId)) anchors.set(memberId, anchor)
        }
      })
    }
    const positions = forcePositions(visible, visibleRelations, anchors)
    const showLabels = Boolean(focusId || selectedNodeId)
    const nodes: Node[] = visible.map((entity) => ({ id: entity.id, type: 'entity' as const, position: positions.get(entity.id) || { x: 0, y: 0 }, data: { label: <div className="graph-node"><span style={{ background: groupResult.assignment.get(entity.id)?.color || nodeColors[entity.type] || '#687078' }}>{entity.name.slice(0, 1)}</span><div><strong>{entity.name}</strong><small>{labelType(entity.type)}{entity.canon_status === 'candidate' ? ' · 候选' : ' · 正史'}</small></div></div> }, style: { width: 190, border: `${entity.id === focusId || entity.id === selectedNodeId ? 2 : 1}px ${entity.canon_status === 'candidate' ? 'dashed' : 'solid'} ${entity.id === focusId ? '#aa5a35' : entity.id === selectedNodeId ? '#202625' : entity.canon_status === 'candidate' ? '#c7973f' : groupResult.assignment.get(entity.id)?.color || `${nodeColors[entity.type] || '#687078'}88`}`, borderRadius: 6, boxShadow: entity.id === focusId ? '0 7px 24px rgba(170,90,53,.2)' : '0 4px 16px rgba(30,38,37,.08)', padding: 0, background: entity.canon_status === 'candidate' ? '#fffcf5' : '#fff' } }))
    // 依据布局坐标为每条边挑最近的边侧：|dx|>|dy| 走左右侧，否则走上下侧
    const handleFor = (from: { x: number; y: number }, to: { x: number; y: number }) => {
      const dx = to.x - from.x
      const dy = to.y - from.y
      return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'r' : 'l') : (dy > 0 ? 'b' : 't')
    }
    // 密集语料（首无 51 条关系）里两类线重叠最伤可读性：同一对节点的平行关系
    // 以相同贝塞尔几何完全重合；不同对的边共享锚段时近段重合。前者按组内序号
    // 递增曲率扇出，后者用 id 哈希做微小曲率差，配合收窄线宽降低交叉的视觉重量。
    const pairSeen = new Map<string, number>()
    const hashCurvature = (id: string) => { let hash = 0; for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) % 997; return 0.16 + (hash % 4) * 0.05 }
    const edges: Edge[] = visibleRelations.map((relation) => {
      const identity = relation.type === 'same_person' || relation.type === 'identity_of'
      const selected = relation.id === selectedRelationId
      const color = identity ? '#735b8e' : relation.sentiment === 'negative' ? '#b65745' : relation.sentiment === 'positive' ? '#14746f' : '#89918f'
      const fromPos = positions.get(relation.from_entity_id) || { x: 0, y: 0 }
      const toPos = positions.get(relation.to_entity_id) || { x: 0, y: 0 }
      const pairKey = [relation.from_entity_id, relation.to_entity_id].sort().join('~')
      const parallelIndex = pairSeen.get(pairKey) ?? 0
      pairSeen.set(pairKey, parallelIndex + 1)
      const curvature = parallelIndex === 0 ? hashCurvature(relation.id) : Math.min(.9, .34 + parallelIndex * .24)
      return { id: relation.id, source: relation.from_entity_id, target: relation.to_entity_id, sourceHandle: handleFor(fromPos, toPos), targetHandle: handleFor(toPos, fromPos), type: 'default', pathOptions: { curvature }, label: identity || showLabels ? relation.label || relation.type : undefined, zIndex: selected ? 3 : 0, style: { stroke: color, strokeWidth: selected ? 3.5 : Math.max(identity ? 2 : 1, Math.min(2.4, relation.strength / 45)), opacity: selected || identity ? 1 : .85, strokeDasharray: identity ? '8 5' : undefined }, labelStyle: { fontSize: 10, fontWeight: identity ? 700 : 500, fill: color }, labelBgStyle: { fill: '#f8f7f3', fillOpacity: .95 } }
    })
    return { nodes, edges }
  }, [baseEntities, relations, groupResult, mode, plot, chapters, focusId, hops, hideIsolated, minStrength, selectedNodeId, selectedRelationId])

  // 数据异步到达后（节点数从 0 变化）也要重新 fitView，否则画布停在空白视口。
  // focusId 变化由 focusEntity 自己做节点定向缩放；这里若同时全图 fitView 会与之竞态，
  // 把聚焦簇缩成针尖，故聚焦状态下跳过。
  useEffect(() => {
    if (!graph.nodes.length || focusId) return
    window.setTimeout(() => flow?.fitView({ padding: .24, duration: 350 }), 240)
  }, [flow, graph.nodes.length, mode, hops, hideIsolated, minStrength, scope, projectId])

  const modeEntities = baseEntities
  const selectedEntity = entities.find((entity) => entity.id === selectedNodeId)
  const selectedRelation = relations.find((relation) => relation.id === selectedRelationId)
  const selectedConnections = selectedEntity ? relations.filter((relation) => relation.from_entity_id === selectedEntity.id || relation.to_entity_id === selectedEntity.id) : []
  const addRelation = async () => { await post(`/api/projects/${projectId}/relations`, form); setOpen(false); load() }
  const analyzeManuscript = async () => {
    setAnalyzing(true); setAnalysisNotice('')
    try { const result = await post<{ entities: unknown[]; events: unknown[]; plotlines: unknown[]; relations: unknown[] }>(`/api/projects/${projectId}/analyze`, { replaceCandidates: true }); await load(); setScope('review'); setAnalysisNotice(`同步完成：${result.entities.length} 个候选节点、${result.relations.length} 条关系、${result.events.length} 个事件。`) }
    catch (caught) { setAnalysisNotice(`同步失败：${(caught as Error).message}`) } finally { setAnalyzing(false) }
  }
  const focusEntity = (entity: Entity) => { setFocusId(entity.id); setSelectedNodeId(entity.id); setSelectedRelationId(''); setQuery(entity.name); window.setTimeout(() => flow?.fitView({ nodes: [{ id: entity.id }], padding: 1.8, duration: 450 }), 60) }

  return <div className="graph-page">
    <div className="graph-toolbar"><div className="graph-toolbar-groups"><div className="segmented">{modes.map(([key, label]) => <button key={key} className={mode === key ? 'active' : ''} onClick={() => { setMode(key); setFocusId(''); setSelectedNodeId(''); setSelectedRelationId('') }}>{label}</button>)}</div>{!['events', 'foreshadowing'].includes(mode) && <div className="segmented"><button className={scope === 'review' ? 'active' : ''} onClick={() => setScope('review')}>候选审阅</button><button className={scope === 'canon' ? 'active' : ''} onClick={() => setScope('canon')}>仅正史</button></div>}</div><div className="graph-legend">{mode === 'characters' && groupResult.meta.map((group) => <span key={group.id}><i className="dot" style={{ background: group.color }} />{group.name}</span>)}<span><i className="positive" />正向</span><span><i className="neutral" />中性</span><span><i className="negative" />冲突</span><span><i className="identity" />同一人身份</span><Button variant="secondary" onClick={analyzeManuscript} disabled={analyzing}>{analyzing ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />} {analyzing ? '同步中…' : '从文稿同步'}</Button>{modeEntities.length > 1 && <Button onClick={() => { setForm({ ...form, fromEntityId: modeEntities[0]?.id || '', toEntityId: modeEntities[1]?.id || '' }); setOpen(true) }}><Plus size={15} /> 新增关系</Button>}</div></div>
    {!['events', 'foreshadowing'].includes(mode) && <div className="graph-filterbar"><div className="graph-search"><Search size={15} /><Input value={query} onChange={(event) => { setQuery(event.target.value); setFocusId('') }} placeholder={`搜索${mode === 'characters' ? '人物或别称' : '节点'}…`} />{searchResults.length > 0 && !focusId && <div className="graph-search-results">{searchResults.map((entity) => <button key={entity.id} onClick={() => focusEntity(entity)}><strong>{entity.name}</strong><span>{displayValue(entity.data?.aliases) || entity.summary || '暂无摘要'}</span></button>)}</div>}</div><div className="graph-filter-controls"><Focus size={15} /><select className="input" value={hops} onChange={(event) => setHops(Number(event.target.value) as 1 | 2)} disabled={!focusId}><option value={1}>一跳关系</option><option value={2}>二跳关系</option></select><label><input type="checkbox" checked={hideIsolated} onChange={(event) => setHideIsolated(event.target.checked)} />隐藏孤立节点</label><label className="strength-filter"><SlidersHorizontal size={14} />强度 ≥ {minStrength}<input type="range" min="0" max="80" step="10" value={minStrength} onChange={(event) => setMinStrength(Number(event.target.value))} /></label>{focusId && <Button variant="ghost" onClick={() => { setFocusId(''); setQuery('') }}><X size={14} /> 清除聚焦</Button>}</div></div>}
    {analyzing && <LoadingState label="正在提取实体、关系、事件与剧情线" />}{analysisNotice && <p className="analysis-notice">{analysisNotice}</p>}
    <section className="graph-canvas">{graph.nodes.length ? <ReactFlow nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: .22 }} minZoom={.2} maxZoom={2} onInit={setFlow} onPaneClick={() => { setSelectedNodeId(''); setSelectedRelationId('') }} onNodeClick={(_, node) => { setSelectedNodeId(node.id); setSelectedRelationId('') }} onEdgeClick={(_, edge) => { setSelectedRelationId(edge.id); setSelectedNodeId('') }} onNodeDoubleClick={(_, node) => { const entity = entities.find((item) => item.id === node.id); const event = plot.events.find((item) => item.id === node.id); const chapter = chapters.find((item) => item.id === node.id); navigate(`/memory?q=${encodeURIComponent(entity?.name || event?.title || chapter?.title || '')}`) }}><Background gap={22} size={1} color="#d8d8d1" /><MiniMap pannable zoomable nodeColor={(node) => nodeColors[entities.find((entity) => entity.id === node.id)?.type || ''] || '#89918f'} /><Controls /></ReactFlow> : <div className="graph-empty"><Network size={28} /><strong>这个视图还没有可显示的关系</strong><p>{hideIsolated ? '当前已隐藏孤立节点；可关闭筛选，或从文稿同步并审阅候选关系。' : '导入文稿后运行模型分析，并在设定百科中检查候选条目。'}</p></div>}
      <div className="graph-summary"><Network size={16} /><strong>{graph.nodes.length}</strong> 个节点 · <strong>{graph.edges.length}</strong> 条关系 · 双击节点查看证据</div>
      {(selectedEntity || selectedRelation) && <aside className="graph-detail"><header><div><span>{selectedEntity ? labelType(selectedEntity.type) : '关系'}</span><strong>{selectedEntity?.name || selectedRelation?.label || selectedRelation?.type}</strong></div><IconButton label="关闭详情" onClick={() => { setSelectedNodeId(''); setSelectedRelationId('') }}><X size={16} /></IconButton></header>{selectedEntity && <><p>{selectedEntity.summary || '暂无摘要'}</p>{displayValue(selectedEntity.data?.aliases) && <div className="graph-detail-row"><span>普通别称</span><strong>{displayValue(selectedEntity.data?.aliases)}</strong></div>}{displayValue(selectedEntity.data?.narrativeIdentities) && <div className="graph-detail-row"><span>独立身份</span><strong>{displayValue(selectedEntity.data?.narrativeIdentities)}</strong></div>}<div className="graph-detail-connections"><span>直接关系 · {selectedConnections.length}</span>{selectedConnections.slice(0, 10).map((relation) => { const otherId = relation.from_entity_id === selectedEntity.id ? relation.to_entity_id : relation.from_entity_id; const other = entities.find((entity) => entity.id === otherId); return <button key={relation.id} onClick={() => other && focusEntity(other)}><strong>{other?.name || '未知节点'}</strong><small>{relation.label || relation.type} · {relation.strength}</small></button> })}</div><Button variant="secondary" onClick={() => navigate(`/memory?q=${encodeURIComponent(selectedEntity.name)}`)}><Search size={14} /> 查看原文证据</Button></>}{selectedRelation && <RelationDetail relation={selectedRelation} entities={entities} onFocus={focusEntity} />}</aside>}
    </section>
    {open && <Modal title="新增关系" onClose={() => setOpen(false)} footer={<><Button variant="ghost" onClick={() => setOpen(false)}>取消</Button><Button onClick={addRelation} disabled={!form.fromEntityId || !form.toEntityId || form.fromEntityId === form.toEntityId}><Link2 size={15} /> 建立关系</Button></>}><div className="form-grid two"><Field label="起点"><select className="input" value={form.fromEntityId} onChange={(event) => setForm({ ...form, fromEntityId: event.target.value })}>{modeEntities.map((entity) => <option key={entity.id} value={entity.id}>{entity.name}</option>)}</select></Field><Field label="终点"><select className="input" value={form.toEntityId} onChange={(event) => setForm({ ...form, toEntityId: event.target.value })}>{modeEntities.map((entity) => <option key={entity.id} value={entity.id}>{entity.name}</option>)}</select></Field><Field label="关系类型"><select className="input" value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })}><option value="alliance">盟友/合作</option><option value="family">亲属</option><option value="enemy">敌对</option><option value="same_person">同一人的不同身份</option><option value="member">成员与组织</option><option value="association">其他关联</option></select></Field><Field label="显示标签"><Input value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} placeholder="盟友、姐妹、同一人的不同身份……" /></Field><Field label="情感倾向"><select className="input" value={form.sentiment} onChange={(event) => setForm({ ...form, sentiment: event.target.value })}><option value="positive">正向</option><option value="neutral">中性</option><option value="mixed">复杂</option><option value="negative">冲突</option></select></Field><Field label={`关系强度：${form.strength}`}><input type="range" min="0" max="100" value={form.strength} onChange={(event) => setForm({ ...form, strength: Number(event.target.value) })} /></Field></div></Modal>}
  </div>
}

function RelationDetail({ relation, entities, onFocus }: { relation: Relation; entities: Entity[]; onFocus: (entity: Entity) => void }) {
  const from = entities.find((entity) => entity.id === relation.from_entity_id)
  const to = entities.find((entity) => entity.id === relation.to_entity_id)
  return <div className="relation-detail"><div className="relation-pair"><button onClick={() => from && onFocus(from)}>{from?.name || '未知'}</button><span>{relation.type === 'same_person' ? '同一人身份' : relation.label || relation.type}</span><button onClick={() => to && onFocus(to)}>{to?.name || '未知'}</button></div><div className="graph-detail-row"><span>关系类型</span><strong>{relation.type}</strong></div><div className="graph-detail-row"><span>情感倾向</span><Badge tone={relation.sentiment === 'negative' ? 'red' : relation.sentiment === 'positive' ? 'teal' : 'neutral'}>{relation.sentiment}</Badge></div><div className="graph-detail-row"><span>关系强度</span><strong>{relation.strength} / 100</strong></div></div>
}

function displayValue(value: unknown) { return Array.isArray(value) ? value.join('、') : String(value ?? '') }
function labelType(type: string) { return ({ character: '人物', location: '地点', faction: '势力', system: '体系', item: '物品' } as Record<string, string>)[type] || type }
function graphStyle(color: string) { return { width: 190, border: `1px solid ${color}55`, borderRadius: 6, boxShadow: '0 4px 16px rgba(30,38,37,.08)', padding: 0, background: '#fff' } }
