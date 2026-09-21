import { describe, expect, it } from 'vitest'
import { chunkText, deduplicateChapters, extractEntityCandidates, isEffectivelyEmptyChapter, splitChapters, splitChaptersDetailed, summarize } from './importer.ts'

describe('import pipeline', () => {
  it('splits Chinese chapter headings while preserving content', () => {
    const result = splitChapters('第1章 初见\n林雾来到雾港。\n\n第2章 白塔\n季岚看向白塔，季岚说道：“别回头。”')
    expect(result).toHaveLength(2)
    expect(result[0].title).toBe('第1章 初见')
    expect(result[1].content).toContain('季岚')
  })

  it('chunks long text with overlap without losing the ending', () => {
    const source = '甲'.repeat(1800)
    const chunks = chunkText(source, 700, 100)
    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks.at(-1)?.endsWith('甲')).toBe(true)
  })

  it('does not invent entity candidates without a model', () => {
    const candidates = extractEntityCandidates('季岚说道。季岚看向白塔。季岚问林雾。林雾说道。林雾想起旧事。')
    expect(candidates).toEqual([])
  })

  it('drops table-of-contents duplicates and blank chapters', () => {
    const source = `目录\n第一章 初见\n第二章 离开\n\n-- 2 of 20 --\n第一章\n初见\n林雾来到雾港。这里发生了真正的正文内容。\n\n第二章 离开\n季岚离开白塔，决定返回旧城区继续调查。`
    const result = splitChaptersDetailed(source)
    expect(result.chapters).toHaveLength(2)
    expect(result.chapters[0].title).toContain('第一章')
    expect(result.chapters[0].content).toContain('真正的正文')
    expect(result.diagnostics.duplicateHeadings).toBe(2)
    expect(result.diagnostics.removedPageMarkers).toBe(1)
  })

  it('keeps volume context without creating empty volume chapters', () => {
    const result = splitChapters('第一卷 北境\n第一章 风雪\n风雪封住山口，商队只能留宿。\n\n第二章 来客\n陌生旅人带来王都的密信。')
    expect(result).toHaveLength(2)
    expect(result[0].title).toContain('第一卷 北境')
  })

  it('creates a bounded summary', () => {
    expect(summarize('第一句。第二句。第三句。', 100)).toBe('第一句。第二句。')
  })

  it('drops repeated content even when duplicate chapter titles differ', () => {
    const result = deduplicateChapters([
      { title: '第一章 初见', content: '林雾来到雾港，这里发生了真正的正文内容。' },
      { title: '第1章 初见（重复）', content: '林雾来到雾港， 这里发生了真正的正文内容。' },
    ])
    expect(result.chapters).toHaveLength(1)
    expect(result.duplicateContents).toBe(1)
  })

  it('treats title-only and punctuation-only sections as empty', () => {
    expect(isEffectivelyEmptyChapter('第三章 风雪', '第三章 风雪\n……')).toBe(true)
    expect(isEffectivelyEmptyChapter('第三章 风雪', '商队在风雪中绕过山口，终于看见了北境城墙。')).toBe(false)
  })
})
