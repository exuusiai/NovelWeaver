import { sql } from './db.ts'
import { decodeRow } from './routes/helpers.ts'

// Full-project JSON payload shared by the export route and the backup scheduler.
export function buildProjectExport(projectId: string) {
  return {
    project: sql.get('SELECT * FROM projects WHERE id = ?', projectId),
    chapters: sql.all('SELECT * FROM chapters WHERE project_id = ? ORDER BY position', projectId),
    volumes: sql.all('SELECT * FROM volumes WHERE project_id = ? ORDER BY order_index', projectId),
    chapterVolumeBindings: sql.all(`SELECT b.* FROM chapter_volume_bindings b JOIN chapters c ON c.id=b.chapter_id
      WHERE c.project_id=? ORDER BY b.volume_id, b.order_index`, projectId),
    entities: sql.all<Record<string, unknown>>('SELECT * FROM entities WHERE project_id = ? ORDER BY type, name', projectId).map(decodeRow),
    plotlines: sql.all('SELECT * FROM plotlines WHERE project_id = ?', projectId),
    outlines: sql.all('SELECT * FROM story_outlines WHERE project_id = ? ORDER BY version DESC', projectId),
    events: sql.all<Record<string, unknown>>('SELECT * FROM events WHERE project_id = ? ORDER BY narrative_order', projectId).map(decodeRow),
    relations: sql.all('SELECT * FROM relations WHERE project_id = ?', projectId),
    foreshadowing: sql.all('SELECT * FROM foreshadowing WHERE project_id = ?', projectId),
    facts: sql.all('SELECT * FROM story_facts WHERE project_id = ? ORDER BY introduced_position, importance DESC', projectId),
    chapterOutlines: sql.all('SELECT * FROM chapter_outlines WHERE project_id = ? ORDER BY created_at', projectId),
    exportedAt: sql.now(),
  }
}

export interface ManuscriptChapterRow { id: string; title: string; content: string; volume_id: string | null; order_index: number | null; position: number }

// Volume-grouped chapters in reading order; unbound chapters go to a trailing group.
export function assembleManuscriptVolumes(projectId: string) {
  const volumeRows = sql.all<{ id: string; title: string }>('SELECT id, title FROM volumes WHERE project_id = ? ORDER BY order_index', projectId)
  const chapterRows = sql.all<ManuscriptChapterRow>(`SELECT c.id, c.title, c.content, b.volume_id, b.order_index, c.position FROM chapters c
    LEFT JOIN chapter_volume_bindings b ON b.chapter_id = c.id WHERE c.project_id = ?`, projectId)
  const volumes = volumeRows.map((volume) => ({
    title: volume.title,
    chapters: chapterRows
      .filter((chapter) => chapter.volume_id === volume.id)
      .sort((left, right) => (left.order_index ?? left.position) - (right.order_index ?? right.position))
      .map((chapter) => ({ title: chapter.title, content: chapter.content })),
  }))
  const unbound = chapterRows.filter((chapter) => !chapter.volume_id).sort((left, right) => left.position - right.position)
  if (unbound.length) volumes.push({ title: '未分卷', chapters: unbound.map((chapter) => ({ title: chapter.title, content: chapter.content })) })
  return volumes
}
