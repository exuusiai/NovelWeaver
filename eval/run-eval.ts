import fs from 'node:fs'
import { baselinePathFor, formatReportMarkdown, runRetrievalEval } from './retrieval-core.ts'

// Usage: tsx eval/run-eval.ts [projectName] [--golden <path>] [--save-baseline]
// Defaults to the deterministic seed project 雾港纪事.
const args = process.argv.slice(2)
const saveBaseline = args.includes('--save-baseline')
const goldenIndex = args.indexOf('--golden')
const positional = args.find((arg, index) => !arg.startsWith('--') && (goldenIndex < 0 || (index !== goldenIndex && index !== goldenIndex + 1)))
const projectName = positional || '雾港纪事'
const goldenPath = goldenIndex >= 0 ? args[goldenIndex + 1] : `eval/golden/${projectName}.jsonl`
const baselinePath = baselinePathFor(projectName)

if (!fs.existsSync(goldenPath)) {
  console.error(`金标准文件不存在：${goldenPath}。为项目编写 eval/golden/${projectName}.jsonl 后再评测。`)
  process.exit(1)
}

const report = runRetrievalEval(projectName, goldenPath)

if (saveBaseline) {
  fs.writeFileSync(baselinePath, JSON.stringify({ savedAt: new Date().toISOString(), metrics: report.metrics }, null, 2))
  console.log(`基线已保存到 ${baselinePath}`)
}

console.log(formatReportMarkdown(report))
if (fs.existsSync(baselinePath)) {
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as { metrics: typeof report.metrics }
  console.log('\n--- 与基线对比 ---')
  for (const [key, value] of Object.entries(report.metrics)) {
    const base = baseline.metrics[key as keyof typeof baseline.metrics]
    const delta = Number((value - base).toFixed(3))
    console.log(`${key}: ${value}（基线 ${base}，Δ${delta >= 0 ? '+' : ''}${delta}）`)
  }
} else if (!saveBaseline) {
  console.log(`\n还没有基线。运行 pnpm eval:baseline ${projectName === '雾港纪事' ? '' : projectName} 锁定当前指标。`)
}
