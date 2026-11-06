import { Router } from 'express'
import { z } from 'zod'
import { generate, generateStream } from '../ai.ts'
import { asyncRoute, requireProject } from './helpers.ts'
import { taskInputSchema } from '../tasks/contracts.ts'
import { previewTaskContext } from '../tasks/service.ts'

const generateRequestSchema = taskInputSchema

export const generateRouter = Router()

generateRouter.post('/api/ai/context', asyncRoute(async (req, res) => {
  const body = z.object({ projectId: z.string(), prompt: z.string().default(''), chapterId: z.string().optional(), tokenBudget: z.number().int().min(1000).max(50000).optional(), chapterContent: z.string().optional(), chapterOutline: z.string().optional(), scope: z.enum(['upto', 'full']).optional() }).parse(req.body)
  requireProject(body.projectId)
  res.json(await previewTaskContext({ ...req.body, task: req.body.task ?? 'chat', budget: { ...req.body.budget, contextTokens: body.tokenBudget ?? req.body.budget?.contextTokens } }))
}))

generateRouter.post('/api/ai/generate', asyncRoute(async (req, res) => {
  const body = generateRequestSchema.parse(req.body)
  requireProject(body.projectId)
  res.json(await generate(body))
}))

generateRouter.post('/api/ai/generate/stream', asyncRoute(async (req, res) => {
  const body = generateRequestSchema.parse(req.body)
  requireProject(body.projectId)
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()
  try {
    for await (const event of generateStream(body)) {
      res.write(`data: ${JSON.stringify(event)}\n\n`)
    }
  } catch (error) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: (error as Error).message })}\n\n`)
  } finally {
    res.end()
  }
}))
