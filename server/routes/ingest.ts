import multer from 'multer'
import crypto from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import { db, sql } from '../db.ts'
import { chapterContentFingerprint, chunkText, extractText, isEffectivelyEmptyChapter, splitChaptersDetailed, summarize } from '../importer.ts'
import { getModelStatus } from '../ai.ts'
import { analysisQuality, analyzeProjectData, createAnalysisJob, startAnalysisJob, updateAnalysisJob } from './analysis-service.ts'
import { asyncRoute, contentHash, analysisModelRequired, bindChapterToVolume, decodeRow, deduplicateImportedChapters, removeChapterWithMemory, requireProject } from './helpers.ts'

export const ingestRouter = Router()

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 150 * 1024 * 1024 } })

ingestRouter.post('/api/projects/:projectId/import/preview', upload.single('file'), (req, res) => {
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

ingestRouter.get('/api/projects/:projectId/import/previews/:previewId', (req, res) => {
  requireProject(req.params.projectId)
  const row = sql.get<Record<string, unknown>>('SELECT * FROM import_previews WHERE id = ? AND project_id = ?', req.params.previewId, req.params.projectId)
  if (!row) return res.status(404).json({ error: '导入预览不存在。' })
  res.json(decodeRow(row))
})

ingestRouter.patch('/api/projects/:projectId/import/previews/:previewId', (req, res) => {
  requireProject(req.params.projectId)
  const current = sql.get<Record<string, unknown>>('SELECT * FROM import_previews WHERE id = ? AND project_id = ?', req.params.previewId, req.params.projectId)
  if (!current) return res.status(404).json({ error: '导入预览不存在。' })
  const body = z.object({ chapters: z.array(z.object({ title: z.string().min(1), content: z.string(), summary: z.string().default(''), position: z.number().int().nonnegative().optional() })) }).parse(req.body)
  const chapters = body.chapters.map((chapter, position) => ({ ...chapter, position }))
  sql.run('UPDATE import_previews SET chapters=?, updated_at=? WHERE id=?', JSON.stringify(chapters), sql.now(), req.params.previewId)
  res.json({ ...decodeRow(current), chapters })
})

ingestRouter.post('/api/projects/:projectId/import/previews/:previewId/commit', asyncRoute(async (req, res) => {
  const projectId = String(req.params.projectId); const project = requireProject(projectId)
  const preview = sql.get<Record<string, unknown>>('SELECT * FROM import_previews WHERE id = ? AND project_id = ?', req.params.previewId, projectId)
  if (!preview) return res.status(404).json({ error: '导入预览不存在。' })
  if (preview.status !== 'pending') return res.status(409).json({ error: '这个导入预览已经处理过。' })
  const replaceImported = Boolean(req.body?.replace)
  const rawText = String(preview.raw_text); const fileHash = String(preview.file_hash)
  const duplicate = sql.get('SELECT id FROM imports WHERE project_id = ? AND file_hash = ?', projectId, fileHash)
  if (duplicate && !replaceImported) return res.status(409).json({ error: '这份文稿已经导入过；如需替换旧文稿，请选择替换导入。' })
  const chapters = JSON.parse(String(preview.chapters)) as Array<{ title: string; content: string; summary?: string; position?: number }>
  const diagnostics = decodeRow(preview).diagnostics as { warnings: string[] }
  // 替换导入的去重口径：仅与"替换后仍保留的章节"（手写/规划章）比对；
  // 与旧导入章节同文不算重复——它们本来就要被新稿覆盖。
  const importedChapters = replaceImported
    ? sql.all<{ id: string; content: string }>("SELECT id, content FROM chapters WHERE project_id = ? AND status = 'imported'", projectId)
    : []
  const importedIdSet = new Set(importedChapters.map((row) => row.id))
  const importedFingerprints = new Set(importedChapters.map((row) => chapterContentFingerprint(row.content)))
  const existingFingerprints = new Set(sql.all<{ content: string; status: string }>('SELECT content, status FROM chapters WHERE project_id = ? AND LENGTH(TRIM(content)) > 0', projectId)
    .filter((row) => !replaceImported || row.status !== 'imported')
    .map((row) => chapterContentFingerprint(row.content)))
  // 文学结构（循环章、间章、叙诡）可能是作者刻意的重复——提交时不再静默丢弃，
  // 保留全部有效章节并把疑似重复列为警告，由作者在预览中自行删减。
  const duplicateWarns: string[] = []
  const filtered = chapters.filter((chapter) => {
    if (isEffectivelyEmptyChapter(chapter.title, chapter.content)) return false
    if (existingFingerprints.has(chapterContentFingerprint(chapter.content))) {
      duplicateWarns.push(chapter.title)
      return true
    }
    return true
  })
  if (duplicateWarns.length) diagnostics.warnings.push(`有 ${duplicateWarns.length} 章内容与现有章节相同，已按作者意图保留：${duplicateWarns.slice(0, 4).join('、')}${duplicateWarns.length > 4 ? '……' : ''}。若是无意重复，请在预览中删除。`)
  if (!filtered.length) {
    return res.status(409).json({ error: replaceImported
      ? '新文稿中没有有效章节可写入。请检查预览中的章节边界。'
      : '没有可新增的有效章节：请在预览中调整章节边界或选择替换导入。' })
  }
  if (replaceImported) {
    const importedIds = importedChapters.map((row) => ({ id: row.id }))
    const candidateIds = sql.all<{ id: string }>(`SELECT id FROM entities WHERE project_id = ? AND canon_status = 'candidate' AND json_extract(data, '$.source') = 'model-analysis'`, projectId)
    db.transaction(() => {
        // 数据失效流程：一次替换 = 新的稿件修订。旧稿派生的候选数据整体清除；
        // 作者人工确认过的正史保留（那是作者的决定，不由导入器替作者删），但剥离失效章节来源。
        importedIds.forEach(({ id }) => removeChapterWithMemory(id))
        candidateIds.forEach(({ id }) => { sql.run('DELETE FROM relations WHERE from_entity_id=? OR to_entity_id=?', id, id); sql.run('DELETE FROM entities WHERE id=?', id) })
        sql.run("DELETE FROM events WHERE project_id=? AND status='candidate'", projectId)
        sql.run("DELETE FROM plotlines WHERE project_id=? AND status='candidate'", projectId)
        sql.run(`DELETE FROM story_facts WHERE project_id=? AND canon_status='candidate' AND source_chapter_id IS NOT NULL
          AND source_chapter_id NOT IN (SELECT id FROM chapters WHERE project_id=?)`, projectId, projectId)
        sql.run('UPDATE story_facts SET source_chapter_id=NULL WHERE project_id=? AND source_chapter_id NOT IN (SELECT id FROM chapters WHERE project_id=?)', projectId, projectId)
        sql.run('DELETE FROM reviews WHERE project_id=? AND status=?', projectId, 'open')
        sql.run('DELETE FROM chapter_history WHERE project_id=? AND chapter_id NOT IN (SELECT id FROM chapters WHERE project_id=?)', projectId, projectId)
        // 修订号递增：在途分析任务（旧修订）写回前会被 revision 校验拦截
        sql.run('UPDATE projects SET import_revision = import_revision + 1 WHERE id=?', projectId)
        sql.run("UPDATE analysis_jobs SET status='canceled', stage='canceled', message='替换导入，任务已取消', updated_at=? WHERE project_id=? AND status IN ('queued','running')", sql.now(), projectId)
        sql.run('DELETE FROM imports WHERE project_id=?', projectId)
      })()
  }
  db.transaction(() => {
    const basePosition = replaceImported
      ? (sql.get<{ max: number }>('SELECT COALESCE(MAX(position), -1) max FROM chapters WHERE project_id = ?', projectId)?.max ?? -1) + 1
      : (sql.get<{ max: number }>('SELECT COALESCE(MAX(position), -1) max FROM chapters WHERE project_id = ?', projectId)?.max ?? -1) + 1
    filtered.forEach((chapter, index) => { const chapterId = sql.id(); const stamp = sql.now(); sql.run(`INSERT INTO chapters (id, project_id, title, content, position, status, summary, pov, target_words, created_at, updated_at, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, chapterId, projectId, chapter.title, chapter.content, basePosition + index, 'imported', chapter.summary || summarize(chapter.content), '', 3000, stamp, stamp, contentHash(chapter.content)); bindChapterToVolume(projectId, chapterId); chunkText(chapter.content).forEach((chunk, chunkIndex) => sql.addMemory(projectId, 'chapter', chapterId, chunk, chunkIndex === 0 ? (chapter.summary || summarize(chunk)) : summarize(chunk), `${chapter.title} 导入片段`, chapterId)) })
    sql.run('INSERT INTO imports VALUES (?, ?, ?, ?, ?, ?, ?)', sql.id(), projectId, preview.filename, fileHash, rawText, JSON.stringify(diagnostics), sql.now()); sql.run('UPDATE projects SET imported=1, updated_at=? WHERE id=?', sql.now(), projectId); sql.run('UPDATE import_previews SET status=?, updated_at=? WHERE id=?', 'committed', sql.now(), req.params.previewId)
  })()
  const revision = sql.get<{ r: number }>('SELECT import_revision r FROM projects WHERE id=?', projectId)?.r ?? 0
  const configured = getModelStatus().configured
  const job = createAnalysisJob(projectId, configured
    ? { message: '等待模型分析', replaceCandidates: replaceImported }
    : { message: '文稿已导入，配置模型后可重试分析', error: '当前未配置模型 API。', replaceCandidates: replaceImported })
  if (configured) startAnalysisJob(job)
  res.status(201).json({ project, previewId: req.params.previewId, chapters: filtered.length, analysisJobId: job, diagnostics, replaced: replaceImported })
}))

ingestRouter.post('/api/projects/:projectId/import', upload.single('file'), asyncRoute(async (req, res) => {
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
      sql.run(`INSERT INTO chapters (id, project_id, title, content, position, status, summary, pov, target_words, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, chapterId, projectId,
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

ingestRouter.post('/api/projects/:projectId/analyze', asyncRoute(async (req, res) => {
  const projectId = String(req.params.projectId)
  requireProject(projectId)
  const result = await analyzeProjectData(projectId, Boolean(req.body?.replaceCandidates))
  res.json({ status: 'completed', ...result, model: getModelStatus() })
}))

ingestRouter.post('/api/projects/:projectId/analysis/jobs', (req, res) => {
  const projectId = String(req.params.projectId); requireProject(projectId)
  if (!getModelStatus().configured) throw analysisModelRequired()
  const active = sql.get<Record<string, unknown>>("SELECT * FROM analysis_jobs WHERE project_id = ? AND status IN ('queued','running','paused') ORDER BY created_at DESC LIMIT 1", projectId)
  if (active) return res.status(409).json({ error: '已有分析任务正在进行。', job: decodeRow(active) })
  const replaceCandidates = Boolean(req.body?.replaceCandidates)
  const jobId = createAnalysisJob(projectId, { replaceCandidates })
  startAnalysisJob(jobId)
  res.status(202).json(decodeRow(sql.get<Record<string, unknown>>('SELECT * FROM analysis_jobs WHERE id = ?', jobId)!))
})

ingestRouter.get('/api/projects/:projectId/analysis/jobs', (req, res) => {
  requireProject(req.params.projectId)
  res.json(sql.all<Record<string, unknown>>('SELECT * FROM analysis_jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 20', req.params.projectId).map(decodeRow))
})

ingestRouter.get('/api/analysis/jobs/:jobId', (req, res) => {
  const job = sql.get<Record<string, unknown>>('SELECT * FROM analysis_jobs WHERE id = ?', req.params.jobId)
  if (!job) return res.status(404).json({ error: '分析任务不存在。' })
  res.json(decodeRow(job))
})

ingestRouter.post('/api/analysis/jobs/:jobId/pause', (req, res) => {
  const job = sql.get<Record<string, unknown>>('SELECT * FROM analysis_jobs WHERE id = ?', req.params.jobId)
  if (!job) return res.status(404).json({ error: '分析任务不存在。' })
  if (!['queued', 'running'].includes(String(job.status))) return res.status(409).json({ error: '当前任务状态不能暂停。' })
  updateAnalysisJob(req.params.jobId, { status: 'paused', stage: 'paused', message: '将在当前批次结束后暂停' })
  res.json(decodeRow(sql.get<Record<string, unknown>>('SELECT * FROM analysis_jobs WHERE id = ?', req.params.jobId)!))
})

ingestRouter.post('/api/analysis/jobs/:jobId/resume', (req, res) => {
  const job = sql.get<Record<string, unknown>>('SELECT * FROM analysis_jobs WHERE id = ?', req.params.jobId)
  if (!job) return res.status(404).json({ error: '分析任务不存在。' })
  if (job.status !== 'paused') return res.status(409).json({ error: '只有暂停中的任务可以继续。' })
  updateAnalysisJob(req.params.jobId, { status: 'running', stage: 'extracting', message: '正在继续分析' })
  startAnalysisJob(req.params.jobId)
  res.json(decodeRow(sql.get<Record<string, unknown>>('SELECT * FROM analysis_jobs WHERE id = ?', req.params.jobId)!))
})

ingestRouter.post('/api/analysis/jobs/:jobId/retry', (req, res) => {
  const previous = sql.get<Record<string, unknown>>('SELECT * FROM analysis_jobs WHERE id = ?', req.params.jobId)
  if (!previous) return res.status(404).json({ error: '分析任务不存在。' })
  const decoded = decodeRow(previous); const result = decoded.result as { failures?: Array<{ chapterIds: string[] }> } | undefined
  const failedIds = [...new Set((result?.failures || []).flatMap((failure) => failure.chapterIds))]
  if (!failedIds.length && previous.status !== 'failed') return res.status(409).json({ error: '这个任务没有可重试的失败章节。' })
  const jobId = createAnalysisJob(String(previous.project_id), { message: failedIds.length ? `准备重试 ${failedIds.length} 个失败章节` : '准备重试分析' })
  startAnalysisJob(jobId, failedIds.length ? failedIds : undefined)
  res.status(202).json(decodeRow(sql.get<Record<string, unknown>>('SELECT * FROM analysis_jobs WHERE id = ?', jobId)!))
})

ingestRouter.get('/api/projects/:projectId/analysis/quality', (req, res) => {
  requireProject(req.params.projectId)
  const audits = sql.all<Record<string, unknown>>('SELECT * FROM analysis_quality WHERE project_id = ? ORDER BY created_at DESC LIMIT 10', req.params.projectId).map(decodeRow)
  res.json({ ...analysisQuality(req.params.projectId), audits })
})

ingestRouter.post('/api/projects/:projectId/analysis/second-pass', (req, res) => {
  const projectId = String(req.params.projectId); requireProject(projectId)
  if (!getModelStatus().configured) throw analysisModelRequired()
  const jobId = createAnalysisJob(projectId, { stage: 'second-pass', message: '等待独立复核', replaceCandidates: true })
  startAnalysisJob(jobId)
  res.status(202).json(decodeRow(sql.get<Record<string, unknown>>('SELECT * FROM analysis_jobs WHERE id = ?', jobId)!))
})

ingestRouter.get('/api/projects/:projectId/analysis/latest', (req, res) => {
  requireProject(req.params.projectId)
  const run = sql.get<Record<string, unknown>>('SELECT * FROM analysis_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1', req.params.projectId)
  res.json(run ? decodeRow(run) : null)
})

ingestRouter.post('/api/projects/:projectId/chapters/deduplicate', (req, res) => {
  requireProject(req.params.projectId)
  res.json(deduplicateImportedChapters(req.params.projectId))
})

ingestRouter.get('/api/projects/:projectId/imports', (req, res) => {
  requireProject(req.params.projectId)
  res.json(sql.all<Record<string, unknown>>('SELECT id, filename, file_hash, diagnostics, created_at FROM imports WHERE project_id = ? ORDER BY created_at DESC', req.params.projectId).map(decodeRow))
})
