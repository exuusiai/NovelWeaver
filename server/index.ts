import express from 'express'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { sql } from './db.ts'
import { startBackupScheduler } from './backup.ts'
import { projectsRouter } from './routes/projects.ts'
import { chaptersRouter } from './routes/chapters.ts'
import { worldRouter } from './routes/world.ts'
import { storyRouter } from './routes/story.ts'
import { ingestRouter } from './routes/ingest.ts'
import { generateRouter } from './routes/generate.ts'
import { statsRouter } from './routes/stats.ts'
import { recoverInterruptedJobs } from './routes/analysis-service.ts'
import { startEmbeddingSweeper } from './embeddings.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const port = Number(process.env.PORT || 4300)

const app = express()
app.use(express.json({ limit: '5mb' }))

app.use(projectsRouter)
app.use(chaptersRouter)
app.use(worldRouter)
app.use(storyRouter)
app.use(ingestRouter)
app.use(generateRouter)
app.use(statsRouter)

recoverInterruptedJobs()
startBackupScheduler()
startEmbeddingSweeper()

const dist = path.join(root, 'dist')
if (fs.existsSync(dist)) {
  app.use(express.static(dist))
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(dist, 'index.html')))
}

app.use((error: Error & { status?: number; issues?: unknown }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error)
  res.status(error.status || 500).json({ error: error.message || '服务器发生未知错误。', details: error.issues })
})

const host = process.env.HOST || '127.0.0.1'
app.listen(port, host, () => console.log(`NovelWeaver server running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port} (${host === '0.0.0.0' ? 'LAN open' : 'loopback only'})`))

export { app }
