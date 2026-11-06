import fs from 'node:fs'
import { z } from 'zod'
import { taskInputSchema, artifactSchema, TASK_SCHEMA_VERSION } from '../server/tasks/contracts.ts'
import { taskProfiles } from '../server/tasks/profiles.ts'
import { ROUTER_VERSION } from '../server/tasks/resolve.ts'
import { adaptationSchema } from '../server/harness/schemas.ts'
fs.mkdirSync('docs/handoff', { recursive: true })
fs.writeFileSync(
  'docs/handoff/task-profiles.json',
  JSON.stringify(
    { schemaVersion: TASK_SCHEMA_VERSION, routerVersion: ROUTER_VERSION, profiles: taskProfiles },
    null,
    2,
  ) + '\n',
)
fs.writeFileSync(
  'docs/handoff/task-schemas.json',
  JSON.stringify(
    {
      schemaVersion: TASK_SCHEMA_VERSION,
      input: z.toJSONSchema(taskInputSchema),
      resolution: z.toJSONSchema(adaptationSchema),
      artifact: z.toJSONSchema(artifactSchema),
    },
    null,
    2,
  ) + '\n',
)
console.log('Wrote task-profiles.json and task-schemas.json')
