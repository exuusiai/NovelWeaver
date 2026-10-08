import express from 'express'
import { db, sql } from '../db.ts'
import { chapterContentFingerprint, chunkText, isEffectivelyEmptyChapter, summarize } from '../importer.ts'

export const asyncRoute = (handler: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response, next: express.NextFunction) => handler(req, res).catch(next)

export function decodeRow<T extends Record<string, unknown>>(row: T) {
  const output: Record<string, unknown> = { ...row }
  for (const key of ['data', 'participants', 'knowledge', 'evidence', 'diagnostics', 'details', 'result', 'snapshot', 'payload', 'metrics', 'disagreements', 'chapters']) {
    if (typeof output[key] === 'string') {
      try { output[key] = JSON.parse(output[key] as string) } catch { /* retain raw value */ }
    }
  }
  return output
}

export function requireProject(projectId: string) {
  const project = sql.get<Record<string, unknown>>('SELECT * FROM projects WHERE id = ?', projectId)
  if (!project) throw Object.assign(new Error('项目不存在。'), { status: 404 })
  return project
}

export function analysisModelRequired() {
  return Object.assign(new Error('需要先配置可用的模型 API，才能进行可靠的文稿分析。当前本地模式不会猜测人物和地点。'), { status: 409, code: 'MODEL_REQUIRED' })
}

import { createHash } from 'node:crypto'

export function contentHash(text: string) {
  return createHash('sha256').update(text).digest('hex').slice(0, 32)
}

export function removeChapterWithMemory(chapterId: string) {
  const memoryIds = sql.all<{ id: string }>('SELECT id FROM memory_chunks WHERE chapter_id = ?', chapterId)
  memoryIds.forEach((row) => sql.run('DELETE FROM memory_fts WHERE id = ?', row.id))
  sql.run('DELETE FROM memory_chunks WHERE chapter_id = ?', chapterId)
  sql.run('DELETE FROM events WHERE chapter_id = ?', chapterId)
  // 悬空引用清理：伏笔与实体来源指向已删除章节时置空，避免作者看到指向不存在章节的证据
  sql.run('UPDATE foreshadowing SET setup_chapter_id = NULL WHERE setup_chapter_id = ?', chapterId)
  sql.run('UPDATE foreshadowing SET payoff_chapter_id = NULL WHERE payoff_chapter_id = ?', chapterId)
  sql.run('UPDATE entities SET source_chapter_id = NULL WHERE source_chapter_id = ?', chapterId)
  // 开放审查的证据数组剥离该章节；剥空的结构类条目直接删除
  for (const review of sql.all<{ id: string; evidence: string }>("SELECT id, evidence FROM reviews WHERE status = 'open' AND evidence LIKE ?", `%${chapterId}%`)) {
    try {
      const ids = JSON.parse(review.evidence) as string[]
      const rest = ids.filter((entry) => entry !== chapterId)
      if (rest.length === ids.length) continue
      if (rest.length === 0) sql.run('DELETE FROM reviews WHERE id = ?', review.id)
      else sql.run('UPDATE reviews SET evidence = ? WHERE id = ?', JSON.stringify(rest), review.id)
    } catch { /* malformed evidence left alone */ }
  }
  sql.run('DELETE FROM chapters WHERE id = ?', chapterId)
}

// Stale plan chapters are removed, not deleted-with-events: user-curated events stay as plan data.
export function removeStalePlannedChapter(chapterId: string) {
  sql.run('UPDATE events SET chapter_id=NULL WHERE chapter_id=?', chapterId)
  const memoryIds = sql.all<{ id: string }>('SELECT id FROM memory_chunks WHERE chapter_id = ?', chapterId)
  memoryIds.forEach((row) => sql.run('DELETE FROM memory_fts WHERE id = ?', row.id))
  sql.run('DELETE FROM memory_chunks WHERE chapter_id = ?', chapterId)
  sql.run('DELETE FROM chapters WHERE id = ?', chapterId)
}

export function rebuildChapterMemory(projectId: string, chapterId: string, title: string, content: string, summary: string) {
  const old = sql.all<{ id: string }>('SELECT id FROM memory_chunks WHERE source_type = ? AND source_id = ?', 'chapter', chapterId)
  old.forEach(({ id }) => sql.run('DELETE FROM memory_fts WHERE id = ?', id))
  sql.run('DELETE FROM memory_chunks WHERE source_type = ? AND source_id = ?', 'chapter', chapterId)
  chunkText(content).forEach((chunk, index) => sql.addMemory(projectId, 'chapter', chapterId, chunk,
    index === 0 ? (summary || summarize(chunk)) : summarize(chunk), `${title} 正文`, chapterId))
}

export const CHAPTER_HISTORY_LIMIT = 50

export function saveChapterHistory(chapter: { id: string; project_id: string; title: string; content: string; summary: string }) {
  sql.run('INSERT INTO chapter_history VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    sql.id(), chapter.id, chapter.project_id, chapter.title, chapter.content, chapter.summary,
    chapter.content.replace(/\s/g, '').length, sql.now())
  sql.run(`DELETE FROM chapter_history WHERE chapter_id = ? AND id NOT IN
    (SELECT id FROM chapter_history WHERE chapter_id = ? ORDER BY created_at DESC LIMIT ?)`,
    chapter.id, chapter.id, CHAPTER_HISTORY_LIMIT)
}

export function ensureDefaultVolume(projectId: string) {
  const existing = sql.get<{ id: string }>('SELECT id FROM volumes WHERE project_id=? ORDER BY order_index LIMIT 1', projectId)
  if (existing) return existing.id
  const volumeId = sql.id(); const stamp = sql.now()
  sql.run('INSERT INTO volumes VALUES (?, ?, ?, ?, ?, ?, ?)', volumeId, projectId, '第一卷', '', 0, stamp, stamp)
  return volumeId
}

export function bindChapterToVolume(projectId: string, chapterId: string, volumeId?: string | null) {
  const target = volumeId || ensureDefaultVolume(projectId)
  const order = (sql.get<{ max: number }>('SELECT COALESCE(MAX(order_index), -1) max FROM chapter_volume_bindings WHERE volume_id=?', target)?.max ?? -1) + 1
  sql.run(`INSERT INTO chapter_volume_bindings (chapter_id, volume_id, order_index) VALUES (?, ?, ?)
    ON CONFLICT(chapter_id) DO UPDATE SET volume_id=excluded.volume_id, order_index=excluded.order_index`, chapterId, target, order)
}

export function chapterSelect(where: string) {
  return `SELECT c.*, COALESCE(m.bookmarked, 0) AS bookmarked, COALESCE(m.importance, 'normal') AS importance,
    COALESCE(m.note, '') AS mark_note, COALESCE(o.content, '') AS detailed_outline,
    COALESCE(o.status, '') AS outline_status, b.volume_id, v.title AS volume_title, b.order_index AS volume_order_index
    FROM chapters c LEFT JOIN chapter_marks m ON m.chapter_id = c.id
    LEFT JOIN chapter_outlines o ON o.chapter_id=c.id
    LEFT JOIN chapter_volume_bindings b ON b.chapter_id=c.id LEFT JOIN volumes v ON v.id=b.volume_id ${where}`
}

export function normalizeChapterPositions(projectId: string) {
  sql.all<{ id: string }>('SELECT id FROM chapters WHERE project_id = ? ORDER BY position, created_at', projectId)
    .forEach((chapter, position) => sql.run('UPDATE chapters SET position=? WHERE id=?', position, chapter.id))
}

export function deduplicateImportedChapters(projectId: string) {
  const chapters = sql.all<{ id: string; title: string; content: string }>("SELECT id, title, content FROM chapters WHERE project_id = ? AND status = 'imported' ORDER BY position", projectId)
  const seenContent = new Set<string>()
  const removeIds: string[] = []
  let empty = 0; let duplicates = 0
  for (const chapter of chapters) {
    if (isEffectivelyEmptyChapter(chapter.title, chapter.content)) { removeIds.push(chapter.id); empty += 1; continue }
    const fingerprint = chapterContentFingerprint(chapter.content)
    if (seenContent.has(fingerprint)) { removeIds.push(chapter.id); duplicates += 1; continue }
    seenContent.add(fingerprint)
  }
  db.transaction(() => {
    removeIds.forEach(removeChapterWithMemory)
    sql.all<{ id: string }>('SELECT id FROM chapters WHERE project_id = ? ORDER BY position, created_at', projectId)
      .forEach((chapter, position) => sql.run('UPDATE chapters SET position=? WHERE id=?', position, chapter.id))
    if (removeIds.length) sql.run('UPDATE projects SET updated_at=? WHERE id=?', sql.now(), projectId)
  })()
  return { removed: removeIds.length, empty, duplicates }
}

export function snapshotEntity(id: string) {
  return sql.get<Record<string, unknown>>('SELECT * FROM entities WHERE id = ?', id)
}

export function recordEntityEdit(projectId: string, action: string, targetId: string | null, snapshot: unknown, payload: unknown) {
  const editId = sql.id()
  sql.run('INSERT INTO entity_edits VALUES (?, ?, ?, ?, ?, ?, ?, ?)', editId, projectId, action, targetId, JSON.stringify(snapshot), JSON.stringify(payload), 0, sql.now())
  return editId
}

export function refreshEntityMemory(entityId: string) {
  const entity = sql.get<{ project_id: string; name: string; type: string; summary: string; data: string }>('SELECT project_id, name, type, summary, data FROM entities WHERE id = ?', entityId)
  if (!entity) return
  const old = sql.all<{ id: string }>('SELECT id FROM memory_chunks WHERE source_type = ? AND source_id = ?', 'entity', entityId)
  old.forEach(({ id }) => sql.run('DELETE FROM memory_fts WHERE id = ?', id)); sql.run('DELETE FROM memory_chunks WHERE source_type = ? AND source_id = ?', 'entity', entityId)
  sql.addMemory(entity.project_id, 'entity', entityId, `${entity.name}：${entity.summary}\n${entity.data}`, entity.summary, `${entity.name} ${entity.type}`)
}
