import { describe, it } from 'vitest'
import { taskScenarios } from '../eval/task-scenarios.ts'
describe('任务适配与状态链路离线验收', () => {
  for (const scenario of taskScenarios) it(`${scenario.id} ${scenario.name}`, scenario.run)
})
