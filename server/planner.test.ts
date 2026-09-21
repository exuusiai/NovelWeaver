import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./ai.ts', () => ({ structuredCompletion: vi.fn() }))

import { structuredCompletion } from './ai.ts'
import { chapterOutlineMarkdown, decomposeOutline } from './planner.ts'

const completion = vi.mocked(structuredCompletion)

describe('outline decomposition', () => {
  beforeEach(() => completion.mockReset())

  it('builds plotlines and chapter outlines from two structured calls', async () => {
    completion
      .mockResolvedValueOnce(JSON.stringify({ plotlines: [{ name: '接力线', type: 'framework', summary: '后果跨时代传递', events: [] }] }))
      .mockResolvedValueOnce(JSON.stringify({ volumes: [{ title: '第一卷', summary: '发现秘密', chapters: [{ title: '旧城来信', summary: '第一位发现者留下线索', pov: '', targetWords: 3000, purpose: '建立谜题', entryState: '城市平静', scenes: [{ title: '来信', objective: '确认来源', obstacle: '地址不存在', information: '信来自未来', turn: '收信人已死亡' }], exitState: '秘密开始传递', continuity: ['信件不可损毁'], plotlineNames: ['接力线'] }] }] }))

    const result = await decomposeOutline({ projectName: '测试', premise: '跨时代群像', outline: '# 大纲' })

    expect(completion).toHaveBeenCalledTimes(2)
    expect(result.plotlines[0].name).toBe('接力线')
    expect(result.volumes[0].chapters[0].scenes).toHaveLength(1)
  })

  it('renders editable markdown for the writing studio', () => {
    const markdown = chapterOutlineMarkdown({ title: '旧城来信', summary: '', pov: '', targetWords: 3000, purpose: '建立谜题', entryState: '城市平静', scenes: [{ title: '来信', objective: '确认来源', obstacle: '地址不存在', information: '信来自未来', turn: '收信人已死亡' }], exitState: '秘密开始传递', continuity: ['信件不可损毁'], plotlineNames: ['接力线'] })
    expect(markdown).toContain('## 场景序列')
    expect(markdown).toContain('信件不可损毁')
    expect(markdown).toContain('接力线')
  })
})
