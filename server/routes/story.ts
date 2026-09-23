import { Router } from 'express'
import { z } from 'zod'
import { db, sql } from '../db.ts'
import { isEffectivelyEmptyChapter } from '../importer.ts'
import { getModelStatus } from '../ai.ts'
import { chapterOutlineMarkdown, decomposeOutline, outlineDecompositionSchema } from '../planner.ts'
import { asyncRoute, decodeRow, normalizeChapterPositions, removeStalePlannedChapter, requireProject } from './helpers.ts'

export const storyRouter = Router()

storyRouter.get('/api/projects/:projectId/plot', (req, res) => {
  requireProject(req.params.projectId)
  res.json({
    plotlines: sql.all('SELECT * FROM plotlines WHERE project_id = ? ORDER BY created_at', req.params.projectId),
    events: sql.all<Record<string, unknown>>('SELECT * FROM events WHERE project_id = ? ORDER BY narrative_order', req.params.projectId).map(decodeRow),
    foreshadowing: sql.all('SELECT * FROM foreshadowing WHERE project_id = ? ORDER BY created_at', req.params.projectId),
  })
})

storyRouter.get('/api/projects/:projectId/outlines', (req, res) => {
  requireProject(req.params.projectId)
  res.json(sql.all('SELECT * FROM story_outlines WHERE project_id=? ORDER BY version DESC, created_at DESC', req.params.projectId))
})

storyRouter.post('/api/projects/:projectId/outlines', (req, res) => {
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

storyRouter.patch('/api/outlines/:outlineId', (req, res) => {
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

storyRouter.post('/api/outlines/:outlineId/decompose', asyncRoute(async (req, res) => {
  const outline = sql.get<{ id: string; project_id: string; title: string; content: string }>('SELECT id, project_id, title, content FROM story_outlines WHERE id=?', req.params.outlineId)
  if (!outline) return res.status(404).json({ error: '大纲版本不存在。' })
  if (!getModelStatus().configured) throw Object.assign(new Error('需要先配置可用的模型 API，才能把大纲可靠地拆分为剧情线和章节细纲。'), { status: 409, code: 'MODEL_REQUIRED' })
  const project = requireProject(outline.project_id)
  const started = Date.now()
  const plan = await decomposeOutline({ projectName: String(project.name), premise: String(project.premise), outline: outline.content })
  res.json({ plan, elapsedMs: Date.now() - started, sourceOutline: { id: outline.id, title: outline.title } })
}))

storyRouter.post('/api/outlines/:outlineId/apply-decomposition', (req, res) => {
  const outline = sql.get<{ id: string; project_id: string }>('SELECT id, project_id FROM story_outlines WHERE id=?', req.params.outlineId)
  if (!outline) return res.status(404).json({ error: '大纲版本不存在。' })
  const plan = outlineDecompositionSchema.parse(req.body.plan)
  const stamp = sql.now(); const colors = ['#13766f', '#aa5a35', '#496982', '#8a6b38', '#665f91', '#47725a']
  const result = { plotlines: 0, events: 0, volumes: 0, chapters: 0, skippedChapters: 0, removedStaleChapters: 0, removedVolumes: 0, removedTitles: [] as string[] }
  db.transaction(() => {
    // Re-planning replaces the previous plan's scaffolding: planned chapters the author never
    // wrote in are removed so the new chapters can take their place; chapters with real prose
    // (any status) are never touched and matched by title during insertion.
    const stalePlanned = sql.all<{ id: string; title: string; content: string }>(
      "SELECT id, title, content FROM chapters WHERE project_id=? AND status='planned'", outline.project_id)
      .filter((chapter) => isEffectivelyEmptyChapter(chapter.title, chapter.content))
    const staleIds = new Set(stalePlanned.map((chapter) => chapter.id))
    const planVolumeTitles = new Set(plan.volumes.map((volume) => volume.title))
    const staleVolumeIds = new Set<string>()
    for (const volume of sql.all<{ id: string; title: string }>('SELECT id, title FROM volumes WHERE project_id=?', outline.project_id)) {
      if (planVolumeTitles.has(volume.title) || !staleIds.size) continue
      const bindings = sql.all<{ chapter_id: string }>('SELECT chapter_id FROM chapter_volume_bindings WHERE volume_id=?', volume.id)
      if (bindings.length && bindings.every((binding) => staleIds.has(binding.chapter_id))) staleVolumeIds.add(volume.id)
    }
    stalePlanned.forEach((chapter) => removeStalePlannedChapter(chapter.id))
    staleVolumeIds.forEach((volumeId) => sql.run('DELETE FROM volumes WHERE id=?', volumeId))
    if (staleIds.size) normalizeChapterPositions(outline.project_id)
    result.removedStaleChapters = stalePlanned.length
    result.removedVolumes = staleVolumeIds.size
    result.removedTitles = stalePlanned.map((chapter) => chapter.title)

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

storyRouter.post('/api/projects/:projectId/plotlines', (req, res) => {
  requireProject(req.params.projectId)
  const body = z.object({ name: z.string().min(1), type: z.string().default('main'), summary: z.string().default(''), color: z.string().default('#13766f') }).parse(req.body)
  const itemId = sql.id()
  sql.run('INSERT INTO plotlines VALUES (?, ?, ?, ?, ?, ?, ?, ?)', itemId, req.params.projectId, body.name, body.type, body.summary, body.color, 'active', sql.now())
  res.status(201).json(sql.get('SELECT * FROM plotlines WHERE id = ?', itemId))
})

storyRouter.post('/api/projects/:projectId/events', (req, res) => {
  requireProject(req.params.projectId)
  const body = z.object({ title: z.string().min(1), summary: z.string().default(''), storyTime: z.string().default(''), status: z.string().default('planned'), plotlineId: z.string().nullable().optional(), chapterId: z.string().nullable().optional(), participants: z.array(z.string()).default([]), location: z.string().default(''), cause: z.string().default(''), consequence: z.string().default('') }).parse(req.body)
  const order = (sql.get<{ max: number }>('SELECT COALESCE(MAX(narrative_order), 0) max FROM events WHERE project_id = ?', req.params.projectId)?.max ?? 0) + 1
  const eventId = sql.id(); const stamp = sql.now()
  sql.run(`INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, eventId, req.params.projectId, body.title,
    body.summary, body.storyTime, order, body.status, body.plotlineId ?? null, body.chapterId ?? null, JSON.stringify(body.participants),
    body.location, body.cause, body.consequence, '{}', stamp, stamp)
  res.status(201).json(decodeRow(sql.get<Record<string, unknown>>('SELECT * FROM events WHERE id = ?', eventId)!))
})

storyRouter.patch('/api/events/:eventId', (req, res) => {
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

storyRouter.post('/api/projects/:projectId/foreshadowing', (req, res) => {
  requireProject(req.params.projectId)
  const body = z.object({ title: z.string().min(1), setupChapterId: z.string().nullable().optional(), payoffChapterId: z.string().nullable().optional(), status: z.string().default('open'), notes: z.string().default('') }).parse(req.body)
  const itemId = sql.id()
  sql.run('INSERT INTO foreshadowing VALUES (?, ?, ?, ?, ?, ?, ?, ?)', itemId, req.params.projectId, body.title, body.setupChapterId ?? null, body.payoffChapterId ?? null, body.status, body.notes, sql.now())
  res.status(201).json(sql.get('SELECT * FROM foreshadowing WHERE id = ?', itemId))
})
