import JSZip from 'jszip'
import crypto from 'node:crypto'

export interface ManuscriptChapter { title: string; content: string }
export interface ManuscriptVolume { title: string; chapters: ManuscriptChapter[] }

export type ManuscriptFormat = 'txt' | 'md' | 'docx' | 'epub'

export function buildTxt(name: string, volumes: ManuscriptVolume[]): string {
  const parts: string[] = [`《${name}》`, '']
  for (const volume of volumes) {
    parts.push(volume.title, '')
    for (const chapter of volume.chapters) {
      parts.push(chapter.title, chapter.content, '')
    }
    parts.push('')
  }
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

export function buildMarkdown(name: string, volumes: ManuscriptVolume[]): string {
  const parts: string[] = [`# ${name}`, '']
  for (const volume of volumes) {
    parts.push(`## ${volume.title}`, '')
    for (const chapter of volume.chapters) {
      parts.push(`### ${chapter.title}`, '', chapter.content, '')
    }
  }
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

const escapeXml = (value: string) => value
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

function paragraph(text: string, size: number, bold: boolean, center = false) {
  const jc = center ? '<w:pPr><w:jc w:val="center"/></w:pPr>' : ''
  const rPr = `<w:rPr>${bold ? '<w:b/>' : ''}<w:sz w:val="${size}"/></w:rPr>`
  return `<w:p>${jc}<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`
}

function bodyParagraphs(content: string) {
  return content.split('\n').map((line) => line.trim()
    ? paragraph(line, 24, false)
    : '<w:p/>').join('')
}

// Minimal OOXML package: [Content_Types].xml + _rels/.rels + word/document.xml with
// direct run formatting, so Word/WPS open it without a styles part.
export async function buildDocx(name: string, volumes: ManuscriptVolume[]): Promise<Buffer> {
  const sections: string[] = [
    paragraph(name, 36, true, true),
    '<w:p/>',
  ]
  for (const volume of volumes) {
    sections.push(paragraph(volume.title, 30, true), '<w:p/>')
    for (const chapter of volume.chapters) {
      sections.push(paragraph(chapter.title, 26, true), bodyParagraphs(chapter.content), '<w:p/>')
    }
    sections.push('<w:p/>')
  }
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${sections.join('')}</w:body></w:document>`
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)
  zip.file('word/document.xml', document)
  return zip.generateAsync({ type: 'nodebuffer' })
}

export const manuscriptContentTypes: Record<ManuscriptFormat, string> = {
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  epub: 'application/epub+zip',
}

export function manuscriptExtension(format: ManuscriptFormat) {
  return format === 'docx' ? 'docx' : format
}

const xhtmlParagraphs = (content: string) => content.split('\n')
  .map((line) => line.trim() ? `<p>${escapeXml(line)}</p>` : '')
  .join('')

function chapterXhtml(title: string, body: string, partLabel?: string) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh"><head><title>${escapeXml(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body>${partLabel ? `<p class="part">${escapeXml(partLabel)}</p>` : ''}<h2>${escapeXml(title)}</h2>${body}</body></html>`
}

// Minimal EPUB 3 package: stored (uncompressed) mimetype first, then container, OPF, nav and
// one XHTML document per chapter. Volume headings become part pages when there are several.
export async function buildEpub(name: string, volumes: ManuscriptVolume[]): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`)
  const bookId = `urn:uuid:${crypto.randomUUID()}`
  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  const docs: Array<{ id: string; href: string; title: string }> = []
  const multiVolume = volumes.length > 1
  let partIndex = 0
  let chapterIndex = 0
  for (const volume of volumes) {
    if (multiVolume) {
      partIndex += 1
      const id = `part${partIndex}`
      docs.push({ id, href: `${id}.xhtml`, title: volume.title })
      zip.file(`OEBPS/${id}.xhtml`, chapterXhtml(volume.title, '', '分卷'))
    }
    for (const chapter of volume.chapters) {
      chapterIndex += 1
      const id = `ch${chapterIndex}`
      docs.push({ id, href: `${id}.xhtml`, title: chapter.title })
      zip.file(`OEBPS/${id}.xhtml`, chapterXhtml(chapter.title, xhtmlParagraphs(chapter.content), multiVolume ? volume.title : undefined))
    }
  }
  zip.file('OEBPS/style.css', 'body{font-family:serif;line-height:1.8;margin:1em}h2{font-size:1.3em;margin:1.5em 0 .8em}p{text-indent:2em;margin:.4em 0}.part{color:#666;letter-spacing:.3em;margin-top:3em;text-indent:0}\n')
  zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh"><head><title>目录</title></head><body><nav epub:type="toc" id="toc"><h1>目录</h1><ol>${docs.map((doc) => `<li><a href="${doc.href}">${escapeXml(doc.title)}</a></li>`).join('')}</ol></nav></body></html>`)
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">${bookId}</dc:identifier><dc:title>${escapeXml(name)}</dc:title><dc:language>zh</dc:language><meta property="dcterms:modified">${modified}</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="style.css" media-type="text/css"/>${docs.map((doc) => `<item id="${doc.id}" href="${doc.href}" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine>${docs.map((doc) => `<itemref idref="${doc.id}"/>`).join('')}</spine></package>`)
  return zip.generateAsync({ type: 'nodebuffer' })
}
