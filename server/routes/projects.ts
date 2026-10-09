import fs from 'node:fs'
import { Router } from 'express'
import { z } from 'zod'
import { db, sql } from '../db.ts'
import { searchMemory } from '../memory.ts'
import { generate, generateStream, getModelStatus, normalizeBaseUrl, probeModel, setRuntimeConfig } from '../ai.ts'
import { runReview, selfAuditReviews } from '../review.ts'
import { buildDocx, buildEpub, buildMarkdown, buildTxt, manuscriptContentTypes, manuscriptExtension, type ManuscriptFormat } from '../exporter.ts'
import { buildProjectExport, assembleManuscriptVolumes } from '../project-export.ts'
import { backupPath, listBackups } from '../backup.ts'
import { setEmbeddingAuto, kickBackfill, getEmbeddingSweepState, embeddingStatus, setEmbeddingModel } from '../embeddings.ts'
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
  sql.run('INSERT INTO projects (id, name, genre, premise, status, word_goal, imported, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', projectId, body.name, body.genre, body.premise, 'active', body.wordGoal, 0, stamp, stamp)
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

// 项目快照恢复：接受完整导出 JSON，重建为**新项目**（原名 + 恢复日期），不覆盖现有数据。
projectsRouter.post('/api/projects/restore', asyncRoute(async (req, res) => {
  const payload = req.body as Record<string, unknown> & { project?: Record<string, unknown>; schemaVersion?: number }
  const source = payload.project
  if (!source || !source.name) return res.status(400).json({ error: '这不是有效的项目备份文件（缺少 project 字段）。' })
  const newId = sql.id(); const stamp = sql.now()
  const restoredName = `${String(source.name)}（恢复 ${new Date().toLocaleDateString('zh-CN')}）`
  const remap = (rows: unknown): Array<Record<string, unknown>> => Array.isArray(rows) ? rows as Array<Record<string, unknown>> : []
  const insertRows = (table: string, rows: Array<Record<string, unknown>>, withProjectId = true) => {
    for (const row of rows) {
      const finalRow = withProjectId ? { ...row, project_id: newId } : row
      const keys = Object.keys(finalRow)
      if (!keys.length) continue
      sql.run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((key) => (finalRow as Record<string, unknown>)[key]))
    }
  }
  db.transaction(() => {
    sql.run('INSERT INTO projects (id, name, genre, premise, status, word_goal, imported, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      newId, restoredName, String(source.genre || ''), String(source.premise || ''), String(source.status || 'active'), Number(source.word_goal) || 100000, source.imported ? 1 : 0, String(source.created_at || stamp), stamp)
    insertRows('volumes', remap(payload.volumes))
    insertRows('chapters', remap(payload.chapters))
    sql.run(`INSERT INTO memory_fts (id, project_id, content, summary, keywords)
      SELECT id, project_id, content, summary, keywords FROM memory_chunks WHERE project_id = ?`, newId)
    insertRows('chapter_volume_bindings', remap(payload.chapterVolumeBindings), false)
    insertRows('entities', remap(payload.entities))
    insertRows('plotlines', remap(payload.plotlines))
    insertRows('story_outlines', remap(payload.outlines))
    insertRows('events', remap(payload.events))
    insertRows('relations', remap(payload.relations))
    insertRows('foreshadowing', remap(payload.foreshadowing))
    insertRows('story_facts', remap(payload.facts))
    insertRows('chapter_outlines', remap(payload.chapterOutlines))
    insertRows('memory_chunks', remap(payload.memoryChunks))
    insertRows('imports', remap(payload.imports))
    insertRows('reviews', remap(payload.reviews))
    insertRows('generations', remap(payload.generations))
    insertRows('chapter_history', remap(payload.chapterHistory), false)
    insertRows('analysis_runs', remap(payload.analysisRuns))
  })()
  res.status(201).json({ id: newId, name: restoredName, schemaVersion: payload.schemaVersion ?? null, chapters: remap(payload.chapters).length })
}))

projectsRouter.get('/api/projects/:projectId/search', asyncRoute(async (req, res) => {
  const projectId = String(req.params.projectId)
  requireProject(projectId)
  const query = String(req.query.q || '')
  const chapterId = typeof req.query.chapterId === 'string' ? req.query.chapterId : undefined
  res.json({ query, results: await searchMemory(projectId, query, Number(req.query.limit || 15), chapterId) })
}))

projectsRouter.get('/api/model', (_req, res) => res.json({ ...getModelStatus(), embedding: embeddingStatus() }))
projectsRouter.post('/api/model', (req, res) => {
  const body = z.object({ baseUrl: z.string().url().optional(), apiKey: z.string().optional(), model: z.string().min(1).optional(), embeddingModel: z.string().optional(), clearKey: z.boolean().optional() }).parse(req.body)
  const next: { baseUrl?: string; apiKey?: string; model?: string } = {}
  if (body.baseUrl !== undefined) next.baseUrl = body.baseUrl
  if (body.model !== undefined) next.model = body.model
  if (body.clearKey) next.apiKey = ''
  else if (body.apiKey?.trim()) next.apiKey = body.apiKey
  // 先写入凭据再触发向量回填：setEmbeddingModel 会立刻 kick，需要密钥已就位
  const status = setRuntimeConfig(next)
  if (body.embeddingModel !== undefined) setEmbeddingModel(body.embeddingModel)
  res.json({ ...status, embedding: embeddingStatus() })
})
projectsRouter.post('/api/model/probe', asyncRoute(async (_req, res) => { res.json(await probeModel()) }))
// 向量化控制：作者可暂停后台发送，或手动触发一次处理
projectsRouter.post('/api/embeddings/auto', (req, res) => {
  const body = z.object({ enabled: z.boolean() }).parse(req.body)
  setEmbeddingAuto(body.enabled)
  res.json({ ...embeddingStatus(), auto: body.enabled })
})
projectsRouter.post('/api/embeddings/backfill-now', asyncRoute(async (_req, res) => {
  await kickBackfill(true)
  res.json(embeddingStatus())
}))
// 拉取网关可用模型列表：用户不必猜测模型名。只读探测，不触碰运行时配置。
projectsRouter.post('/api/model/catalog', asyncRoute(async (req, res) => {
  const body = z.object({ baseUrl: z.string().trim().min(1), apiKey: z.string().trim().optional() }).parse(req.body)
  const url = `${normalizeBaseUrl(body.baseUrl).replace(/\/$/, '')}/models`
  const upstream = await fetch(url, { headers: body.apiKey ? { Authorization: `Bearer ${body.apiKey}` } : {}, signal: AbortSignal.timeout(8000) })
  if (!upstream.ok) throw Object.assign(new Error(`模型列表请求失败（HTTP ${upstream.status}）`), { status: 502 })
  const data = await upstream.json() as { data?: Array<{ id?: string }> }
  const models = (data.data ?? []).map((item) => String(item.id || '')).filter(Boolean).sort()
  res.json({ models })
}))

projectsRouter.get('/api/projects/:projectId/reviews', (req, res) => {
  requireProject(req.params.projectId)
  res.json(sql.all<Record<string, unknown>>('SELECT * FROM reviews WHERE project_id = ? ORDER BY CASE severity WHEN \'high\' THEN 1 WHEN \'medium\' THEN 2 ELSE 3 END, created_at DESC', req.params.projectId).map(decodeRow))
})
projectsRouter.post('/api/projects/:projectId/reviews/run', (req, res) => { requireProject(req.params.projectId); res.json({ issues: runReview(req.params.projectId) }) })
// AI 自审：对未预判的 open 审查项做一次预判（可自动/建议忽略/需人工），写回 ai_suggestion
projectsRouter.post('/api/projects/:projectId/reviews/self-audit', asyncRoute(async (req, res) => {
  const projectId = String(req.params.projectId)
  requireProject(projectId)
  res.json(await selfAuditReviews(projectId))
}))
// 按建议批量处理：auto_resolve → resolved，suggest_ignore → ignored；needs_human 保持 open
projectsRouter.post('/api/projects/:projectId/reviews/apply-suggestions', asyncRoute(async (req, res) => {
  const rows = sql.all<{ id: string; ai_suggestion: string }>("SELECT id, ai_suggestion FROM reviews WHERE project_id = ? AND status = 'open' AND ai_suggestion != ''", req.params.projectId)
  let applied = 0
  for (const row of rows) {
    try {
      const suggestion = JSON.parse(row.ai_suggestion) as { verdict: string }
      if (suggestion.verdict === 'auto_resolve') { sql.run("UPDATE reviews SET status = 'resolved' WHERE id = ?", row.id); applied += 1 }
      else if (suggestion.verdict === 'suggest_ignore') { sql.run("UPDATE reviews SET status = 'ignored' WHERE id = ?", row.id); applied += 1 }
    } catch { /* malformed suggestion stays for manual review */ }
  }
  res.json({ applied })
}))
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
