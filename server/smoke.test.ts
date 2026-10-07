process.env.NOVELWEAVER_DATA_DIR = ':memory:'
delete process.env.AI_API_KEY
delete process.env.AI_BASE_URL

// 端到端冒烟（API 级，离线）：创建项目 → 上传文稿 → 预览-提交导入 → 检索记忆 →
// 本地规则生成 → 规则审查与裁决 → 导出稿件。覆盖无 API Key 时的完整主链路。

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

async function json<T>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, data: await res.json().catch(() => null) as T }
}

const chapterText = (title: string, marker: string) =>
  `${title}\n\n${marker}。`.repeat(1) + '雨夜的港口亮着零星的灯，潮水一遍遍漫过石阶，把盐味送进每一扇没有关严的窗。'.repeat(12)

describe('离线全链路冒烟', () => {
  let projectId = ''

  it('创建项目并上传文稿预览', async () => {
    const created = await json<{ id: string }>('POST', '/api/projects', { name: '冒烟测试项目', premise: '港口城市的失踪案' })
    expect(created.status).toBe(201)
    projectId = created.data.id
    const text = `第一章 石阶\n\n${chapterText('第一章 石阶', '林雾在第七码头醒来')}\n\n第二章 灯塔\n\n${chapterText('第二章 灯塔', '季岚带林雾登上旧灯塔')}`
    const form = new FormData()
    form.append('file', new Blob([text], { type: 'text/plain' }), 'smoke.txt')
    const res = await fetch(`${base}/api/projects/${projectId}/import/preview`, { method: 'POST', body: form })
    expect(res.status).toBe(201)
    const preview = await res.json() as { id: string; chapters: unknown[] }
    expect(preview.chapters.length).toBeGreaterThanOrEqual(2)
    const committed = await json<{ chapters: number; analysisJobId: string }>('POST', `/api/projects/${projectId}/import/previews/${preview.id}/commit`, { replace: false })
    expect(committed.status).toBe(201)
    expect(committed.data.chapters).toBeGreaterThanOrEqual(2)
  })

  it('章节与记忆已写入，检索可命中', async () => {
    const chapters = await json<Array<{ id: string; title: string; content: string; summary: string }>>('GET', `/api/projects/${projectId}/chapters`)
    expect(chapters.data.length).toBeGreaterThanOrEqual(2)
    expect(chapters.data[0].content.length).toBeGreaterThan(100)
    const search = await json<{ results: Array<{ id: string; summary: string; score: number }> }>('GET', `/api/projects/${projectId}/search?q=${encodeURIComponent('第七码头的灯')}`)
    expect(search.status).toBe(200)
    expect(search.data.results.length).toBeGreaterThan(0)
    expect(search.data.results[0].score).toBeGreaterThan(0)
  })

  it('本地规则模式可生成并留档', async () => {
    const generation = await json<{ generationId: string; output: string; model: string; citations: unknown[] }>('POST', '/api/ai/generate', { projectId, task: 'analysis', prompt: '林雾在第一章的处境是什么？' })
    expect(generation.status).toBe(200)
    expect(generation.data.model).toBe('local-rules-v1')
    expect(generation.data.output).toContain('本地')
    expect(generation.data.generationId).toBeTruthy()
    // 上下文组装报告可用（离线也有检索证据进入快照）
    const context = await json<{ citations: unknown[]; report: { included: unknown[] } }>('POST', '/api/ai/context', { projectId, prompt: '林雾在第一章的处境是什么？' })
    expect(context.status).toBe(200)
    expect(context.data.citations.length).toBeGreaterThan(0)
  })

  it('规则审查发现问题并可裁决', async () => {
    const run = await json<{ issues: Array<{ id: string; category: string }> }>('POST', `/api/projects/${projectId}/reviews/run`, {})
    expect(run.status).toBe(200)
    expect(run.data.issues.length).toBeGreaterThan(0)
    const open = await json<Array<{ id: string; status: string }>>('GET', `/api/projects/${projectId}/reviews`)
    expect(open.data.some((issue) => issue.status === 'open')).toBe(true)
    const target = open.data[0]
    const patched = await json<{ status: string }>('PATCH', `/api/reviews/${target.id}`, { status: 'resolved' })
    expect(patched.status).toBe(200)
  })

  it('稿件可导出', async () => {
    const res = await fetch(`${base}/api/projects/${projectId}/export/manuscript?format=txt`)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('第一章')
    expect(text.replace(/\s/g, '').length).toBeGreaterThan(200)
  })
})
