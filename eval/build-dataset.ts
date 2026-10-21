import fs from 'node:fs'
import path from 'node:path'
import { sql } from '../server/db.ts'
import { getModelStatus, setRuntimeConfig, structuredCompletion } from '../server/ai.ts'
import { parseModelJson } from '../server/analyzer.ts'

// 大纲提取流水线：从成品小说构建「单章大纲→正文」训练数据集。
//
// Usage: tsx eval/build-dataset.ts [项目名] [--output <path>] [--max-chapters N] [--skip-quality]
//   需要先启动服务并配置模型（eval/.api-test.local.json），或通过环境变量。
//
// 输出：JSONL，每行一个 {input: {chapter_outline, context}, output, extraction_metadata}

const here = path.dirname(new URL(import.meta.url).pathname)
const args = process.argv.slice(2)
const projectName = args.find((arg, index) => !arg.startsWith('--') && (index === 0 || args[index - 1] !== '--output')) || '三体'
const outputArg = args.includes('--output') ? args[args.indexOf('--output') + 1] : `eval/datasets/${projectName}-dataset.jsonl`
const maxChapters = args.includes('--max-chapters') ? Number(args[args.indexOf('--max-chapters') + 1]) : Infinity
const skipQuality = args.includes('--skip-quality')

// ---- 配置模型 ----
interface LocalConfig { baseUrl: string; model: string; apiKey: string }
const localPath = new URL('./.api-test.local.json', import.meta.url)
if (fs.existsSync(localPath)) {
  const config = JSON.parse(fs.readFileSync(localPath, 'utf8')) as LocalConfig
  setRuntimeConfig({ baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey })
  console.log(`模型已配置：${config.model}`)
}
if (!getModelStatus().configured) {
  console.error('未配置模型 API。请提供 eval/.api-test.local.json 或设置环境变量。')
  process.exit(1)
}

// ---- 数据库查询 ----
const project = sql.get<{ id: string; name: string; genre: string; premise: string }>(
  'SELECT id, name, genre, premise FROM projects WHERE name = ?', projectName)
if (!project) {
  console.error(`找不到项目「${projectName}」。可用项目：${sql.all('SELECT name FROM projects').map((row) => row.name).join(', ')}`)
  process.exit(1)
}

const chapters = sql.all<{ id: string; title: string; content: string; position: number }>(
  'SELECT id, title, content, position FROM chapters WHERE project_id = ? AND LENGTH(TRIM(content)) > 500 ORDER BY position',
  project.id,
).slice(0, maxChapters)

console.log(`项目：${project.name}（${project.genre}）· 有效章节：${chapters.length} 章`)
console.log(`输出：${outputArg}`)
console.log(`质量校验：${skipQuality ? '跳过' : '启用'}\n`)

// ---- 提示词 ----
const summarySystem = `你是小说编辑。用简洁的语言概括章节核心情节。`
const summaryPrompt = (text: string) =>
  `用不超过 80 字概括以下章节的核心情节（谁做了什么、结果如何）。不要描写细节，只写情节推进。\n\n${text.slice(0, 6000)}`

const extractSystem = `你是一个小说编辑。你的任务是阅读一章完整的小说正文，写出作者在写这章之前可能拟好的细纲。细纲是给作者自己看的备忘，不是给读者的摘要。

关键原则：
1. 只写"发生了什么、谁做的、结果如何"——不写具体的句子、对话、描写细节
2. 按场景分段，每个场景用 2-3 句话概括（目标→阻力→转折）
3. 标注视角人物和需要承接的前文事实
4. 大纲字数控制在正文的 3-8%
5. 不要复制原文中的句子或短语——用自己的话重新表述

只输出细纲文本，不要 JSON、不要 Markdown 标记、不要解释。`

const extractPrompt = (text: string, previousSummary: string) =>
  `请阅读以下章节正文，生成作者视角的写作细纲。

输出格式（纯文本）：

视角：[POV 人物名]
承接：[需承接的前文事实，一句话]

场景一：[2-3 句话概括]
场景二：[2-3 句话概括]
……

预计字数：[目标字数]

——

正文：
${text.slice(0, 12000)}

前一章摘要（供参考，不要在大纲中重复）：
${previousSummary || '（本章为第一章，无前文）'}`

const qualitySystem = `你是一个严格的编辑。评估大纲是否达到了"作者写作前的细纲"标准。只返回 JSON。`
const qualityPrompt = (outline: string, text: string) =>
  `评估以下大纲质量。

返回 JSON：
{"coverage": 0-100, "abstraction": 0-100, "structure": 0-100, "actionability": 0-100, "compression_ratio": 0.03-0.08, "verdict": "pass|fail|revise", "issues": ["问题描述"], "suggestion": "修改建议"}

大纲：
${outline}

正文（前 3000 字）：
${text.slice(0, 3000)}`

// ---- 提取管线 ----
interface DatasetEntry {
  id: string
  source: { title: string; author: string; genre: string; chapter_index: number; chapter_title: string }
  input: {
    chapter_outline: string
    context: { pov: string; characters_expected: string[]; previous_summary: string; word_target: number }
  }
  output: string
  extraction_metadata: {
    model: string
    confidence: number
    outline_word_count: number
    text_word_count: number
    compression_ratio: number
    quality_flags: string[]
  }
}

const qualitySchema = {
  coverage: 0, abstraction: 0, structure: 0, actionability: 0,
  verdict: '', issues: [] as string[], suggestion: '',
}

async function generateText(system: string, prompt: string): Promise<string> {
  const raw = await structuredCompletion(system, prompt)
  return raw.trim()
}

async function generateQuality(outline: string, text: string): Promise<typeof qualitySchema> {
  try {
    const raw = await structuredCompletion(qualitySystem, qualityPrompt(outline, text))
    return { ...qualitySchema, ...parseModelJson(raw) } as typeof qualitySchema
  } catch {
    return { ...qualitySchema, verdict: 'error' }
  }
}

// ---- 执行 ----
const results: DatasetEntry[] = []
let previousSummary = ''
let skipped = 0

for (const [index, chapter] of chapters.entries()) {
  const chapterNum = index + 1
  process.stdout.write(`  [${chapterNum}/${chapters.length}] ${chapter.title.slice(0, 20)}… `)

  try {
    // Step 1: 提取大纲
    const outline = await generateText(extractSystem, extractPrompt(chapter.content, previousSummary))
    if (!outline || outline.length < 50) {
      console.log('✗ 大纲过短，跳过')
      skipped += 1
      previousSummary = await generateText(summarySystem, summaryPrompt(chapter.content))
      continue
    }

    // Step 2: 质量校验
    let quality: typeof qualitySchema | null = null
    let qualityFlags: string[] = []
    if (!skipQuality) {
      quality = await generateQuality(outline, chapter.content)
      if (quality.verdict === 'fail') {
        console.log(`✗ 质量不过关（coverage=${quality.coverage}）`)
        skipped += 1
        previousSummary = await generateText(summarySystem, summaryPrompt(chapter.content))
        continue
      }
      if (quality.issues?.length) qualityFlags = quality.issues.slice(0, 3)
    }

    // Step 3: 确定性过滤
    const textWords = chapter.content.replace(/\s/g, '').length
    const outlineWords = outline.replace(/\s/g, '').length
    const ratio = outlineWords / Math.max(1, textWords)
    if (ratio < 0.02 || ratio > 0.12) {
      console.log(`✗ 压缩比 ${ratio.toFixed(3)} 超范围 [0.02, 0.12]`)
      skipped += 1
      previousSummary = await generateText(summarySystem, summaryPrompt(chapter.content))
      continue
    }

    // Step 4: 提取 POV 和出场人物
    const povMatch = outline.match(/视角[：:]\s*(.+)$/m)
    const pov = povMatch ? povMatch[1].trim() : ''
    // 简单人物提取：大纲中出现的 2-4 字中文人名
    const charactersExpected = [...outline.matchAll(/[\u4e00-\u9fff]{2,4}(?=[，。；\s]|$)/g)]
      .map((match) => match[0])
      .filter((name) => name.length >= 2 && name.length <= 4 && !['场景', '视角', '承接', '预计', '字数'].includes(name))
      .slice(0, 8)

    // Step 5: 组装数据条目
    const entry: DatasetEntry = {
      id: `${project.name}/ch${String(chapterNum).padStart(3, '0')}`,
      source: {
        title: project.name,
        author: '',
        genre: project.genre || '未知',
        chapter_index: chapterNum,
        chapter_title: chapter.title,
      },
      input: {
        chapter_outline: outline,
        context: {
          pov,
          characters_expected: [...new Set(charactersExpected)],
          previous_summary: previousSummary,
          word_target: Math.round(textWords / 100) * 100,
        },
      },
      output: chapter.content,
      extraction_metadata: {
        model: getModelStatus().model,
        confidence: quality ? (quality.coverage + quality.actionability) / 200 : 0.8,
        outline_word_count: outlineWords,
        text_word_count: textWords,
        compression_ratio: Number(ratio.toFixed(4)),
        quality_flags: qualityFlags,
      },
    }
    results.push(entry)
    console.log(`✓ 大纲 ${outlineWords} 字 / 正文 ${textWords} 字 (ratio ${ratio.toFixed(3)})`)

    // Step 6: 为下一章生成摘要
    previousSummary = await generateText(summarySystem, summaryPrompt(chapter.content))
  } catch (error) {
    console.log(`✗ 提取失败：${(error as Error).message}`)
    skipped += 1
    try { previousSummary = await generateText(summarySystem, summaryPrompt(chapter.content)) } catch { /* continue */ }
  }
}

// ---- 输出 ----
const outputDir = path.dirname(outputArg)
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true })
fs.writeFileSync(outputArg, results.map((entry) => JSON.stringify(entry, null, 0)).join('\n') + '\n')

console.log(`\n=== 完成 ===`)
console.log(`有效样本：${results.length} / ${chapters.length} 章（跳过 ${skipped}）`)
console.log(`输出文件：${outputArg}`)
console.log(`文件大小：${(fs.statSync(outputArg).size / 1024).toFixed(1)} KB`)

// 统计
if (results.length > 0) {
  const ratios = results.map((entry) => entry.extraction_metadata.compression_ratio)
  const avgRatio = ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length
  const wordCounts = results.map((entry) => entry.extraction_metadata.text_word_count)
  const avgWords = wordCounts.reduce((sum, count) => sum + count, 0) / wordCounts.length
  console.log(`平均压缩比：${avgRatio.toFixed(3)} · 平均正文字数：${Math.round(avgWords)}`)
  console.log(`压缩比范围：[${Math.min(...ratios).toFixed(3)}, ${Math.max(...ratios).toFixed(3)}]`)
  const withPov = results.filter((entry) => entry.input.context.pov).length
  console.log(`POV 标注率：${Math.round(withPov / results.length * 100)}%`)
}
