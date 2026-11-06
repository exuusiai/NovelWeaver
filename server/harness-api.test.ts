import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
const { app } = await import('./index.ts')
const { setupFixture } = await import('../eval/harness-fixture.ts')
const { readEvidence } = await import('./harness/evidence.ts')
const { sql } = await import('./db.ts')
let server: Server
let base = ''
beforeAll(async () => {
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>((r) => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => {
  await new Promise<void>((r, reject) => server.close((e) => (e ? reject(e) : r())))
})
async function call<T = any>(method: string, url: string, body?: unknown) {
  const response = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, data: (await response.json()) as T }
}

describe('Harness HTTP 与共享历史恢复', () => {
  it('公开可序列化工具 Schema 与标准输入错误', async () => {
    const catalog = await call('GET', '/api/harness/tools')
    expect(catalog.status).toBe(200)
    expect(catalog.data.length).toBeGreaterThanOrEqual(15)
    expect(catalog.data.find((t: { name: string }) => t.name === 'revision.commit').inputSchema.required).toContain(
      'baseRevision',
    )
    const invalid = await call('POST', '/api/harness/runs', {})
    expect(invalid.status).toBe(400)
    expect(invalid.data.code).toBe('INVALID_INPUT')
  })
  it('未配置语义模型时可通过作者候选、检查、确认、导出和回放完成链路', async () => {
    const f = setupFixture()
    const created = await call('POST', '/api/harness/runs', f.request)
    expect(created.status).toBe(202)
    const id = created.data.id
    // All steps are local in this test; the HTTP turn yields until the background run pauses.
    let run = (await call('GET', `/api/harness/runs/${id}`)).data
    for (let i = 0; i < 30 && run.stopReason !== 'needs_check'; i++) {
      await new Promise((r) => setTimeout(r, 5))
      run = (await call('GET', `/api/harness/runs/${id}`)).data
    }
    expect(run.stopReason).toBe('needs_check')
    const replacement = f.chapters[0].content.replace('非常非常', '很')
    const proposal = await call('POST', `/api/harness/runs/${id}/call`, {
      tool: 'revision.propose',
      input: { manualReplacement: replacement },
    })
    expect(proposal.data.status).toBe('ok')
    const candidate = proposal.data.output.candidate
    const check = await call('POST', `/api/harness/runs/${id}/call`, {
      tool: 'revision.verify',
      input: { patchIds: ['manual-1'] },
    })
    expect(check.data.output.status).toBe('pending')
    const commit = await call('POST', `/api/harness/runs/${id}/call`, {
      tool: 'revision.commit',
      input: {
        baseRevision: 1,
        idempotencyKey: `api-commit-${id}`,
        candidateId: candidate.id,
        patchIds: ['manual-1'],
        acknowledgePending: true,
        authorEvaluation: { note: '作者逐字核验' },
      },
    })
    expect(commit.data.status).toBe('ok')
    const exported = await fetch(`${base}/api/harness/runs/${id}/export`)
    expect(exported.headers.get('content-type')).toContain('application/x-ndjson')
    const line = JSON.parse((await exported.text()).trim())
    expect(line.adoption).toHaveLength(1)
    const snap = await call('POST', `/api/harness/runs/${id}/snapshots`, {})
    expect(snap.status).toBe(201)
    const replay = await call('GET', `/api/harness/snapshots/${snap.data.id}/replay`)
    expect(replay.data.mode).toBe('recorded_observations')
  })
  it('编辑与历史恢复统一处理摘要、原文版本、细纲和派生记忆', async () => {
    const f = setupFixture()
    const id = f.chapters[0].id
    await call('PATCH', `/api/chapters/${id}/outline`, { content: '' })
    const edited = await call('PATCH', `/api/chapters/${id}`, { content: '陆宁把铜钥匙放进绿盒。', baseRevision: 1 })
    expect(edited.status).toBe(200)
    expect(edited.data.summary).toBe('')
    expect(edited.data.revision).toBeGreaterThan(1)
    expect(() => readEvidence(f.projectId, f.evidence.id)).toThrow()
    await call('PATCH', `/api/chapters/${id}/outline`, { content: '新的细纲' })
    const history = await call('GET', `/api/chapters/${id}/history`)
    const target = history.data.find((r: { fullContent: string }) => r.fullContent === f.chapters[0].content)
    const restored = await call('POST', `/api/chapters/${id}/history/${target.id}/restore`, {})
    expect(restored.status).toBe(200)
    expect(restored.data.content).toBe(f.chapters[0].content)
    expect(restored.data.summary).toBe(f.chapters[0].summary)
    expect(restored.data.detailed_outline).toBe('')
    expect(
      sql.get<{ validity: string }>('SELECT validity FROM source_bindings WHERE item_id=?', f.factId)?.validity,
    ).toBe('stale')
    expect(
      sql
        .all<{ content: string }>('SELECT content FROM memory_chunks WHERE chapter_id=?', id)
        .some((c) => c.content === f.chapters[0].content),
    ).toBe(true)
  })
})
