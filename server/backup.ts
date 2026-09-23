import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from './db.ts'
import { buildProjectExport } from './project-export.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
export const backupDir = path.join(process.env.NOVELWEAVER_DATA_DIR && process.env.NOVELWEAVER_DATA_DIR !== ':memory:' ? process.env.NOVELWEAVER_DATA_DIR : path.join(root, '.data'), 'backups')
const KEEP_PER_PROJECT = 10

// Full-project JSON snapshot — same payload as the export route. Returns the written file path.
export function backupProject(projectId: string): string {
  const payload = buildProjectExport(projectId)
  fs.mkdirSync(backupDir, { recursive: true })
  const file = path.join(backupDir, `${projectId}.${Date.now()}.json`)
  fs.writeFileSync(file, JSON.stringify(payload))
  pruneBackups(projectId)
  return file
}

export function listBackups(projectId: string): Array<{ file: string; size: number; createdAt: string }> {
  if (!fs.existsSync(backupDir)) return []
  return fs.readdirSync(backupDir)
    .filter((name) => name.startsWith(`${projectId}.`) && name.endsWith('.json'))
    .sort((left, right) => right.localeCompare(left))
    .map((name) => {
      const full = path.join(backupDir, name)
      return { file: name, size: fs.statSync(full).size, createdAt: fs.statSync(full).mtime.toISOString() }
    })
}

export function backupPath(projectId: string, file: string): string | null {
  const name = path.basename(file)
  if (!name.startsWith(`${projectId}.`) || !name.endsWith('.json')) return null
  const full = path.join(backupDir, name)
  return fs.existsSync(full) ? full : null
}

function pruneBackups(projectId: string) {
  const files = listBackups(projectId).slice(KEEP_PER_PROJECT).map((item) => item.file)
  files.forEach((name) => fs.rmSync(path.join(backupDir, name), { force: true }))
}

export function runBackups() {
  const projects = sql.all<{ id: string }>('SELECT id FROM projects')
  const written: string[] = []
  for (const project of projects) {
    try { written.push(backupProject(project.id)) } catch (error) { console.error(`backup failed for ${project.id}:`, (error as Error).message) }
  }
  return written
}

export function startBackupScheduler() {
  if (process.env.NOVELWEAVER_DATA_DIR === ':memory:') return
  runBackups()
  setInterval(runBackups, 12 * 60 * 60 * 1000).unref()
}
