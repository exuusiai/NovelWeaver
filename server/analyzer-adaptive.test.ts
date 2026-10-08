import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./ai.ts', () => ({ structuredCompletion: vi.fn() }))

import { structuredCompletion } from './ai.ts'
import { analyzeManuscript } from './analyzer.ts'

const completion = vi.mocked(structuredCompletion)

// 两遍管线下，每个用例首轮调用是「人物名册快扫」；空名册返回让用例聚焦主分析流
const emptyRoster = '{"characters":[],"worldNotes":""}'

describe('adaptive manuscript analysis', () => {
  beforeEach(() => completion.mockReset())

  it('splits only the failed oversized batch and combines its results', async () => {
    completion
      .mockResolvedValueOnce(emptyRoster)
      .mockResolvedValueOnce('被截断的非 JSON 输出')
      .mockResolvedValueOnce('{"entities":[{"type":"character","name":"甲"}],"events":[],"relations":[]}')
      .mockResolvedValueOnce('{"entities":[{"type":"location","name":"乙地"}],"events":[],"relations":[]}')
      .mockResolvedValueOnce('{"plotlines":[]}')

    const result = await analyzeManuscript([{ id: 'chapter-1', title: '第一章', content: '文'.repeat(7001) }])

    expect(completion).toHaveBeenCalledTimes(5)
    expect(result.entities.map((entity) => entity.name)).toEqual(['甲', '乙地'])
    expect(result.batches).toBe(3)
  })

  it('uses compact extraction when a minimal batch still reaches the output limit', async () => {
    completion
      .mockResolvedValueOnce(emptyRoster)
      .mockRejectedValueOnce(Object.assign(new Error('truncated'), { code: 'MODEL_OUTPUT_TRUNCATED' }))
      .mockRejectedValueOnce(Object.assign(new Error('truncated'), { code: 'MODEL_OUTPUT_TRUNCATED' }))
      .mockResolvedValueOnce('{"entities":[{"type":"character","name":"阿无"}],"events":[],"relations":[]}')
      .mockResolvedValueOnce('{"plotlines":[]}')

    const result = await analyzeManuscript([{ id: 'chapter-1', title: '第一章', content: '文'.repeat(3000) }])

    expect(completion).toHaveBeenCalledTimes(5)
    expect(result.entities[0]?.name).toBe('阿无')
  })

  it('records a failed chapter batch and continues with later chapters', async () => {
    completion
      .mockResolvedValueOnce(emptyRoster)
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValueOnce('{"entities":[{"type":"character","name":"乙"}],"events":[],"relations":[]}')
      .mockResolvedValueOnce('{"plotlines":[]}')
    const progress: number[] = []

    const result = await analyzeManuscript([
      { id: 'failed-chapter', title: '第一章', content: '甲'.repeat(10000) },
      { id: 'ok-chapter', title: '第二章', content: '乙'.repeat(10000) },
    ], { continueOnError: true, onProgress: ({ completed }) => { if (completed > 0) progress.push(completed) } })

    expect(result.entities.map((entity) => entity.name)).toEqual(['乙'])
    expect(result.failures).toEqual([{ chapterIds: ['failed-chapter'], message: 'provider unavailable' }])
  })

  it('名册核验把 term 误判矫正为 character 并剔除零频次幻觉', async () => {
    completion
      .mockResolvedValueOnce('{"characters":[{"name":"隆达","aliases":["隆达·卡佩"],"role":"男主角","evidence":"隆达开口宽慰道"},{"name":"幻影人","aliases":[],"role":"","evidence":"幻觉"}],"worldNotes":"中世纪奇幻"}')
      .mockResolvedValueOnce('{"entities":[{"type":"term","name":"隆达·卡佩","aliases":[],"summary":"术语"}],"events":[],"relations":[]}')
      .mockResolvedValueOnce('{"plotlines":[]}')

    const result = await analyzeManuscript([
      { id: 'c1', title: '第一章', content: '隆达看了看母亲。隆达·卡佩开口说话，隆达说了很多。' },
    ])

    expect(result.entities[0]?.type).toBe('character')
    expect(result.roster.map((entry) => entry.name)).toEqual(['隆达'])
  })
})
