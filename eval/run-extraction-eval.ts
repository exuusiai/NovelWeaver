import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { baselinePathFor, resolveProject } from './retrieval-core.ts'
import { sql } from '../server/db.ts'

// Usage: tsx eval/run-extraction-eval.ts [configPath] [--save-baseline]
// Config example: eval/extraction-hobbit.json
export interface ExtractionResult {
  project: string
  splitOk: boolean
  chapterCount: number
  totalChars: number
  emptyChapters: number
  extractedCount: number
  gtTotal: number
  gtRecall: number
  missing: string[]
  extraCount: number
  extraRatio: number | null
  report: string
}

export function runExtractionEval(configPath = 'eval/extraction-hobbit.json'): ExtractionResult {
  interface GroundTruth {
    project: string
    translation?: string
    chapterSplit: { minChapters: number; minTotalChars: number }
    entities: Array<{ name: string; type: string; aliases: string[]; category: string }>
  }
  const normalize = (value: string) => value.toLowerCase().replace(/[·・\s]/g, '')
  const gt = JSON.parse(fs.readFileSync(configPath, 'utf8')) as GroundTruth
  const project = resolveProject(gt.project)

  // --- Chapter split check (deterministic, no model needed) ---
  const chapters = sql.all<{ id: string; title: string; content: string }>('SELECT id, title, content FROM chapters WHERE project_id = ? ORDER BY position', project.id)
  const totalChars = chapters.reduce((sum, chapter) => sum + chapter.content.replace(/\s/g, '').length, 0)
  const emptyChapters = chapters.filter((chapter) => chapter.content.replace(/\s/g, '').length < 4).length
  const splitOk = chapters.length >= gt.chapterSplit.minChapters && totalChars >= gt.chapterSplit.minTotalChars && emptyChapters === 0

  // --- Extraction check (needs model analysis to have run) ---
  const extracted = sql.all<{ type: string; name: string; data: string }>('SELECT type, name, data FROM entities WHERE project_id = ?', project.id)
    .map((row) => {
      let aliases: string[] = []
      try { const data = JSON.parse(row.data); if (Array.isArray(data.aliases)) aliases = data.aliases.map(String) } catch { /* legacy rows */ }
      return { type: row.type, name: row.name, aliases }
    })
  const extractVariants = extracted.map((entity) => [normalize(entity.name), ...entity.aliases.map(normalize)])
  const gtVariants = gt.entities.map((entry) => [normalize(entry.name), ...entry.aliases.map(normalize)])

  // Many-to-many match matrix: one extracted entity (e.g. 袋底洞 aliasing 比尔博的霍比特地洞)
  // may legitimately satisfy multiple GT entries; greedy first-match undercounts recall.
  const matchesGtSet = (gtSet: string[], variants: string[]) => variants.some((variant) => gtSet.some((needle) => needle && (variant.includes(needle) || needle.includes(variant))))
  const matchMatrix = gtVariants.map((gtSet) => extractVariants.map((variants) => matchesGtSet(gtSet, variants)))
  const gtMatchedFlags = matchMatrix.map((row) => row.some(Boolean))
  const gtRecall = gt.entities.length ? gtMatchedFlags.filter(Boolean).length / gt.entities.length : 0
  const extraCount = extractVariants.filter((_, index) => !matchMatrix.some((row) => row[index])).length
  const missing = gt.entities.filter((_, index) => !gtMatchedFlags[index]).map((entry) => `${entry.name}（${entry.category}）`)

  const report = [
    `# 设定提取评测 · ${gt.project}`,
    '',
    `## 章节切分校验（不依赖模型）`,
    `- 章节：${chapters.length}（要求 ≥ ${gt.chapterSplit.minChapters}）`,
    `- 总字数：${totalChars.toLocaleString()}（要求 ≥ ${gt.chapterSplit.minTotalChars.toLocaleString()}）`,
    `- 空章节：${emptyChapters}`,
    `- 结果：${splitOk ? '通过' : '未通过'}`,
    '',
    `## 实体提取对照（${gt.translation || ''}）`,
    extracted.length === 0
      ? '- 该项目还没有实体数据；配置模型 API 并运行分析后本节才有意义。'
      : [
          `- 数据库实体：${extracted.length} 个 · Ground Truth：${gt.entities.length} 条`,
          `- GT 召回率：${(gtRecall * 100).toFixed(0)}%（提取到的期望设定占比）`,
          `- GT 外实体：${extraCount} 个（GT 为不完整清单，仅供参考）`,
          `- 未命中：${missing.length ? missing.join('、') : '无'}`,
        ].join('\n'),
  ].join('\n')

  return {
    project: gt.project, splitOk, chapterCount: chapters.length, totalChars, emptyChapters,
    extractedCount: extracted.length, gtTotal: gt.entities.length,
    gtRecall: Number(gtRecall.toFixed(3)), missing, extraCount,
    extraRatio: extracted.length ? Number((extraCount / extracted.length).toFixed(3)) : null,
    report,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runExtractionEval(process.argv.find((arg) => arg.endsWith('.json')) || 'eval/extraction-hobbit.json')
  console.log(result.report)
  if (process.argv.includes('--save-baseline')) {
    const baselinePath = baselinePathFor(`extraction-${result.project}`)
    fs.writeFileSync(baselinePath, JSON.stringify({ savedAt: new Date().toISOString(), splitOk: result.splitOk, chapterCount: result.chapterCount, extractedCount: result.extractedCount, gtRecall: result.gtRecall, extraCount: result.extraCount }, null, 2))
    console.log(`\n基线已保存到 ${baselinePath}`)
  }
}
