import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
process.env.NOVELWEAVER_DATA_DIR = ':memory:'
process.env.HARNESS_MODEL_ENABLED = '0'
process.env.AI_API_KEY = ''
const { createRegistry } = await import('../server/harness/tools.ts')
const { runSchema, observationSchema, snapshotSchema, exportSchema } = await import('../server/harness/schemas.ts')
const target = path.resolve(process.argv[2] || 'docs/handoff/harness-schemas.json')
const schema = {
  schemaVersion: 'novelweaver.harness.v1',
  tools: createRegistry().catalog(),
  observation: z.toJSONSchema(observationSchema),
  run: z.toJSONSchema(runSchema),
  snapshot: z.toJSONSchema(snapshotSchema),
  jsonlRecord: z.toJSONSchema(exportSchema),
}
fs.mkdirSync(path.dirname(target), { recursive: true })
fs.writeFileSync(target, JSON.stringify(schema, null, 2) + '\n')
console.log(target)
