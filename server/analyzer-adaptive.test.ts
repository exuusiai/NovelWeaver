import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./ai.ts', () => ({ structuredCompletion: vi.fn() }))

import { structuredCompletion } from './ai.ts'
import { analyzeManuscript } from './analyzer.ts'

const completion = vi.mocked(structuredCompletion)

describe('adaptive manuscript analysis', () => {
  beforeEach(() => completion.mockReset())

  it('splits only the failed oversized batch and combines its results', async () => {
    completion
      .mockResolvedValueOnce('被截断的非 JSON 输出')
      .mockResolvedValueOnce('{"entities":[{"type":"character","name":"甲"}],"events":[],"relations":[]}')
      .mockResolvedValueOnce('{"entities":[{"type":"location","name":"乙地"}],"events":[],"relations":[]}')
      .mockResolvedValueOnce('{"plotlines":[]}')

    const result = await analyzeManuscript([{ id: 'chapter-1', title: '第一章', content: '文'.repeat(7001) }])

    expect(completion).toHaveBeenCalledTimes(4)
    expect(result.entities.map((entity) => entity.name)).toEqual(['甲', '乙地'])
    expect(result.batches).toBe(3)
  })

  it('uses compact extraction when a minimal batch still reaches the output limit', async () => {
    completion
      .mockRejectedValueOnce(Object.assign(new Error('truncated'), { code: 'MODEL_OUTPUT_TRUNCATED' }))
      .mockRejectedValueOnce(Object.assign(new Error('truncated'), { code: 'MODEL_OUTPUT_TRUNCATED' }))
      .mockResolvedValueOnce('{"entities":[{"type":"character","name":"阿无"}],"events":[],"relations":[]}')
      .mockResolvedValueOnce('{"plotlines":[]}')

    const result = await analyzeManuscript([{ id: 'chapter-1', title: '第一章', content: '文'.repeat(3000) }])

    expect(completion).toHaveBeenCalledTimes(4)
    expect(result.entities[0]?.name).toBe('阿无')
  })

  it('records a failed chapter batch and continues with later chapters', async () => {
    completion
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValueOnce('{"entities":[{"type":"character","name":"乙"}],"events":[],"relations":[]}')
      .mockResolvedValueOnce('{"plotlines":[]}')
    const progress: number[] = []

    const result = await analyzeManuscript([
      { id: 'failed-chapter', title: '第一章', content: '甲'.repeat(10000) },
      { id: 'ok-chapter', title: '第二章', content: '乙'.repeat(10000) },
    ], { continueOnError: true, onProgress: ({ completed }) => { progress.push(completed) } })

    expect(result.entities.map((entity) => entity.name)).toEqual(['乙'])
    expect(result.failures).toEqual([{ chapterIds: ['failed-chapter'], message: 'provider unavailable' }])
    expect(progress).toEqual([1, 2])
  })
})
