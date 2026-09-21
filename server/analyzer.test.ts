import { describe, expect, it } from 'vitest'
import { characterNameVariants, mergeEntities, parseModelJson, type AnalysisEntity } from './analyzer.ts'

describe('parseModelJson', () => {
  it('parses a plain JSON object', () => {
    expect(parseModelJson('{"entities":[],"events":[]}')).toEqual({ entities: [], events: [] })
  })

  it('ignores reasoning and Markdown fences', () => {
    const raw = '<think>先分析人物。</think>\n结果如下：\n```json\n{"plotlines":[]}\n```'
    expect(parseModelJson(raw)).toEqual({ plotlines: [] })
  })

  it('repairs common JSON formatting mistakes', () => {
    expect(parseModelJson("{'entities': [], 'events': [],}")).toEqual({ entities: [], events: [] })
  })

  it('rejects responses without a JSON object', () => {
    expect(() => parseModelJson('抱歉，我无法完成这项任务。')).toThrow('不是有效 JSON')
  })
})

describe('character entity normalization', () => {
  const entity = (name: string): AnalysisEntity => ({ type: 'character', name, aliases: [], summary: '', data: {}, evidence: [] })

  it('treats a professional suffix as an alias of the same person', () => {
    expect(characterNameVariants('小明医生')).toContain('小明')
    const merged = mergeEntities([entity('小明'), entity('小明医生')])
    expect(merged).toHaveLength(1)
    expect(merged[0].aliases).toContain('小明医生')
  })

  it('keeps narrative identities separate when the manuscript links them explicitly', () => {
    const merged = mergeEntities([entity('克莱恩'), entity('夏洛克')], [{ from: '克莱恩', to: '夏洛克', type: 'same_person', label: '同一人的不同身份', sentiment: 'neutral', strength: 100, evidence: '身份揭示' }])
    expect(merged).toHaveLength(2)
  })
})
