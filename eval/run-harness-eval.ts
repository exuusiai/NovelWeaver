import fs from 'node:fs'
import path from 'node:path'
process.env.NOVELWEAVER_DATA_DIR = ':memory:'
process.env.NOVELWEAVER_OFFLINE = '1'
process.env.HARNESS_MODEL_ENABLED = '0'
process.env.AI_API_KEY = ''
process.env.AI_EMBEDDING_MODEL = ''
// The evaluator has no network dependencies, even when a local .env contains credentials.
globalThis.fetch = async () => {
  throw new Error('Harness offline evaluation blocked network')
}
const { harnessScenarios } = await import('./harness-scenarios.ts')
const { exportRun } = await import('../server/harness/store.ts')
const output = path.resolve(process.argv[2] || '.data/harness-eval')
fs.mkdirSync(output, { recursive: true })
const results = []
const trajectories = []
for (const scenario of harnessScenarios) {
  try {
    const run = await scenario.run()
    results.push({ id: scenario.id, name: scenario.name, status: 'pass' })
    if (run) trajectories.push(exportRun(run))
  } catch (error) {
    results.push({ id: scenario.id, name: scenario.name, status: 'fail', error: (error as Error).message })
  }
}
const report = {
  schemaVersion: 'novelweaver.harness.eval.v1',
  dataOrigin: 'synthetic',
  sourceFamilies: ['synthetic-foglamp-01'],
  split: 'test',
  paidApiCalls: 0,
  passed: results.filter((r) => r.status === 'pass').length,
  failed: results.filter((r) => r.status === 'fail').length,
  dimensions: {
    citationFormat: 'program checks',
    semanticSupport: 'deterministic mock with fixed text pairs',
    creativeQuality: 'author evaluation only; real model evaluation pending',
  },
  results,
}
fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
fs.writeFileSync(path.join(output, 'trajectories.jsonl'), trajectories.map((t) => JSON.stringify(t)).join('\n') + '\n')
console.log(JSON.stringify(report, null, 2))
console.log(`Artifacts: ${output}`)
if (report.failed) process.exitCode = 1
