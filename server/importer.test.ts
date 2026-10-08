import { describe, expect, it } from 'vitest'
import { chunkText, deduplicateChapters, extractEntityCandidates, isEffectivelyEmptyChapter, splitChapters, splitChaptersDetailed, summarize } from './importer.ts'

describe('import pipeline', () => {
  it('splits Chinese chapter headings while preserving content', () => {
    const result = splitChapters('第1章 初见\n林雾来到雾港。\n\n第2章 白塔\n季岚看向白塔，季岚说道：“别回头。”')
    expect(result).toHaveLength(2)
    expect(result[0].title).toBe('第1章 初见')
    expect(result[1].content).toContain('季岚')
  })

  it('识别 PDF 无分隔回目并剔除目录页码条目', () => {
    const text = [
      '前 言',
      '这本书讲的是三分天下的故事。',
      '',
      '目 录',
      '第一回宴桃园豪杰三结义斩黄巾英雄首立功.1',
      '第二回张翼德怒鞭督邮 何国舅谋诛宦竖. 6',
      '第三回议温明董卓叱丁原馈金珠李肃说吕布……•…"12',
      '',
      '第一回宴桃园豪杰三结义斩黄巾英雄首立功',
      '话说天下大势，分久必合，合久必分。刘备在桃园与关羽张飞结义。',
      '',
      '第二回张翼德怒鞭督邮 何国舅谋诛宦竖',
      '且说督邮来到县中，众人议论纷纷。张飞大怒，睁圆环眼。',
      '',
      '第三回议温明董卓叱丁原馈金珠李肃说吕布',
      '董卓在温明园中大宴宾客，吕布站在丁原身后，气宇轩昂。',
    ].join('\n')
    const result = splitChaptersDetailed(text)
    expect(result.diagnostics.chapters).toBe(3)
    expect(result.chapters.map((chapter) => chapter.title)).toEqual(['第一回宴桃园豪杰三结义斩黄巾英雄首立功', '第二回张翼德怒鞭督邮 何国舅谋诛宦竖', '第三回议温明董卓叱丁原馈金珠李肃说吕布'])
    expect(result.chapters[0].content).toContain('桃园')
    expect(result.chapters[0].content).not.toContain('目 录')
    expect(result.diagnostics.warnings.some((warning) => warning.includes('目录页条目'))).toBe(true)
  })

  it('不把行首散文"第一回合"当章节标题', () => {
    const result = splitChaptersDetailed('第一回合就开始落后。\n\n第二回合的争夺更加激烈，双方你来我往互不相让，场面十分胶着。')
    expect(result.diagnostics.headingCount).toBe(0)
    expect(result.chapters).toHaveLength(1)
    expect(result.chapters[0].title).toBe('导入文稿')
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

  it('识别字间空格排版的卷章标题', () => {
    const text = '第 一 卷 光 晕 之 卷\n\n序言内容。\n\n第 一 章 雾 港\n\n林雾来到雾港。\n\n第 二 章 白 塔\n\n季岚看向白塔。'
    const result = splitChaptersDetailed(text)
    expect(result.diagnostics.chapters).toBe(2)
    expect(result.chapters[0].title).toMatch(/第一章\s*雾\s*港/)
  })

  it('treats title-only and punctuation-only sections as empty', () => {
    expect(isEffectivelyEmptyChapter('第三章 风雪', '第三章 风雪\n……')).toBe(true)
    expect(isEffectivelyEmptyChapter('第三章 风雪', '商队在风雪中绕过山口，终于看见了北境城墙。')).toBe(false)
  })
})
