import { describe, it } from 'vitest'
const { harnessScenarios } = await import('../eval/harness-scenarios.ts')
describe('Harness 合成离线验收', () => {
  for (const scenario of harnessScenarios) it(`${scenario.id} ${scenario.name}`, scenario.run)
})
