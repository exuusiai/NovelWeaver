import express from 'express'
import multer from 'multer'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { db, sql } from './db.ts'
import { chapterContentFingerprint, chunkText, extractText, isEffectivelyEmptyChapter, splitChaptersDetailed, summarize } from './importer.ts'
import { assembleContext, searchMemory } from './memory.ts'
import { generate, getModelStatus, probeModel, setRuntimeConfig } from './ai.ts'
import { analyzeManuscript, characterNameVariants } from './analyzer.ts'
import { runReview } from './review.ts'
import { chapterOutlineMarkdown, decomposeOutline, outlineDecompositionSchema } from './planner.ts'

const app = express()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024 } })
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const port = Number(process.env.PORT || 4300)

app.use(express.json({ limit: '5mb' }))

const asyncRoute = (handler: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response, next: express.NextFunction) => handler(req, res).catch(next)

function decodeRow<T extends Record<string, unknown>>(row: T) {
  const output: Record<string, unknown> = { ...row }
  for (const key of ['data', 'participants', 'knowledge', 'evidence', 'diagnostics', 'details', 'result', 'snapshot', 'payload', 'metrics', 'disagreements', 'chapters']) {
    if (typeof output[key] === 'string') {
      try { output[key] = JSON.parse(output[key] as string) } catch { /* retain raw value */ }
    }
  }
  return output
}

function requireProject(projectId: string) {
  const project = sql.get<Record<string, unknown>>('SELECT * FROM projects WHERE id = ?', projectId)
  if (!project) throw Object.assign(new Error('项目不存在。'), { status: 404 })
  return project
}

function analysisModelRequired() {
  return Object.assign(new Error('需要先配置可用的模型 API，才能进行可靠的文稿分析。当前本地模式不会猜测人物和地点。'), { status: 409, code: 'MODEL_REQUIRED' })
}

function removeChapterWithMemory(chapterId: string) {
  const memoryIds = sql.all<{ id: string }>('SELECT id FROM memory_chunks WHERE chapter_id = ?', chapterId)
  memoryIds.forEach((row) => sql.run('DELETE FROM memory_fts WHERE id = ?', row.id))
  sql.run('DELETE FROM memory_chunks WHERE chapter_id = ?', chapterId)
  sql.run('DELETE FROM events WHERE chapter_id = ?', chapterId)
  sql.run('DELETE FROM chapters WHERE id = ?', chapterId)
}

function ensureDefaultVolume(projectId: string) {
  const existing = sql.get<{ id: string }>('SELECT id FROM volumes WHERE project_id=? ORDER BY order_index LIMIT 1', projectId)
  if (existing) return existing.id
  const volumeId = sql.id(); const stamp = sql.now()
  sql.run('INSERT INTO volumes VALUES (?, ?, ?, ?, ?, ?, ?)', volumeId, projectId, '第一卷', '', 0, stamp, stamp)
  return volumeId
}

function bindChapterToVolume(projectId: string, chapterId: string, volumeId?: string | null) {
  const target = volumeId || ensureDefaultVolume(projectId)
  const order = (sql.get<{ max: number }>('SELECT COALESCE(MAX(order_index), -1) max FROM chapter_volume_bindings WHERE volume_id=?', target)?.max ?? -1) + 1
  sql.run(`INSERT INTO chapter_volume_bindings (chapter_id, volume_id, order_index) VALUES (?, ?, ?)
    ON CONFLICT(chapter_id) DO UPDATE SET volume_id=excluded.volume_id, order_index=excluded.order_index`, chapterId, target, order)
}

function chapterSelect(where: string) {
  return `SELECT c.*, COALESCE(m.bookmarked, 0) AS bookmarked, COALESCE(m.importance, 'normal') AS importance,
    COALESCE(m.note, '') AS mark_note, COALESCE(o.content, '') AS detailed_outline,
    COALESCE(o.status, '') AS outline_status, b.volume_id, v.title AS volume_title, b.order_index AS volume_order_index
    FROM chapters c LEFT JOIN chapter_marks m ON m.chapter_id = c.id
    LEFT JOIN chapter_outlines o ON o.chapter_id=c.id
    LEFT JOIN chapter_volume_bindings b ON b.chapter_id=c.id LEFT JOIN volumes v ON v.id=b.volume_id ${where}`
}

function normalizeChapterPositions(projectId: string) {
  sql.all<{ id: string }>('SELECT id FROM chapters WHERE project_id = ? ORDER BY position, created_at', projectId)
    .forEach((chapter, position) => sql.run('UPDATE chapters SET position=? WHERE id=?', position, chapter.id))
}

function deduplicateImportedChapters(projectId: string) {
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

function updateAnalysisJob(jobId: string, values: { status?: string; stage?: string; progress?: number; message?: string; error?: string; result?: unknown }) {
  const current = sql.get<Record<string, unknown>>('SELECT * FROM analysis_jobs WHERE id = ?', jobId)
  if (!current) return
  sql.run(`UPDATE analysis_jobs SET status=?, stage=?, progress=?, message=?, error=?, result=?, updated_at=? WHERE id=?`,
    values.status ?? current.status, values.stage ?? current.stage, values.progress ?? current.progress,
    values.message ?? current.message, values.error ?? current.error, values.result ? JSON.stringify(values.result) : current.result,
    sql.now(), jobId)
}

function analysisQuality(projectId: string) {
  const run = sql.get<Record<string, unknown>>('SELECT * FROM analysis_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1', projectId)
  const chapters = sql.all<{ id: string; content: string }>('SELECT id, content FROM chapters WHERE project_id = ? AND LENGTH(TRIM(content)) > 0', projectId)
  const entities = sql.all<{ data: string; confidence: number; canon_status: string }>('SELECT data, confidence, canon_status FROM entities WHERE project_id = ?', projectId)
  const events = sql.all<{ chapter_id: string | null; knowledge: string }>('SELECT chapter_id, knowledge FROM events WHERE project_id = ?', projectId)
  const evidenceEntities = entities.filter((row) => { try { const data = JSON.parse(row.data); return Array.isArray(data.evidence) && data.evidence.length > 0 } catch { return false } }).length
  const linkedEvents = events.filter((row) => Boolean(row.chapter_id)).length
  const details = run?.details ? decodeRow(run).details as Record<string, unknown> : {}
  const failedJobs = sql.all<{ id: string; message: string; error: string; status: string; stage: string }>("SELECT id, message, error, status, stage FROM analysis_jobs WHERE project_id = ? AND status IN ('failed','partial') ORDER BY created_at DESC LIMIT 20", projectId)
  return {
    run: run ? decodeRow(run) : null,
    metrics: {
      chapters: chapters.length, analyzedCharacters: chapters.reduce((sum, row) => sum + row.content.length, 0),
      estimatedInputTokens: Math.ceil(chapters.reduce((sum, row) => sum + row.content.length, 0) / 3),
      entities: entities.length, evidenceCoverage: entities.length ? Math.round(evidenceEntities / entities.length * 100) : 0,
      eventChapterCoverage: events.length ? Math.round(linkedEvents / events.length * 100) : 0,
      candidateCount: entities.filter((row) => row.canon_status === 'candidate').length,
      lowConfidenceCount: entities.filter((row) => row.confidence < .65).length,
      hallucinationRiskCount: entities.filter((row) => row.canon_status === 'candidate' && (row.confidence < .65 || (() => { try { const data = JSON.parse(row.data); return !Array.isArray(data.evidence) || data.evidence.length === 0 } catch { return true } })())).length,
      truncationFailures: failedJobs.filter((row) => /截断|长度上限|truncat|max.?token/i.test(`${row.message} ${row.error}`)).length,
      failedJobs: failedJobs.length, details,
    }, failedJobs,
  }
}

function snapshotEntity(id: string) {
  return sql.get<Record<string, unknown>>('SELECT * FROM entities WHERE id = ?', id)
}

function recordEntityEdit(projectId: string, action: string, targetId: string | null, snapshot: unknown, payload: unknown) {
  const editId = sql.id()
  sql.run('INSERT INTO entity_edits VALUES (?, ?, ?, ?, ?, ?, ?, ?)', editId, projectId, action, targetId, JSON.stringify(snapshot), JSON.stringify(payload), 0, sql.now())
  return editId
}

function refreshEntityMemory(entityId: string) {
  const entity = sql.get<{ project_id: string; name: string; type: string; summary: string; data: string }>('SELECT project_id, name, type, summary, data FROM entities WHERE id = ?', entityId)
  if (!entity) return
  const old = sql.all<{ id: string }>('SELECT id FROM memory_chunks WHERE source_type = ? AND source_id = ?', 'entity', entityId)
  old.forEach(({ id }) => sql.run('DELETE FROM memory_fts WHERE id = ?', id)); sql.run('DELETE FROM memory_chunks WHERE source_type = ? AND source_id = ?', 'entity', entityId)
  sql.addMemory(entity.project_id, 'entity', entityId, `${entity.name}：${entity.summary}\n${entity.data}`, entity.summary, `${entity.name} ${entity.type}`)
}

async function analyzeProjectData(projectId: string, replaceCandidates = false, jobId?: string, onlyChapterIds?: string[]) {
  if (!getModelStatus().configured) throw analysisModelRequired()
  if (jobId) updateAnalysisJob(jobId, { status: 'running', stage: 'preparing', progress: 5, message: '正在读取章节并建立分析快照' })
  const allChapters = sql.all<{ id: string; title: string; content: string }>('SELECT id, title, content FROM chapters WHERE project_id = ? AND LENGTH(TRIM(content)) > 0 ORDER BY position', projectId)
  const chapters = onlyChapterIds?.length ? allChapters.filter((chapter) => onlyChapterIds.includes(chapter.id)) : allChapters
  const completedChapterIds = new Set<string>()
  let result: Awaited<ReturnType<typeof analyzeManuscript>>
  try {
    if (jobId) updateAnalysisJob(jobId, { stage: 'extracting', progress: 22, message: `正在分批提取 ${chapters.length} 个章节的实体与事件` })
    result = await analyzeManuscript(chapters, {
      continueOnError: Boolean(jobId),
      shouldPause: () => jobId ? sql.get<{ status: string }>('SELECT status FROM analysis_jobs WHERE id = ?', jobId)?.status === 'paused' : false,
      onProgress: ({ chapterIds }) => { if (jobId) { chapterIds.forEach((id) => completedChapterIds.add(id)); updateAnalysisJob(jobId, { stage: 'extracting', progress: 10 + Math.round(completedChapterIds.size / Math.max(chapters.length, 1) * 68), message: `已完成 ${completedChapterIds.size}/${chapters.length} 个章节`, result: { completedChapterIds: [...completedChapterIds], totalChapters: chapters.length } }) } },
    })
  } catch (error) {
    const stamp = sql.now()
    sql.run('INSERT INTO analysis_runs VALUES (?, ?, ?, ?, ?, ?)', sql.id(), projectId, 'failed', getModelStatus().model,
      JSON.stringify({ message: (error as Error).message }), stamp)
    if (jobId) updateAnalysisJob(jobId, { status: 'failed', stage: 'failed', progress: 100, error: (error as Error).message, message: '分析失败，可重试此任务' })
    throw error
  }
  const stamp = sql.now()
  if (jobId) updateAnalysisJob(jobId, { stage: 'persisting', progress: 82, message: '正在写入候选设定、剧情线与事实摘要' })
  const candidateIds = replaceCandidates ? sql.all<{ id: string }>(`SELECT id FROM entities WHERE project_id = ? AND canon_status = 'candidate'
    AND (json_extract(data, '$.source') = 'model-analysis' OR summary LIKE '从导入文稿中出现%')`, projectId) : []
  const entityIdByName = new Map<string, string>()
  const normalized = (value: string) => value.trim().toLowerCase()
  const transaction = db.transaction(() => {
    candidateIds.forEach(({ id }) => {
      const memoryIds = sql.all<{ id: string }>('SELECT id FROM memory_chunks WHERE source_type = ? AND source_id = ?', 'entity', id)
      memoryIds.forEach((memory) => sql.run('DELETE FROM memory_fts WHERE id = ?', memory.id))
      sql.run('DELETE FROM memory_chunks WHERE source_type = ? AND source_id = ?', 'entity', id)
      sql.run('DELETE FROM relations WHERE from_entity_id = ? OR to_entity_id = ?', id, id)
      sql.run('DELETE FROM entities WHERE id = ?', id)
    })
    if (replaceCandidates) {
      sql.run("DELETE FROM events WHERE project_id = ? AND status = 'candidate'", projectId)
      sql.run("DELETE FROM plotlines WHERE project_id = ? AND status = 'candidate'", projectId)
      sql.run("DELETE FROM story_facts WHERE project_id = ? AND canon_status = 'candidate'", projectId)
    }
    sql.all<{ id: string; type: string; name: string; data: string }>('SELECT id, type, name, data FROM entities WHERE project_id = ?', projectId).forEach((entity) => {
      const addName = (name: string) => (entity.type === 'character' ? characterNameVariants(name) : new Set([normalized(name)])).forEach((variant) => entityIdByName.set(variant, entity.id))
      addName(entity.name)
      try { const data = JSON.parse(entity.data); if (Array.isArray(data.aliases)) data.aliases.forEach((alias: unknown) => addName(String(alias))) } catch { /* legacy data may not be JSON */ }
    })
    for (const entity of result.entities) {
      const lookupNames = [entity.name, ...entity.aliases].flatMap((name) => entity.type === 'character' ? [...characterNameVariants(name)] : [normalized(name)])
      const knownId = lookupNames.map((name) => entityIdByName.get(name)).find(Boolean)
      const existing = knownId ? sql.get<{ id: string; canon_status: string; data: string; summary: string }>('SELECT id, canon_status, data, summary FROM entities WHERE project_id = ? AND id = ?', projectId, knownId) : undefined
      const priorData = existing ? (() => { try { return JSON.parse(existing.data) as Record<string, unknown> } catch { return {} } })() : {}
      const priorAliases = Array.isArray(priorData.aliases) ? priorData.aliases.map(String) : []
      const data = { ...priorData, ...entity.data, aliases: [...new Set([...priorAliases, ...entity.aliases])], evidence: entity.evidence, source: existing && priorData.source === 'user-correction' ? 'user-correction' : 'model-analysis' }
      if (existing) {
        lookupNames.forEach((name) => entityIdByName.set(name, existing.id))
        if (existing.canon_status === 'candidate') sql.run('UPDATE entities SET type=?, summary=?, data=?, confidence=?, updated_at=? WHERE id=?', entity.type, entity.summary, JSON.stringify(data), .8, stamp, existing.id)
      } else {
        const id = sql.id(); lookupNames.forEach((name) => entityIdByName.set(name, id))
        sql.run(`INSERT INTO entities VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, projectId, entity.type, entity.name, entity.summary, JSON.stringify(data), 'candidate', .8, null, stamp, stamp)
        sql.addMemory(projectId, 'entity', id, `${entity.name}：${entity.summary}\n${JSON.stringify(data)}`, entity.summary, `${entity.name} ${entity.type}`)
      }
      const resolvedId = lookupNames.map((name) => entityIdByName.get(name)).find(Boolean)
      if (resolvedId) lookupNames.forEach((name) => entityIdByName.set(name, resolvedId))
    }
    const eventIds = new Map<string, string>()
    for (const event of result.events) {
      const chapter = chapters.find((item) => item.title === event.chapterTitle || event.chapterTitle.startsWith(item.title) || item.title.startsWith(event.chapterTitle))
      const id = sql.id(); eventIds.set(event.title, id)
      const order = (sql.get<{ max: number }>('SELECT COALESCE(MAX(narrative_order), 0) max FROM events WHERE project_id = ?', projectId)?.max ?? 0) + 1
      sql.run(`INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, projectId, event.title, event.summary, event.storyTime, order, 'candidate', null, chapter?.id ?? null, JSON.stringify(event.participants), event.location, event.cause, event.consequence, JSON.stringify({ source: 'model-analysis' }), stamp, stamp)
      const factExists = sql.get('SELECT id FROM story_facts WHERE project_id=? AND subject=? AND predicate=? AND value=?', projectId, event.title, '事件摘要', event.summary)
      if (!factExists) sql.run('INSERT INTO story_facts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', sql.id(), projectId, event.title, '事件摘要', event.summary, chapter?.id ?? null, chapter ? allChapters.findIndex((item) => item.id === chapter.id) : 0, 65, 'candidate', event.consequence || event.summary, stamp, stamp)
    }
    for (const plot of result.plotlines) {
      const plotId = sql.id()
      sql.run('INSERT INTO plotlines VALUES (?, ?, ?, ?, ?, ?, ?, ?)', plotId, projectId, plot.name, plot.type, plot.summary, plot.type === 'main' ? '#0c6f68' : '#b7613c', 'candidate', stamp)
      plot.eventTitles.forEach((title) => { const eventId = eventIds.get(title); if (eventId) sql.run('UPDATE events SET plotline_id=? WHERE id=?', plotId, eventId) })
    }
    for (const relation of result.relations) {
      const from = entityIdByName.get(normalized(relation.from)); const to = entityIdByName.get(normalized(relation.to))
      if (!from || !to || from === to) continue
      const exists = sql.get('SELECT id FROM relations WHERE project_id=? AND from_entity_id=? AND to_entity_id=? AND type=?', projectId, from, to, relation.type)
      if (!exists) sql.run('INSERT INTO relations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', sql.id(), projectId, from, to, relation.type, relation.label, relation.sentiment, Math.round(relation.strength), '', '', stamp)
    }
    sql.run('INSERT INTO analysis_runs VALUES (?, ?, ?, ?, ?, ?)', sql.id(), projectId, result.failures.length ? 'partial' : 'completed', getModelStatus().model, JSON.stringify({ entities: result.entities.length, events: result.events.length, plotlines: result.plotlines.length, relations: result.relations.length, batches: result.batches, failures: result.failures }), stamp)
    sql.run('UPDATE projects SET updated_at=? WHERE id=?', stamp, projectId)
  })
  transaction()
  if (jobId) updateAnalysisJob(jobId, { status: result.failures.length ? 'partial' : 'completed', stage: 'completed', progress: 100, message: result.failures.length ? `分析完成，${result.failures.length} 个批次需要重试` : '分析完成', result: { entities: result.entities.length, events: result.events.length, plotlines: result.plotlines.length, relations: result.relations.length, batches: result.batches, failures: result.failures } })
  return result
}

const activeAnalysisJobs = new Set<string>()

function startAnalysisJob(jobId: string, onlyChapterIds?: string[]) {
  if (activeAnalysisJobs.has(jobId)) return
  const job = sql.get<{ project_id: string; replace_candidates: number }>('SELECT project_id, replace_candidates FROM analysis_jobs WHERE id = ?', jobId)
  if (!job) return
  activeAnalysisJobs.add(jobId)
  setImmediate(() => {
    const task = job.replace_candidates === -1 ? runSecondPassJob(jobId, job.project_id) : analyzeProjectData(job.project_id, Boolean(job.replace_candidates) && !onlyChapterIds?.length, jobId, onlyChapterIds)
    void task.catch(() => undefined).finally(() => activeAnalysisJobs.delete(jobId))
  })
}

async function runSecondPassJob(jobId: string, projectId: string) {
  try {
    updateAnalysisJob(jobId, { status: 'running', stage: 'second-pass', progress: 10, message: '正在独立复核实体与事件' })
    const chapters = sql.all<{ id: string; title: string; content: string }>('SELECT id, title, content FROM chapters WHERE project_id = ? AND LENGTH(TRIM(content)) > 0 ORDER BY position', projectId)
    const second = await analyzeManuscript(chapters, { continueOnError: true, shouldPause: () => sql.get<{ status: string }>('SELECT status FROM analysis_jobs WHERE id = ?', jobId)?.status === 'paused', onProgress: ({ completed, total }) => updateAnalysisJob(jobId, { progress: 10 + Math.round(completed / total * 75), message: `复核进度 ${completed}/${total}` }) })
    const primaryEntities = sql.all<{ name: string; type: string }>('SELECT name, type FROM entities WHERE project_id = ?', projectId)
    const primaryEvents = sql.all<{ title: string }>('SELECT title FROM events WHERE project_id = ?', projectId)
    const entityKeys = new Set(primaryEntities.map((item) => `${item.type}:${item.name.toLowerCase()}`)); const eventKeys = new Set(primaryEvents.map((item) => item.title.toLowerCase()))
    const disagreements = [
      ...second.entities.filter((item) => !entityKeys.has(`${item.type}:${item.name.toLowerCase()}`)).map((item) => ({ kind: 'missing_entity', label: item.name, detail: `二次分析发现了主分析未记录的${item.type}` })),
      ...second.events.filter((item) => !eventKeys.has(item.title.toLowerCase())).map((item) => ({ kind: 'missing_event', label: item.title, detail: `二次分析在《${item.chapterTitle}》发现了额外事件` })),
    ]
    const metrics = { secondPassEntities: second.entities.length, secondPassEvents: second.events.length, disagreements: disagreements.length, failedBatches: second.failures.length, estimatedInputTokens: Math.ceil(chapters.reduce((sum, chapter) => sum + chapter.content.length, 0) / 3) }
    sql.run('INSERT INTO analysis_quality VALUES (?, ?, ?, ?, ?, ?, ?)', sql.id(), projectId, jobId, 'second-pass', JSON.stringify(metrics), JSON.stringify(disagreements), sql.now())
    updateAnalysisJob(jobId, { status: second.failures.length ? 'partial' : 'completed', stage: 'completed', progress: 100, message: `复核完成，发现 ${disagreements.length} 项分歧`, result: { metrics, disagreements, failures: second.failures } })
  } catch (error) { updateAnalysisJob(jobId, { status: 'failed', stage: 'failed', progress: 100, message: '独立复核失败', error: (error as Error).message }) }
}

sql.run("UPDATE analysis_jobs SET status='paused', stage='recovered', message='服务重启后已暂停，可继续运行', updated_at=? WHERE status IN ('queued','running')", sql.now())

app.get('/api/health', (_req, res) => res.json({ ok: true, database: 'sqlite', model: getModelStatus() }))

app.get('/api/projects', (_req, res) => {
  const projects = sql.all<Record<string, unknown>>(`SELECT p.*,
    (SELECT COUNT(*) FROM chapters c WHERE c.project_id = p.id) chapter_count,
    (SELECT COALESCE(SUM(LENGTH(c.content)), 0) FROM chapters c WHERE c.project_id = p.id) character_count,
    (SELECT COUNT(*) FROM entities e WHERE e.project_id = p.id) entity_count,
    (SELECT COUNT(*) FROM reviews r WHERE r.project_id = p.id AND r.status = 'open') open_review_count
    FROM projects p ORDER BY p.updated_at DESC`)
  res.json(projects)
})

app.post('/api/projects', (req, res) => {
  const body = z.object({ name: z.string().min(1), genre: z.string().default(''), premise: z.string().default(''), wordGoal: z.number().int().positive().default(100000) }).parse(req.body)
  const projectId = sql.id(); const stamp = sql.now()
  sql.run('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', projectId, body.name, body.genre, body.premise, 'active', body.wordGoal, 0, stamp, stamp)
  ensureDefaultVolume(projectId)
  res.status(201).json(requireProject(projectId))
})

app.get('/api/projects/:projectId', (req, res) => {
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

app.patch('/api/projects/:projectId', (req, res) => {
  requireProject(req.params.projectId)
  const body = z.object({ name: z.string().min(1).optional(), genre: z.string().optional(), premise: z.string().optional(), status: z.enum(['active', 'completed']).optional(), wordGoal: z.number().int().positive().optional() }).parse(req.body)
  const current = requireProject(req.params.projectId)
  sql.run(`UPDATE projects SET name=?, genre=?, premise=?, status=?, word_goal=?, updated_at=? WHERE id=?`,
    body.name ?? current.name, body.genre ?? current.genre, body.premise ?? current.premise,
    body.status ?? current.status, body.wordGoal ?? current.word_goal, sql.now(), req.params.projectId)
  res.json(requireProject(req.params.projectId))
})

app.delete('/api/projects/:projectId', (req, res) => {
  requireProject(req.params.projectId)
  const memoryIds = sql.all<{ id: string }>('SELECT id FROM memory_chunks WHERE project_id = ?', req.params.projectId)
  const transaction = db.transaction(() => {
    memoryIds.forEach(({ id }) => sql.run('DELETE FROM memory_fts WHERE id = ?', id))
    sql.run('DELETE FROM projects WHERE id = ?', req.params.projectId)
  })
  transaction()
  res.status(204).end()
})

app.post('/api/projects/:projectId/import/preview', upload.single('file'), (req, res) => {
  const projectId = String(req.params.projectId)
  requireProject(projectId)
  if (!req.file) return res.status(400).json({ error: '请选择要导入的文稿。' })
  const text = extractText(req.file)
  Promise.resolve(text).then((rawText) => {
    if (!rawText.trim()) return res.status(400).json({ error: '没有从文件中读取到正文。' })
    const split = splitChaptersDetailed(rawText)
    const fileHash = crypto.createHash('sha256').update(req.file!.buffer).digest('hex')
    const previewId = sql.id(); const stamp = sql.now()
    sql.run('INSERT INTO import_previews VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', previewId, projectId, req.file!.originalname, fileHash, rawText,
      JSON.stringify(split.chapters), JSON.stringify(split.diagnostics), 'pending', stamp, stamp)
    res.status(201).json({ id: previewId, filename: req.file!.originalname, chapters: split.chapters, diagnostics: split.diagnostics })
  }).catch((error) => res.status(400).json({ error: (error as Error).message }))
})

app.get('/api/projects/:projectId/import/previews/:previewId', (req, res) => {
  requireProject(req.params.projectId)
  const row = sql.get<Record<string, unknown>>('SELECT * FROM import_previews WHERE id = ? AND project_id = ?', req.params.previewId, req.params.projectId)
  if (!row) return res.status(404).json({ error: '导入预览不存在。' })
  res.json(decodeRow(row))
})

app.patch('/api/projects/:projectId/import/previews/:previewId', (req, res) => {
  requireProject(req.params.projectId)
  const current = sql.get<Record<string, unknown>>('SELECT * FROM import_previews WHERE id = ? AND project_id = ?', req.params.previewId, req.params.projectId)
  if (!current) return res.status(404).json({ error: '导入预览不存在。' })
  const body = z.object({ chapters: z.array(z.object({ title: z.string().min(1), content: z.string(), summary: z.string().default(''), position: z.number().int().nonnegative().optional() })) }).parse(req.body)
  const chapters = body.chapters.map((chapter, position) => ({ ...chapter, position }))
  sql.run('UPDATE import_previews SET chapters=?, updated_at=? WHERE id=?', JSON.stringify(chapters), sql.now(), req.params.previewId)
  res.json({ ...decodeRow(current), chapters })
})

app.post('/api/projects/:projectId/import/previews/:previewId/commit', asyncRoute(async (req, res) => {
  const projectId = String(req.params.projectId); const project = requireProject(projectId)
  const preview = sql.get<Record<string, unknown>>('SELECT * FROM import_previews WHERE id = ? AND project_id = ?', req.params.previewId, projectId)
  if (!preview) return res.status(404).json({ error: '导入预览不存在。' })
  if (preview.status !== 'pending') return res.status(409).json({ error: '这个导入预览已经处理过。' })
  const replaceImported = Boolean(req.body?.replace)
  const rawText = String(preview.raw_text); const fileHash = String(preview.file_hash)
  const duplicate = sql.get('SELECT id FROM imports WHERE project_id = ? AND file_hash = ?', projectId, fileHash)
  if (duplicate && !replaceImported) return res.status(409).json({ error: '这份文稿已经导入过；如需替换旧文稿，请选择替换导入。' })
  const chapters = JSON.parse(String(preview.chapters)) as Array<{ title: string; content: string; summary?: string; position?: number }>
  const existingFingerprints = new Set(sql.all<{ content: string }>('SELECT content FROM chapters WHERE project_id = ? AND LENGTH(TRIM(content)) > 0', projectId).map((row) => chapterContentFingerprint(row.content)))
  const filtered = chapters.filter((chapter) => !isEffectivelyEmptyChapter(chapter.title, chapter.content) && !existingFingerprints.has(chapterContentFingerprint(chapter.content)))
  if (!filtered.length) return res.status(409).json({ error: '没有可新增的有效章节：请在预览中调整章节边界或选择替换导入。' })
  if (replaceImported) {
    const importedIds = sql.all<{ id: string }>("SELECT id FROM chapters WHERE project_id = ? AND status = 'imported'", projectId)
    const candidateIds = sql.all<{ id: string }>(`SELECT id FROM entities WHERE project_id = ? AND canon_status = 'candidate' AND json_extract(data, '$.source') = 'model-analysis'`, projectId)
    db.transaction(() => { importedIds.forEach(({ id }) => removeChapterWithMemory(id)); candidateIds.forEach(({ id }) => { sql.run('DELETE FROM relations WHERE from_entity_id=? OR to_entity_id=?', id, id); sql.run('DELETE FROM entities WHERE id=?', id) }); sql.run("DELETE FROM events WHERE project_id=? AND status='candidate'", projectId); sql.run("DELETE FROM plotlines WHERE project_id=? AND status='candidate'", projectId); sql.run('DELETE FROM imports WHERE project_id=?', projectId) })()
  }
  const basePosition = (sql.get<{ max: number }>('SELECT COALESCE(MAX(position), -1) max FROM chapters WHERE project_id = ?', projectId)?.max ?? -1) + 1
  const diagnostics = decodeRow(preview).diagnostics
  db.transaction(() => {
    filtered.forEach((chapter, index) => { const chapterId = sql.id(); const stamp = sql.now(); sql.run(`INSERT INTO chapters VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, chapterId, projectId, chapter.title, chapter.content, basePosition + index, 'imported', chapter.summary || summarize(chapter.content), '', 3000, stamp, stamp); bindChapterToVolume(projectId, chapterId); chunkText(chapter.content).forEach((chunk, chunkIndex) => sql.addMemory(projectId, 'chapter', chapterId, chunk, chunkIndex === 0 ? (chapter.summary || summarize(chunk)) : summarize(chunk), `${chapter.title} 导入片段`, chapterId)) })
    sql.run('INSERT INTO imports VALUES (?, ?, ?, ?, ?, ?, ?)', sql.id(), projectId, preview.filename, fileHash, rawText, JSON.stringify(diagnostics), sql.now()); sql.run('UPDATE projects SET imported=1, updated_at=? WHERE id=?', sql.now(), projectId); sql.run('UPDATE import_previews SET status=?, updated_at=? WHERE id=?', 'committed', sql.now(), req.params.previewId)
  })()
  const configured = getModelStatus().configured
  const job = sql.id(); const stamp = sql.now(); sql.run('INSERT INTO analysis_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', job, projectId, configured ? 'queued' : 'failed', configured ? 'queued' : 'waiting-model', configured ? 0 : 100, configured ? '等待模型分析' : '文稿已导入，配置模型后可重试分析', configured ? '' : '当前未配置模型 API。', replaceImported ? 1 : 0, '{}', stamp, stamp)
  if (configured) startAnalysisJob(job)
  res.status(201).json({ project, previewId: req.params.previewId, chapters: filtered.length, analysisJobId: job, diagnostics, replaced: replaceImported })
}))

app.post('/api/projects/:projectId/import', upload.single('file'), asyncRoute(async (req, res) => {
  const projectId = String(req.params.projectId)
  const project = requireProject(projectId)
  if (!req.file) return res.status(400).json({ error: '请选择要导入的文稿。' })
  const text = await extractText(req.file)
  if (!text.trim()) return res.status(400).json({ error: '没有从文件中读取到正文。' })
  const split = splitChaptersDetailed(text)
  let chapters = split.chapters
  const fileHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex')
  const replaceImported = String(req.query.replace || '') === 'true'
  const duplicate = sql.get('SELECT id FROM imports WHERE project_id = ? AND file_hash = ?', projectId, fileHash)
  if (duplicate && !replaceImported) return res.status(409).json({ error: '这份文稿已经导入过；如需替换旧文稿，请使用“替换导入”。' })
  if (replaceImported) {
    const importedChapterIds = sql.all<{ id: string }>("SELECT id FROM chapters WHERE project_id = ? AND status = 'imported'", projectId)
    const generatedCandidateIds = sql.all<{ id: string }>(`SELECT id FROM entities WHERE project_id = ? AND canon_status = 'candidate'
      AND (json_extract(data, '$.source') = 'model-analysis' OR summary LIKE '从导入文稿中出现%')`, projectId)
    db.transaction(() => {
      importedChapterIds.forEach(({ id }) => removeChapterWithMemory(id))
      generatedCandidateIds.forEach(({ id }) => { sql.run('DELETE FROM relations WHERE from_entity_id=? OR to_entity_id=?', id, id); sql.run('DELETE FROM entities WHERE id=?', id) })
      sql.run("DELETE FROM events WHERE project_id=? AND status='candidate'", projectId)
      sql.run("DELETE FROM plotlines WHERE project_id=? AND status='candidate'", projectId)
      sql.run('DELETE FROM imports WHERE project_id=?', projectId)
    })()
  }
  const existingFingerprints = new Set(sql.all<{ content: string }>('SELECT content FROM chapters WHERE project_id = ? AND LENGTH(TRIM(content)) > 0', projectId).map((row) => chapterContentFingerprint(row.content)))
  const skippedExisting = chapters.filter((chapter) => existingFingerprints.has(chapterContentFingerprint(chapter.content))).length
  chapters = chapters.filter((chapter) => !existingFingerprints.has(chapterContentFingerprint(chapter.content)))
  if (skippedExisting) {
    split.diagnostics.duplicateContents += skippedExisting
    split.diagnostics.warnings.push(`已跳过 ${skippedExisting} 个与项目现有正文重复的章节。`)
  }
  split.diagnostics.chapters = chapters.length
  if (!chapters.length) return res.status(409).json({ error: '没有可新增的有效章节：文稿内容为空或已存在于当前项目。' })
  const basePosition = (sql.get<{ max: number }>('SELECT COALESCE(MAX(position), -1) max FROM chapters WHERE project_id = ?', projectId)?.max ?? -1) + 1
  const transaction = db.transaction(() => {
    chapters.forEach((chapter, index) => {
      const chapterId = sql.id(); const stamp = sql.now()
      sql.run(`INSERT INTO chapters VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, chapterId, projectId,
        chapter.title, chapter.content, basePosition + index, 'imported', chapter.summary, '', 3000, stamp, stamp)
      bindChapterToVolume(projectId, chapterId)
      chunkText(chapter.content).forEach((chunk, chunkIndex) => sql.addMemory(projectId, 'chapter', chapterId, chunk,
        chunkIndex === 0 ? chapter.summary : summarize(chunk), `${chapter.title} 导入片段`, chapterId))
    })
    sql.run('INSERT INTO imports VALUES (?, ?, ?, ?, ?, ?, ?)', sql.id(), projectId, req.file!.originalname, fileHash, text, JSON.stringify(split.diagnostics), sql.now())
    sql.run('UPDATE projects SET imported=1, updated_at=? WHERE id=?', sql.now(), projectId)
  })
  transaction()
  let analysis: { status: string; entities?: number; events?: number; plotlines?: number; relations?: number; message?: string } = { status: 'waiting_for_model' }
  if (getModelStatus().configured) {
    try {
      const result = await analyzeProjectData(projectId, true)
      analysis = { status: 'completed', entities: result.entities.length, events: result.events.length, plotlines: result.plotlines.length, relations: result.relations.length }
    } catch (error) { analysis = { status: 'failed', message: (error as Error).message } }
  }
  res.status(201).json({ project, filename: req.file.originalname, chapters: chapters.length, characters: text.length, candidates: [], diagnostics: split.diagnostics, analysis, replaced: replaceImported })
}))

app.post('/api/projects/:projectId/analyze', asyncRoute(async (req, res) => {
  const projectId = String(req.params.projectId)
  requireProject(projectId)
  const result = await analyzeProjectData(projectId, Boolean(req.body?.replaceCandidates))
  res.json({ status: 'completed', ...result, model: getModelStatus() })
}))

app.post('/api/projects/:projectId/analysis/jobs', (req, res) => {
  const projectId = String(req.params.projectId); requireProject(projectId)
  if (!getModelStatus().configured) throw analysisModelRequired()
  const active = sql.get<Record<string, unknown>>("SELECT * FROM analysis_jobs WHERE project_id = ? AND status IN ('queued','running','paused') ORDER BY created_at DESC LIMIT 1", projectId)
  if (active) return res.status(409).json({ error: '已有分析任务正在进行。', job: decodeRow(active) })
  const replaceCandidates = Boolean(req.body?.replaceCandidates); const jobId = sql.id(); const stamp = sql.now()
  sql.run('INSERT INTO analysis_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', jobId, projectId, 'queued', 'queued', 0, '等待开始', '', replaceCandidates ? 1 : 0, '{}', stamp, stamp)
  startAnalysisJob(jobId)
  res.status(202).json(decodeRow(sql.get<Record<string, unknown>>('SELECT * FROM analysis_jobs WHERE id = ?', jobId)!))
})

app.get('/api/projects/:projectId/analysis/jobs', (req, res) => {
  requireProject(req.params.projectId)
  res.json(sql.all<Record<string, unknown>>('SELECT * FROM analysis_jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 20', req.params.projectId).map(decodeRow))
})

app.get('/api/analysis/jobs/:jobId', (req, res) => {
  const job = sql.get<Record<string, unknown>>('SELECT * FROM analysis_jobs WHERE id = ?', req.params.jobId)
  if (!job) return res.status(404).json({ error: '分析任务不存在。' })
  res.json(decodeRow(job))
})

app.post('/api/analysis/jobs/:jobId/pause', (req, res) => {
  const job = sql.get<Record<string, unknown>>('SELECT * FROM analysis_jobs WHERE id = ?', req.params.jobId)
  if (!job) return res.status(404).json({ error: '分析任务不存在。' })
  if (!['queued', 'running'].includes(String(job.status))) return res.status(409).json({ error: '当前任务状态不能暂停。' })
  updateAnalysisJob(req.params.jobId, { status: 'paused', stage: 'paused', message: '将在当前批次结束后暂停' })
  res.json(decodeRow(sql.get<Record<string, unknown>>('SELECT * FROM analysis_jobs WHERE id = ?', req.params.jobId)!))
})

app.post('/api/analysis/jobs/:jobId/resume', (req, res) => {
  const job = sql.get<Record<string, unknown>>('SELECT * FROM analysis_jobs WHERE id = ?', req.params.jobId)
  if (!job) return res.status(404).json({ error: '分析任务不存在。' })
  if (job.status !== 'paused') return res.status(409).json({ error: '只有暂停中的任务可以继续。' })
  updateAnalysisJob(req.params.jobId, { status: 'running', stage: 'extracting', message: '正在继续分析' })
  if (!activeAnalysisJobs.has(req.params.jobId)) startAnalysisJob(req.params.jobId)
  res.json(decodeRow(sql.get<Record<string, unknown>>('SELECT * FROM analysis_jobs WHERE id = ?', req.params.jobId)!))
})

app.post('/api/analysis/jobs/:jobId/retry', (req, res) => {
  const previous = sql.get<Record<string, unknown>>('SELECT * FROM analysis_jobs WHERE id = ?', req.params.jobId)
  if (!previous) return res.status(404).json({ error: '分析任务不存在。' })
  const decoded = decodeRow(previous); const result = decoded.result as { failures?: Array<{ chapterIds: string[] }> } | undefined
  const failedIds = [...new Set((result?.failures || []).flatMap((failure) => failure.chapterIds))]
  if (!failedIds.length && previous.status !== 'failed') return res.status(409).json({ error: '这个任务没有可重试的失败章节。' })
  const jobId = sql.id(); const stamp = sql.now(); sql.run('INSERT INTO analysis_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', jobId, previous.project_id, 'queued', 'queued', 0, failedIds.length ? `准备重试 ${failedIds.length} 个失败章节` : '准备重试分析', '', 0, '{}', stamp, stamp)
  startAnalysisJob(jobId, failedIds.length ? failedIds : undefined)
  res.status(202).json(decodeRow(sql.get<Record<string, unknown>>('SELECT * FROM analysis_jobs WHERE id = ?', jobId)!))
})

app.get('/api/projects/:projectId/analysis/quality', (req, res) => {
  requireProject(req.params.projectId)
  const audits = sql.all<Record<string, unknown>>('SELECT * FROM analysis_quality WHERE project_id = ? ORDER BY created_at DESC LIMIT 10', req.params.projectId).map(decodeRow)
  res.json({ ...analysisQuality(req.params.projectId), audits })
})

app.post('/api/projects/:projectId/analysis/second-pass', (req, res) => {
  const projectId = String(req.params.projectId); requireProject(projectId)
  if (!getModelStatus().configured) throw analysisModelRequired()
  const jobId = sql.id(); const stamp = sql.now(); sql.run('INSERT INTO analysis_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', jobId, projectId, 'queued', 'second-pass', 0, '等待独立复核', '', -1, '{}', stamp, stamp)
  startAnalysisJob(jobId)
  res.status(202).json(decodeRow(sql.get<Record<string, unknown>>('SELECT * FROM analysis_jobs WHERE id = ?', jobId)!))
})

app.get('/api/projects/:projectId/analysis/latest', (req, res) => {
  requireProject(req.params.projectId)
  const run = sql.get<Record<string, unknown>>('SELECT * FROM analysis_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1', req.params.projectId)
  res.json(run ? decodeRow(run) : null)
})

app.post('/api/projects/:projectId/chapters/deduplicate', (req, res) => {
  requireProject(req.params.projectId)
  res.json(deduplicateImportedChapters(req.params.projectId))
})

app.get('/api/projects/:projectId/imports', (req, res) => {
  requireProject(req.params.projectId)
  res.json(sql.all<Record<string, unknown>>('SELECT id, filename, file_hash, diagnostics, created_at FROM imports WHERE project_id = ? ORDER BY created_at DESC', req.params.projectId).map(decodeRow))
})

app.get('/api/projects/:projectId/chapters', (req, res) => {
  requireProject(req.params.projectId)
  res.json(sql.all(`${chapterSelect('WHERE c.project_id = ?')} ORDER BY c.position`, req.params.projectId))
})

app.get('/api/projects/:projectId/volumes', (req, res) => {
  requireProject(req.params.projectId)
  ensureDefaultVolume(req.params.projectId)
  const volumes = sql.all<Record<string, unknown>>(`SELECT v.*,
    (SELECT COUNT(*) FROM chapter_volume_bindings b WHERE b.volume_id=v.id) chapter_count,
    (SELECT COALESCE(SUM(LENGTH(c.content)), 0) FROM chapter_volume_bindings b JOIN chapters c ON c.id=b.chapter_id WHERE b.volume_id=v.id) character_count
    FROM volumes v WHERE v.project_id=? ORDER BY v.order_index`, req.params.projectId)
  res.json(volumes)
})

app.post('/api/projects/:projectId/volumes', (req, res) => {
  requireProject(req.params.projectId)
  const body = z.object({ title: z.string().min(1), summary: z.string().default('') }).parse(req.body)
  const order = (sql.get<{ max: number }>('SELECT COALESCE(MAX(order_index), -1) max FROM volumes WHERE project_id=?', req.params.projectId)?.max ?? -1) + 1
  const volumeId = sql.id(); const stamp = sql.now()
  sql.run('INSERT INTO volumes VALUES (?, ?, ?, ?, ?, ?, ?)', volumeId, req.params.projectId, body.title, body.summary, order, stamp, stamp)
  res.status(201).json(sql.get('SELECT * FROM volumes WHERE id=?', volumeId))
})

app.patch('/api/volumes/:volumeId', (req, res) => {
  const current = sql.get<Record<string, unknown>>('SELECT * FROM volumes WHERE id=?', req.params.volumeId)
  if (!current) return res.status(404).json({ error: '卷不存在。' })
  const body = z.object({ title: z.string().min(1).optional(), summary: z.string().optional(), orderIndex: z.number().int().nonnegative().optional() }).parse(req.body)
  sql.run('UPDATE volumes SET title=?, summary=?, order_index=?, updated_at=? WHERE id=?', body.title ?? current.title, body.summary ?? current.summary, body.orderIndex ?? current.order_index, sql.now(), req.params.volumeId)
  res.json(sql.get('SELECT * FROM volumes WHERE id=?', req.params.volumeId))
})

app.delete('/api/volumes/:volumeId', (req, res) => {
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

app.post('/api/projects/:projectId/chapters', (req, res) => {
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
  })()
  res.status(201).json(sql.get(chapterSelect('WHERE c.id = ?'), chapterId))
})

app.patch('/api/chapters/:chapterId', (req, res) => {
  const current = sql.get<Record<string, unknown>>('SELECT * FROM chapters WHERE id = ?', req.params.chapterId)
  if (!current) return res.status(404).json({ error: '章节不存在。' })
  const body = z.object({ title: z.string().optional(), content: z.string().optional(), summary: z.string().optional(), pov: z.string().optional(), status: z.string().optional(), targetWords: z.number().int().positive().optional(), position: z.number().int().nonnegative().optional() }).parse(req.body)
  sql.run(`UPDATE chapters SET title=?, content=?, summary=?, pov=?, status=?, target_words=?, position=?, updated_at=? WHERE id=?`,
    body.title ?? current.title, body.content ?? current.content, body.summary ?? current.summary, body.pov ?? current.pov,
    body.status ?? current.status, body.targetWords ?? current.target_words, body.position ?? current.position, sql.now(), req.params.chapterId)
  if (body.content !== undefined) {
    const old = sql.all<{ id: string }>('SELECT id FROM memory_chunks WHERE source_type = ? AND source_id = ?', 'chapter', req.params.chapterId)
    old.forEach(({ id }) => sql.run('DELETE FROM memory_fts WHERE id = ?', id))
    sql.run('DELETE FROM memory_chunks WHERE source_type = ? AND source_id = ?', 'chapter', req.params.chapterId)
    chunkText(body.content).forEach((chunk, index) => sql.addMemory(String(current.project_id), 'chapter', req.params.chapterId, chunk,
      index === 0 ? String(body.summary ?? current.summary ?? summarize(chunk)) : summarize(chunk), `${body.title ?? current.title} 正文`, req.params.chapterId))
  }
  sql.run('UPDATE projects SET updated_at=? WHERE id=?', sql.now(), current.project_id)
  res.json(sql.get(chapterSelect('WHERE c.id = ?'), req.params.chapterId))
})

app.patch('/api/chapters/:chapterId/outline', (req, res) => {
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

app.patch('/api/chapters/:chapterId/mark', (req, res) => {
  const current = sql.get<{ id: string; project_id: string }>('SELECT id, project_id FROM chapters WHERE id = ?', req.params.chapterId)
  if (!current) return res.status(404).json({ error: '章节不存在。' })
  const body = z.object({ bookmarked: z.boolean().optional(), importance: z.enum(['normal', 'important', 'critical']).optional(), note: z.string().max(500).optional() }).parse(req.body)
  const existing = sql.get<{ bookmarked: number; importance: string; note: string }>('SELECT bookmarked, importance, note FROM chapter_marks WHERE chapter_id = ?', current.id)
  sql.run(`INSERT INTO chapter_marks (chapter_id, project_id, bookmarked, importance, note, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(chapter_id) DO UPDATE SET bookmarked=excluded.bookmarked, importance=excluded.importance, note=excluded.note, updated_at=excluded.updated_at`,
  current.id, current.project_id, body.bookmarked === undefined ? existing?.bookmarked ?? 0 : Number(body.bookmarked), body.importance ?? existing?.importance ?? 'normal', body.note ?? existing?.note ?? '', sql.now())
  res.json(sql.get(chapterSelect('WHERE c.id = ?'), current.id))
})

app.patch('/api/chapters/:chapterId/volume', (req, res) => {
  const chapter = sql.get<{ project_id: string }>('SELECT project_id FROM chapters WHERE id=?', req.params.chapterId)
  if (!chapter) return res.status(404).json({ error: '章节不存在。' })
  const body = z.object({ volumeId: z.string(), orderIndex: z.number().int().nonnegative().optional() }).parse(req.body)
  const volume = sql.get<{ project_id: string }>('SELECT project_id FROM volumes WHERE id=?', body.volumeId)
  if (!volume || volume.project_id !== chapter.project_id) return res.status(400).json({ error: '目标卷无效。' })
  bindChapterToVolume(chapter.project_id, req.params.chapterId, body.volumeId)
  if (body.orderIndex !== undefined) sql.run('UPDATE chapter_volume_bindings SET order_index=? WHERE chapter_id=?', body.orderIndex, req.params.chapterId)
  res.json(sql.get(chapterSelect('WHERE c.id=?'), req.params.chapterId))
})

app.delete('/api/chapters/:chapterId', (req, res) => {
  const current = sql.get<{ project_id: string }>('SELECT project_id FROM chapters WHERE id = ?', req.params.chapterId)
  if (!current) return res.status(404).json({ error: '章节不存在。' })
  db.transaction(() => { removeChapterWithMemory(req.params.chapterId); normalizeChapterPositions(current.project_id); sql.run('UPDATE projects SET updated_at=? WHERE id=?', sql.now(), current.project_id) })()
  res.status(204).end()
})

app.get('/api/projects/:projectId/entities', (req, res) => {
  requireProject(req.params.projectId)
  const type = typeof req.query.type === 'string' ? req.query.type : ''
  const rows = type ? sql.all<Record<string, unknown>>('SELECT * FROM entities WHERE project_id = ? AND type = ? ORDER BY name', req.params.projectId, type)
    : sql.all<Record<string, unknown>>('SELECT * FROM entities WHERE project_id = ? ORDER BY type, name', req.params.projectId)
  res.json(rows.map(decodeRow))
})

app.get('/api/projects/:projectId/entities/duplicate-suggestions', (req, res) => {
  requireProject(req.params.projectId)
  const characters = sql.all<{ id: string; name: string; data: string }>("SELECT id, name, data FROM entities WHERE project_id=? AND type='character' ORDER BY name", req.params.projectId)
  const suggestions: Array<{ leftId: string; leftName: string; rightId: string; rightName: string; reason: string }> = []
  for (let leftIndex = 0; leftIndex < characters.length; leftIndex += 1) {
    const left = characters[leftIndex]
    const leftData = (() => { try { return JSON.parse(left.data) as Record<string, unknown> } catch { return {} } })()
    const leftNames = [left.name, ...(Array.isArray(leftData.aliases) ? leftData.aliases.map(String) : [])]
    const leftVariants = new Set(leftNames.flatMap((name) => [...characterNameVariants(name)]))
    for (let rightIndex = leftIndex + 1; rightIndex < characters.length; rightIndex += 1) {
      const right = characters[rightIndex]
      const rightData = (() => { try { return JSON.parse(right.data) as Record<string, unknown> } catch { return {} } })()
      const rightNames = [right.name, ...(Array.isArray(rightData.aliases) ? rightData.aliases.map(String) : [])]
      if (rightNames.flatMap((name) => [...characterNameVariants(name)]).some((name) => leftVariants.has(name))) {
        suggestions.push({ leftId: left.id, leftName: left.name, rightId: right.id, rightName: right.name, reason: '名称仅有职业/称谓差异，或别称发生重合' })
      }
    }
  }
  res.json(suggestions)
})

app.post('/api/projects/:projectId/entities', (req, res) => {
  requireProject(req.params.projectId)
  const body = z.object({ type: z.string().min(1), name: z.string().min(1), summary: z.string().default(''), data: z.record(z.string(), z.unknown()).default({}), canonStatus: z.string().default('canon') }).parse(req.body)
  const entityId = sql.id(); const stamp = sql.now()
  sql.run(`INSERT INTO entities VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, entityId, req.params.projectId, body.type,
    body.name, body.summary, JSON.stringify(body.data), body.canonStatus, 1, null, stamp, stamp)
  sql.addMemory(req.params.projectId, 'entity', entityId, `${body.name}：${body.summary}\n${JSON.stringify(body.data)}`, body.summary, `${body.name} ${body.type}`)
  res.status(201).json(decodeRow(sql.get<Record<string, unknown>>('SELECT * FROM entities WHERE id = ?', entityId)!))
})

app.patch('/api/entities/:entityId', (req, res) => {
  const current = sql.get<Record<string, unknown>>('SELECT * FROM entities WHERE id = ?', req.params.entityId)
  if (!current) return res.status(404).json({ error: '设定不存在。' })
  const body = z.object({ type: z.string().optional(), name: z.string().optional(), summary: z.string().optional(), data: z.record(z.string(), z.unknown()).optional(), canonStatus: z.string().optional(), confidence: z.number().min(0).max(1).optional() }).parse(req.body)
  sql.run(`UPDATE entities SET type=?, name=?, summary=?, data=?, canon_status=?, confidence=?, updated_at=? WHERE id=?`,
    body.type ?? current.type, body.name ?? current.name, body.summary ?? current.summary,
    body.data ? JSON.stringify(body.data) : current.data, body.canonStatus ?? current.canon_status,
    body.confidence ?? current.confidence, sql.now(), req.params.entityId)
  res.json(decodeRow(sql.get<Record<string, unknown>>('SELECT * FROM entities WHERE id = ?', req.params.entityId)!))
})

app.delete('/api/entities/:entityId', (req, res) => {
  sql.run('DELETE FROM relations WHERE from_entity_id = ? OR to_entity_id = ?', req.params.entityId, req.params.entityId)
  sql.run('DELETE FROM entities WHERE id = ?', req.params.entityId)
  res.status(204).end()
})

app.get('/api/projects/:projectId/entity-edits', (req, res) => {
  requireProject(req.params.projectId)
  res.json(sql.all<Record<string, unknown>>('SELECT * FROM entity_edits WHERE project_id = ? ORDER BY created_at DESC LIMIT 30', req.params.projectId).map(decodeRow))
})

app.post('/api/entities/:entityId/rename', (req, res) => {
  const current = snapshotEntity(req.params.entityId)
  if (!current) return res.status(404).json({ error: '设定不存在。' })
  const body = z.object({ name: z.string().min(1), aliases: z.array(z.string()).default([]) }).parse(req.body)
  const data = JSON.parse(String(current.data || '{}')) as Record<string, unknown>; const oldName = String(current.name)
  data.aliases = [...new Set([...(Array.isArray(data.aliases) ? data.aliases.map(String) : []), oldName, ...body.aliases])].filter((name) => name && name !== body.name)
  const editId = recordEntityEdit(String(current.project_id), 'rename', req.params.entityId, { entity: current }, { oldName, newName: body.name })
  sql.run('UPDATE entities SET name=?, data=?, updated_at=? WHERE id=?', body.name, JSON.stringify(data), sql.now(), req.params.entityId); refreshEntityMemory(req.params.entityId)
  res.json({ entity: decodeRow(snapshotEntity(req.params.entityId)!), editId })
})

app.post('/api/projects/:projectId/entities/merge', (req, res) => {
  const projectId = String(req.params.projectId); requireProject(projectId)
  const body = z.object({ targetId: z.string(), sourceIds: z.array(z.string()).min(1) }).parse(req.body)
  const ids = [...new Set([body.targetId, ...body.sourceIds])]
  const entities = ids.map(snapshotEntity).filter(Boolean) as Record<string, unknown>[]
  if (entities.length !== ids.length || entities.some((entity) => entity.project_id !== projectId)) return res.status(400).json({ error: '合并对象无效或不属于当前项目。' })
  const target = entities.find((entity) => entity.id === body.targetId)!; const sources = entities.filter((entity) => entity.id !== body.targetId)
  const relations = sql.all<Record<string, unknown>>(`SELECT * FROM relations WHERE project_id = ? AND (from_entity_id IN (${ids.map(() => '?').join(',')}) OR to_entity_id IN (${ids.map(() => '?').join(',')}))`, projectId, ...ids, ...ids)
  const targetData = JSON.parse(String(target.data || '{}')) as Record<string, unknown>; const aliases = new Set<string>(Array.isArray(targetData.aliases) ? targetData.aliases.map(String) : [])
  sources.forEach((source) => { aliases.add(String(source.name)); try { const data = JSON.parse(String(source.data || '{}')); if (Array.isArray(data.aliases)) data.aliases.forEach((alias: unknown) => aliases.add(String(alias))) } catch { /* ignore invalid legacy data */ } })
  targetData.aliases = [...aliases].filter((alias) => alias !== target.name)
  const editId = recordEntityEdit(projectId, 'merge', body.targetId, { entities, relations }, { targetId: body.targetId, sourceIds: sources.map((source) => source.id) })
  db.transaction(() => {
    sql.run('UPDATE entities SET data=?, updated_at=? WHERE id=?', JSON.stringify(targetData), sql.now(), body.targetId)
    sources.forEach((source) => {
      sql.run('UPDATE relations SET from_entity_id=? WHERE from_entity_id=?', body.targetId, source.id); sql.run('UPDATE relations SET to_entity_id=? WHERE to_entity_id=?', body.targetId, source.id)
      sql.run('DELETE FROM relations WHERE project_id=? AND from_entity_id=to_entity_id', projectId)
      const memoryIds = sql.all<{ id: string }>('SELECT id FROM memory_chunks WHERE source_type=? AND source_id=?', 'entity', source.id); memoryIds.forEach(({ id }) => sql.run('DELETE FROM memory_fts WHERE id=?', id)); sql.run('DELETE FROM memory_chunks WHERE source_type=? AND source_id=?', 'entity', source.id); sql.run('DELETE FROM entities WHERE id=?', source.id)
    })
    const duplicates = sql.all<{ id: string }>(`SELECT r1.id FROM relations r1 JOIN relations r2 ON r1.project_id=r2.project_id AND r1.from_entity_id=r2.from_entity_id AND r1.to_entity_id=r2.to_entity_id AND r1.type=r2.type AND r1.id>r2.id WHERE r1.project_id=?`, projectId)
    duplicates.forEach(({ id }) => sql.run('DELETE FROM relations WHERE id=?', id)); refreshEntityMemory(body.targetId)
  })()
  res.json({ entity: decodeRow(snapshotEntity(body.targetId)!), editId })
})

app.post('/api/entities/:entityId/split', (req, res) => {
  const current = snapshotEntity(req.params.entityId)
  if (!current) return res.status(404).json({ error: '设定不存在。' })
  const body = z.object({ name: z.string().min(1), type: z.string().optional(), summary: z.string().default(''), aliases: z.array(z.string()).default([]), linkAsIdentity: z.boolean().default(false) }).parse(req.body)
  const newId = sql.id(); const stamp = sql.now(); const data = JSON.parse(String(current.data || '{}')) as Record<string, unknown>
  const existingAliases = Array.isArray(data.aliases) ? data.aliases.map(String) : []; data.aliases = existingAliases.filter((alias) => alias !== body.name && !body.aliases.includes(alias))
  const editId = recordEntityEdit(String(current.project_id), 'split', req.params.entityId, { entity: current }, { createdIds: [newId] })
  db.transaction(() => {
    sql.run('UPDATE entities SET data=?, updated_at=? WHERE id=?', JSON.stringify(data), stamp, req.params.entityId)
    sql.run('INSERT INTO entities VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', newId, current.project_id, body.type || current.type, body.name, body.summary, JSON.stringify({ aliases: body.aliases, source: 'user-correction' }), 'canon', 1, current.source_chapter_id || null, stamp, stamp)
    if (body.linkAsIdentity) sql.run('INSERT INTO relations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', sql.id(), current.project_id, req.params.entityId, newId, 'same_person', '同一人的不同身份', 'neutral', 100, '', '', stamp)
    refreshEntityMemory(req.params.entityId); refreshEntityMemory(newId)
  })()
  res.status(201).json({ entity: decodeRow(snapshotEntity(newId)!), editId })
})

app.post('/api/entity-edits/:editId/undo', (req, res) => {
  const edit = sql.get<Record<string, unknown>>('SELECT * FROM entity_edits WHERE id = ?', req.params.editId)
  if (!edit) return res.status(404).json({ error: '修订记录不存在。' })
  if (edit.undone) return res.status(409).json({ error: '这次修订已经撤销。' })
  const decoded = decodeRow(edit); const snapshot = decoded.snapshot as { entity?: Record<string, unknown>; entities?: Record<string, unknown>[]; relations?: Record<string, unknown>[] }; const payload = decoded.payload as { createdIds?: string[] }
  db.transaction(() => {
    if (edit.action === 'merge' && snapshot.entities) {
      const ids = snapshot.entities.map((entity) => String(entity.id)); ids.forEach((id) => { sql.run('DELETE FROM relations WHERE from_entity_id=? OR to_entity_id=?', id, id); sql.run('DELETE FROM entities WHERE id=?', id) })
      snapshot.entities.forEach((entity) => sql.run('INSERT INTO entities VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', entity.id, entity.project_id, entity.type, entity.name, entity.summary, entity.data, entity.canon_status, entity.confidence, entity.source_chapter_id, entity.created_at, entity.updated_at))
      snapshot.relations?.forEach((relation) => sql.run('INSERT INTO relations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', relation.id, relation.project_id, relation.from_entity_id, relation.to_entity_id, relation.type, relation.label, relation.sentiment, relation.strength, relation.valid_from, relation.valid_to, relation.created_at))
      ids.forEach(refreshEntityMemory)
    } else if (edit.action === 'split' && snapshot.entity) {
      payload.createdIds?.forEach((id) => { sql.run('DELETE FROM relations WHERE from_entity_id=? OR to_entity_id=?', id, id); sql.run('DELETE FROM entities WHERE id=?', id) }); const entity = snapshot.entity
      sql.run('UPDATE entities SET type=?, name=?, summary=?, data=?, canon_status=?, confidence=?, source_chapter_id=?, updated_at=? WHERE id=?', entity.type, entity.name, entity.summary, entity.data, entity.canon_status, entity.confidence, entity.source_chapter_id, entity.updated_at, entity.id); refreshEntityMemory(String(entity.id))
    } else if (snapshot.entity) {
      const entity = snapshot.entity; sql.run('UPDATE entities SET type=?, name=?, summary=?, data=?, canon_status=?, confidence=?, source_chapter_id=?, updated_at=? WHERE id=?', entity.type, entity.name, entity.summary, entity.data, entity.canon_status, entity.confidence, entity.source_chapter_id, entity.updated_at, entity.id); refreshEntityMemory(String(entity.id))
    }
    sql.run('UPDATE entity_edits SET undone=1 WHERE id=?', req.params.editId)
  })()
  res.json({ ok: true })
})

app.get('/api/projects/:projectId/plot', (req, res) => {
  requireProject(req.params.projectId)
  res.json({
    plotlines: sql.all('SELECT * FROM plotlines WHERE project_id = ? ORDER BY created_at', req.params.projectId),
    events: sql.all<Record<string, unknown>>('SELECT * FROM events WHERE project_id = ? ORDER BY narrative_order', req.params.projectId).map(decodeRow),
    foreshadowing: sql.all('SELECT * FROM foreshadowing WHERE project_id = ? ORDER BY created_at', req.params.projectId),
  })
})

app.get('/api/projects/:projectId/outlines', (req, res) => {
  requireProject(req.params.projectId)
  res.json(sql.all('SELECT * FROM story_outlines WHERE project_id=? ORDER BY version DESC, created_at DESC', req.params.projectId))
})

app.post('/api/projects/:projectId/outlines', (req, res) => {
  requireProject(req.params.projectId)
  const body = z.object({
    title: z.string().min(1).default('全书大纲'), content: z.string().min(1),
    parentId: z.string().nullable().optional(), sourcePrompt: z.string().default(''),
    status: z.enum(['candidate', 'current', 'archived']).default('candidate'),
  }).parse(req.body)
  const version = (sql.get<{ max: number }>('SELECT COALESCE(MAX(version), 0) max FROM story_outlines WHERE project_id=?', req.params.projectId)?.max ?? 0) + 1
  const outlineId = sql.id(); const stamp = sql.now()
  db.transaction(() => {
    if (body.status === 'current') sql.run("UPDATE story_outlines SET status='archived', updated_at=? WHERE project_id=? AND status='current'", stamp, req.params.projectId)
    sql.run('INSERT INTO story_outlines VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', outlineId, req.params.projectId, body.title, body.content, version, body.parentId ?? null, body.status, body.sourcePrompt, stamp, stamp)
  })()
  res.status(201).json(sql.get('SELECT * FROM story_outlines WHERE id=?', outlineId))
})

app.patch('/api/outlines/:outlineId', (req, res) => {
  const current = sql.get<Record<string, unknown>>('SELECT * FROM story_outlines WHERE id=?', req.params.outlineId)
  if (!current) return res.status(404).json({ error: '大纲版本不存在。' })
  const body = z.object({ title: z.string().min(1).optional(), content: z.string().min(1).optional(), status: z.enum(['candidate', 'current', 'archived']).optional() }).parse(req.body)
  const stamp = sql.now()
  db.transaction(() => {
    if (body.status === 'current') sql.run("UPDATE story_outlines SET status='archived', updated_at=? WHERE project_id=? AND status='current' AND id!=?", stamp, current.project_id, req.params.outlineId)
    sql.run('UPDATE story_outlines SET title=?, content=?, status=?, updated_at=? WHERE id=?', body.title ?? current.title, body.content ?? current.content, body.status ?? current.status, stamp, req.params.outlineId)
  })()
  res.json(sql.get('SELECT * FROM story_outlines WHERE id=?', req.params.outlineId))
})

app.post('/api/outlines/:outlineId/decompose', asyncRoute(async (req, res) => {
  const outline = sql.get<{ id: string; project_id: string; title: string; content: string }>('SELECT id, project_id, title, content FROM story_outlines WHERE id=?', req.params.outlineId)
  if (!outline) return res.status(404).json({ error: '大纲版本不存在。' })
  if (!getModelStatus().configured) throw Object.assign(new Error('需要先配置可用的模型 API，才能把大纲可靠地拆分为剧情线和章节细纲。'), { status: 409, code: 'MODEL_REQUIRED' })
  const project = requireProject(outline.project_id)
  const started = Date.now()
  const plan = await decomposeOutline({ projectName: String(project.name), premise: String(project.premise), outline: outline.content })
  res.json({ plan, elapsedMs: Date.now() - started, sourceOutline: { id: outline.id, title: outline.title } })
}))

app.post('/api/outlines/:outlineId/apply-decomposition', (req, res) => {
  const outline = sql.get<{ id: string; project_id: string }>('SELECT id, project_id FROM story_outlines WHERE id=?', req.params.outlineId)
  if (!outline) return res.status(404).json({ error: '大纲版本不存在。' })
  const plan = outlineDecompositionSchema.parse(req.body.plan)
  const stamp = sql.now(); const colors = ['#13766f', '#aa5a35', '#496982', '#8a6b38', '#665f91', '#47725a']
  const result = { plotlines: 0, events: 0, volumes: 0, chapters: 0, skippedChapters: 0 }
  db.transaction(() => {
    const plotlineIds = new Map<string, string>()
    plan.plotlines.forEach((plotline, index) => {
      const existing = sql.get<{ id: string }>('SELECT id FROM plotlines WHERE project_id=? AND name=?', outline.project_id, plotline.name)
      const plotlineId = existing?.id || sql.id()
      if (!existing) {
        sql.run('INSERT INTO plotlines VALUES (?, ?, ?, ?, ?, ?, ?, ?)', plotlineId, outline.project_id, plotline.name, plotline.type, plotline.summary, plotline.color || colors[index % colors.length], 'active', stamp)
        result.plotlines += 1
      }
      plotlineIds.set(plotline.name, plotlineId)
      plotline.events.forEach((event) => {
        const duplicate = sql.get('SELECT id FROM events WHERE project_id=? AND title=? AND summary=?', outline.project_id, event.title, event.summary)
        if (duplicate) return
        const order = (sql.get<{ max: number }>('SELECT COALESCE(MAX(narrative_order), 0) max FROM events WHERE project_id=?', outline.project_id)?.max ?? 0) + 1
        sql.run('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', sql.id(), outline.project_id, event.title, event.summary, event.phase, order, 'planned', plotlineId, null, JSON.stringify(event.participants), event.location, event.cause, event.consequence, '{}', stamp, stamp)
        result.events += 1
      })
    })

    let position = (sql.get<{ max: number }>('SELECT COALESCE(MAX(position), -1) max FROM chapters WHERE project_id=?', outline.project_id)?.max ?? -1) + 1
    const emptyDefault = sql.get<{ id: string }>(`SELECT v.id FROM volumes v WHERE v.project_id=? AND v.title='第一卷'
      AND NOT EXISTS (SELECT 1 FROM chapter_volume_bindings b WHERE b.volume_id=v.id) ORDER BY v.order_index LIMIT 1`, outline.project_id)
    plan.volumes.forEach((volume, volumeIndex) => {
      let volumeRow = sql.get<{ id: string }>('SELECT id FROM volumes WHERE project_id=? AND title=?', outline.project_id, volume.title)
      if (!volumeRow && volumeIndex === 0 && emptyDefault) {
        volumeRow = emptyDefault
        sql.run('UPDATE volumes SET title=?, summary=?, updated_at=? WHERE id=?', volume.title, volume.summary, stamp, volumeRow.id)
      } else if (!volumeRow) {
        volumeRow = { id: sql.id() }
        const order = (sql.get<{ max: number }>('SELECT COALESCE(MAX(order_index), -1) max FROM volumes WHERE project_id=?', outline.project_id)?.max ?? -1) + 1
        sql.run('INSERT INTO volumes VALUES (?, ?, ?, ?, ?, ?, ?)', volumeRow.id, outline.project_id, volume.title, volume.summary, order, stamp, stamp)
      }
      result.volumes += 1
      let volumeOrder = (sql.get<{ max: number }>('SELECT COALESCE(MAX(order_index), -1) max FROM chapter_volume_bindings WHERE volume_id=?', volumeRow.id)?.max ?? -1) + 1
      volume.chapters.forEach((chapter) => {
        if (sql.get('SELECT id FROM chapters WHERE project_id=? AND title=?', outline.project_id, chapter.title)) { result.skippedChapters += 1; return }
        const chapterId = sql.id()
        sql.run('INSERT INTO chapters VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', chapterId, outline.project_id, chapter.title, '', position++, 'planned', chapter.summary, chapter.pov, chapter.targetWords, stamp, stamp)
        sql.run('INSERT INTO chapter_marks VALUES (?, ?, ?, ?, ?, ?)', chapterId, outline.project_id, 0, 'normal', '', stamp)
        sql.run('INSERT INTO chapter_volume_bindings VALUES (?, ?, ?)', chapterId, volumeRow!.id, volumeOrder++)
        sql.run('INSERT INTO chapter_outlines VALUES (?, ?, ?, ?, ?, ?, ?)', chapterId, outline.project_id, outline.id, chapterOutlineMarkdown(chapter), 'active', stamp, stamp)
        result.chapters += 1
      })
    })
    sql.run('UPDATE projects SET updated_at=? WHERE id=?', stamp, outline.project_id)
  })()
  res.status(201).json(result)
})

app.post('/api/projects/:projectId/plotlines', (req, res) => {
  requireProject(req.params.projectId)
  const body = z.object({ name: z.string().min(1), type: z.string().default('main'), summary: z.string().default(''), color: z.string().default('#13766f') }).parse(req.body)
  const itemId = sql.id()
  sql.run('INSERT INTO plotlines VALUES (?, ?, ?, ?, ?, ?, ?, ?)', itemId, req.params.projectId, body.name, body.type, body.summary, body.color, 'active', sql.now())
  res.status(201).json(sql.get('SELECT * FROM plotlines WHERE id = ?', itemId))
})

app.post('/api/projects/:projectId/events', (req, res) => {
  requireProject(req.params.projectId)
  const body = z.object({ title: z.string().min(1), summary: z.string().default(''), storyTime: z.string().default(''), status: z.string().default('planned'), plotlineId: z.string().nullable().optional(), chapterId: z.string().nullable().optional(), participants: z.array(z.string()).default([]), location: z.string().default(''), cause: z.string().default(''), consequence: z.string().default('') }).parse(req.body)
  const order = (sql.get<{ max: number }>('SELECT COALESCE(MAX(narrative_order), 0) max FROM events WHERE project_id = ?', req.params.projectId)?.max ?? 0) + 1
  const eventId = sql.id(); const stamp = sql.now()
  sql.run(`INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, eventId, req.params.projectId, body.title,
    body.summary, body.storyTime, order, body.status, body.plotlineId ?? null, body.chapterId ?? null, JSON.stringify(body.participants),
    body.location, body.cause, body.consequence, '{}', stamp, stamp)
  res.status(201).json(decodeRow(sql.get<Record<string, unknown>>('SELECT * FROM events WHERE id = ?', eventId)!))
})

app.patch('/api/events/:eventId', (req, res) => {
  const current = sql.get<Record<string, unknown>>('SELECT * FROM events WHERE id = ?', req.params.eventId)
  if (!current) return res.status(404).json({ error: '事件不存在。' })
  const body = z.object({ title: z.string().optional(), summary: z.string().optional(), storyTime: z.string().optional(), status: z.string().optional(), plotlineId: z.string().nullable().optional(), chapterId: z.string().nullable().optional(), participants: z.array(z.string()).optional(), location: z.string().optional(), cause: z.string().optional(), consequence: z.string().optional(), narrativeOrder: z.number().int().optional() }).parse(req.body)
  sql.run(`UPDATE events SET title=?, summary=?, story_time=?, status=?, plotline_id=?, chapter_id=?, participants=?, location=?, cause=?, consequence=?, narrative_order=?, updated_at=? WHERE id=?`,
    body.title ?? current.title, body.summary ?? current.summary, body.storyTime ?? current.story_time, body.status ?? current.status,
    body.plotlineId === undefined ? current.plotline_id : body.plotlineId, body.chapterId === undefined ? current.chapter_id : body.chapterId,
    body.participants ? JSON.stringify(body.participants) : current.participants, body.location ?? current.location, body.cause ?? current.cause,
    body.consequence ?? current.consequence, body.narrativeOrder ?? current.narrative_order, sql.now(), req.params.eventId)
  res.json(decodeRow(sql.get<Record<string, unknown>>('SELECT * FROM events WHERE id = ?', req.params.eventId)!))
})

app.post('/api/projects/:projectId/foreshadowing', (req, res) => {
  requireProject(req.params.projectId)
  const body = z.object({ title: z.string().min(1), setupChapterId: z.string().nullable().optional(), payoffChapterId: z.string().nullable().optional(), status: z.string().default('open'), notes: z.string().default('') }).parse(req.body)
  const itemId = sql.id()
  sql.run('INSERT INTO foreshadowing VALUES (?, ?, ?, ?, ?, ?, ?, ?)', itemId, req.params.projectId, body.title, body.setupChapterId ?? null, body.payoffChapterId ?? null, body.status, body.notes, sql.now())
  res.status(201).json(sql.get('SELECT * FROM foreshadowing WHERE id = ?', itemId))
})

app.get('/api/projects/:projectId/facts', (req, res) => {
  requireProject(req.params.projectId)
  res.json(sql.all(`SELECT f.*, c.title source_chapter_title FROM story_facts f
    LEFT JOIN chapters c ON c.id=f.source_chapter_id WHERE f.project_id=?
    ORDER BY f.introduced_position, f.importance DESC`, req.params.projectId))
})

app.post('/api/projects/:projectId/facts', (req, res) => {
  requireProject(req.params.projectId)
  const body = z.object({ subject: z.string().min(1), predicate: z.string().min(1), value: z.string().min(1), sourceChapterId: z.string().nullable().optional(), importance: z.number().int().min(0).max(100).default(50), canonStatus: z.enum(['candidate', 'canon', 'deprecated']).default('candidate'), evidence: z.string().default('') }).parse(req.body)
  const position = body.sourceChapterId ? sql.get<{ position: number }>('SELECT position FROM chapters WHERE id=?', body.sourceChapterId)?.position ?? 0 : 0
  const factId = sql.id(); const stamp = sql.now()
  sql.run('INSERT INTO story_facts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', factId, req.params.projectId, body.subject, body.predicate, body.value, body.sourceChapterId ?? null, position, body.importance, body.canonStatus, body.evidence, stamp, stamp)
  res.status(201).json(sql.get('SELECT * FROM story_facts WHERE id=?', factId))
})

app.patch('/api/facts/:factId', (req, res) => {
  const current = sql.get<Record<string, unknown>>('SELECT * FROM story_facts WHERE id=?', req.params.factId)
  if (!current) return res.status(404).json({ error: '事实不存在。' })
  const body = z.object({ subject: z.string().min(1).optional(), predicate: z.string().min(1).optional(), value: z.string().min(1).optional(), importance: z.number().int().min(0).max(100).optional(), canonStatus: z.enum(['candidate', 'canon', 'deprecated']).optional(), evidence: z.string().optional() }).parse(req.body)
  sql.run('UPDATE story_facts SET subject=?, predicate=?, value=?, importance=?, canon_status=?, evidence=?, updated_at=? WHERE id=?', body.subject ?? current.subject, body.predicate ?? current.predicate, body.value ?? current.value, body.importance ?? current.importance, body.canonStatus ?? current.canon_status, body.evidence ?? current.evidence, sql.now(), req.params.factId)
  res.json(sql.get('SELECT * FROM story_facts WHERE id=?', req.params.factId))
})

app.delete('/api/facts/:factId', (req, res) => {
  sql.run('DELETE FROM story_facts WHERE id=?', req.params.factId)
  res.status(204).end()
})

app.get('/api/projects/:projectId/graph', (req, res) => {
  requireProject(req.params.projectId)
  const entities = sql.all<Record<string, unknown>>('SELECT id, project_id, type, name, summary, data, canon_status, confidence, source_chapter_id, updated_at FROM entities WHERE project_id = ? ORDER BY type, name', req.params.projectId).map(decodeRow)
  const relations = sql.all<Record<string, unknown>>('SELECT * FROM relations WHERE project_id = ?', req.params.projectId)
  res.json({ entities, relations })
})

app.post('/api/projects/:projectId/relations', (req, res) => {
  requireProject(req.params.projectId)
  const body = z.object({ fromEntityId: z.string(), toEntityId: z.string(), type: z.string(), label: z.string().default(''), sentiment: z.string().default('neutral'), strength: z.number().int().min(0).max(100).default(50) }).parse(req.body)
  const relationId = sql.id()
  sql.run('INSERT INTO relations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', relationId, req.params.projectId, body.fromEntityId, body.toEntityId,
    body.type, body.label, body.sentiment, body.strength, '', '', sql.now())
  res.status(201).json(sql.get('SELECT * FROM relations WHERE id = ?', relationId))
})

app.get('/api/projects/:projectId/search', (req, res) => {
  requireProject(req.params.projectId)
  const query = String(req.query.q || '')
  const chapterId = typeof req.query.chapterId === 'string' ? req.query.chapterId : undefined
  res.json({ query, results: searchMemory(req.params.projectId, query, Number(req.query.limit || 15), chapterId) })
})

app.post('/api/ai/context', (req, res) => {
  const body = z.object({ projectId: z.string(), prompt: z.string().default(''), chapterId: z.string().optional(), tokenBudget: z.number().int().min(1000).max(50000).default(10000) }).parse(req.body)
  requireProject(body.projectId)
  const assembled = assembleContext(body.projectId, body.prompt, body.chapterId, body.tokenBudget)
  res.json({ report: assembled.report, citations: assembled.hits })
})

app.post('/api/ai/generate', asyncRoute(async (req, res) => {
  const body = z.object({ projectId: z.string(), task: z.enum(['chat', 'outline', 'chapter_outline', 'prose', 'setting', 'plot', 'analysis']), prompt: z.string().default(''), chapterId: z.string().optional() }).parse(req.body)
  requireProject(body.projectId)
  res.json(await generate(body))
}))

app.get('/api/model', (_req, res) => res.json(getModelStatus()))
app.post('/api/model', (req, res) => {
  const body = z.object({ baseUrl: z.string().url().optional(), apiKey: z.string().optional(), model: z.string().min(1).optional(), clearKey: z.boolean().optional() }).parse(req.body)
  const next: { baseUrl?: string; apiKey?: string; model?: string } = {}
  if (body.baseUrl !== undefined) next.baseUrl = body.baseUrl
  if (body.model !== undefined) next.model = body.model
  if (body.clearKey) next.apiKey = ''
  else if (body.apiKey?.trim()) next.apiKey = body.apiKey
  res.json(setRuntimeConfig(next))
})
app.post('/api/model/probe', asyncRoute(async (_req, res) => { res.json(await probeModel()) }))

app.get('/api/projects/:projectId/reviews', (req, res) => {
  requireProject(req.params.projectId)
  res.json(sql.all<Record<string, unknown>>('SELECT * FROM reviews WHERE project_id = ? ORDER BY CASE severity WHEN \'high\' THEN 1 WHEN \'medium\' THEN 2 ELSE 3 END, created_at DESC', req.params.projectId).map(decodeRow))
})
app.post('/api/projects/:projectId/reviews/run', (req, res) => { requireProject(req.params.projectId); res.json({ issues: runReview(req.params.projectId) }) })
app.patch('/api/reviews/:reviewId', (req, res) => {
  const status = z.object({ status: z.enum(['open', 'resolved', 'ignored']) }).parse(req.body).status
  sql.run('UPDATE reviews SET status=? WHERE id=?', status, req.params.reviewId)
  res.json(decodeRow(sql.get<Record<string, unknown>>('SELECT * FROM reviews WHERE id = ?', req.params.reviewId)!))
})

app.get('/api/projects/:projectId/generations', (req, res) => {
  requireProject(req.params.projectId)
  res.json(sql.all('SELECT id, task_type, input, output, model, created_at FROM generations WHERE project_id = ? ORDER BY created_at DESC LIMIT 30', req.params.projectId))
})

app.get('/api/projects/:projectId/export', (req, res) => {
  const project = requireProject(req.params.projectId)
  const payload = {
    project,
    chapters: sql.all('SELECT * FROM chapters WHERE project_id = ? ORDER BY position', req.params.projectId),
    volumes: sql.all('SELECT * FROM volumes WHERE project_id = ? ORDER BY order_index', req.params.projectId),
    chapterVolumeBindings: sql.all(`SELECT b.* FROM chapter_volume_bindings b JOIN chapters c ON c.id=b.chapter_id
      WHERE c.project_id=? ORDER BY b.volume_id, b.order_index`, req.params.projectId),
    entities: sql.all<Record<string, unknown>>('SELECT * FROM entities WHERE project_id = ? ORDER BY type, name', req.params.projectId).map(decodeRow),
    plotlines: sql.all('SELECT * FROM plotlines WHERE project_id = ?', req.params.projectId),
    outlines: sql.all('SELECT * FROM story_outlines WHERE project_id = ? ORDER BY version DESC', req.params.projectId),
    events: sql.all<Record<string, unknown>>('SELECT * FROM events WHERE project_id = ? ORDER BY narrative_order', req.params.projectId).map(decodeRow),
    relations: sql.all('SELECT * FROM relations WHERE project_id = ?', req.params.projectId),
    foreshadowing: sql.all('SELECT * FROM foreshadowing WHERE project_id = ?', req.params.projectId),
    facts: sql.all('SELECT * FROM story_facts WHERE project_id = ? ORDER BY introduced_position, importance DESC', req.params.projectId),
    chapterOutlines: sql.all('SELECT * FROM chapter_outlines WHERE project_id = ? ORDER BY created_at', req.params.projectId),
    exportedAt: sql.now(),
  }
  res.setHeader('Content-Disposition', `attachment; filename="novelweaver-${req.params.projectId}.json"`)
  res.json(payload)
})

const dist = path.join(root, 'dist')
if (fs.existsSync(dist)) {
  app.use(express.static(dist))
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(dist, 'index.html')))
}

app.use((error: Error & { status?: number; issues?: unknown }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error)
  res.status(error.status || 500).json({ error: error.message || '服务器发生未知错误。', details: error.issues })
})

app.listen(port, () => console.log(`NovelWeaver server running at http://localhost:${port}`))

export { app }
