import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from '../server/db.ts'
import { searchMemory } from '../server/memory.ts'
import { loadGolden, resolveProject } from './retrieval-core.ts'

// 对照实验：词法混合检索（生产基线） vs 纯向量 vs RRF 融合。
// 同一裁剪标准（金标准 expectAny/expectAll）、同一指标，n=18 真实语料查询。
// Usage: tsx eval/run-retrieval-experiment.ts [projectName] [--fresh]

const here = path.dirname(fileURLToPath(import.meta.url))
const projectName = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '首无'
const goldenFlag = process.argv.indexOf('--golden')
const goldenPath = goldenFlag >= 0 ? process.argv[goldenFlag + 1] : path.join(here, 'golden', `${projectName}.jsonl`)
const fresh = process.argv.includes('--fresh')
const K = 16
const RRF_K = 60
const EMBED_MODEL = 'GLM-Embedding-3'
const EMBED_BATCH = 16

interface LocalConfig { baseUrl: string; model: string; apiKey: string }
const config = JSON.parse(fs.readFileSync(path.join(here, '.api-test.local.json'), 'utf8')) as LocalConfig
const embedBase = config.baseUrl.replace(/\/$/, '')

async function embedBatch(inputs: string[], retry = 1): Promise<number[][]> {
  try {
    const res = await fetch(`${embedBase}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model: EMBED_MODEL, input: inputs }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`)
    const data = await res.json() as { data: Array<{ index: number; embedding: number[] }> }
    const sorted = [...data.data].sort((a, b) => a.index - b.index)
    return sorted.map((item) => item.embedding)
  } catch (error) {
    if (retry > 0) { await new Promise((resolve) => setTimeout(resolve, 1500)); return embedBatch(inputs, retry - 1) }
    throw error
  }
}

const cosine = (a: number[], b: number[]) => {
  let dot = 0; let na = 0; let nb = 0
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

// --- 语料与查询 ---
const project = resolveProject(projectName)
const golden = loadGolden(goldenPath)
const chunks = sql.all<{ id: string; content: string; summary: string; keywords: string; importance: number }>(
  'SELECT id, content, summary, keywords, importance FROM memory_chunks WHERE project_id = ?', project.id)
console.log(`语料：${project.name} · ${chunks.length} 个记忆块 · ${golden.length} 条查询 · Embedding：${EMBED_MODEL}`)

// --- 向量化（带磁盘缓存） ---
const cachePath = path.join(here, `.cache-embeddings-${projectName}.json`)
let cache: Record<string, number[]> = {}
if (!fresh && fs.existsSync(cachePath)) cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
const texts = chunks.map((chunk) => `${chunk.summary} ${chunk.keywords} ${chunk.content}`)
let embedded = 0
const startedAt = Date.now()
for (let offset = 0; offset < texts.length; offset += EMBED_BATCH) {
  const batch = texts.slice(offset, offset + EMBED_BATCH)
  const missing = batch.filter((text) => !cache[text])
  if (missing.length) {
    const vectors = await embedBatch(missing)
    missing.forEach((text, index) => { cache[text] = vectors[index] })
  }
  embedded += batch.length
  process.stdout.write(`\r语料向量化 ${Math.min(embedded, texts.length)}/${texts.length}`)
}
const queryVectors = await embedBatch(golden.map((entry) => entry.query))
console.log(` · 完成，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
fs.mkdirSync(path.dirname(cachePath), { recursive: true })
fs.writeFileSync(cachePath, JSON.stringify(cache))

const chunkVectors = texts.map((text) => cache[text])

// --- 三种检索方法 ---
const lexicalRank = (query: string) => {
  const hits = searchMemory(project.id, query, K)
  const rank = new Map<string, number>()
  hits.forEach((hit, index) => rank.set(hit.id, index + 1))
  return rank
}
const vectorRank = (queryVector: number[]) => {
  const scored = chunkVectors.map((vector, index) => ({ index, score: cosine(queryVector, vector) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, K)
  const rank = new Map<string, number>()
  scored.forEach((item, index) => rank.set(chunks[item.index].id, index + 1))
  return rank
}
const rrfFuse = (...rankMaps: Array<Map<string, number>>) => {
  const fused = new Map<string, number>()
  for (const rank of rankMaps) {
    for (const [id, position] of rank) fused.set(id, (fused.get(id) || 0) + 1 / (RRF_K + position))
  }
  return fused
}

const haystackOf = (chunk: { content: string; summary: string; keywords: string }) => `${chunk.summary} ${chunk.keywords} ${chunk.content}`
const isRelevant = (chunk: { content: string; summary: string; keywords: string }, entry: { expectAny?: string[]; expectAll?: string[] }) => {
  const haystack = haystackOf(chunk)
  if (entry.expectAll?.length) return entry.expectAll.every((needle) => haystack.includes(needle))
  return (entry.expectAny ?? []).some((needle) => haystack.includes(needle))
}

interface MethodResult { recallAt5: number; recallAt8: number; recallAt16: number; mrr: number; noiseRatioTop8: number }
const evaluate = (ranks: Array<Map<string, number>>) => {
  const rows = golden.map((entry, index) => {
    const rank = ranks[index]
    const ordered = [...rank.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => chunks.find((chunk) => chunk.id === id)!).filter(Boolean)
    const first = ordered.findIndex((chunk) => isRelevant(chunk, entry))
    const noise = ordered.slice(0, 8).filter((chunk) => !isRelevant(chunk, entry)).length
    return { firstRank: first >= 0 ? first + 1 : null, noise }
  })
  const total = rows.length || 1
  const below = (k: number) => rows.filter((row) => (row.firstRank ?? Infinity) <= k).length / total
  return {
    recallAt5: below(5), recallAt8: below(8), recallAt16: below(16),
    mrr: Number((rows.reduce((sum, row) => sum + (row.firstRank ? 1 / row.firstRank : 0), 0) / total).toFixed(3)),
    noiseRatioTop8: Number((rows.reduce((sum, row) => sum + row.noise, 0) / (total * 8)).toFixed(3)),
  } satisfies MethodResult
}

const methods: Record<string, Array<Map<string, number>>> = { 'A 词法混合（生产基线）': [], 'B 纯向量': [], 'C RRF 融合（词法+向量）': [] }
const perQueryRanks: Record<string, Array<number | null>> = { 'A 词法混合（生产基线）': [], 'B 纯向量': [], 'C RRF 融合（词法+向量）': [] }
const searchTiming: Record<string, number> = { 'A 词法混合（生产基线）': 0, 'B 纯向量': 0, 'C RRF 融合（词法+向量）': 0 }

for (let index = 0; index < golden.length; index += 1) {
  const entry = golden[index]
  let t0 = performance.now(); const lex = lexicalRank(entry.query); searchTiming['A 词法混合（生产基线）'] += performance.now() - t0
  t0 = performance.now(); const vec = vectorRank(queryVectors[index]); searchTiming['B 纯向量'] += performance.now() - t0
  t0 = performance.now(); const fused = rrfFuse(lex, vec); searchTiming['C RRF 融合（词法+向量）'] += performance.now() - t0
  methods['A 词法混合（生产基线）'].push(lex)
  methods['B 纯向量'].push(vec)
  methods['C RRF 融合（词法+向量）'].push(fused)
  const firstOf = (rank: Map<string, number>) => {
    const ordered = [...rank.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => chunks.find((chunk) => chunk.id === id)!).filter(Boolean)
    const found = ordered.findIndex((chunk) => isRelevant(chunk, entry))
    return found >= 0 ? found + 1 : null
  }
  perQueryRanks['A 词法混合（生产基线）'].push(firstOf(lex))
  perQueryRanks['B 纯向量'].push(firstOf(vec))
  perQueryRanks['C RRF 融合（词法+向量）'].push(firstOf(fused))
}

const results = Object.fromEntries(Object.entries(methods).map(([name, ranks]) => [name, evaluate(ranks)])) as Record<string, MethodResult>
const baseline = results['A 词法混合（生产基线）']

const lines: string[] = [
  `# 检索对照实验 · ${project.name}`,
  '',
  `- 语料：${chunks.length} 个记忆块 · 查询：${golden.length} 条金标准 · 裁剪标准一致（expectAll/expectAny 子串）`,
  `- 向量：${EMBED_MODEL} · RRF k=${RRF_K} · 对照方法：A 生产词法基线 / B 纯向量 / C RRF 融合`,
  `- 说明：n=${golden.length} 为小样本，差值在 ±1 次命中内视为持平；向量方法可能召回"语义相关但不含期望子串"的片段，被同一子串裁剪计为噪声，对向量方法偏保守。`,
  '',
  '| 方法 | Recall@5 | Recall@8 | Recall@16 | MRR | Top-8 噪声率 | 平均检索耗时 |',
  '|---|---|---|---|---|---|---|',
  ...Object.entries(results).map(([name, metrics]) => {
    const avg = (searchTiming[name] / golden.length).toFixed(2)
    const d = (key: keyof MethodResult) => {
      const delta = Number((metrics[key] - baseline[key]).toFixed(3))
      return name.startsWith('A') ? '' : `（Δ${delta >= 0 ? '+' : ''}${delta}）`
    }
    return `| ${name} | ${(metrics.recallAt5 * 100).toFixed(0)}%${d('recallAt5')} | ${(metrics.recallAt8 * 100).toFixed(0)}%${d('recallAt8')} | ${(metrics.recallAt16 * 100).toFixed(0)}%${d('recallAt16')} | ${metrics.mrr}${d('mrr')} | ${(metrics.noiseRatioTop8 * 100).toFixed(1)}%${d('noiseRatioTop8')} | ${avg}ms |`
  }),
  '',
  '## 逐查询首命中排名',
  '',
  '| 查询 | 类别 | A 词法 | B 向量 | C 融合 |',
  '|---|---|---|---|---|',
  ...golden.map((entry, index) => `| ${entry.query} | ${entry.category || 'general'} | ${perQueryRanks['A 词法混合（生产基线）'][index] ?? '—'} | ${perQueryRanks['B 纯向量'][index] ?? '—'} | ${perQueryRanks['C RRF 融合（词法+向量）'][index] ?? '—'} |`),
]

const report = lines.join('\n')
console.log('\n' + report)
const reportsDir = path.join(here, 'reports')
fs.mkdirSync(reportsDir, { recursive: true })
const reportPath = path.join(reportsDir, `retrieval-experiment-${projectName}-${new Date().toISOString().slice(0, 10)}.md`)
fs.writeFileSync(reportPath, report + '\n')
console.log(`\n报告已保存：${reportPath}`)
