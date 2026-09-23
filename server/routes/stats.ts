import { Router } from 'express'
import { z } from 'zod'
import { sql } from '../db.ts'
import { estimateTokens } from '../memory.ts'
import { requireProject } from './helpers.ts'

export const statsRouter = Router()

// Behavioral feedback for a generation: whether its output was appended to the manuscript
// or discarded. Drives the acceptance-rate metric (the product's north-star signal).
statsRouter.post('/api/generations/:generationId/feedback', (req, res) => {
  const action = z.object({ action: z.enum(['appended', 'discarded']) }).parse(req.body).action
  const generation = sql.get<{ id: string }>('SELECT id FROM generations WHERE id = ?', req.params.generationId)
  if (!generation) return res.status(404).json({ error: '生成记录不存在。' })
  sql.run('UPDATE generations SET used=? WHERE id=?', action === 'appended' ? 1 : 0, req.params.generationId)
  res.json({ ok: true })
})

statsRouter.get('/api/projects/:projectId/stats', (req, res) => {
  requireProject(req.params.projectId)
  const projectId = req.params.projectId
  const chapters = sql.get<{ count: number; words: number }>("SELECT COUNT(*) count, COALESCE(SUM(LENGTH(REPLACE(REPLACE(REPLACE(REPLACE(content, ' ', ''), char(10), ''), char(13), ''), char(9), ''))), 0) words FROM chapters WHERE project_id = ?", projectId) ?? { count: 0, words: 0 }
  const generations = sql.get<{ total: number; appended: number; discarded: number }>(`SELECT COUNT(*) total,
    COALESCE(SUM(CASE WHEN used = 1 THEN 1 ELSE 0 END), 0) appended,
    COALESCE(SUM(CASE WHEN used = 0 THEN 1 ELSE 0 END), 0) discarded
    FROM generations WHERE project_id = ?`, projectId) ?? { total: 0, appended: 0, discarded: 0 }
  const reviews = sql.get<{ open: number; resolved: number }>(`SELECT
    COALESCE(SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END), 0) open,
    COALESCE(SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END), 0) resolved
    FROM reviews WHERE project_id = ?`, projectId) ?? { open: 0, resolved: 0 }
  const historyVersions = sql.get<{ count: number }>('SELECT COUNT(*) count FROM chapter_history WHERE project_id = ?', projectId)?.count ?? 0

  // Token-estimator calibration: real prompt tokens from provider usage vs our estimate
  // over the same assembled context snapshot. Needs API-key generations to accumulate.
  const usageRows = sql.all<{ usage: string; context_snapshot: string }>("SELECT usage, context_snapshot FROM generations WHERE project_id = ? AND usage != '' AND context_snapshot != ''", projectId)
  const ratios: number[] = []
  for (const row of usageRows) {
    try {
      const usage = JSON.parse(row.usage) as { prompt_tokens?: number }
      if (usage.prompt_tokens && usage.prompt_tokens > 0) ratios.push(usage.prompt_tokens / estimateTokens(row.context_snapshot))
    } catch { /* malformed usage row */ }
  }
  const tokenCalibration = ratios.length
    ? { samples: ratios.length, avgRatio: Number((ratios.reduce((sum, value) => sum + value, 0) / ratios.length).toFixed(2)) }
    : null

  const decided = generations.appended + generations.discarded
  res.json({
    chapters: chapters?.count ?? 0,
    wordsTotal: chapters?.words ?? 0,
    generations: {
      total: generations.total, appended: generations.appended, discarded: generations.discarded,
      acceptanceRate: decided ? Math.round(generations.appended / decided * 100) : null,
    },
    reviews: {
      open: reviews.open, resolved: reviews.resolved,
      resolutionRate: reviews.open + reviews.resolved ? Math.round(reviews.resolved / (reviews.open + reviews.resolved) * 100) : null,
    },
    historyVersions,
    tokenCalibration,
  })
})
