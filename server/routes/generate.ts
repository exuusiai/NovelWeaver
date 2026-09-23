import { Router } from 'express'
import { z } from 'zod'
import { assembleContext } from '../memory.ts'
import { generate, generateStream } from '../ai.ts'
import { asyncRoute, requireProject } from './helpers.ts'

const generateRequestSchema = z.object({ projectId: z.string(), task: z.enum(['chat', 'outline', 'chapter_outline', 'prose', 'setting', 'plot', 'analysis']), prompt: z.string().default(''), chapterId: z.string().optional() })

export const generateRouter = Router()

generateRouter.post('/api/ai/context', asyncRoute(async (req, res) => {
  const body = z.object({ projectId: z.string(), prompt: z.string().default(''), chapterId: z.string().optional(), tokenBudget: z.number().int().min(1000).max(50000).default(10000) }).parse(req.body)
  requireProject(body.projectId)
  const assembled = await assembleContext(body.projectId, body.prompt, body.chapterId, body.tokenBudget)
  res.json({ report: assembled.report, citations: assembled.hits })
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
