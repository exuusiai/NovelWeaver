import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from '../server/db.ts'
import { searchMemory } from '../server/memory.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
export const GOLDEN_DIR = path.join(here, 'golden')
export const BASELINE_DIR = path.join(here, 'baselines')

export interface GoldenQuery {
  query: string
  // relevant if ANY substring matches (weakest), or ALL substrings co-occur in one chunk
  // (strongest — used for relation queries where two names must appear together)
  expectAny?: string[]
  expectAll?: string[]
  category?: string
  note?: string
}

export interface QueryResult extends GoldenQuery {
  firstRelevantRank: number | null
  noiseInTop8: number
  topPreview: string
}

export interface RetrievalReport {
  projectName: string
  goldenPath: string
  queryCount: number
  metrics: {
    recallAt5: number
    recallAt8: number
    recallAt16: number
    mrr: number
    noiseRatioTop8: number
  }
  categoryMetrics: Record<string, { queries: number; recallAt8: number }>
  results: QueryResult[]
}

export function loadGolden(goldenPath: string): GoldenQuery[] {
  return fs.readFileSync(goldenPath, 'utf8').split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as GoldenQuery)
}

export function resolveProject(name: string): { id: string; name: string } {
  const row = sql.get<{ id: string; name: string }>('SELECT id, name FROM projects WHERE name = ? ORDER BY created_at LIMIT 1', name)
  if (!row) throw new Error(`找不到项目「${name}」。请确认项目已创建或导入。`)
  return row
}

function isRelevant(hit: { summary: string; keywords: string; content: string }, query: GoldenQuery) {
  const haystack = `${hit.summary} ${hit.keywords} ${hit.content}`
  if (query.expectAll?.length) return query.expectAll.every((needle) => haystack.includes(needle))
  return (query.expectAny ?? []).some((needle) => haystack.includes(needle))
}

export async function runRetrievalEval(projectName: string, goldenPath: string, limit = 16): Promise<RetrievalReport> {
  const project = resolveProject(projectName)
  const golden = loadGolden(goldenPath)
  const results: QueryResult[] = await Promise.all(golden.map(async (entry) => {
    const hits = await searchMemory(project.id, entry.query, limit)
    const rank = hits.findIndex((hit) => isRelevant(hit, entry))
    const noiseInTop8 = hits.slice(0, 8).filter((hit) => !isRelevant(hit, entry)).length
    const relevant = rank >= 0 ? hits[rank] : null
    return {
      ...entry,
      firstRelevantRank: rank >= 0 ? rank + 1 : null,
      noiseInTop8,
      topPreview: (relevant?.summary || hits[0]?.summary || '').slice(0, 40),
    }
  }))
  const total = results.length || 1
  const rankOf = (result: QueryResult) => result.firstRelevantRank ?? Number.POSITIVE_INFINITY
  const shareBelow = (k: number) => results.filter((result) => rankOf(result) <= k).length / total
  const categories: Record<string, QueryResult[]> = {}
  for (const result of results) {
    const key = result.category || 'general'
    ;(categories[key] ??= []).push(result)
  }
  const categoryMetrics: RetrievalReport['categoryMetrics'] = {}
  for (const [key, items] of Object.entries(categories)) {
    categoryMetrics[key] = {
      queries: items.length,
      recallAt8: items.filter((result) => rankOf(result) <= 8).length / items.length,
    }
  }
  return {
    projectName: project.name,
    goldenPath,
    queryCount: results.length,
    metrics: {
      recallAt5: shareBelow(5),
      recallAt8: shareBelow(8),
      recallAt16: shareBelow(16),
      mrr: Number((results.reduce((sum, result) => sum + (result.firstRelevantRank ? 1 / result.firstRelevantRank : 0), 0) / total).toFixed(3)),
      noiseRatioTop8: Number((results.reduce((sum, result) => sum + result.noiseInTop8, 0) / (total * 8)).toFixed(3)),
    },
    categoryMetrics,
    results,
  }
}

export function formatReportMarkdown(report: RetrievalReport): string {
  const lines = [
    `# 检索评测报告 · ${report.projectName}`,
    '',
    `- 金标准：${report.goldenPath.replace(/^.*eval\//, 'eval/')}（${report.queryCount} 条查询）`,
    `- Recall@5 / @8 / @16：${(report.metrics.recallAt5 * 100).toFixed(0)}% / ${(report.metrics.recallAt8 * 100).toFixed(0)}% / ${(report.metrics.recallAt16 * 100).toFixed(0)}%`,
    `- MRR：${report.metrics.mrr} · Top-8 疑似噪声率：${(report.metrics.noiseRatioTop8 * 100).toFixed(0)}%`,
    '',
    ...Object.entries(report.categoryMetrics).map(([key, value]) =>
      `  - ${key}：${value.queries} 条，Recall@8 ${(value.recallAt8 * 100).toFixed(0)}%`),
    '',
    '| 类别 | 查询 | 首个相关排名 | Top-8 噪声 | 命中摘要 |',
    '|---|---|---|---|---|',
    ...report.results.map((result) => `| ${result.category || 'general'} | ${result.query} | ${result.firstRelevantRank ?? '未命中'} | ${result.noiseInTop8}/8 | ${result.topPreview || '—'} |`),
  ]
  return lines.join('\n')
}

export function baselinePathFor(projectName: string) {
  return path.join(BASELINE_DIR, `retrieval-${projectName}.json`)
}
