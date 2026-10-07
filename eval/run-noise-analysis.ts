import fs from 'node:fs'
import { formatReportMarkdown, loadGolden, resolveProject, runRetrievalEval } from './retrieval-core.ts'
import { sql } from '../server/db.ts'
import { expandedTerms, searchMemory } from '../server/memory.ts'

// Usage: tsx eval/run-noise-analysis.ts [projectName]
// 对每条金标准查询逐块分析 Top-8 中"疑似噪声"的构成：
// 每个噪声块按其命中的查询词分类——仅命中 ≤2 字泛化词（bigram-only）、
// 命中 ≥3 字实词（partial-overlap）、或与期望子串同块但被裁剪口径判噪（annotation-gap）。
// 结论用于决定降噪手段：打分加权（IDF / 长片段奖励）还是清理语料。

const projectName = process.argv[2] || '首无'
const goldenPath = `eval/golden/${projectName}.jsonl`
if (!fs.existsSync(goldenPath)) {
  console.error(`金标准文件不存在：${goldenPath}`)
  process.exit(1)
}

const report = await runRetrievalEval(projectName, goldenPath)
const project = resolveProject(projectName)
const golden = loadGolden(goldenPath)
const chunkCount = sql.get<{ n: number }>('SELECT COUNT(*) n FROM memory_chunks WHERE project_id = ?', project.id)?.n ?? 0

interface NoiseRow {
  query: string
  category: string
  rank: number
  sourceType: string
  score: number
  reason: string
  summary: string
  matchedTerms: string[]
  noiseClass: 'co-occurrence-gap' | 'bigram-only' | 'partial-overlap' | 'other'
}

const rows: NoiseRow[] = []
for (const entry of golden) {
  const hits = await searchMemory(project.id, entry.query, 16)
  const { terms } = expandedTerms(project.id, entry.query)
  const needles = [...(entry.expectAll ?? []), ...(entry.expectAny ?? [])]
  for (let index = 0; index < Math.min(8, hits.length); index += 1) {
    const hit = hits[index]
    const haystack = `${hit.summary} ${hit.keywords} ${hit.content}`.toLowerCase()
    // 官方口径判噪：expectAll 需全部子串同块共现，expectAny 需任一子串出现；
    // 空数组 .every() 是空真，必须先判长度，否则全部误判为相关
    const expectAllHit = (entry.expectAll?.length ?? 0) > 0 && entry.expectAll!.every((needle) => haystack.includes(needle.toLowerCase()))
    const expectAnyHit = (entry.expectAny?.length ?? 0) > 0 && entry.expectAny!.some((needle) => haystack.includes(needle.toLowerCase()))
    if (expectAllHit || expectAnyHit) continue
    const matchedTerms = terms.filter((term) => term.length > 1 && haystack.includes(term.toLowerCase()))
    const presentNames = (entry.expectAll ?? []).filter((needle) => haystack.includes(needle.toLowerCase()))
    const noiseClass: NoiseRow['noiseClass'] =
      presentNames.length > 0 ? 'co-occurrence-gap'
      : matchedTerms.length > 0 && matchedTerms.every((term) => term.length <= 2) ? 'bigram-only'
      : matchedTerms.some((term) => term.length >= 3) ? 'partial-overlap'
      : 'other'
    rows.push({
      query: entry.query,
      category: entry.category || 'general',
      rank: index + 1,
      sourceType: hit.sourceType,
      score: hit.score,
      reason: hit.reason || '',
      summary: hit.summary.slice(0, 50),
      matchedTerms,
      noiseClass,
    })
  }
}

const byClass = {
  cooccurrence: rows.filter((row) => row.noiseClass === 'co-occurrence-gap'),
  bigramOnly: rows.filter((row) => row.noiseClass === 'bigram-only'),
  partialOverlap: rows.filter((row) => row.noiseClass === 'partial-overlap'),
  other: rows.filter((row) => row.noiseClass === 'other'),
}

const termDf = new Map<string, number>()
const topTerms = new Map<string, number>()
for (const row of rows) {
  for (const term of row.matchedTerms) {
    topTerms.set(term, (topTerms.get(term) || 0) + 1)
  }
}
for (const term of topTerms.keys()) {
  const like = `%${term}%`
  const df = sql.get<{ n: number }>('SELECT COUNT(*) n FROM memory_chunks WHERE project_id = ? AND (content LIKE ? OR summary LIKE ? OR keywords LIKE ?)', project.id, like, like, like)?.n ?? 0
  termDf.set(term, df)
}

const lines = [
  `# 噪声构成分析 · ${projectName}`,
  '',
  `- 语料：${chunkCount} 个记忆块 · 查询：${report.queryCount} 条 · Top-8 噪声总数：${rows.length}`,
  `- 总噪声率：${(report.metrics.noiseRatioTop8 * 100).toFixed(1)}%`,
  '',
  '## 按命中词形态分类',
  '',
  `> 口径说明：**真噪声** = 与查询主题无关的块（泛化二字词、部分重叠、其他）；**弱相关** = 单实体挤占（含查询实体之一，只是不满足共现口径）——它仍是生成时的有效上下文。重排器只值得追"真噪声"。`,
  '',
  `| 类别 | 数量 | 占噪声比 | 说明 |`,
  `|---|---:|---:|---|`,
  `| 单实体挤占（co-occurrence-gap） | ${byClass.cooccurrence.length} | ${((byClass.cooccurrence.length / (rows.length || 1)) * 100).toFixed(0)}% | 含期望实体之一但缺共现，挤占双实体证据块 |`,
  `| 仅命中 ≤2 字泛化词（bigram-only） | ${byClass.bigramOnly.length} | ${((byClass.bigramOnly.length / (rows.length || 1)) * 100).toFixed(0)}% | 打分被高频二字组合抬进 Top-8，与查询主题无关 |`,
  `| 命中 ≥3 字实词（partial-overlap） | ${byClass.partialOverlap.length} | ${((byClass.partialOverlap.length / (rows.length || 1)) * 100).toFixed(0)}% | 有主题关联但未含期望子串 |`,
  `| 其他（无实词命中） | ${byClass.other.length} | ${((byClass.other.length / (rows.length || 1)) * 100).toFixed(0)}% | 通常来自向量召回或 LIKE 兜底 |`,
  '',
  `- 表面噪声率（子串口径）：${(report.metrics.noiseRatioTop8 * 100).toFixed(1)}%`,
  `- **真噪声率**（真噪声块 / 全部 Top-8 槽位）：${(((byClass.bigramOnly.length + byClass.partialOverlap.length + byClass.other.length) / (report.queryCount * 8)) * 100).toFixed(1)}%`,
  `- **有效上下文率**（1 - 真噪声率）：${(100 - ((byClass.bigramOnly.length + byClass.partialOverlap.length + byClass.other.length) / (report.queryCount * 8)) * 100).toFixed(1)}%`,
  '',
  '## 高频噪声词（在噪声块中出现的匹配词，附全库文档频率）',
  '',
  `| 词 | 在噪声块中出现次数 | 全库块频率 DF | DF/语料 |`,
  `|---|---:|---:|---:|`,
  ...[...topTerms.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([term, count]) => {
    const df = termDf.get(term) || 0
    return `| ${term} | ${count} | ${df} | ${(df / (chunkCount || 1)).toFixed(2)} |`
  }),
  '',
  '## 噪声明细',
  '',
  `| 类别 | 查询 | 排名 | 来源 | 分数 | 命中词 | 摘要 |`,
  `|---|---|---:|---|---:|---|---|`,
  ...rows.map((row) => `| ${row.noiseClass} | ${row.query} | ${row.rank} | ${row.sourceType} | ${row.score} | ${row.matchedTerms.slice(0, 6).join('、') || '—'} | ${row.summary.replace(/\|/g, '/')} |`),
]

const outPath = `eval/reports/noise-analysis-${projectName}-2026-10-07.md`
fs.writeFileSync(outPath, lines.join('\n'))
console.log(`报告已写入 ${outPath}`)
console.log('')
console.log(formatReportMarkdown(report))
console.log('')
console.log(`co-occurrence-gap: ${byClass.cooccurrence.length} / bigram-only: ${byClass.bigramOnly.length} / partial-overlap: ${byClass.partialOverlap.length} / other: ${byClass.other.length}`)
console.log('Top 噪声词 DF:', [...topTerms.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([term, count]) => `${term}(x${count},df=${termDf.get(term)})`).join(' '))
