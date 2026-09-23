import { db, sql } from '../db.ts'
import { estimateTokens } from '../memory.ts'
import { analyzeManuscript, characterNameVariants } from '../analyzer.ts'
import { getModelStatus } from '../ai.ts'
import { analysisModelRequired, decodeRow } from './helpers.ts'

export function updateAnalysisJob(jobId: string, values: { status?: string; stage?: string; progress?: number; message?: string; error?: string; result?: unknown }) {
  const current = sql.get<Record<string, unknown>>('SELECT * FROM analysis_jobs WHERE id = ?', jobId)
  if (!current) return
  sql.run(`UPDATE analysis_jobs SET status=?, stage=?, progress=?, message=?, error=?, result=?, updated_at=? WHERE id=?`,
    values.status ?? current.status, values.stage ?? current.stage, values.progress ?? current.progress,
    values.message ?? current.message, values.error ?? current.error, values.result ? JSON.stringify(values.result) : current.result,
    sql.now(), jobId)
}

export function analysisQuality(projectId: string) {
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
      estimatedInputTokens: chapters.reduce((sum, row) => sum + estimateTokens(row.content), 0),
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

export async function analyzeProjectData(projectId: string, replaceCandidates = false, jobId?: string, onlyChapterIds?: string[]) {
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

export function startAnalysisJob(jobId: string, onlyChapterIds?: string[]) {
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
    const metrics = { secondPassEntities: second.entities.length, secondPassEvents: second.events.length, disagreements: disagreements.length, failedBatches: second.failures.length, estimatedInputTokens: chapters.reduce((sum, chapter) => sum + estimateTokens(chapter.content), 0) }
    sql.run('INSERT INTO analysis_quality VALUES (?, ?, ?, ?, ?, ?, ?)', sql.id(), projectId, jobId, 'second-pass', JSON.stringify(metrics), JSON.stringify(disagreements), sql.now())
    updateAnalysisJob(jobId, { status: second.failures.length ? 'partial' : 'completed', stage: 'completed', progress: 100, message: `复核完成，发现 ${disagreements.length} 项分歧`, result: { metrics, disagreements, failures: second.failures } })
  } catch (error) { updateAnalysisJob(jobId, { status: 'failed', stage: 'failed', progress: 100, message: '独立复核失败', error: (error as Error).message }) }
}

// Restart recovery: jobs interrupted by a process restart become resumable.
export function recoverInterruptedJobs() {
  sql.run("UPDATE analysis_jobs SET status='paused', stage='recovered', message='服务重启后已暂停，可继续运行', updated_at=? WHERE status IN ('queued','running')", sql.now())
}
