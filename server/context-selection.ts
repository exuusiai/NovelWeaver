import { sql } from './db.ts'
import { estimateTokens, searchMemory, type SearchHit } from './memory.ts'
import { memoryScope, visibilityReason, type Visibility } from './provenance.ts'
import { chapterEvidence, recordEvidence, recordText, type Evidence } from './harness/evidence.ts'

export interface SelectionItem {
  id: string
  kind: string
  label: string
  text: string
  priority: number
  tokens: number
  reason: string
  evidenceIds: string[]
}
export interface Selection {
  items: SelectionItem[]
  excluded: Array<{ id: string; kind: string; reason: string }>
  evidence: Evidence[]
  hits: SearchHit[]
  diagnostics: string[]
}
export async function selectSettings(projectId: string, query: string, view: Visibility = {}): Promise<Selection> {
  const diagnostics: string[] = []
  const boundary = view.chapterId
    ? sql.get<{ story_tick: number | null }>(
        'SELECT story_tick FROM chapters WHERE id=? AND project_id=?',
        view.chapterId,
        projectId,
      )
    : undefined
  if (view.chapterId && view.storyTick === undefined && boundary?.story_tick == null)
    diagnostics.push('story_time_unset:narrative_order_only')
  if (view.audience === 'character' && !view.holderId) diagnostics.push('character_identity_unset')
  const items: SelectionItem[] = []
  const excluded: Selection['excluded'] = []
  const evidence: Evidence[] = []
  const hits = await searchMemory(projectId, query, 100, view.chapterId, {
    excludeFuture: view.audience !== 'author' && Boolean(view.chapterId),
    lexicalOnly: process.env.NOVELWEAVER_OFFLINE === '1',
  })
  const add = (
    kind: string,
    id: string,
    label: string,
    text: string,
    priority: number,
    chapterId?: string | null,
    basis = 'explicit_setting',
  ) => {
    const reason = visibilityReason(projectId, kind, id, view, chapterId)
    if (reason) {
      excluded.push({ id, kind, reason })
      return
    }
    const ev = recordEvidence(projectId, kind, id, text, basis, chapterId ?? null)
    evidence.push(ev)
    items.push({
      id,
      kind,
      label,
      text: `【${kind}/${memoryScope(kind, id).audience || 'world'}】${text}`,
      priority,
      tokens: 0,
      reason: basis,
      evidenceIds: [ev.id],
    })
  }
  const project = sql.get<{ name: string; genre: string; premise: string }>(
    'SELECT name, genre, premise FROM projects WHERE id=?',
    projectId,
  )
  if (project)
    items.push({
      id: projectId,
      kind: 'project',
      label: '项目基线',
      text: `【项目】${project.name} ${project.genre}${view.audience === 'author' ? `\n核心命题：${project.premise}` : ''}`,
      priority: 100,
      tokens: 0,
      reason: 'project_identity',
      evidenceIds: [],
    })
  const tables = [
    {
      table: 'entities',
      kind: 'entity',
      title: 'name',
      source: 'source_chapter_id',
      where: "canon_status IN ('canon','candidate')",
      priority: 75,
    },
    {
      table: 'story_facts',
      kind: 'fact',
      title: 'subject',
      source: 'source_chapter_id',
      where: "canon_status IN ('canon','candidate')",
      priority: 85,
    },
    {
      table: 'events',
      kind: 'event',
      title: 'title',
      source: 'chapter_id',
      where: "status NOT IN ('rejected','deprecated')",
      priority: 65,
    },
    {
      table: 'relations',
      kind: 'relation',
      title: 'label',
      source: 'NULL',
      where: "canon_status IN ('canon','candidate')",
      priority: 70,
    },
    {
      table: 'foreshadowing',
      kind: 'foreshadowing',
      title: 'title',
      source: 'setup_chapter_id',
      where: "status != 'resolved'",
      priority: 88,
    },
    { table: 'chapters', kind: 'summary', title: 'title', source: 'id', where: "summary != ''", priority: 60 },
  ]
  for (const spec of tables) {
    const rows = sql.all<{ id: string; label: string; chapterId: string | null }>(
      `SELECT id, ${spec.title} label, ${spec.source} chapterId FROM ${spec.table} WHERE project_id=? AND ${spec.where} ORDER BY id`,
      projectId,
    )
    for (const row of rows) {
      // Relations require both endpoint cards to pass the same scope predicate.
      if (spec.kind === 'relation') {
        const relation = sql.get<{ from_entity_id: string; to_entity_id: string }>(
          'SELECT from_entity_id,to_entity_id FROM relations WHERE id=?',
          row.id,
        )!
        if (
          [relation.from_entity_id, relation.to_entity_id].some((id) => visibilityReason(projectId, 'entity', id, view))
        ) {
          excluded.push({ id: row.id, kind: spec.kind, reason: 'endpoint_scope' })
          continue
        }
      }
      if (
        spec.kind === 'event' &&
        view.audience !== 'author' &&
        sql.get<{ status: string }>('SELECT status FROM events WHERE id=?', row.id)?.status === 'planned'
      ) {
        excluded.push({ id: row.id, kind: spec.kind, reason: 'author_plan' })
        continue
      }
      const text = recordText(projectId, spec.kind, row.id) || ''
      if (spec.kind === 'relation') row.label = text.split('：')[0]
      const relevant = query.includes(row.label) || text.includes(query)
      add(spec.kind, row.id, row.label, text, spec.priority + (relevant ? 15 : 0), row.chapterId)
    }
  }
  for (const hit of hits) {
    if (hit.sourceType !== 'chapter' || !hit.chapterId) continue // structured sources pass the shared predicate above
    const reason = visibilityReason(projectId, 'chapter', hit.chapterId, view, hit.chapterId)
    if (reason) {
      excluded.push({ id: hit.id, kind: 'evidence', reason })
      continue
    }
    const chapter = sql.get<{ content: string }>('SELECT content FROM chapters WHERE id=?', hit.chapterId)
    const start = chapter?.content.indexOf(hit.content) ?? -1
    if (start < 0 || !hit.content) {
      excluded.push({ id: hit.id, kind: 'evidence', reason: 'unlocated_chunk' })
      continue
    }
    const ev = chapterEvidence(projectId, hit.chapterId, start, start + hit.content.length, hit.reason || hit.path)
    evidence.push(ev)
    items.push({
      id: ev.id,
      kind: 'evidence',
      label: ev.id,
      text: `[${ev.id}] ${ev.text}`,
      priority: 70 + hit.score * 20,
      tokens: 0,
      reason: hit.reason || 'retrieval',
      evidenceIds: [ev.id],
    })
  }
  items.forEach((item) => {
    item.tokens = estimateTokens(item.text)
  })
  return {
    items,
    diagnostics,
    excluded,
    evidence,
    hits: hits.filter(
      (hit) => hit.chapterId && !visibilityReason(projectId, 'chapter', hit.chapterId, view, hit.chapterId),
    ),
  }
}

// Whole-item packing preserves quotations and source locations. Oversize items are
// excluded rather than silently truncating evidence into a different proposition.
export function packContext(selection: Selection, tokenBudget: number) {
  const included: SelectionItem[] = []
  const trimmed: Array<SelectionItem & { reason: string }> = []
  let text = ''
  for (const item of [...selection.items].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))) {
    const next = text ? `${text}\n\n${item.text}` : item.text
    if (estimateTokens(next) <= tokenBudget) {
      included.push(item)
      text = next
    } else trimmed.push({ ...item, reason: 'token_budget' })
  }
  const evidenceIds = new Set(included.flatMap((i) => i.evidenceIds))
  return {
    text,
    evidence: selection.evidence.filter((e) => evidenceIds.has(e.id)),
    report: {
      tokenBudget,
      estimatedTokens: text ? estimateTokens(text) : 0,
      included,
      trimmed,
      excluded: selection.excluded,
      truncation: 'whole_item_only',
      diagnostics: selection.diagnostics,
    },
  }
}
