import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { buildDocx, buildEpub, buildMarkdown, buildTxt } from './exporter.ts'

const volumes = [
  { title: '第一卷 雾港来信', chapters: [
    { title: '序章：退潮后的地图', content: '林雾在退潮后的石滩上醒来。\n\n手中的地图渗出海水。' },
    { title: '第一章：不存在的第七码头', content: '账本里夹着一张船票。& <标签> "引用"' },
  ] },
  { title: '第二卷', chapters: [{ title: '第二章：潮汐议会', content: '议长顾衡要求交出地图。' }] },
]

describe('buildTxt', () => {
  it('包含书名、卷、章与正文', () => {
    const text = buildTxt('雾港纪事', volumes)
    expect(text).toContain('《雾港纪事》')
    expect(text).toContain('第一卷 雾港来信')
    expect(text).toContain('序章：退潮后的地图')
    expect(text).toContain('林雾在退潮后的石滩上醒来。')
  })
})

describe('buildMarkdown', () => {
  it('按书/卷/章三级标题组织', () => {
    const md = buildMarkdown('雾港纪事', volumes)
    expect(md).toContain('# 雾港纪事')
    expect(md).toContain('## 第一卷 雾港来信')
    expect(md).toContain('### 第一章：不存在的第七码头')
  })
})

describe('buildDocx', () => {
  it('生成可解包的最小 OOXML 包并转义 XML 实体', async () => {
    const buffer = await buildDocx('雾港纪事', volumes)
    const zip = await JSZip.loadAsync(buffer)
    expect(zip.file('[Content_Types].xml')).toBeTruthy()
    expect(zip.file('_rels/.rels')).toBeTruthy()
    const document = await zip.file('word/document.xml')!.async('string')
    expect(document).toContain('雾港纪事')
    expect(document).toContain('&amp; &lt;标签&gt;')
    expect(document).not.toContain('& <标签>')
  })
})

describe('buildEpub', () => {
  it('生成 mimetype 首条目为 STORE 的 EPUB 3 包，目录包含全部章节', async () => {
    const buffer = await buildEpub('雾港纪事', volumes)
    const zip = await JSZip.loadAsync(buffer)
    expect(await zip.file('mimetype')!.async('string')).toBe('application/epub+zip')
    const container = await zip.file('META-INF/container.xml')!.async('string')
    expect(container).toContain('OEBPS/content.opf')
    const opf = await zip.file('OEBPS/content.opf')!.async('string')
    expect(opf).toContain('<dc:title>雾港纪事</dc:title>')
    expect(opf).toContain('properties="nav"')
    expect(opf).toContain('href="ch1.xhtml"')
    expect(opf).toContain('href="part1.xhtml"')
    const nav = await zip.file('OEBPS/nav.xhtml')!.async('string')
    expect(nav).toContain('序章：退潮后的地图')
    const chapter = await zip.file('OEBPS/ch2.xhtml')!.async('string')
    expect(chapter).toContain('<p>账本里夹着一张船票。&amp; &lt;标签&gt; &quot;引用&quot;</p>')
  })
})
