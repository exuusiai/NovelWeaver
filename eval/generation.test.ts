import { describe, expect, it } from 'vitest'
import { aggregateReport, countIncludedEvidence, extractNumbers, formatGenerationReport, numberGrounding, scanCitations, scoreGeneration } from './generation-core.ts'

describe('引用扫描', () => {
  it('有效引用全部落入证据区间', () => {
    const scan = scanCitations('结论是正确的[R1]，另有旁证[R3]。', 8)
    expect(scan.markers).toEqual([1, 3])
    expect(scan.invalid).toEqual([])
    expect(scan.valid).toEqual([1, 3])
  })

  it('越界编号判为伪造接地', () => {
    const scan = scanCitations('前八条证据之外的 [R9] 与零号 [R0] 都是编造。', 8)
    expect(scan.valid).toEqual([])
    expect(scan.invalid).toEqual([9, 0])
  })

  it('证据条数来自上下文报告的 evidence 标签', () => {
    const report = { included: [
      { kind: 'project', label: '项目基线' },
      { kind: 'evidence', label: 'R1：原文' },
      { kind: 'evidence', label: 'R2：设定' },
      { kind: 'fact', label: '事实：某某' },
    ] }
    expect(countIncludedEvidence(report)).toBe(2)
    expect(countIncludedEvidence(undefined)).toBe(0)
  })
})

describe('数字接地', () => {
  it('提取数字并去重', () => {
    expect(extractNumbers('远征队共 13 人，走了 13 天，耗时 1.5 个月。')).toEqual(['13', '1.5'])
  })

  it('排除 Markdown 列表序号与标题编号', () => {
    const output = '## 1. 总览\n\n- 第 1 条：版本 1937 年出版\n\n1. 列表项甲\n2. 列表项乙'
    expect(extractNumbers(output)).toEqual(['1937'])
  })

  it('接地判定按上下文包含', () => {
    const context = '远征队共 13 人，1937 年首次出版。'
    expect(numberGrounding('全书 13 人，1937 年出版。', context)).toEqual({ total: 2, grounded: 2 })
    expect(numberGrounding('全书 14 人。', context)).toEqual({ total: 1, grounded: 0 })
  })
})

describe('综合评分', () => {
  it('完整链路：引用有效 + 数字接地', () => {
    const context = '【R1】比尔博 1937 年出版。'
    const score = scoreGeneration('比尔博的故事 1937 年出版[R1]。', context, 1, { expectCitation: true })
    expect(score.citationValidRate).toBe(1)
    expect(score.cited).toBe(true)
    expect(score.numberGroundedRate).toBe(1)
    expect(score.complete).toBe(true)
  })

  it('分析任务无引用时按违反契约计 0 分', () => {
    const score = scoreGeneration('一段没有任何引用的结论。', '上下文', 8, { expectCitation: true })
    expect(score.citationValidRate).toBe(0)
    expect(score.cited).toBe(false)
  })

  it('占位输出判为不完整', () => {
    expect(scoreGeneration('模型未返回内容。', '', 0).complete).toBe(false)
    expect(scoreGeneration('  ', '', 0).complete).toBe(false)
  })

  it('聚合与报告渲染', () => {
    const base = { task: 'analysis', prompt: '测试', model: 'test', latencyMs: 100, evidenceIncluded: 8, complete: true }
    const report = aggregateReport('测试项目', 'test-model', [
      { ...base, citationTotal: 2, citationValid: 2, citationInvalid: 0, citationValidRate: 1, cited: true, numberTotal: 1, numberGrounded: 1, numberGroundedRate: 1, outputChars: 100 },
      { ...base, citationTotal: 1, citationValid: 0, citationInvalid: 1, citationValidRate: 0, cited: true, numberTotal: 0, numberGrounded: 0, numberGroundedRate: null, outputChars: 80 },
    ])
    expect(report.metrics.citationValidRate).toBeCloseTo(0.5)
    expect(report.metrics.citationCoverage).toBe(1)
    expect(report.metrics.numberGroundedRate).toBe(1)
    expect(report.metrics.completeRate).toBe(1)
    expect(formatGenerationReport(report)).toContain('引用有效率：50%')
  })
})
