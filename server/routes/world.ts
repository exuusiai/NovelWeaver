import { Router } from 'express'
import { z } from 'zod'
import { db, sql } from '../db.ts'
import { characterNameVariants } from '../analyzer.ts'
import { decodeRow, recordEntityEdit, refreshEntityMemory, requireProject, snapshotEntity } from './helpers.ts'

export const worldRouter = Router()

worldRouter.get('/api/projects/:projectId/entities', (req, res) => {
  requireProject(req.params.projectId)
  const type = typeof req.query.type === 'string' ? req.query.type : ''
  const rows = type ? sql.all<Record<string, unknown>>('SELECT * FROM entities WHERE project_id = ? AND type = ? ORDER BY name', req.params.projectId, type)
    : sql.all<Record<string, unknown>>('SELECT * FROM entities WHERE project_id = ? ORDER BY type, name', req.params.projectId)
  res.json(rows.map(decodeRow))
})

worldRouter.get('/api/projects/:projectId/entities/duplicate-suggestions', (req, res) => {
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

worldRouter.post('/api/projects/:projectId/entities', (req, res) => {
  requireProject(req.params.projectId)
  const body = z.object({ type: z.string().min(1), name: z.string().min(1), summary: z.string().default(''), data: z.record(z.string(), z.unknown()).default({}), canonStatus: z.string().default('canon') }).parse(req.body)
  const entityId = sql.id(); const stamp = sql.now()
  sql.run(`INSERT INTO entities VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, entityId, req.params.projectId, body.type,
    body.name, body.summary, JSON.stringify(body.data), body.canonStatus, 1, null, stamp, stamp)
  sql.addMemory(req.params.projectId, 'entity', entityId, `${body.name}：${body.summary}\n${JSON.stringify(body.data)}`, body.summary, `${body.name} ${body.type}`)
  res.status(201).json(decodeRow(sql.get<Record<string, unknown>>('SELECT * FROM entities WHERE id = ?', entityId)!))
})

worldRouter.patch('/api/entities/:entityId', (req, res) => {
  const current = sql.get<Record<string, unknown>>('SELECT * FROM entities WHERE id = ?', req.params.entityId)
  if (!current) return res.status(404).json({ error: '设定不存在。' })
  const body = z.object({ type: z.string().optional(), name: z.string().optional(), summary: z.string().optional(), data: z.record(z.string(), z.unknown()).optional(), canonStatus: z.string().optional(), confidence: z.number().min(0).max(1).optional() }).parse(req.body)
  sql.run(`UPDATE entities SET type=?, name=?, summary=?, data=?, canon_status=?, confidence=?, updated_at=? WHERE id=?`,
    body.type ?? current.type, body.name ?? current.name, body.summary ?? current.summary,
    body.data ? JSON.stringify(body.data) : current.data, body.canonStatus ?? current.canon_status,
    body.confidence ?? current.confidence, sql.now(), req.params.entityId)
  // 记忆一致性：作者改完人物卡，AI 必须立刻读到新资料。
  // 废弃的设定从检索记忆移除（不再喂给模型）；其余状态重建记忆。
  if ((body.canonStatus ?? current.canon_status) === 'deprecated') {
    const stale = sql.all<{ id: string }>('SELECT id FROM memory_chunks WHERE source_type=? AND source_id=?', 'entity', req.params.entityId)
    stale.forEach(({ id }) => sql.run('DELETE FROM memory_fts WHERE id=?', id))
    sql.run('DELETE FROM memory_chunks WHERE source_type=? AND source_id=?', 'entity', req.params.entityId)
  } else {
    refreshEntityMemory(req.params.entityId)
  }
  res.json(decodeRow(sql.get<Record<string, unknown>>('SELECT * FROM entities WHERE id = ?', req.params.entityId)!))
})

worldRouter.delete('/api/entities/:entityId', (req, res) => {
  sql.run('DELETE FROM relations WHERE from_entity_id = ? OR to_entity_id = ?', req.params.entityId, req.params.entityId)
  // 删除设定时同步移除检索记忆，避免"已删除的设定又出现在 AI 上下文里"
  const memoryIds = sql.all<{ id: string }>('SELECT id FROM memory_chunks WHERE source_type=? AND source_id=?', 'entity', req.params.entityId)
  memoryIds.forEach(({ id }) => sql.run('DELETE FROM memory_fts WHERE id=?', id))
  sql.run('DELETE FROM memory_chunks WHERE source_type=? AND source_id=?', 'entity', req.params.entityId)
  sql.run('DELETE FROM entities WHERE id = ?', req.params.entityId)
  res.status(204).end()
})

worldRouter.get('/api/projects/:projectId/entity-edits', (req, res) => {
  requireProject(req.params.projectId)
  res.json(sql.all<Record<string, unknown>>('SELECT * FROM entity_edits WHERE project_id = ? ORDER BY created_at DESC LIMIT 30', req.params.projectId).map(decodeRow))
})

worldRouter.post('/api/entities/:entityId/rename', (req, res) => {
  const current = snapshotEntity(req.params.entityId)
  if (!current) return res.status(404).json({ error: '设定不存在。' })
  const body = z.object({ name: z.string().min(1), aliases: z.array(z.string()).default([]) }).parse(req.body)
  const data = JSON.parse(String(current.data || '{}')) as Record<string, unknown>; const oldName = String(current.name)
  data.aliases = [...new Set([...(Array.isArray(data.aliases) ? data.aliases.map(String) : []), oldName, ...body.aliases])].filter((name) => name && name !== body.name)
  const editId = recordEntityEdit(String(current.project_id), 'rename', req.params.entityId, { entity: current }, { oldName, newName: body.name })
  sql.run('UPDATE entities SET name=?, data=?, updated_at=? WHERE id=?', body.name, JSON.stringify(data), sql.now(), req.params.entityId); refreshEntityMemory(req.params.entityId)
  res.json({ entity: decodeRow(snapshotEntity(req.params.entityId)!), editId })
})

worldRouter.post('/api/projects/:projectId/entities/merge', (req, res) => {
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

worldRouter.post('/api/entities/:entityId/split', (req, res) => {
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

worldRouter.post('/api/entity-edits/:editId/undo', (req, res) => {
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

worldRouter.get('/api/projects/:projectId/facts', (req, res) => {
  requireProject(req.params.projectId)
  res.json(sql.all(`SELECT f.*, c.title source_chapter_title FROM story_facts f
    LEFT JOIN chapters c ON c.id=f.source_chapter_id WHERE f.project_id=?
    ORDER BY f.introduced_position, f.importance DESC`, req.params.projectId))
})

worldRouter.post('/api/projects/:projectId/facts', (req, res) => {
  requireProject(req.params.projectId)
  const body = z.object({ subject: z.string().min(1), predicate: z.string().min(1), value: z.string().min(1), sourceChapterId: z.string().nullable().optional(), importance: z.number().int().min(0).max(100).default(50), canonStatus: z.enum(['candidate', 'canon', 'deprecated']).default('candidate'), evidence: z.string().default('') }).parse(req.body)
  const position = body.sourceChapterId ? sql.get<{ position: number }>('SELECT position FROM chapters WHERE id=?', body.sourceChapterId)?.position ?? 0 : 0
  const factId = sql.id(); const stamp = sql.now()
  sql.run('INSERT INTO story_facts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', factId, req.params.projectId, body.subject, body.predicate, body.value, body.sourceChapterId ?? null, position, body.importance, body.canonStatus, body.evidence, stamp, stamp)
  res.status(201).json(sql.get('SELECT * FROM story_facts WHERE id=?', factId))
})

worldRouter.patch('/api/facts/:factId', (req, res) => {
  const current = sql.get<Record<string, unknown>>('SELECT * FROM story_facts WHERE id=?', req.params.factId)
  if (!current) return res.status(404).json({ error: '事实不存在。' })
  const body = z.object({ subject: z.string().min(1).optional(), predicate: z.string().min(1).optional(), value: z.string().min(1).optional(), importance: z.number().int().min(0).max(100).optional(), canonStatus: z.enum(['candidate', 'canon', 'deprecated']).optional(), evidence: z.string().optional() }).parse(req.body)
  sql.run('UPDATE story_facts SET subject=?, predicate=?, value=?, importance=?, canon_status=?, evidence=?, updated_at=? WHERE id=?', body.subject ?? current.subject, body.predicate ?? current.predicate, body.value ?? current.value, body.importance ?? current.importance, body.canonStatus ?? current.canon_status, body.evidence ?? current.evidence, sql.now(), req.params.factId)
  res.json(sql.get('SELECT * FROM story_facts WHERE id=?', req.params.factId))
})

worldRouter.delete('/api/facts/:factId', (req, res) => {
  sql.run('DELETE FROM story_facts WHERE id=?', req.params.factId)
  res.status(204).end()
})

worldRouter.get('/api/projects/:projectId/graph', (req, res) => {
  requireProject(req.params.projectId)
  const entities = sql.all<Record<string, unknown>>('SELECT id, project_id, type, name, summary, data, canon_status, confidence, source_chapter_id, updated_at FROM entities WHERE project_id = ? ORDER BY type, name', req.params.projectId).map(decodeRow)
  const relations = sql.all<Record<string, unknown>>('SELECT * FROM relations WHERE project_id = ?', req.params.projectId)
  res.json({ entities, relations })
})

worldRouter.post('/api/projects/:projectId/relations', (req, res) => {
  requireProject(req.params.projectId)
  const body = z.object({ fromEntityId: z.string(), toEntityId: z.string(), type: z.string(), label: z.string().default(''), sentiment: z.string().default('neutral'), strength: z.number().int().min(0).max(100).default(50) }).parse(req.body)
  const relationId = sql.id()
  sql.run('INSERT INTO relations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', relationId, req.params.projectId, body.fromEntityId, body.toEntityId,
    body.type, body.label, body.sentiment, body.strength, '', '', sql.now())
  res.status(201).json(sql.get('SELECT * FROM relations WHERE id = ?', relationId))
})
