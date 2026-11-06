import { sql } from './db.ts'

export type MemoryKind = 'entity' | 'relation' | 'fact' | 'event' | 'summary' | 'chapter' | 'foreshadowing'
export interface MemoryScope {
  audience?: 'world' | 'belief' | 'reader' | 'author'
  holderId?: string
  entityIds?: string[]
  knownBy?: string[]
  chapterIds?: string[]
  volumeId?: string
  validFromTick?: number
  validToTick?: number
  tags?: Array<'state' | 'goal' | 'causality' | 'foreshadowing'>
  manualOnly?: boolean
  legacyUnresolved?: boolean
}
export interface Visibility {
  chapterId?: string
  audience?: 'author' | 'reader' | 'character'
  holderId?: string
  storyTick?: number
  entityIds?: string[]
  manualIds?: string[]
}

export function bindSources(kind: string, itemId: string, chapterIds: string[]) {
  sql.run('DELETE FROM source_bindings WHERE kind=? AND item_id=?', kind, itemId)
  for (const chapterId of new Set(chapterIds))
    sql.run(
      `INSERT INTO source_bindings
    SELECT ?, ?, id, revision, 'current' FROM chapters WHERE id=?`,
      kind,
      itemId,
      chapterId,
    )
}
export function setMemoryScope(projectId: string, kind: string, itemId: string, metadata: MemoryScope) {
  sql.run(
    `INSERT INTO memory_scopes VALUES (?, ?, ?, ?) ON CONFLICT(kind,item_id) DO UPDATE SET metadata=excluded.metadata`,
    kind,
    itemId,
    projectId,
    JSON.stringify(metadata),
  )
}
export function memoryScope(kind: string, itemId: string): MemoryScope {
  const row = sql.get<{ metadata: string }>(
    'SELECT metadata FROM memory_scopes WHERE kind=? AND item_id=?',
    kind,
    itemId,
  )
  if (row) return JSON.parse(row.metadata)
  if (kind !== 'entity') return {}
  const entity = sql.get<{ project_id: string; data: string }>(
    'SELECT project_id,data FROM entities WHERE id=?',
    itemId,
  )
  if (!entity) return {}
  let legacy: Record<string, unknown> = {}
  try {
    legacy = JSON.parse(entity.data)
  } catch {
    return {}
  }
  if (legacy.contextScope === 'manual') return { manualOnly: true }
  if (legacy.contextScope === 'volume') {
    const title = String(legacy.contextVolume ?? '').trim()
    const matches = title
      ? sql.all<{ id: string }>(
          'SELECT id FROM volumes WHERE project_id=? AND instr(title,?)>0',
          entity.project_id,
          title,
        )
      : []
    return matches.length === 1 ? { volumeId: matches[0].id } : { legacyUnresolved: true }
  }
  if (legacy.contextScope === 'chapter') {
    const title = String(legacy.contextNearChapter ?? '').trim()
    const anchors = title
      ? sql.all<{ position: number }>(
          'SELECT position FROM chapters WHERE project_id=? AND instr(title,?)>0',
          entity.project_id,
          title,
        )
      : []
    if (anchors.length !== 1) return { legacyUnresolved: true }
    return {
      chapterIds: sql
        .all<{
          id: string
        }>('SELECT id FROM chapters WHERE project_id=? AND ABS(position-?)<=2', entity.project_id, anchors[0].position)
        .map((c) => c.id),
    }
  }
  return {}
}
export function sourceBindings(kind: string, itemId: string) {
  return sql.all<{
    chapterId: string
    revision: number
    validity: string
    liveRevision: number | null
    position: number | null
    storyTick: number | null
  }>(
    `SELECT b.chapter_id chapterId, b.source_revision revision, b.validity,
    c.revision liveRevision, c.position, c.story_tick storyTick FROM source_bindings b LEFT JOIN chapters c ON c.id=b.chapter_id
    WHERE b.kind=? AND b.item_id=? ORDER BY b.chapter_id`,
    kind,
    itemId,
  )
}

// One predicate is shared by cards, relations, facts, events, summaries and evidence.
// Unknown identity/time is reported explicitly; a pinned card cannot bypass visibility.
export function visibilityReason(
  projectId: string,
  kind: string,
  itemId: string,
  view: Visibility = {},
  chapterId?: string | null,
): string | null {
  const sources = sourceBindings(kind, itemId)
  const inheritedChapter = chapterId || (sources.length === 1 ? sources[0].chapterId : undefined)
  const scope = { ...(inheritedChapter ? memoryScope('chapter', inheritedChapter) : {}), ...memoryScope(kind, itemId) }
  if (scope.legacyUnresolved) return 'legacy_scope_unresolved'
  if (scope.manualOnly && !view.manualIds?.includes(itemId)) return 'manual_selection_required'
  if (sources.some((s) => s.validity !== 'current' || s.liveRevision !== s.revision)) return 'stale_source'
  const current = view.chapterId
    ? sql.get<{ position: number; story_tick: number | null; project_id: string }>(
        'SELECT position, story_tick, project_id FROM chapters WHERE id=?',
        view.chapterId,
      )
    : undefined
  if (view.chapterId && (!current || current.project_id !== projectId)) return 'invalid_chapter'
  const audience = view.audience ?? (view.chapterId ? 'reader' : 'author')
  const tick = view.storyTick ?? current?.story_tick ?? undefined
  const originIds = [...new Set([...sources.map((s) => s.chapterId), ...(chapterId ? [chapterId] : [])])]
  if (current && audience !== 'author') {
    for (const id of originIds) {
      const origin = sql.get<{ position: number; story_tick: number | null }>(
        'SELECT position, story_tick FROM chapters WHERE id=? AND project_id=?',
        id,
        projectId,
      )
      if (!origin) return 'missing_source'
      if (origin.position > current.position) return 'future_narrative'
      if (tick !== undefined && origin.story_tick !== null && origin.story_tick > tick) return 'future_story_time'
    }
  }
  if (scope.chapterIds?.length && (!view.chapterId || !scope.chapterIds.includes(view.chapterId)))
    return 'chapter_scope'
  if (
    scope.volumeId &&
    (!view.chapterId ||
      !sql.get(
        'SELECT chapter_id FROM chapter_volume_bindings WHERE chapter_id=? AND volume_id=?',
        view.chapterId,
        scope.volumeId,
      ))
  )
    return 'volume_scope'
  if (scope.validFromTick !== undefined && (tick === undefined || tick < scope.validFromTick))
    return 'before_valid_time'
  if (scope.validToTick !== undefined && (tick === undefined || tick > scope.validToTick)) return 'after_valid_time'
  if (view.entityIds?.length && scope.entityIds?.length && !scope.entityIds.some((id) => view.entityIds!.includes(id)))
    return 'entity_identity'
  if (audience === 'author') return null
  if (scope.audience === 'author') return 'author_plan'
  if (scope.audience === 'belief' && (audience !== 'character' || !view.holderId || scope.holderId !== view.holderId))
    return 'other_character_belief'
  if (audience === 'character') {
    if (scope.audience === 'reader') return 'reader_only'
    if (scope.knownBy?.length && (!view.holderId || !scope.knownBy.includes(view.holderId)))
      return 'character_knowledge'
    // Legacy unbound aggregate cards/relations have no revelation boundary.
    if (!originIds.length && !scope.audience && kind !== 'chapter') return 'unscoped_knowledge'
  }
  return null
}
