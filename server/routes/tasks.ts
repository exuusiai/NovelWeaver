import { Router } from 'express'
import { taskExecutor } from '../tasks/service.ts'
import { taskProfiles } from '../tasks/profiles.ts'
import { taskInputSchema } from '../tasks/contracts.ts'
import { getRun, exportRun, snapshotRun } from '../harness/store.ts'
import { asyncRoute } from './helpers.ts'
import { z } from 'zod'
import { ToolError } from '../harness/protocol.ts'

export const tasksRouter = Router()
tasksRouter.get('/api/tasks/profiles', (_req, res) => res.json(taskProfiles))
tasksRouter.get('/api/tasks/capabilities', (_req, res) =>
  res.json({ ...taskExecutor.registry.capabilities(), tool_policy: false }),
)
tasksRouter.post('/api/tasks/resolve', (req, res) =>
  res.json(taskExecutor.resolve(taskInputSchema.parse(req.body))),
)
tasksRouter.post('/api/tasks/runs', (req, res) => {
  const body = taskInputSchema.parse(req.body)
  const run = taskExecutor.create({ ...body, operation: body.operation })
  void taskExecutor.resume(run.id).catch((error) => console.error('Task execution failed', error))
  res.status(202).json(run)
})
tasksRouter.get('/api/tasks/runs/:id', (req, res) => res.json(getRun(String(req.params.id))))
tasksRouter.get('/api/tasks/runs/:id/observe', (req, res) =>
  res.json(taskExecutor.observe(String(req.params.id))),
)
tasksRouter.post(
  '/api/tasks/runs/:id/step',
  asyncRoute(async (req, res) => {
    const { z } = await import('zod')
    const body = z.object({ tool: z.string(), input: z.unknown() }).parse(req.body)
    res.json(await taskExecutor.call(String(req.params.id), body.tool, body.input, 'policy'))
  }),
)
tasksRouter.post('/api/tasks/runs/:id/snapshots', (req, res) =>
  res.status(201).json(snapshotRun(getRun(String(req.params.id)))),
)
tasksRouter.get('/api/tasks/runs/:id/export', (req, res) =>
  res
    .attachment(`task-${String(req.params.id)}.jsonl`)
    .type('application/x-ndjson')
    .send(JSON.stringify(exportRun(getRun(String(req.params.id)))) + '\n'),
)
tasksRouter.use(
  (
    error: Error,
    _req: import('express').Request,
    res: import('express').Response,
    next: import('express').NextFunction,
  ) => {
    if (error instanceof z.ZodError)
      return res.status(400).json({ code: 'INVALID_INPUT', error: error.message })
    if (!(error instanceof ToolError)) return next(error)
    res.status(error.code === 'NOT_FOUND' ? 404 : error.code === 'INVALID_INPUT' ? 400 : 409).json({
      code: error.code,
      error: error.message,
      retryable: error.retryable,
    })
  },
)
