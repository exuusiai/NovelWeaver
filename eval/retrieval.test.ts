import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { baselinePathFor, resolveProject, runRetrievalEval } from './retrieval-core.ts'

const TOLERANCE = 0.02

// Gates: the seed project is always required (deterministic seed data); real-corpus
// gates activate when both the project and its golden file exist on this machine.
const gates = [
  { project: '雾港纪事', required: true },
  { project: '首无', required: false },
]

describe('检索质量回归门', () => {
  for (const gate of gates) {
    const goldenPath = path.resolve(__dirname, `golden/${gate.project}.jsonl`)
    const available = fs.existsSync(goldenPath) && (() => { try { resolveProject(gate.project); return true } catch { return false } })()

    const run = gate.required || available ? it : it.skip
    run(`[${gate.project}] 金标准全部可解析且项目存在`, async () => {
      const report = await runRetrievalEval(gate.project, goldenPath)
      expect(report.queryCount).toBeGreaterThanOrEqual(10)
      expect(report.results.filter((result) => result.firstRelevantRank === null).length).toBe(0)
    })

    run(`[${gate.project}] 指标不低于锁定基线（容忍 ${TOLERANCE * 100}pp）`, async () => {
      const report = await runRetrievalEval(gate.project, goldenPath)
      const baselinePath = baselinePathFor(gate.project)
      if (!fs.existsSync(baselinePath)) {
        fs.mkdirSync(path.dirname(baselinePath), { recursive: true })
        fs.writeFileSync(baselinePath, JSON.stringify({ savedAt: new Date().toISOString(), metrics: report.metrics }, null, 2))
        console.log(`[${gate.project}] 未发现基线，已用当前指标建立基线：`, report.metrics)
        return
      }
      const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as { metrics: Record<string, number> }
      // recall 与 mrr 越高越好；noiseRatioTop8 越低越好
      for (const key of ['recallAt5', 'recallAt8', 'recallAt16', 'mrr'] as const) {
        expect(report.metrics[key]).toBeGreaterThanOrEqual(baseline.metrics[key] - TOLERANCE)
      }
      expect(report.metrics.noiseRatioTop8).toBeLessThanOrEqual(baseline.metrics.noiseRatioTop8 + TOLERANCE)
    })
  }
})
