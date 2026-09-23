import { db, sql } from './db.ts'
import { getGenerationCredentials } from './ai.ts'

// Embedding support for gated retrieval. Chunks carry pre-computed vectors in
// memory_chunks.embedding; queries are embedded on demand with a small LRU.
// Everything degrades silently to lexical search when no embedding model is
// configured, credentials are missing, or coverage is too low.

const EMBED_BATCH = 16
export const MIN_EMBEDDING_COVERAGE = 0.9
const QUERY_CACHE_MAX = 128

let embeddingModel = (process.env.AI_EMBEDDING_MODEL || '').trim()
let backfillRunning = false
const queryCache = new Map<string, number[]>()

export function getEmbeddingModel() {
  return embeddingModel
}

export function setEmbeddingModel(model: string) {
  embeddingModel = model.trim()
  if (embeddingModel) void kickBackfill()
}

export function embeddingStatus() {
  const total = (sql.get<{ n: number }>('SELECT COUNT(*) n FROM memory_chunks')?.n ?? 0)
  const embedded = (sql.get<{ n: number }>("SELECT COUNT(*) n FROM memory_chunks WHERE embedding != ''")?.n ?? 0)
  return {
    model: embeddingModel || null,
    enabled: Boolean(embeddingModel),
    total,
    embedded,
    coverage: total ? Number((embedded / total).toFixed(3)) : 1,
  }
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const { baseUrl, apiKey } = getGenerationCredentials()
  if (!apiKey) throw Object.assign(new Error('未配置模型 API，无法生成向量。'), { code: 'MODEL_REQUIRED' })
  const results: number[][] = []
  for (let offset = 0; offset < texts.length; offset += EMBED_BATCH) {
    const batch = texts.slice(offset, offset + EMBED_BATCH)
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: embeddingModel, input: batch }),
    })
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 160)
      throw new Error(`向量接口失败（HTTP ${res.status}）：${detail}`)
    }
    const data = await res.json() as { data: Array<{ index: number; embedding: number[] }> }
    const sorted = [...data.data].sort((a, b) => a.index - b.index)
    results.push(...sorted.map((item) => item.embedding))
  }
  return results
}

export async function embedQuery(query: string): Promise<number[]> {
  const key = embeddingModel + ':' + query.trim()
  const cached = queryCache.get(key)
  if (cached) return cached
  const [vector] = await embedTexts([query.trim()])
  queryCache.set(key, vector)
  if (queryCache.size > QUERY_CACHE_MAX) queryCache.delete(queryCache.keys().next().value as string)
  return vector
}

export function cosine(a: number[], b: number[]) {
  let dot = 0; let na = 0; let nb = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

// Coverage for one project's chunks; below MIN_COVERAGE the search layer falls
// back to lexical instead of serving a half-indexed vector view.
export function projectEmbeddingCoverage(projectId: string) {
  const row = sql.get<{ total: number; embedded: number }>(
    "SELECT COUNT(*) total, COALESCE(SUM(CASE WHEN embedding != '' THEN 1 ELSE 0 END), 0) embedded FROM memory_chunks WHERE project_id = ?", projectId)
  if (!row || row.total === 0) return 1
  return row.embedded / row.total
}

async function backfillSweep() {
  const rows = sql.all<{ id: string; text: string }>(
    "SELECT id, summary || ' ' || keywords || ' ' || content AS text FROM memory_chunks WHERE embedding = '' AND LENGTH(TRIM(text)) > 0 LIMIT 64")
  if (!rows.length) return 0
  const vectors = await embedTexts(rows.map((row) => row.text))
  const update = db.prepare('UPDATE memory_chunks SET embedding = ? WHERE id = ?')
  rows.forEach((row, index) => update.run(JSON.stringify(vectors[index]), row.id))
  return rows.length
}

export async function kickBackfill() {
  if (!embeddingModel || backfillRunning) return
  backfillRunning = true
  try {
    while (embeddingModel) {
      const done = await backfillSweep()
      if (!done) break
    }
  } catch (error) {
    console.error('[embeddings] backfill paused:', (error as Error).message)
  } finally {
    backfillRunning = false
  }
}

export function startEmbeddingSweeper() {
  // 间隔常驻：模型可能在运行期通过 /api/model 配置，回填失败后也由下一次清扫重试
  setInterval(() => { void kickBackfill() }, 60_000).unref()
  void kickBackfill()
}
