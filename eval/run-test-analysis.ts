import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

// 内部测试接口：给指定项目跑一次完整的模型分析（走生产 analysis job 管线），
// 完成后自动执行设定提取评测。不是产品功能；密钥只存在于 eval/.api-test.local.json
// 与服务进程内存（process-only），与 README 的持久化约定一致。
//
// Usage: tsx eval/run-test-analysis.ts [项目名] [--config extraction配置路径]

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:4300'
const projectName = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '霍比特人'
const defaultConfig = projectName === '霍比特人' ? 'eval/extraction-hobbit.json' : `eval/extraction-${projectName}.json`
const extractionConfig = process.argv.includes('--config') ? process.argv[process.argv.indexOf('--config') + 1] : defaultConfig

interface LocalConfig { baseUrl: string; model: string; apiKey: string }
const localPath = new URL('./.api-test.local.json', import.meta.url)
if (!fs.existsSync(localPath)) {
  console.error(`缺少 ${localPath.pathname}（内部测试密钥文件）。`)
  process.exit(1)
}
const config = JSON.parse(fs.readFileSync(localPath, 'utf8')) as LocalConfig

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(data as { error?: string })?.error || res.statusText}`)
  return data as T
}

// 1. 配置运行时模型（process-only，重启失效，不落库）
const status = await api<{ configured: boolean; model: string; engine: string }>('POST', '/api/model', { baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey })
console.log(`模型已配置：${status.model}（${status.engine}，进程内临时配置）`)

// 2. 找到目标项目
const projects = await api<Array<{ id: string; name: string; chapters: number }>>('GET', '/api/projects')
const project = projects.find((row) => row.name === projectName)
if (!project) { console.error(`找不到项目「${projectName}」`); process.exit(1) }
console.log(`目标项目：${project.name}`)

// 3. 最小连通性验证
try {
  const probe = await api<{ ok: boolean; latencyMs: number; probeType: string }>('POST', '/api/model/probe', {})
  console.log(`连通性验证：ok=${probe.ok} type=${probe.probeType} latency=${probe.latencyMs}ms`)
} catch (error) { console.error('连通性验证失败：', (error as Error).message); process.exit(1) }

// 4. 启动分析任务（生产管线，支持暂停/重试）
const job = await api<{ id: string; status: string }>('POST', `/api/projects/${project.id}/analysis/jobs`, { replaceCandidates: true })
console.log(`分析任务已启动：${job.id}`)

// 5. 轮询直到结束
const startedAt = Date.now()
let lastLine = ''
for (;;) {
  await new Promise((resolve) => setTimeout(resolve, 4000))
  const state = await api<{ status: string; progress: number; message: string; error: string }>('GET', `/api/analysis/jobs/${job.id}`)
  const line = `  [${Math.round((Date.now() - startedAt) / 1000)}s] ${state.progress}% ${state.message}${state.error ? ` | ${state.error}` : ''}`
  if (line !== lastLine) { console.log(line); lastLine = line }
  if (['completed', 'partial', 'failed'].includes(state.status)) {
    console.log(`分析结束：${state.status}`)
    break
  }
}

// 6. 自动跑设定提取评测
const extractionModule = await import('./run-extraction-eval.ts')
if (fs.existsSync(extractionConfig)) {
  const result = extractionModule.runExtractionEval(extractionConfig)
  console.log('\n' + result.report)
} else {
  console.log(`\n（未找到 ${extractionConfig}，跳过提取评测）`)
}
