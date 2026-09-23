process.env.NOVELWEAVER_DATA_DIR = ':memory:'
delete process.env.AI_API_KEY

// Static imports are hoisted before env assignment — import server modules dynamically.
import { afterEach, describe, expect, it, vi } from 'vitest'
const { sql } = await import('../server/db.ts')
const { searchMemory } = await import('../server/memory.ts')
const { setEmbeddingModel, embeddingStatus } = await import('../server/embeddings.ts')
const { setRuntimeConfig } = await import('../server/ai.ts')

const stamp = () => new Date().toISOString()
const projectId = 'gated-retrieval-0000-0000'
sql.run('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', projectId, '门控检索测试', '测试', '验证检索门控', 'active', 100000, 0, stamp(), stamp())
// 三个记忆块，预填向量：内容 A/B 与"哑谜"语义近、C 无关。这里用可区分的向量：
// 查询向量 mock 返回 [1, 0]，块 A=[1,0]（cos=1）、B=[0.9,0.1]、C=[0,1]（cos=0）
const insertChunk = (id: string, content: string, vector: number[]) => {
  sql.run('INSERT INTO memory_chunks (id, project_id, source_type, source_id, content, summary, keywords, importance, embedding, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, projectId, 'chapter', null, content, content.slice(0, 10), content.slice(0, 6), 50, JSON.stringify(vector), stamp())
}
insertChunk('gate-vec-a', '哑谜在黑暗中的密室里低声数着谜语。', [1, 0])
insertChunk('gate-vec-b', '哑谜沿着通道走向了山下王座的殿堂。', [0.9, 0.1])
insertChunk('gate-vec-c', '港城的白塔在退潮后敲响了钟声。', [0, 1])
sql.run(`INSERT INTO entities VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 'gate-en1', projectId, 'character', '季岚', '巡潮人。', '{}', 'canon', 1, null, stamp(), stamp())

afterEach(() => {
  vi.unstubAllGlobals()
  setEmbeddingModel('')
  setRuntimeConfig({ apiKey: '' })
})

const mockEmbeddings = () => {
  // 每次调用生成新 Response（body 只能读一次），并按输入数量返回向量，
  // 避免后台回填与查询向量竞争同一个已消费的响应体。
  const fetchMock = vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body || '{}') as { input: unknown[] }
    return new Response(JSON.stringify({
      data: (body.input || []).map((_, index) => ({ index, embedding: [1, 0] })),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetchMock)
  setRuntimeConfig({ baseUrl: 'https://example.test/v1', apiKey: 'test-key', model: 'test-model' })
}

describe('检索门控', () => {
  it('未配置 Embedding 模型时全部走词法', async () => {
    const hits = await searchMemory(projectId, '港城的白塔钟声', 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((hit) => hit.path === 'lexical')).toBe(true)
  })

  it('查询不含实体名且覆盖率达标 → 向量语义召回', async () => {
    mockEmbeddings()
    setEmbeddingModel('test-embed')
    const hits = await searchMemory(projectId, '黑暗中数谜语的怪人', 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].path).toBe('vector')
    expect(hits[0].reason).toContain('向量语义召回')
    expect(hits[0].id).toBe('gate-vec-a')
  })

  it('查询命中已知实体名 → 强制词法（实验第一轮结论）', async () => {
    mockEmbeddings()
    setEmbeddingModel('test-embed')
    const hits = await searchMemory(projectId, '季岚和港城白塔的钟声', 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((hit) => hit.path === 'lexical')).toBe(true)
  })

  it('向量覆盖率不足 → 回落词法', async () => {
    mockEmbeddings()
    setEmbeddingModel('test-embed')
    sql.run('UPDATE memory_chunks SET embedding = ? WHERE id = ?', '', 'gate-vec-c')
    expect(embeddingStatus().coverage).toBeLessThan(1)
    const hits = await searchMemory(projectId, '黑暗中数谜语的怪人', 5)
    expect(hits.every((hit) => hit.path === 'lexical')).toBe(true)
    sql.run('UPDATE memory_chunks SET embedding = ? WHERE id = ?', JSON.stringify([0, 1]), 'gate-vec-c')
  })

  it('查询向量接口失败 → 静默回落词法', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"error":{"message":"boom"}}', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)
    setRuntimeConfig({ baseUrl: 'https://example.test/v1', apiKey: 'test-key', model: 'test-model' })
    setEmbeddingModel('test-embed')
    const hits = await searchMemory(projectId, '黑暗中数谜语的人', 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((hit) => hit.path === 'lexical')).toBe(true)
  })
})
