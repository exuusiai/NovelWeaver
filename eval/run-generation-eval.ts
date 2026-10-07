import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assembleContext } from '../server/memory.ts'
import { aggregateReport, countIncludedEvidence, formatGenerationReport, scoreGeneration, type GenerationCaseResult } from './generation-core.ts'

// 生成质量评测：对固定任务集逐条走生产 /api/ai/generate 管线（真实网关），
// 上下文快照由本进程以同一输入确定性重建（assembleContext 只读，WAL 允许并行读），
// 按引用有效率 / 引用覆盖率 / 数字接地率 / 完整度评分，与基线对比并出报告。
// 不是产品功能；密钥只存在于 eval/.api-test.local.json 与服务进程内存（process-only）。
//
// Usage: tsx eval/run-generation-eval.ts [项目名] [--save-baseline] [--prompts <path>]
// 需要先启动服务：pnpm server（默认 http://127.0.0.1:4300）

const here = path.dirname(fileURLToPath(import.meta.url))
const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:4300'
const args = process.argv.slice(2)
const saveBaseline = args.includes('--save-baseline')
const projectName = args.find((arg, index) => !arg.startsWith('--') && (index === 0 || args[index - 1] !== '--prompts')) || '霍比特人'
const promptsPath = args.includes('--prompts') ? args[args.indexOf('--prompts') + 1] : path.join(here, 'golden', `generation-${projectName}.jsonl`)
const baselinePath = path.join(here, 'baselines', `generation-${projectName}.json`)
const reportPath = path.join(here, 'reports', `generation-${projectName}-${new Date().toISOString().slice(0, 10)}.md`)

interface LocalConfig { baseUrl: string; model: string; apiKey: string }
const localPath = new URL('./.api-test.local.json', import.meta.url)
if (!fs.existsSync(localPath)) {
  console.error(`缺少 ${localPath.pathname}（内部测试密钥文件）。`)
  process.exit(1)
}
const config = JSON.parse(fs.readFileSync(localPath, 'utf8')) as LocalConfig

if (!fs.existsSync(promptsPath)) {
  console.error(`任务金标准不存在：${promptsPath}。为项目编写 eval/golden/generation-${projectName}.jsonl 后再评测。`)
  process.exit(1)
}
const tasks = fs.readFileSync(promptsPath, 'utf8').split('\n').filter((line) => line.trim())
  .map((line) => JSON.parse(line) as { task: string; prompt: string; note?: string })

async function api<T>(method: string, apiPath: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${apiPath}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(data as { error?: string })?.error || res.statusText}`)
  return data as T
}

interface GenerateResponse { generationId: string; output: string; model: string; citations: Array<{ id: string }>; contextReport: { included: Array<{ kind: string; label: string }>; trimmed: Array<{ kind: string; label: string }>; tokenBudget: number; estimatedTokens: number } }

const status = await api<{ configured: boolean; model: string; engine: string }>('POST', '/api/model', { baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey })
console.log(`模型已配置：${status.model}（${status.engine}，进程内临时配置）`)

const projects = await api<Array<{ id: string; name: string }>>('GET', '/api/projects')
const project = projects.find((row) => row.name === projectName)
if (!project) { console.error(`找不到项目「${projectName}」。请先导入语料。`); process.exit(1) }
console.log(`目标项目：${project.name} · 任务 ${tasks.length} 条`)

const results: GenerationCaseResult[] = []
for (const [index, task] of tasks.entries()) {
  const startedAt = Date.now()
  try {
    const assembled = await assembleContext(project.id, task.prompt)
    const response = await api<GenerateResponse>('POST', '/api/ai/generate', { projectId: project.id, task: task.task, prompt: task.prompt })
    const latencyMs = Date.now() - startedAt
    const evidenceIncluded = Math.max(countIncludedEvidence(assembled.report), response.citations.length)
    const score = scoreGeneration(response.output, assembled.text, evidenceIncluded, { expectCitation: task.task === 'analysis' })
    results.push({ task: task.task, prompt: task.prompt, note: task.note, model: response.model, latencyMs, evidenceIncluded, ...score })
    console.log(`  [${index + 1}/${tasks.length}] ${task.note || task.prompt.slice(0, 20)} → 引用 ${score.citationValid}/${score.citationTotal} · 数字 ${score.numberGrounded}/${score.numberTotal} · ${latencyMs}ms`)
  } catch (error) {
    console.error(`  [${index + 1}/${tasks.length}] 失败：${(error as Error).message}`)
    process.exit(1)
  }
}

const report = aggregateReport(project.name, results[0]?.model || status.model, results)
console.log('')
console.log(formatGenerationReport(report))

fs.writeFileSync(reportPath, formatGenerationReport(report))
console.log(`\n报告已写入 ${path.relative(process.cwd(), reportPath)}`)

if (saveBaseline) {
  fs.writeFileSync(baselinePath, JSON.stringify({ savedAt: new Date().toISOString(), model: report.model, metrics: report.metrics }, null, 2))
  console.log(`基线已保存到 ${path.relative(process.cwd(), baselinePath)}`)
} else if (fs.existsSync(baselinePath)) {
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as { metrics: typeof report.metrics }
  console.log('\n--- 与基线对比 ---')
  for (const [key, value] of Object.entries(report.metrics)) {
    const base = baseline.metrics[key as keyof typeof baseline.metrics]
    if (base === null || value === null) { console.log(`${key}: ${value}（基线 ${base}）`); continue }
    const delta = Number((value - base).toFixed(3))
    console.log(`${key}: ${value}（基线 ${base}，Δ${delta >= 0 ? '+' : ''}${delta}）`)
  }
}
