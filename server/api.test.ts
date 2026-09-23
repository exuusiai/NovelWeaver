process.env.NOVELWEAVER_DATA_DIR = ':memory:'
delete process.env.AI_API_KEY
delete process.env.AI_BASE_URL

const { app } = await import('./index.ts')
import type { Server } from 'node:http'
import { describe, expect, it, afterAll, beforeAll } from 'vitest'

let server: Server
let base = ''

beforeAll(async () => {
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => { await new Promise((resolve) => server.close(resolve)) })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call<T = any>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, data: await res.json().catch(() => null) as T }
}

const firstTwoBytes = (bytes: Uint8Array) => String.fromCharCode(...bytes.subarray(0, 2))

const planVolume = (title: string, chapters: string[]) => ({
  title, summary: `${title}摘要`,
  chapters: chapters.map((name) => ({
    title: name, summary: `${name}的细纲`, pov: '林雾', targetWords: 3000, purpose: '推进', entryState: '承接',
    scenes: [{ title: '场景', objective: '目标', obstacle: '阻力', information: '信息', turn: '转折' }],
    exitState: '落点', continuity: [], plotlineNames: [],
  })),
})

describe('API 基础', () => {
  it('健康检查', async () => {
    const { status, data } = await call('GET', '/api/health')
    expect(status).toBe(200); expect(data.ok).toBe(true)
  })
})

describe('章节历史与预检', () => {
  let projectId = ''
  let chapterId = ''
  it('创建项目与章节', async () => {
    const created = await call('POST', '/api/projects', { name: 'API测试项目', premise: '测试' })
    expect(created.status).toBe(201); projectId = created.data.id
    const chapter = await call('POST', `/api/projects/${projectId}/chapters`, { title: '第一章' })
    expect(chapter.status).toBe(201); chapterId = chapter.data.id
  })
  it('正文变更自动留档历史版本，恢复可回滚', async () => {
    await call('PATCH', `/api/chapters/${chapterId}`, { content: '第一版正文，林雾在码头醒来。' })
    await call('PATCH', `/api/chapters/${chapterId}`, { content: '第二版正文，季岚出现在码头尽头。' })
    const history = await call('GET', `/api/chapters/${chapterId}/history`)
    expect(history.status).toBe(200); expect(history.data.length).toBe(2)
    const target = history.data.find((row: { preview: string }) => row.preview.includes('第一版正文'))
    expect(target).toBeTruthy()
    const restored = await call('POST', `/api/chapters/${chapterId}/history/${target.id}/restore`, {})
    expect(restored.status).toBe(200); expect(restored.data.content).toContain('第一版正文')
    const afterRestore = await call('GET', `/api/chapters/${chapterId}/history`)
    expect(afterRestore.data.length).toBe(3)
  })
  it('预检返回视角与摘要缺失提示', async () => {
    const { status, data } = await call('GET', `/api/chapters/${chapterId}/precheck`)
    expect(status).toBe(200)
    const categories = data.issues.map((issue: { category: string }) => issue.category)
    expect(categories).toContain('pov'); expect(categories).toContain('structure')
  })
})

describe('重拆分清理规则', () => {
  let projectId = ''
  let outlineId = ''
  it('v1 拆分写入三章，其中一章写有正文', async () => {
    const project = await call('POST', '/api/projects', { name: '重拆分项目' })
    projectId = project.data.id
    const outline = await call('POST', `/api/projects/${projectId}/outlines`, { title: 'v2', content: '重画后的大纲' })
    outlineId = outline.data.id
    const v1 = await call('POST', `/api/outlines/${outlineId}/apply-decomposition`, { plan: { plotlines: [], volumes: [planVolume('测试卷', ['第一章甲', '第二章乙', '第三章丙'])] } })
    expect(v1.status).toBe(201); expect(v1.data.chapters).toBe(3)
    const chapters = await call('GET', `/api/projects/${projectId}/chapters`)
    const second = chapters.data.find((row: { title: string }) => row.title === '第二章乙')
    await call('PATCH', `/api/chapters/${second.id}`, { content: '第二章已经写好的正文，足够长不会被当作空白。' })
  })
  it('v2 应用时空白规划章被删、已写章节保留、新章插入', async () => {
    const v2 = await call('POST', `/api/outlines/${outlineId}/apply-decomposition`, { plan: { plotlines: [], volumes: [planVolume('测试卷', ['第一章甲', '第二章乙', '第四章丁'])] } })
    // v1 的甲、丙都从未写过（空白规划章）→ 被清理；乙已写正文 → 保留；v2 的甲作为新章插入
    expect(v2.data.removedStaleChapters).toBe(2)
    expect(v2.data.removedTitles).toEqual(['第一章甲', '第三章丙'])
    expect(v2.data.skippedChapters).toBe(1)
    expect(v2.data.chapters).toBe(2)
    const chapters = await call('GET', `/api/projects/${projectId}/chapters`)
    const titles = chapters.data.map((row: { title: string }) => row.title)
    expect(titles).not.toContain('第三章丙')
    expect(titles).toContain('第四章丁')
    const written = chapters.data.find((row: { title: string }) => row.title === '第二章乙')
    expect(written.content).toContain('第二章已经写好的正文')
    expect(chapters.data.find((row: { title: string }) => row.title === '第一章甲').content).toBe('')
  })
})

describe('导出与检索', () => {
  let projectId = ''
  it('Markdown / DOCX / EPUB 三种格式可导出', async () => {
    const project = await call('POST', '/api/projects', { name: '导出测试项目' })
    projectId = project.data.id
    await call('POST', `/api/projects/${projectId}/chapters`, { title: '第一章测试', content: '这是导出用的正文内容，足够长。' })
    const md = await fetch(`${base}/api/projects/${projectId}/export/manuscript?format=md`)
    expect((await md.text())).toContain('### 第一章测试')
    const docx = await fetch(`${base}/api/projects/${projectId}/export/manuscript?format=docx`)
    const docxBytes = new Uint8Array(await docx.arrayBuffer())
    expect(firstTwoBytes(docxBytes)).toBe('PK')
    const epub = await fetch(`${base}/api/projects/${projectId}/export/manuscript?format=epub`)
    expect(epub.headers.get('content-type')).toBe('application/epub+zip')
    const epubBytes = new Uint8Array(await epub.arrayBuffer())
    expect(firstTwoBytes(epubBytes)).toBe('PK')
    expect(new TextDecoder().decode(epubBytes.slice(0, 100))).toContain('mimetype')
  })
  it('项目内检索命中已写正文', async () => {
    const { status, data } = await call('GET', `/api/projects/${projectId}/search?q=${encodeURIComponent('导出用的正文')}`)
    expect(status).toBe(200); expect(data.results.length).toBeGreaterThan(0)
  })
})

describe('审查与生成', () => {
  it('规则审查可运行并列出问题', async () => {
    const projects = await call('GET', '/api/projects')
    const projectId = projects.data[0].id
    const run = await call('POST', `/api/projects/${projectId}/reviews/run`, {})
    expect(run.status).toBe(200); expect(Array.isArray(run.data.issues)).toBe(true)
    const list = await call('GET', `/api/projects/${projectId}/reviews`)
    expect(list.status).toBe(200)
  })
  it('本地规则模式生成不依赖 API Key', async () => {
    const projects = await call('GET', '/api/projects')
    const projectId = projects.data[0].id
    const gen = await call('POST', '/api/ai/generate', { projectId, task: 'chat', prompt: '测试' })
    expect(gen.status).toBe(200); expect(gen.data.output.length).toBeGreaterThan(0)
    expect(gen.data.model).toBe('local-rules-v1')
  })
  it('摘要重写在本地模式下返回 409 提示', async () => {
    const projects = await call('GET', '/api/projects')
    const chapters = await call('GET', `/api/projects/${projects.data[0].id}/chapters`)
    const withContent = chapters.data.find((row: { content: string }) => row.content.replace(/\s/g, '').length >= 40)
    if (!withContent) return
    const result = await call('POST', `/api/chapters/${withContent.id}/summary/rewrite`, {})
    expect(result.status).toBe(409)
  })
})
