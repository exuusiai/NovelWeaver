import { Router } from 'express'
import { z } from 'zod'
import { db, sql } from '../db.ts'
import { chapterContentFingerprint } from '../importer.ts'
import { getModelStatus, summarizeWithModel } from '../ai.ts'
import { precheckChapter } from '../review.ts'
import {
  asyncRoute, bindChapterToVolume, chapterSelect, ensureDefaultVolume, rebuildChapterMemory,
  removeChapterWithMemory, requireProject, saveChapterHistory,
} from './helpers.ts'

export const chaptersRouter = Router()

chaptersRouter.get('/api/projects/:projectId/chapters', (req, res) => {
  requireProject(req.params.projectId)
  res.json(sql.all(`${chapterSelect('WHERE c.project_id = ?')} ORDER BY c.position`, req.params.projectId))
})

chaptersRouter.get('/api/projects/:projectId/volumes', (req, res) => {
  requireProject(req.params.projectId)
  ensureDefaultVolume(req.params.projectId)
  const volumes = sql.all<Record<string, unknown>>(`SELECT v.*,
    (SELECT COUNT(*) FROM chapter_volume_bindings b WHERE b.volume_id=v.id) chapter_count,
    (SELECT COALESCE(SUM(LENGTH(c.content)), 0) FROM chapter_volume_bindings b JOIN chapters c ON c.id=b.chapter_id WHERE b.volume_id=v.id) character_count
    FROM volumes v WHERE v.project_id=? ORDER BY v.order_index`, req.params.projectId)
  res.json(volumes)
})

chaptersRouter.post('/api/projects/:projectId/volumes', (req, res) => {
  requireProject(req.params.projectId)
  const body = z.object({ title: z.string().min(1), summary: z.string().default('') }).parse(req.body)
  const order = (sql.get<{ max: number }>('SELECT COALESCE(MAX(order_index), -1) max FROM volumes WHERE project_id=?', req.params.projectId)?.max ?? -1) + 1
  const volumeId = sql.id(); const stamp = sql.now()
  sql.run('INSERT INTO volumes VALUES (?, ?, ?, ?, ?, ?, ?)', volumeId, req.params.projectId, body.title, body.summary, order, stamp, stamp)
  res.status(201).json(sql.get('SELECT * FROM volumes WHERE id=?', volumeId))
})

chaptersRouter.patch('/api/volumes/:volumeId', (req, res) => {
  const current = sql.get<Record<string, unknown>>('SELECT * FROM volumes WHERE id=?', req.params.volumeId)
  if (!current) return res.status(404).json({ error: '卷不存在。' })
  const body = z.object({ title: z.string().min(1).optional(), summary: z.string().optional(), orderIndex: z.number().int().nonnegative().optional() }).parse(req.body)
  sql.run('UPDATE volumes SET title=?, summary=?, order_index=?, updated_at=? WHERE id=?', body.title ?? current.title, body.summary ?? current.summary, body.orderIndex ?? current.order_index, sql.now(), req.params.volumeId)
  res.json(sql.get('SELECT * FROM volumes WHERE id=?', req.params.volumeId))
})

chaptersRouter.delete('/api/volumes/:volumeId', (req, res) => {
  const current = sql.get<{ project_id: string }>('SELECT project_id FROM volumes WHERE id=?', req.params.volumeId)
  if (!current) return res.status(404).json({ error: '卷不存在。' })
  const fallback = sql.get<{ id: string }>('SELECT id FROM volumes WHERE project_id=? AND id<>? ORDER BY order_index LIMIT 1', current.project_id, req.params.volumeId)
  if (!fallback) return res.status(409).json({ error: '项目至少需要保留一卷。' })
  db.transaction(() => {
    sql.all<{ chapter_id: string }>('SELECT chapter_id FROM chapter_volume_bindings WHERE volume_id=? ORDER BY order_index', req.params.volumeId).forEach((row) => bindChapterToVolume(current.project_id, row.chapter_id, fallback.id))
    sql.run('DELETE FROM volumes WHERE id=?', req.params.volumeId)
  })()
  res.status(204).end()
})

chaptersRouter.post('/api/projects/:projectId/chapters', (req, res) => {
  requireProject(req.params.projectId)
  const body = z.object({ title: z.string().min(1), content: z.string().default(''), summary: z.string().default(''), pov: z.string().default(''), targetWords: z.number().int().positive().default(3000), afterChapterId: z.string().nullable().optional() }).parse(req.body)
  const after = body.afterChapterId ? sql.get<{ position: number; project_id: string }>('SELECT position, project_id FROM chapters WHERE id = ?', body.afterChapterId) : undefined
  if (after && after.project_id !== req.params.projectId) return res.status(400).json({ error: '插入位置不属于当前项目。' })
  const position = after ? after.position + 1 : (sql.get<{ max: number }>('SELECT COALESCE(MAX(position), -1) max FROM chapters WHERE project_id = ?', req.params.projectId)?.max ?? -1) + 1
  const chapterId = sql.id(); const stamp = sql.now()
  db.transaction(() => {
    if (after) sql.run('UPDATE chapters SET position=position+1 WHERE project_id=? AND position>=?', req.params.projectId, position)
    sql.run(`INSERT INTO chapters VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, chapterId, req.params.projectId, body.title,
      body.content, position, 'draft', body.summary, body.pov, body.targetWords, stamp, stamp)
    sql.run('INSERT INTO chapter_marks VALUES (?, ?, ?, ?, ?, ?)', chapterId, req.params.projectId, 0, 'normal', '', stamp)
    const afterBinding = body.afterChapterId ? sql.get<{ volume_id: string }>('SELECT volume_id FROM chapter_volume_bindings WHERE chapter_id=?', body.afterChapterId) : undefined
    bindChapterToVolume(req.params.projectId, chapterId, afterBinding?.volume_id)
    if (chapterContentFingerprint(body.content)) {
      rebuildChapterMemory(req.params.projectId, chapterId, body.title, body.content, body.summary)
      sql.run('UPDATE projects SET updated_at=? WHERE id=?', stamp, req.params.projectId)
    }
  })()
  res.status(201).json(sql.get(chapterSelect('WHERE c.id = ?'), chapterId))
})

chaptersRouter.patch('/api/chapters/:chapterId', (req, res) => {
  const current = sql.get<Record<string, unknown>>('SELECT * FROM chapters WHERE id = ?', req.params.chapterId)
  if (!current) return res.status(404).json({ error: '章节不存在。' })
  const body = z.object({ title: z.string().optional(), content: z.string().optional(), summary: z.string().optional(), pov: z.string().optional(), status: z.string().optional(), targetWords: z.number().int().positive().optional(), position: z.number().int().nonnegative().optional() }).parse(req.body)
  if (body.content !== undefined && chapterContentFingerprint(String(current.content)) !== chapterContentFingerprint(body.content)) {
    saveChapterHistory({ id: String(current.id), project_id: String(current.project_id), title: String(current.title), content: String(current.content), summary: String(current.summary ?? '') })
  }
  sql.run(`UPDATE chapters SET title=?, content=?, summary=?, pov=?, status=?, target_words=?, position=?, updated_at=? WHERE id=?`,
    body.title ?? current.title, body.content ?? current.content, body.summary ?? current.summary, body.pov ?? current.pov,
    body.status ?? current.status, body.targetWords ?? current.target_words, body.position ?? current.position, sql.now(), req.params.chapterId)
  if (body.content !== undefined) {
    rebuildChapterMemory(String(current.project_id), req.params.chapterId, String(body.title ?? current.title), body.content, String(body.summary ?? current.summary ?? ''))
  }
  sql.run('UPDATE projects SET updated_at=? WHERE id=?', sql.now(), current.project_id)
  res.json(sql.get(chapterSelect('WHERE c.id = ?'), req.params.chapterId))
})

chaptersRouter.get('/api/chapters/:chapterId/history', (req, res) => {
  const chapter = sql.get<{ project_id: string }>('SELECT project_id FROM chapters WHERE id = ?', req.params.chapterId)
  if (!chapter) return res.status(404).json({ error: '章节不存在。' })
  const rows = sql.all<{ id: string; title: string; summary: string; word_count: number; content: string; created_at: string }>(
    'SELECT id, title, summary, word_count, content, created_at FROM chapter_history WHERE chapter_id = ? ORDER BY created_at DESC', req.params.chapterId)
  res.json(rows.map(({ content, ...row }) => ({ ...row, preview: content.replace(/\s+/g, ' ').slice(0, 120) })))
})

chaptersRouter.post('/api/chapters/:chapterId/history/:historyId/restore', (req, res) => {
  const chapter = sql.get<Record<string, unknown>>('SELECT * FROM chapters WHERE id = ?', req.params.chapterId)
  if (!chapter) return res.status(404).json({ error: '章节不存在。' })
  const version = sql.get<{ id: string; title: string; content: string; summary: string }>(
    'SELECT id, title, content, summary FROM chapter_history WHERE id = ? AND chapter_id = ?', req.params.historyId, req.params.chapterId)
  if (!version) return res.status(404).json({ error: '历史版本不存在。' })
  const stamp = sql.now()
  db.transaction(() => {
    saveChapterHistory({ id: String(chapter.id), project_id: String(chapter.project_id), title: String(chapter.title), content: String(chapter.content), summary: String(chapter.summary ?? '') })
    sql.run('UPDATE chapters SET title=?, content=?, summary=?, updated_at=? WHERE id=?',
      version.title, version.content, version.summary || String(chapter.summary ?? ''), stamp, req.params.chapterId)
    rebuildChapterMemory(String(chapter.project_id), req.params.chapterId, version.title, version.content, version.summary)
    sql.run('UPDATE projects SET updated_at=? WHERE id=?', stamp, chapter.project_id)
  })()
  res.json(sql.get(chapterSelect('WHERE c.id = ?'), req.params.chapterId))
})

chaptersRouter.patch('/api/chapters/:chapterId/outline', (req, res) => {
  const chapter = sql.get<{ project_id: string }>('SELECT project_id FROM chapters WHERE id=?', req.params.chapterId)
  if (!chapter) return res.status(404).json({ error: '章节不存在。' })
  const body = z.object({ content: z.string(), status: z.enum(['candidate', 'active', 'archived']).optional() }).parse(req.body)
  const current = sql.get<{ source_outline_id: string | null; created_at: string }>('SELECT source_outline_id, created_at FROM chapter_outlines WHERE chapter_id=?', req.params.chapterId)
  const stamp = sql.now()
  sql.run(`INSERT INTO chapter_outlines VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chapter_id) DO UPDATE SET content=excluded.content, status=excluded.status, updated_at=excluded.updated_at`,
  req.params.chapterId, chapter.project_id, current?.source_outline_id ?? null, body.content, body.status ?? 'active', current?.created_at ?? stamp, stamp)
  res.json(sql.get(chapterSelect('WHERE c.id=?'), req.params.chapterId))
})

chaptersRouter.patch('/api/chapters/:chapterId/mark', (req, res) => {
  const current = sql.get<{ id: string; project_id: string }>('SELECT id, project_id FROM chapters WHERE id = ?', req.params.chapterId)
  if (!current) return res.status(404).json({ error: '章节不存在。' })
  const body = z.object({ bookmarked: z.boolean().optional(), importance: z.enum(['normal', 'important', 'critical']).optional(), note: z.string().max(500).optional() }).parse(req.body)
  const existing = sql.get<{ bookmarked: number; importance: string; note: string }>('SELECT bookmarked, importance, note FROM chapter_marks WHERE chapter_id = ?', current.id)
  sql.run(`INSERT INTO chapter_marks (chapter_id, project_id, bookmarked, importance, note, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(chapter_id) DO UPDATE SET bookmarked=excluded.bookmarked, importance=excluded.importance, note=excluded.note, updated_at=excluded.updated_at`,
  current.id, current.project_id, body.bookmarked === undefined ? existing?.bookmarked ?? 0 : Number(body.bookmarked), body.importance ?? existing?.importance ?? 'normal', body.note ?? existing?.note ?? '', sql.now())
  res.json(sql.get(chapterSelect('WHERE c.id = ?'), current.id))
})

chaptersRouter.patch('/api/chapters/:chapterId/volume', (req, res) => {
  const chapter = sql.get<{ project_id: string }>('SELECT project_id FROM chapters WHERE id=?', req.params.chapterId)
  if (!chapter) return res.status(404).json({ error: '章节不存在。' })
  const body = z.object({ volumeId: z.string(), orderIndex: z.number().int().nonnegative().optional() }).parse(req.body)
  const volume = sql.get<{ project_id: string }>('SELECT project_id FROM volumes WHERE id=?', body.volumeId)
  if (!volume || volume.project_id !== chapter.project_id) return res.status(400).json({ error: '目标卷无效。' })
  bindChapterToVolume(chapter.project_id, req.params.chapterId, body.volumeId)
  if (body.orderIndex !== undefined) sql.run('UPDATE chapter_volume_bindings SET order_index=? WHERE chapter_id=?', body.orderIndex, req.params.chapterId)
  res.json(sql.get(chapterSelect('WHERE c.id=?'), req.params.chapterId))
})

chaptersRouter.delete('/api/chapters/:chapterId', (req, res) => {
  const current = sql.get<{ project_id: string }>('SELECT project_id FROM chapters WHERE id = ?', req.params.chapterId)
  if (!current) return res.status(404).json({ error: '章节不存在。' })
  db.transaction(() => {
    removeChapterWithMemory(req.params.chapterId)
    const remaining = sql.all<{ id: string }>('SELECT id FROM chapters WHERE project_id = ? ORDER BY position, created_at', current.project_id)
    remaining.forEach((chapter, position) => sql.run('UPDATE chapters SET position=? WHERE id=?', position, chapter.id))
    sql.run('UPDATE projects SET updated_at=? WHERE id=?', sql.now(), current.project_id)
  })()
  res.status(204).end()
})

chaptersRouter.get('/api/chapters/:chapterId/precheck', (req, res) => {
  const chapter = sql.get<{ id: string }>('SELECT id FROM chapters WHERE id = ?', req.params.chapterId)
  if (!chapter) return res.status(404).json({ error: '章节不存在。' })
  res.json({ issues: precheckChapter(req.params.chapterId) })
})

chaptersRouter.post('/api/chapters/:chapterId/summary/rewrite', asyncRoute(async (req, res) => {
  const current = sql.get<{ id: string; project_id: string; title: string; content: string; summary: string }>(
    'SELECT id, project_id, title, content, summary FROM chapters WHERE id = ?', req.params.chapterId)
  if (!current) return res.status(404).json({ error: '章节不存在。' })
  if (current.content.replace(/\s/g, '').length < 40) return res.status(400).json({ error: '正文太短，先写一些内容再生成摘要。' })
  if (!getModelStatus().configured) {
    throw Object.assign(new Error('章节摘要重写需要模型 API；配置后可用。本地规则模式不会用截断冒充摘要。'), { status: 409, code: 'MODEL_REQUIRED' })
  }
  const summary = await summarizeWithModel(current.title, current.content)
  const stamp = sql.now()
  db.transaction(() => {
    sql.run('UPDATE chapters SET summary=?, updated_at=? WHERE id=?', summary, stamp, current.id)
    rebuildChapterMemory(current.project_id, current.id, current.title, current.content, summary)
    sql.run('UPDATE projects SET updated_at=? WHERE id=?', stamp, current.project_id)
  })()
  res.json(sql.get(chapterSelect('WHERE c.id = ?'), current.id))
}))
