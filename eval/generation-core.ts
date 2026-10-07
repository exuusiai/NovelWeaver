// 生成质量评分核心：纯函数、离线可测。
// 度量口径（对应系统提示词的生成契约）：
// 1. 引用有效率 —— 输出中每个 [Rn] 必须指向上下文快照中真实存在的证据条目；
//    越界编号 = 伪造接地（模型假装引用了不存在的证据）。
// 2. 引用覆盖率 —— 分析类任务的输出应至少包含一次引用（系统提示词硬要求）。
// 3. 数字接地率 —— 输出中的阿拉伯数字应能出现在上下文快照中；
//    数字是幻觉最高发且可规则化判定的通道。Markdown 列表序号与标题编号不计。
// 4. 完整度 —— 输出非空且非"模型未返回内容"占位。

export interface CitationScan {
  markers: number[]
  valid: number[]
  invalid: number[]
}

// 上下文快照中的证据条目数可从 contextReport.included 的 label（"R3：…"）提取，
// 生成脚本负责传入；这里只做编号区间判定。
export function scanCitations(output: string, evidenceCount: number): CitationScan {
  const markers: number[] = []
  const pattern = /\[R(\d+)\]/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(output)) !== null) {
    const index = Number(match[1])
    if (Number.isFinite(index)) markers.push(index)
  }
  const valid = markers.filter((index) => index >= 1 && index <= evidenceCount)
  return { markers, valid, invalid: markers.filter((index) => index < 1 || index > evidenceCount) }
}

export function countIncludedEvidence(contextReport?: { included?: Array<{ kind?: string; label?: string }> }): number {
  const labels = contextReport?.included ?? []
  let max = 0
  for (const item of labels) {
    if (item.kind !== 'evidence' || !item.label) continue
    const match = /^R(\d+)：/.exec(item.label)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return max
}

// 数字接地：提取输出中的数字串；排除 Markdown 列表序号（行首 "1."、"2）"）、
// Markdown 标题编号与中文序数（"第 1 条""第 3 卷"）。年份、字数等全部计入——
// 它们若非来自上下文即为编造风险。
const ordinalPattern = /第\s*\d+(?:\.\d+)?\s*[条章卷幕部节位名次轮项步]?/

export function extractNumbers(output: string): string[] {
  const stripped = output
    .split('\n')
    .filter((line) => !/^\s*(\d+[.、)]|#{1,6}\s)/.test(line))
    .join('\n')
    .replace(new RegExp(ordinalPattern.source, 'g'), '第')
  const seen = new Set<string>()
  const numbers: string[] = []
  const pattern = /\d+(?:\.\d+)?/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(stripped)) !== null) {
    const value = match[0]
    if (!seen.has(value)) { seen.add(value); numbers.push(value) }
  }
  return numbers
}

export function numberGrounding(output: string, contextText: string): { total: number; grounded: number } {
  const numbers = extractNumbers(output)
  const grounded = numbers.filter((value) => contextText.includes(value))
  return { total: numbers.length, grounded: grounded.length }
}

export interface GenerationScore {
  citationTotal: number
  citationValid: number
  citationInvalid: number
  citationValidRate: number | null
  cited: boolean
  numberTotal: number
  numberGrounded: number
  numberGroundedRate: number | null
  outputChars: number
  complete: boolean
}

export function scoreGeneration(output: string, contextText: string, evidenceCount: number, options: { expectCitation?: boolean } = {}): GenerationScore {
  const citation = scanCitations(output, evidenceCount)
  const grounding = numberGrounding(output, contextText)
  const trimmed = output.trim()
  const complete = Boolean(trimmed) && !trimmed.startsWith('模型未返回内容')
  return {
    citationTotal: citation.markers.length,
    citationValid: citation.valid.length,
    citationInvalid: citation.invalid.length,
    citationValidRate: citation.markers.length ? citation.valid.length / citation.markers.length : (options.expectCitation ? 0 : null),
    cited: citation.markers.length > 0,
    numberTotal: grounding.total,
    numberGrounded: grounding.grounded,
    numberGroundedRate: grounding.total ? grounding.grounded / grounding.total : null,
    outputChars: trimmed.length,
    complete,
  }
}

export interface GenerationCaseResult extends GenerationScore {
  task: string
  prompt: string
  note?: string
  model: string
  latencyMs: number
  evidenceIncluded: number
  usageTokens?: number
}

export interface GenerationReport {
  projectName: string
  model: string
  caseCount: number
  metrics: {
    citationValidRate: number
    citationCoverage: number
    numberGroundedRate: number | null
    completeRate: number
    avgLatencyMs: number
  }
  results: GenerationCaseResult[]
}

export function aggregateReport(projectName: string, model: string, results: GenerationCaseResult[]): GenerationReport {
  const total = results.length || 1
  const citedResults = results.filter((result) => result.citationTotal > 0)
  const validOfCited = results.filter((result) => result.citationTotal > 0)
  const numberCases = results.filter((result) => result.numberTotal > 0)
  return {
    projectName,
    model,
    caseCount: results.length,
    metrics: {
      citationValidRate: validOfCited.reduce((sum, result) => sum + result.citationValidRate!, 0) / (validOfCited.length || 1),
      citationCoverage: citedResults.length / total,
      numberGroundedRate: numberCases.length ? numberCases.reduce((sum, result) => sum + result.numberGroundedRate!, 0) / numberCases.length : null,
      completeRate: results.filter((result) => result.complete).length / total,
      avgLatencyMs: Math.round(results.reduce((sum, result) => sum + result.latencyMs, 0) / total),
    },
    results,
  }
}

export function formatGenerationReport(report: GenerationReport): string {
  const lines = [
    `# 生成质量评测 · ${report.projectName}`,
    '',
    `- 模型：${report.model} · 任务数：${report.caseCount} · 平均耗时：${report.metrics.avgLatencyMs}ms`,
    `- 引用有效率：${(report.metrics.citationValidRate * 100).toFixed(0)}%（引用过的结论中 [Rn] 指向真实证据的比例）`,
    `- 引用覆盖率：${(report.metrics.citationCoverage * 100).toFixed(0)}%（输出含 [Rn] 引用的任务占比）`,
    `- 数字接地率：${report.metrics.numberGroundedRate === null ? '无数字样本' : `${(report.metrics.numberGroundedRate * 100).toFixed(0)}%`}`,
    `- 完整度：${(report.metrics.completeRate * 100).toFixed(0)}%`,
    '',
    '| 任务 | 请求要点 | 引用 [有效/总数] | 数字接地 | 耗时 | 字数 |',
    '|---|---|---|---|---:|---:|',
    ...report.results.map((result) => `| ${result.task} | ${(result.note || result.prompt).slice(0, 28)} | ${result.citationValid}/${result.citationTotal} | ${result.numberTotal ? `${result.numberGrounded}/${result.numberTotal}` : '—'} | ${result.latencyMs}ms | ${result.outputChars} |`),
  ]
  return lines.join('\n')
}
