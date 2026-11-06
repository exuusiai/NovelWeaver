import fs from 'node:fs'
import path from 'node:path'
process.env.NOVELWEAVER_DATA_DIR = ':memory:'
process.env.NOVELWEAVER_OFFLINE = '1'
process.env.HARNESS_MODEL_ENABLED = '0'
process.env.AI_API_KEY = ''
process.env.AI_EMBEDDING_MODEL = ''
globalThis.fetch = async () => {
  throw new Error('Task acceptance blocked external network')
}
const { taskScenarios, exportRun } = await import('./task-scenarios.ts')
const results = [],
  trajectories = []
for (const scenario of taskScenarios) {
  try {
    const run = await scenario.run()
    results.push({ id: scenario.id, name: scenario.name, status: 'pass' })
    if (run) trajectories.push(exportRun(run))
  } catch (error) {
    results.push({
      id: scenario.id,
      name: scenario.name,
      status: 'fail',
      error: (error as Error).message,
    })
  }
}
const report = {
  schemaVersion: 'novelweaver.tasks.eval.v1',
  sourceFamilies: ['synthetic-foglamp-01'],
  split: 'test',
  dataOrigin: 'synthetic',
  paidApiCalls: 0,
  trainingStarted: false,
  semanticSupport: 'fixed synthetic fixtures; real model validation pending',
  passed: results.filter((r) => r.status === 'pass').length,
  failed: results.filter((r) => r.status === 'fail').length,
  results,
}
const out = path.resolve(process.argv[2] ?? '.data/task-eval')
fs.mkdirSync(out, { recursive: true })
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n')
fs.writeFileSync(
  path.join(out, 'trajectories.jsonl'),
  trajectories.map((t) => JSON.stringify(t)).join('\n') + '\n',
)
console.log(JSON.stringify(report, null, 2))
if (report.failed) process.exitCode = 1
