import { createHash } from 'node:crypto'
import { sql } from '../db.ts'
import { sourceBindings } from '../provenance.ts'
import { ToolError } from './protocol.ts'

export interface Evidence {
  id: string
  kind: string
  sourceId: string
  chapterId: string | null
  location: { start: number; end: number } | null
  sourceVersion: string
  sources: ReturnType<typeof sourceBindings>
  text: string
  basis: string
}
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function chapterEvidence(
  projectId: string,
  chapterId: string,
  start: number,
  end: number,
  basis = 'explicit_location',
): Evidence {
  const chapter = sql.get<{ content: string; revision: number }>(
    'SELECT content, revision FROM chapters WHERE id=? AND project_id=?',
    chapterId,
    projectId,
  )
  if (!chapter) throw new ToolError('NOT_FOUND', '证据章节不存在。')
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > chapter.content.length
  )
    throw new ToolError('INVALID_INPUT', '证据位置超出正文。')
  return remember(projectId, {
    kind: 'chapter',
    sourceId: chapterId,
    chapterId,
    location: { start, end },
    sourceVersion: String(chapter.revision),
    sources: [],
    text: chapter.content.slice(start, end),
    basis,
  })
}
function evidenceSources(kind: string, sourceId: string, chapterId: string | null) {
  const sources = sourceBindings(kind, sourceId)
  if (chapterId && !sources.some((s) => s.chapterId === chapterId)) {
    const chapter = sql.get<{ revision: number; position: number; story_tick: number | null }>(
      'SELECT revision,position,story_tick FROM chapters WHERE id=?',
      chapterId,
    )
    if (chapter)
      sources.push({
        chapterId,
        revision: chapter.revision,
        liveRevision: chapter.revision,
        position: chapter.position,
        storyTick: chapter.story_tick,
        validity: 'current',
      })
  }
  return sources
}
export function recordEvidence(
  projectId: string,
  kind: string,
  sourceId: string,
  text: string,
  basis: string,
  chapterId: string | null = null,
): Evidence {
  return remember(projectId, {
    kind,
    sourceId,
    chapterId,
    location: null,
    sourceVersion: digest(text),
    sources: evidenceSources(kind, sourceId, chapterId),
    text,
    basis,
  })
}
function remember(projectId: string, value: Omit<Evidence, 'id'>) {
  const id = `ev_${digest([projectId, value.kind, value.sourceId, value.location, value.sourceVersion, value.sources]).slice(0, 32)}`
  const evidence = { id, ...value }
  sql.run(
    'INSERT OR IGNORE INTO harness_evidence VALUES (?, ?, ?, ?)',
    id,
    projectId,
    JSON.stringify(evidence),
    value.text,
  )
  return evidence
}
export function recordText(projectId: string, kind: string, id: string): string | undefined {
  if (kind === 'input' || kind === 'outline_input') {
    const row = sql.get<{ payload: string }>(
      'SELECT payload FROM harness_runs WHERE id=? AND project_id=?',
      id,
      projectId,
    )
    return row
      ? (JSON.parse(row.payload).request[kind === 'input' ? 'chapterContent' : 'chapterOutline'] as
          | string
          | undefined)
      : undefined
  }
  if (kind === 'chapter_outline')
    return sql.get<{ text: string }>(
      'SELECT updated_at || char(10) || content text FROM chapter_outlines WHERE chapter_id=? AND project_id=?',
      id,
      projectId,
    )?.text
  if (kind === 'book_outline')
    return sql.get<{ text: string }>(
      "SELECT version || char(10) || content text FROM story_outlines WHERE id=? AND project_id=? AND status='current'",
      id,
      projectId,
    )?.text
  const tables: Record<string, { table: string; expression: string }> = {
    entity: { table: 'entities', expression: "name || '：' || summary || char(10) || data" },
    fact: { table: 'story_facts', expression: "subject || '｜' || predicate || '｜' || value" },
    event: { table: 'events', expression: "title || '：' || summary" },
    relation: {
      table: 'relations',
      expression:
        "(SELECT name FROM entities WHERE id=from_entity_id) || '→' || (SELECT name FROM entities WHERE id=to_entity_id) || '：' || label",
    },
    foreshadowing: { table: 'foreshadowing', expression: "title || '：' || notes || '（' || status || '）'" },
    summary: { table: 'chapters', expression: 'summary' },
  }
  const spec = tables[kind]
  return spec
    ? sql.get<{ text: string }>(
        `SELECT ${spec.expression} text FROM ${spec.table} WHERE id=? AND project_id=?`,
        id,
        projectId,
      )?.text
    : undefined
}
export function readEvidence(projectId: string, id: string): Evidence {
  const row = sql.get<{ locator: string }>(
    'SELECT locator FROM harness_evidence WHERE id=? AND project_id=?',
    id,
    projectId,
  )
  if (!row) throw new ToolError('NOT_FOUND', `证据不存在：${id}`)
  const evidence = JSON.parse(row.locator) as Evidence
  if (evidence.kind === 'chapter') {
    const chapter = sql.get<{ content: string; revision: number }>(
      'SELECT content, revision FROM chapters WHERE id=? AND project_id=?',
      evidence.chapterId,
      projectId,
    )
    if (
      !chapter ||
      String(chapter.revision) !== evidence.sourceVersion ||
      !evidence.location ||
      chapter.content.slice(evidence.location.start, evidence.location.end) !== evidence.text
    )
      throw new ToolError('STALE_EVIDENCE', '原文版本已变化，请重新检索证据。', false, { id })
  } else {
    const text = recordText(projectId, evidence.kind, evidence.sourceId)
    const bindings = evidenceSources(evidence.kind, evidence.sourceId, evidence.chapterId)
    if (
      text === undefined ||
      digest(text) !== evidence.sourceVersion ||
      bindings.some((b) => b.validity !== 'current' || b.revision !== b.liveRevision) ||
      digest(bindings) !== digest(evidence.sources)
    )
      throw new ToolError('STALE_EVIDENCE', '派生证据已失效，请重新分析或由作者复核。', false, { id })
  }
  return evidence
}
