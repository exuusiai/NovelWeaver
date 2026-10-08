import path from 'node:path'
import mammoth from 'mammoth'
import JSZip from 'jszip'
import { convert } from 'html-to-text'
import { PDFParse } from 'pdf-parse'
import { XMLParser } from 'fast-xml-parser'
import type { ParsedChapter } from './types.ts'

const ordinal = '[零〇一二三四五六七八九十百千万两0-9]+'
const chapterLine = new RegExp(`^(?:第${ordinal}[章回节]|(?:chapter|part)\\s+[0-9ivxlcdm]+)(?:[：:、.．\\s]+.*)?$`, 'i')
// 目录页码噪音：第X回标题行尾的 ".372" / "……611"（PDF 目录条目，非章节）
const tocPageSuffix = /[.．…•·]{1,}\s*\d{1,4}$/
// 无分隔连写（"第一回宴桃园豪杰三结义"）时，标题首字不会是这些散文虚词/常用接续字——
// 用于排除"第一回合就开始落后""第二章讲了什么"这类行首散文
const concatTitleBanlist = /^[的了中里就还也和与或是讲写开结合说看要注意因为但]/
const volumeLine = new RegExp(`^第${ordinal}[卷部篇](?:[：:、.．\\s]+.*)?$`, 'i')
const namedHeading = /^(?:序章|楔子|引子|前言|序言|尾声|终章|后记|番外(?:篇)?(?:[一二三四五六七八九十0-9]+)?)(?:[：:、.．\s]+.*)?$/i
const pageMarker = /^\s*(?:--\s*)?\d+\s+(?:of|\/|／)\s+\d+(?:\s*--)?\s*$/i

export interface ImportDiagnostics {
  headingCount: number
  duplicateHeadings: number
  duplicateContents: number
  ignoredEmptySections: number
  removedPageMarkers: number
  chapters: number
  warnings: string[]
}

export interface SplitResult {
  chapters: ParsedChapter[]
  diagnostics: ImportDiagnostics
}

export function normalizeChapterTitle(title: string) {
  return title.toLowerCase().replace(/[\s\u00a0\u3000·:：、,.，。!！?？\-—_]/g, '')
}

export function chapterContentFingerprint(content: string) {
  return content.toLowerCase().replace(/[\s\u00a0\u3000\p{P}\p{S}]/gu, '')
}

export function isEffectivelyEmptyChapter(title: string, content: string) {
  const body = chapterContentFingerprint(content)
  const titleBody = chapterContentFingerprint(title)
  const withoutRepeatedTitle = titleBody && body.startsWith(titleBody) ? body.slice(titleBody.length) : body
  return withoutRepeatedTitle.length < 4
}

export function deduplicateChapters<T extends { title: string; content: string }>(chapters: T[]) {
  const seenContent = new Set<string>()
  const seenTitleContent = new Set<string>()
  const kept: T[] = []
  let ignoredEmpty = 0
  let duplicateContents = 0
  for (const chapter of chapters) {
    if (isEffectivelyEmptyChapter(chapter.title, chapter.content)) { ignoredEmpty += 1; continue }
    const contentKey = chapterContentFingerprint(chapter.content)
    const pairKey = `${normalizeChapterTitle(chapter.title)}|${contentKey}`
    if (seenContent.has(contentKey) || seenTitleContent.has(pairKey)) { duplicateContents += 1; continue }
    seenContent.add(contentKey); seenTitleContent.add(pairKey); kept.push(chapter)
  }
  return { chapters: kept, ignoredEmpty, duplicateContents }
}

export async function extractText(file: Express.Multer.File): Promise<string> {
  const ext = path.extname(file.originalname).toLowerCase()
  if (['.txt', '.md', '.markdown'].includes(ext)) return file.buffer.toString('utf8')
  if (ext === '.docx') return (await mammoth.extractRawText({ buffer: file.buffer })).value
  if (ext === '.epub') {
    const zip = await JSZip.loadAsync(file.buffer)
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' })
    let ordered: JSZip.JSZipObject[] = []
    const tocTitles = new Map<string, string>()
    const resolveZipPath = (baseDir: string, href: string) => path.posix.normalize(path.posix.join(baseDir, href))
    const container = zip.file('META-INF/container.xml')
    if (container) {
      const containerXml = parser.parse(await container.async('string')) as { container?: { rootfiles?: { rootfile?: { 'full-path'?: string } | Array<{ 'full-path'?: string }> } } }
      const rootfileValue = containerXml.container?.rootfiles?.rootfile
      const rootfile = Array.isArray(rootfileValue) ? rootfileValue[0]?.['full-path'] : rootfileValue?.['full-path']
      const opfEntry = rootfile ? zip.file(rootfile) : null
      if (rootfile && opfEntry) {
        const opf = parser.parse(await opfEntry.async('string')) as { package?: { manifest?: { item?: unknown }; spine?: { itemref?: unknown } } }
        const asArray = <T>(value: T | T[] | undefined) => value == null ? [] : Array.isArray(value) ? value : [value]
        const manifest = asArray(opf.package?.manifest?.item as { id?: string; href?: string; 'media-type'?: string } | Array<{ id?: string; href?: string; 'media-type'?: string }> | undefined)
        const refs = asArray(opf.package?.spine?.itemref as { idref?: string; linear?: string } | Array<{ idref?: string; linear?: string }> | undefined)
        const byId = new Map(manifest.map((item) => [item.id, item]))
        const opfDir = path.posix.dirname(rootfile)
        ordered = refs.filter((ref) => ref.linear !== 'no').map((ref) => byId.get(ref.idref)).filter((item): item is { id?: string; href?: string; 'media-type'?: string } => Boolean(item?.href && /html|xhtml/i.test(item['media-type'] || item.href || ''))).map((item) => zip.file(resolveZipPath(opfDir, item.href!))).filter((entry): entry is JSZip.JSZipObject => Boolean(entry && !entry.dir))
        // 读取 toc.ncx：很多 EPUB 的分卷文件本身没有"第X章"式标题（如"1.疯狂年代"），
        // 拍平后正则会全部漏检；用 NCX 标题在文件边界处补标准章节标题行。
        const ncxItem = manifest.find((item) => /ncx$/i.test(item['media-type'] || '') || /\.ncx$/i.test(item.href || ''))
        const ncxEntry = ncxItem?.href ? zip.file(resolveZipPath(opfDir, ncxItem.href)) : null
        if (ncxEntry) {
          const ncxDir = path.posix.dirname(resolveZipPath(opfDir, ncxItem!.href!))
          const ncx = parser.parse(await ncxEntry.async('string')) as { ncx?: { navMap?: { navPoint?: unknown } } }
          const flatten = (points: unknown): Array<{ label?: string; src?: string }> =>
            asArray(points as { navLabel?: { text?: string }; content?: { src?: string }; navPoint?: unknown } | Array<{ navLabel?: { text?: string }; content?: { src?: string }; navPoint?: unknown }>).flatMap((point) => {
              const label = point.navLabel?.text
              const src = point.content?.src
              const children = (point as { navPoint?: unknown }).navPoint
              return [{ label, src }, ...flatten(children)]
            })
          for (const point of flatten(ncx.ncx?.navMap?.navPoint)) {
            if (!point.label || !point.src) continue
            const href = point.src.split('#')[0].trim()
            const key = resolveZipPath(ncxDir, href)
            if (!tocTitles.has(key)) tocTitles.set(key, cleanHeading(String(point.label)))
          }
        }
      }
    }
    if (!ordered.length) ordered = Object.values(zip.files)
      .filter((entry) => /\.(xhtml|html|htm)$/i.test(entry.name) && !entry.dir && !/(?:nav|toc)\.(?:xhtml|html|htm)$/i.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    // 每个 spine 分卷为独立章节边界：NCX 标题在导入器文法内（第X章/序章等）直接作标题行，
    // 否则转写为"第N章 标题"（剥掉标题自带序号避免重复）；无 TOC 标题的分卷并入前章。
    const sections: string[] = []
    let chapterSeq = 0
    for (const entry of ordered) {
      const body = convert(await entry.async('string'), {
        wordwrap: false,
        selectors: [{ selector: 'img', format: 'skip' }, { selector: 'a', options: { ignoreHref: true } }],
      })
      const title = tocTitles.get(entry.name)
      if (!title) { sections.push(body); continue }
      if (headingKind(title)) { sections.push(`${title}\n\n${body}`); continue }
      chapterSeq += 1
      const cleaned = title.replace(/^[\d一二三四五六七八九十百]+\s*[.、:：\s]\s*/, '')
      sections.push(`第${chapterSeq}章 ${cleaned}\n\n${body}`)
    }
    return sections.join('\n\n')
  }
  if (ext === '.pdf') {
    const parser = new PDFParse({ data: file.buffer })
    const result = await parser.getText()
    await parser.destroy()
    return result.text
  }
  throw new Error(`暂不支持 ${ext || '未知'} 格式。请使用 TXT、Markdown、DOCX、EPUB 或 PDF。`)
}

function cleanHeading(line: string) {
  return line.replace(/^#{1,6}\s*/, '').replace(/[\u00a0\u3000]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function headingKind(line: string): 'chapter' | 'volume' | null {
  const clean = cleanHeading(line)
  if (chapterLine.test(clean) || namedHeading.test(clean)) return 'chapter'
  // 无分隔连写："第一回宴桃园豪杰三结义"（PDF 扫描书常见）。要求行短、
  // 标题首字不是虚词，避免"第一回合""第二章讲了"这类散文行首误判
  const concat = clean.match(new RegExp(`^第(${ordinal})[章回节]([^：:、.．\\s].*)?$`, 'i'))
  if (concat && clean.length <= 45 && !concatTitleBanlist.test(concat[2] || '')) return 'chapter'
  if (volumeLine.test(clean)) return 'volume'
  return null
}

function headingKey(title: string) {
  const clean = cleanHeading(title).toLowerCase()
  const match = clean.match(new RegExp(`^(第${ordinal}[章回节]|(?:chapter|part)\\s+[0-9ivxlcdm]+|序章|楔子|引子|前言|序言|尾声|终章|后记|番外(?:篇)?(?:[一二三四五六七八九十0-9]+)?)`, 'i'))
  return (match?.[1] || clean).replace(/\s+/g, '')
}

function isSubtitle(line: string) {
  const clean = cleanHeading(line)
  return clean.length >= 2 && clean.length <= 32 && !headingKind(clean) && !/[。！？!?；;]$/.test(clean) && !pageMarker.test(clean)
}

export function normalizeImportedText(text: string) {
  const source = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/[\u00a0\u3000]/g, ' ')
  let removedPageMarkers = 0
  const lines = source.split('\n').map((line) => line.replace(/[ \t]+$/g, '')).filter((line) => {
    if (pageMarker.test(line)) { removedPageMarkers += 1; return false }
    return !/^\s*Page\s+\d+\s*$/i.test(line)
  })
  return { text: lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trim(), removedPageMarkers }
}

function formatBody(source: string) {
  const blocks = source.split(/\n\s*\n/)
  return blocks.map((block) => {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean)
    if (lines.length <= 1) return lines[0] || ''
    const formatted: string[] = []
    let current = ''
    for (const line of lines) {
      const structural = /^[-*+]\s|^>\s|^#{1,6}\s|^[“\"「『]/.test(line)
      if (structural && current) { formatted.push(current); current = line }
      else current += line
      if (/[。！？!?…」』”\"]$/.test(line) && current.length > 18) { formatted.push(current); current = '' }
    }
    if (current) formatted.push(current)
    return formatted.join('\n')
  }).filter(Boolean).join('\n\n').trim()
}

export function splitChaptersDetailed(text: string): SplitResult {
  const normalized = normalizeImportedText(text)
  const lines = normalized.text.split('\n')
  const headings: Array<{ line: number; title: string; kind: 'chapter' | 'volume' }> = []
  let removedTocEntries = 0
  for (let index = 0; index < lines.length; index += 1) {
    const clean = cleanHeading(lines[index])
    const kind = headingKind(clean)
    if (!kind) continue
    // 第X回 + 行尾页码（".372"/"……611"）是 PDF 目录条目：剔除，避免既产生
    // 假章节、又因 headingKey 同 key 把正文真标题当重复吃掉
    if (kind === 'chapter' && tocPageSuffix.test(clean)) { removedTocEntries += 1; continue }
    headings.push({ line: index, title: clean, kind })
  }

  const warnings: string[] = []
  if (!headings.some((item) => item.kind === 'chapter')) {
    const content = formatBody(normalized.text)
    return {
      chapters: content ? [{ title: '导入文稿', content, position: 0, summary: summarize(content) }] : [],
      diagnostics: { headingCount: 0, duplicateHeadings: 0, duplicateContents: 0, ignoredEmptySections: 0, removedPageMarkers: normalized.removedPageMarkers, chapters: content ? 1 : 0, warnings: ['未识别到明确章节标题，已作为单篇文稿导入。'] },
    }
  }

  type Section = { title: string; key: string; content: string; order: number; volume: string; headingLine: number }
  const sections: Section[] = []
  let activeVolume = ''
  headings.forEach((heading, index) => {
    const end = headings[index + 1]?.line ?? lines.length
    if (heading.kind === 'volume') { activeVolume = heading.title; return }
    let title = heading.title
    let bodyStart = heading.line + 1
    const bareOrdinal = new RegExp(`^(?:第${ordinal}[章回节]|(?:chapter|part)\\s+[0-9ivxlcdm]+)$`, 'i').test(title)
    if (bareOrdinal && isSubtitle(lines[bodyStart] || '')) {
      title = `${title} ${cleanHeading(lines[bodyStart])}`
      bodyStart += 1
    }
    const content = formatBody(lines.slice(bodyStart, end).join('\n'))
    sections.push({ title, key: headingKey(title), content, order: sections.length, volume: activeVolume, headingLine: heading.line })
  })

  const initialGroups = new Map<string, Section[]>()
  sections.forEach((section) => initialGroups.set(section.key, [...(initialGroups.get(section.key) || []), section]))
  const repeatedGroups = [...initialGroups.values()].filter((group) => group.length > 1)
  let bodyStartOrder = 0
  if (repeatedGroups.length >= 3) bodyStartOrder = Math.min(...repeatedGroups.map((group) => group[1].order))
  const workingSections = sections.filter((section) => section.order >= bodyStartOrder)
  const groups = new Map<string, Section[]>()
  workingSections.forEach((section) => groups.set(section.key, [...(groups.get(section.key) || []), section]))
  let duplicateHeadings = sections.length - workingSections.length
  let ignoredEmptySections = 0
  const chosen = new Set<Section>()
  for (const group of groups.values()) {
    if (group.length > 1) duplicateHeadings += group.length - 1
    const best = [...group].sort((a, b) => b.content.replace(/\s/g, '').length - a.content.replace(/\s/g, '').length || b.order - a.order)[0]
    if (best.content.replace(/\s/g, '').length >= 4) chosen.add(best)
    else ignoredEmptySections += group.length
  }
  const selected = workingSections.filter((section) => chosen.has(section))
  const firstBodySection = workingSections[0]
  const previousSection = bodyStartOrder > 0 ? sections[bodyStartOrder - 1] : undefined
  const prefaceStart = previousSection ? previousSection.headingLine + 1 : 0
  const firstHeadingLine = firstBodySection?.headingLine ?? (headings.find((item) => item.kind === 'chapter')?.line ?? 0)
  const prefaceText = formatBody(lines.slice(prefaceStart, firstHeadingLine).join('\n'))
  if (prefaceText.replace(/\s/g, '').length >= 80 && !/^(?:目录|contents?)\b/i.test(prefaceText)) {
    selected.unshift({ title: '导入前置内容', key: '__preface__', content: prefaceText, order: -1, volume: '', headingLine: prefaceStart })
  }
  const mapped = selected.map((section, position) => ({
    title: section.volume && !section.title.startsWith(section.volume) ? `${section.volume} · ${section.title}` : section.title,
    content: section.content,
    position,
    summary: summarize(section.content),
  }))
  const deduplicated = deduplicateChapters(mapped)
  const chapters = deduplicated.chapters.map((chapter, position) => ({ ...chapter, position }))
  ignoredEmptySections += deduplicated.ignoredEmpty
  const duplicateContents = deduplicated.duplicateContents
  if (duplicateHeadings) warnings.push(`已忽略 ${duplicateHeadings} 个目录或重复章节标题。`)
  if (duplicateContents) warnings.push(`已忽略 ${duplicateContents} 个正文重复章节。`)
  if (ignoredEmptySections) warnings.push(`已忽略 ${ignoredEmptySections} 个无正文的空章节。`)
  if (normalized.removedPageMarkers) warnings.push(`已移除 ${normalized.removedPageMarkers} 个 PDF 页码标记。`)
  if (removedTocEntries > 0) warnings.push(`已识别并剔除 ${removedTocEntries} 个目录页条目（标题行尾带页码）。`)
  return { chapters, diagnostics: { headingCount: sections.length, duplicateHeadings, duplicateContents, ignoredEmptySections, removedPageMarkers: normalized.removedPageMarkers, chapters: chapters.length, warnings } }
}

export function splitChapters(text: string): ParsedChapter[] {
  return splitChaptersDetailed(text).chapters
}

export function summarize(content: string, max = 140) {
  const clean = content.replace(/\s+/g, ' ').trim()
  if (!clean) return '暂无摘要。'
  const sentences = clean.split(/(?<=[。！？!?])/).filter(Boolean)
  const summary = sentences.slice(0, 2).join('') || clean
  return summary.length > max ? `${summary.slice(0, max)}…` : summary
}

export function chunkText(content: string, size = 1200, overlap = 160) {
  const clean = content.replace(/\n{3,}/g, '\n\n').trim()
  const chunks: string[] = []
  for (let start = 0; start < clean.length; start += size - overlap) {
    chunks.push(clean.slice(start, start + size))
    if (start + size >= clean.length) break
  }
  return chunks
}

// Local mode deliberately does not guess proper nouns. Reliable entity resolution
// is performed by the structured model analysis pipeline after import.
export function extractEntityCandidates(_text: string) {
  return [] as Array<{ name: string; count: number; type: string }>
}
