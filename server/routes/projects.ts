import fs from 'node:fs'
import { Router } from 'express'
import { z } from 'zod'
import { db, sql } from '../db.ts'
import { searchMemory } from '../memory.ts'
import { generate, generateStream, getModelStatus, probeModel, setRuntimeConfig } from '../ai.ts'
import { runReview } from '../review.ts'
import { buildDocx, buildEpub, buildMarkdown, buildTxt, manuscriptContentTypes, manuscriptExtension, type ManuscriptFormat } from '../exporter.ts'
import { buildProjectExport, assembleManuscriptVolumes } from '../project-export.ts'
import { backupPath, listBackups } from '../backup.ts'
import { asyncRoute, decodeRow, ensureDefaultVolume, requireProject } from './helpers.ts'

export const projectsRouter = Router()

projectsRouter.get('/api/health', (_req, res) => res.json({ ok: true, database: 'sqlite', model: getModelStatus() }))

projectsRouter.get('/api/projects', (_req, res) => {
  const projects = sql.all<Record<string, unknown>>(`SELECT p.*,
    (SELECT COUNT(*) FROM chapters c WHERE c.project_id = p.id) chapter_count,
    (SELECT COALESCE(SUM(LENGTH(c.content)), 0) FROM chapters c WHERE c.project_id = p.id) character_count,
    (SELECT COUNT(*) FROM entities e WHERE e.project_id = p.id) entity_count,
    (SELECT COUNT(*) FROM reviews r WHERE r.project_id = p.id AND r.status = 'open') open_review_count
    FROM projects p ORDER BY p.updated_at DESC`)
  res.json(projects)
})

projectsRouter.post('/api/projects', (req, res) => {
  const body = z.object({ name: z.string().min(1), genre: z.string().default(''), premise: z.string().default(''), wordGoal: z.number().int().positive().default(100000) }).parse(req.body)
  const projectId = sql.id(); const stamp = sql.now()
  sql.run('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', projectId, body.name, body.genre, body.premise, 'active', body.wordGoal, 0, stamp, stamp)
  ensureDefaultVolume(projectId)
  res.status(201).json(requireProject(projectId))
})

projectsRouter.get('/api/projects/:projectId', (req, res) => {
  const project = requireProject(req.params.projectId)
  const metrics = sql.get<Record<string, unknown>>(`SELECT
    (SELECT COUNT(*) FROM chapters WHERE project_id = ?) chapters,
    (SELECT COALESCE(SUM(LENGTH(content)), 0) FROM chapters WHERE project_id = ?) characters,
    (SELECT COUNT(*) FROM entities WHERE project_id = ?) entities,
    (SELECT COUNT(*) FROM events WHERE project_id = ?) events,
    (SELECT COUNT(*) FROM foreshadowing WHERE project_id = ? AND status != 'resolved') open_foreshadowing,
    (SELECT COUNT(*) FROM reviews WHERE project_id = ? AND status = 'open') open_reviews`,
    req.params.projectId, req.params.projectId, req.params.projectId, req.params.projectId, req.params.projectId, req.params.projectId)
  res.json({ ...project, metrics })
})

projectsRouter.patch('/api/projects/:projectId', (req, res) => {
  requireProject(req.params.projectId)
  const body = z.object({ name: z.string().min(1).optional(), genre: z.string().optional(), premise: z.string().optional(), status: z.enum(['active', 'completed']).optional(), wordGoal: z.number().int().positive().optional() }).parse(req.body)
  const current = requireProject(req.params.projectId)
  sql.run(`UPDATE projects SET name=?, genre=?, premise=?, status=?, word_goal=?, updated_at=? WHERE id=?`,
    body.name ?? current.name, body.genre ?? current.genre, body.premise ?? current.premise,
    body.status ?? current.status, body.wordGoal ?? current.word_goal, sql.now(), req.params.projectId)
  res.json(requireProject(req.params.projectId))
})

projectsRouter.delete('/api/projects/:projectId', (req, res) => {
  requireProject(req.params.projectId)
  const memoryIds = sql.all<{ id: string }>('SELECT id FROM memory_chunks WHERE project_id = ?', req.params.projectId)
  const transaction = db.transaction(() => {
    memoryIds.forEach(({ id }) => sql.run('DELETE FROM memory_fts WHERE id = ?', id))
    sql.run('DELETE FROM projects WHERE id = ?', req.params.projectId)
  })
  transaction()
  res.status(204).end()
})

projectsRouter.get('/api/projects/:projectId/search', (req, res) => {
  requireProject(req.params.projectId)
  const query = String(req.query.q || '')
  const chapterId = typeof req.query.chapterId === 'string' ? req.query.chapterId : undefined
  res.json({ query, results: searchMemory(req.params.projectId, query, Number(req.query.limit || 15), chapterId) })
})

projectsRouter.get('/api/model', (_req, res) => res.json(getModelStatus()))
projectsRouter.post('/api/model', (req, res) => {
  const body = z.object({ baseUrl: z.string().url().optional(), apiKey: z.string().optional(), model: z.string().min(1).optional(), clearKey: z.boolean().optional() }).parse(req.body)
  const next: { baseUrl?: string; apiKey?: string; model?: string } = {}
  if (body.baseUrl !== undefined) next.baseUrl = body.baseUrl
  if (body.model !== undefined) next.model = body.model
  if (body.clearKey) next.apiKey = ''
  else if (body.apiKey?.trim()) next.apiKey = body.apiKey
  res.json(setRuntimeConfig(next))
})
projectsRouter.post('/api/model/probe', asyncRoute(async (_req, res) => { res.json(await probeModel()) }))

projectsRouter.get('/api/projects/:projectId/reviews', (req, res) => {
  requireProject(req.params.projectId)
  res.json(sql.all<Record<string, unknown>>('SELECT * FROM reviews WHERE project_id = ? ORDER BY CASE severity WHEN \'high\' THEN 1 WHEN \'medium\' THEN 2 ELSE 3 END, created_at DESC', req.params.projectId).map(decodeRow))
})
projectsRouter.post('/api/projects/:projectId/reviews/run', (req, res) => { requireProject(req.params.projectId); res.json({ issues: runReview(req.params.projectId) }) })
projectsRouter.patch('/api/reviews/:reviewId', (req, res) => {
  const status = z.object({ status: z.enum(['open', 'resolved', 'ignored']) }).parse(req.body).status
  sql.run('UPDATE reviews SET status=? WHERE id=?', status, req.params.reviewId)
  res.json(decodeRow(sql.get<Record<string, unknown>>('SELECT * FROM reviews WHERE id = ?', req.params.reviewId)!))
})

projectsRouter.get('/api/projects/:projectId/generations', (req, res) => {
  requireProject(req.params.projectId)
  res.json(sql.all('SELECT id, task_type, input, output, model, created_at FROM generations WHERE project_id = ? ORDER BY created_at DESC LIMIT 30', req.params.projectId))
})

projectsRouter.get('/api/projects/:projectId/export', (req, res) => {
  requireProject(req.params.projectId)
  res.setHeader('Content-Disposition', `attachment; filename="novelweaver-${req.params.projectId}.json"`)
  res.json(buildProjectExport(req.params.projectId))
})

projectsRouter.get('/api/projects/:projectId/export/manuscript', asyncRoute(async (req, res) => {
  const project = requireProject(String(req.params.projectId))
  const requested = String(req.query.format || '')
  const format = (['txt', 'md', 'docx', 'epub'] as const).includes(requested as ManuscriptFormat) ? requested as ManuscriptFormat : 'md'
  const volumes = assembleManuscriptVolumes(String(req.params.projectId))
  const name = String(project.name || '未命名作品')
  const extension = manuscriptExtension(format)
  res.setHeader('Content-Type', manuscriptContentTypes[format])
  res.setHeader('Content-Disposition', `attachment; filename="manuscript.${extension}"; filename*=UTF-8''${encodeURIComponent(name)}.${extension}`)
  if (format === 'txt') res.send(buildTxt(name, volumes))
  else if (format === 'docx') res.send(await buildDocx(name, volumes))
  else if (format === 'epub') res.send(await buildEpub(name, volumes))
  else res.send(buildMarkdown(name, volumes))
}))

projectsRouter.get('/api/projects/:projectId/backups', (req, res) => {
  requireProject(req.params.projectId)
  res.json(listBackups(String(req.params.projectId)))
})

projectsRouter.get('/api/projects/:projectId/backups/:file', (req, res) => {
  requireProject(req.params.projectId)
  const file = backupPath(String(req.params.projectId), String(req.params.file))
  if (!file) return res.status(404).json({ error: '备份文件不存在。' })
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.file}"`)
  fs.createReadStream(file).pipe(res)
})
