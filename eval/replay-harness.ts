import fs from 'node:fs'
import path from 'node:path'
import { snapshotSchema } from '../server/harness/schemas.ts'

const source = process.argv[2]
if (!source) throw new Error('Usage: pnpm harness:replay snapshot.json [--resume] [--out directory]')
process.env.NOVELWEAVER_DATA_DIR = ':memory:'
process.env.NOVELWEAVER_OFFLINE = '1'
process.env.AI_API_KEY = ''
process.env.HARNESS_MODEL_ENABLED = '0'
globalThis.fetch = async () => {
  throw new Error('Offline replay blocked network')
}
const snapshot = snapshotSchema.parse(JSON.parse(fs.readFileSync(source, 'utf8')))
const outIndex = process.argv.indexOf('--out')
const out = path.resolve(outIndex < 0 ? '.data/harness-replay' : process.argv[outIndex + 1])
fs.mkdirSync(out, { recursive: true })
let result: unknown = {
  mode: 'recorded_observations',
  run: snapshot.run,
  database: snapshot.database,
  remainingBudget: snapshot.remainingBudget,
  randomState: snapshot.randomState,
}
if (process.argv.includes('--resume')) {
  const { restoreProject, saveRun, exportRun } = await import('../server/harness/store.ts')
  const { Executor } = await import('../server/harness/executor.ts')
  const { createRegistry } = await import('../server/harness/tools.ts')
  const { revisionWorkflow } = await import('../server/harness/workflows.ts')
  const run = snapshot.run as import('../server/harness/protocol.ts').Run
  restoreProject(snapshot.database)
  saveRun(run)
  result = {
    mode: 'isolated_offline_resume',
    record: exportRun(await new Executor(createRegistry(), [revisionWorkflow]).resume(run.id)),
  }
}
fs.writeFileSync(path.join(out, 'replay.json'), JSON.stringify(result, null, 2) + '\n')
console.log(`Replay saved: ${out}`)
