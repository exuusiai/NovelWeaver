import { db, sql } from '../db.ts'
import { digest } from './evidence.ts'
import { runSchema, snapshotSchema, exportSchema } from './schemas.ts'
import { ToolError, type Run } from './protocol.ts'

export function saveRun(run: Run) {
  run.updatedAt = sql.now()
  runSchema.parse(run)
  sql.run(
    'INSERT INTO harness_runs VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at',
    run.id,
    run.projectId,
    JSON.stringify(run),
    run.updatedAt,
  )
}
export function getRun(id: string): Run {
  const row = sql.get<{ payload: string }>('SELECT payload FROM harness_runs WHERE id=?', id)
  if (!row) throw new ToolError('NOT_FOUND', '运行不存在。')
  return JSON.parse(row.payload)
}
export function projectRevision(projectId: string) {
  const state = {
    chapters: sql.all('SELECT id,revision FROM chapters WHERE project_id=? ORDER BY id', projectId),
    entities: sql.all(
      'SELECT id,summary,data,canon_status,updated_at FROM entities WHERE project_id=? ORDER BY id',
      projectId,
    ),
    facts: sql.all('SELECT * FROM story_facts WHERE project_id=? ORDER BY id', projectId),
    events: sql.all('SELECT * FROM events WHERE project_id=? ORDER BY id', projectId),
    relations: sql.all('SELECT * FROM relations WHERE project_id=? ORDER BY id', projectId),
    scopes: sql.all('SELECT * FROM memory_scopes WHERE project_id=? ORDER BY kind,item_id', projectId),
    sources: sql.all(
      'SELECT * FROM source_bindings WHERE chapter_id IN (SELECT id FROM chapters WHERE project_id=?) ORDER BY kind,item_id,chapter_id',
      projectId,
    ),
    dependencies: sql.all('SELECT * FROM harness_dependencies WHERE project_id=? ORDER BY id', projectId),
    outlines: sql.all('SELECT * FROM chapter_outlines WHERE project_id=? ORDER BY chapter_id', projectId),
    foreshadowing: sql.all('SELECT * FROM foreshadowing WHERE project_id=? ORDER BY id', projectId),
  }
  return digest(state)
}
// Domain snapshot includes interaction records and indexes; API credentials never enter it.
const domainTables = [
  'projects',
  'volumes',
  'chapters',
  'chapter_volume_bindings',
  'chapter_marks',
  'chapter_history',
  'story_outlines',
  'chapter_outlines',
  'entities',
  'plotlines',
  'events',
  'relations',
  'foreshadowing',
  'memory_chunks',
  'story_facts',
  'reviews',
  'generations',
  'imports',
  'analysis_runs',
  'analysis_jobs',
  'analysis_quality',
  'entity_edits',
  'import_previews',
  'memory_scopes',
  'harness_dependencies',
  'harness_evidence',
  'harness_receipts',
]
export function captureProject(projectId: string) {
  const tables: Record<string, Record<string, unknown>[]> = {}
  for (const table of domainTables) {
    const where =
      table === 'projects'
        ? 'id=?'
        : table === 'chapter_volume_bindings'
          ? 'chapter_id IN (SELECT id FROM chapters WHERE project_id=?)'
          : 'project_id=?'
    tables[table] = sql.all(`SELECT * FROM ${table} WHERE ${where} ORDER BY rowid`, projectId)
  }
  tables.source_bindings = sql.all(
    'SELECT * FROM source_bindings WHERE chapter_id IN (SELECT id FROM chapters WHERE project_id=?) OR item_id IN (SELECT id FROM entities WHERE project_id=? UNION SELECT id FROM story_facts WHERE project_id=? UNION SELECT id FROM events WHERE project_id=? UNION SELECT id FROM relations WHERE project_id=? UNION SELECT id FROM foreshadowing WHERE project_id=?) ORDER BY kind,item_id,chapter_id',
    projectId,
    projectId,
    projectId,
    projectId,
    projectId,
    projectId,
  )
  return { projectId, tables }
}
export function snapshotRun(run: Run) {
  const snapshot = {
    schemaVersion: run.schemaVersion,
    run: structuredClone(run),
    database: captureProject(run.projectId),
    remainingBudget: {
      calls: run.budget.maxCalls - run.costs.calls,
      tokens: run.budget.maxTokens - run.costs.inputTokens - run.costs.outputTokens,
    },
    randomState: run.randomState,
  }
  const id = sql.id()
  snapshotSchema.parse(snapshot)
  sql.run('INSERT INTO harness_snapshots VALUES (?, ?, ?, ?)', id, run.id, JSON.stringify(snapshot), sql.now())
  return { id, ...snapshot }
}
export function loadSnapshot(id: string) {
  const row = sql.get<{ payload: string }>('SELECT payload FROM harness_snapshots WHERE id=?', id)
  if (!row) throw new ToolError('NOT_FOUND', '快照不存在。')
  return JSON.parse(row.payload) as ReturnType<typeof snapshotRun>
}

// Replay observations without tool execution or business writes. A caller can continue
// a captured run on an isolated DB; restoreProject is intentionally not exposed over HTTP.
export function replaySnapshot(id: string) {
  const snapshot = loadSnapshot(id)
  return { mode: 'recorded_observations', ...snapshot, finalState: snapshot.run.state, steps: snapshot.run.steps }
}
export function restoreProject(snapshot: ReturnType<typeof captureProject>) {
  if (process.env.NOVELWEAVER_DATA_DIR !== ':memory:' && process.env.NOVELWEAVER_REPLAY_ISOLATED !== '1')
    throw new ToolError('INVALID_INPUT', '状态回放需要隔离数据库。')
  for (const [table, rows] of Object.entries(snapshot.tables)) {
    if (![...domainTables, 'source_bindings'].includes(table))
      throw new ToolError('INVALID_INPUT', `未知快照表：${table}`)
    const fields = new Set(sql.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name))
    if (rows.some((row) => Object.keys(row).some((key) => !fields.has(key))))
      throw new ToolError('INVALID_INPUT', `未知快照列：${table}`)
  }
  db.transaction(() => {
    db.pragma('defer_foreign_keys = ON')
    sql.run(
      'DELETE FROM source_bindings WHERE chapter_id IN (SELECT id FROM chapters WHERE project_id=?)',
      snapshot.projectId,
    )
    for (const table of [...domainTables].reverse()) {
      if (table === 'projects') continue
      const where =
        table === 'chapter_volume_bindings'
          ? 'chapter_id IN (SELECT id FROM chapters WHERE project_id=?)'
          : 'project_id=?'
      sql.run(`DELETE FROM ${table} WHERE ${where}`, snapshot.projectId)
    }
    // Upsert the project so Harness runs/snapshots keep their project foreign key.
    for (const [table, rows] of Object.entries(snapshot.tables))
      for (const row of rows) {
        const keys = Object.keys(row)
        if (table === 'projects' && sql.get('SELECT id FROM projects WHERE id=?', snapshot.projectId)) {
          const fields = keys.filter((k) => k !== 'id')
          sql.run(
            `UPDATE projects SET ${fields.map((k) => `"${k}"=?`).join(',')} WHERE id=?`,
            ...fields.map((k) => row[k]),
            snapshot.projectId,
          )
        } else
          sql.run(
            `INSERT OR REPLACE INTO ${table} (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
            ...keys.map((k) => row[k]),
          )
      }
    sql.run('DELETE FROM memory_fts WHERE project_id=?', snapshot.projectId)
    sql.run(
      'INSERT INTO memory_fts SELECT id,project_id,content,summary,keywords FROM memory_chunks WHERE project_id=?',
      snapshot.projectId,
    )
  })()
}
export function exportRun(run: Run) {
  return exportSchema.parse({
    taskId: run.taskId,
    sourceFamilyId: run.sourceFamilyId,
    split: run.split,
    schemaVersion: run.schemaVersion,
    dataOrigin: run.dataOrigin,
    initialState: run.initialState,
    goal: run.request.goal,
    constraints: run.state.task ?? run.request,
    workflow: { name: run.workflow, version: run.workflowVersion },
    modelVersions: run.modelVersions,
    steps: run.steps,
    outcome: { status: run.status, stopReason: run.stopReason, state: run.state },
    costs: run.costs,
    verification: run.state.verification ?? null,
    adoption: run.adoption,
    interaction: run.interaction,
    randomState: run.randomState,
    adaptation: run.adaptation,
  })
}
