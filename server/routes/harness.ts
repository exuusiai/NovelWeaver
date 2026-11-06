import { Router } from 'express'
import { z } from 'zod'
import { sql } from '../db.ts'
import { asyncRoute, requireProject } from './helpers.ts'
import { recoverRuns } from '../harness/executor.ts'
import { exportRun, getRun, replaySnapshot, snapshotRun } from '../harness/store.ts'
import { ToolError } from '../harness/protocol.ts'
import { taskExecutor } from '../tasks/service.ts'

export const harnessExecutor = taskExecutor
export const harnessRouter = Router()
recoverRuns()
harnessRouter.get('/api/harness/tools', (_req, res) => res.json(harnessExecutor.registry.catalog()))
harnessRouter.get('/api/projects/:projectId/harness/runs', (req, res) => {
  requireProject(req.params.projectId)
  res.json(
    sql
      .all<{
        id: string
      }>('SELECT id FROM harness_runs WHERE project_id=? ORDER BY updated_at DESC LIMIT 100', req.params.projectId)
      .filter(row=>{const run=getRun(row.id);return !run.adaptation || run.adaptation.plan.profileId==='revision.local'})
      .map((row) => {
        const r = getRun(row.id)
        return {
          id: r.id,
          taskId: r.taskId,
          status: r.status,
          stopReason: r.stopReason,
          chapterId: r.request.chapterId,
          goal: r.request.goal,
          updatedAt: r.updatedAt,
        }
      }),
  )
})
harnessRouter.post('/api/harness/runs', (req, res) => {
  const run = harnessExecutor.create(req.body)
  void harnessExecutor.resume(run.id).catch((error) => console.error('Harness run failed', error))
  res.status(202).json(run)
})
harnessRouter.get('/api/harness/runs/:runId', (req, res) => res.json(getRun(String(req.params.runId))))
harnessRouter.post(
  '/api/harness/runs/:runId/control',
  asyncRoute(async (req, res) => {
    const body = z.object({ action: z.enum(['pause', 'resume', 'cancel']) }).parse(req.body)
    if (body.action === 'resume') {
      void harnessExecutor
        .resume(String(req.params.runId))
        .catch((error) => console.error('Harness resume failed', error))
      res.status(202).json(getRun(String(req.params.runId)))
    } else res.json(harnessExecutor.control(String(req.params.runId), body.action))
  }),
)
harnessRouter.post(
  '/api/harness/runs/:runId/call',
  asyncRoute(async (req, res) => {
    const body = z.object({ tool: z.string(), input: z.unknown() }).parse(req.body)
    res.json(await harnessExecutor.call(String(req.params.runId), body.tool, body.input))
  }),
)
harnessRouter.post('/api/harness/runs/:runId/snapshots', (req, res) =>
  res.status(201).json(snapshotRun(getRun(String(req.params.runId)))),
)
harnessRouter.get('/api/harness/snapshots/:snapshotId/replay', (req, res) =>
  res.json(replaySnapshot(req.params.snapshotId)),
)
harnessRouter.get('/api/harness/runs/:runId/export', (req, res) =>
  res
    .attachment(`harness-${String(req.params.runId)}.jsonl`)
    .type('application/x-ndjson')
    .send(JSON.stringify(exportRun(getRun(String(req.params.runId)))) + '\n'),
)
harnessRouter.use(
  (
    error: Error,
    _req: import('express').Request,
    res: import('express').Response,
    next: import('express').NextFunction,
  ) => {
    if (error instanceof z.ZodError)
      return res.status(400).json({ error: error.message, code: 'INVALID_INPUT', retryable: false })
    if (!(error instanceof ToolError)) return next(error)
    const status =
      error.code === 'NOT_FOUND'
        ? 404
        : ['VERSION_CONFLICT', 'STALE_EVIDENCE', 'IDEMPOTENCY_CONFLICT', 'VERIFICATION_FAILED'].includes(error.code)
          ? 409
          : error.code === 'INVALID_INPUT'
            ? 400
            : 422
    res
      .status(status)
      .json({ error: error.message, code: error.code, retryable: error.retryable, details: error.details })
  },
)
