import { db, sql } from './db.ts'
import { cosine, embedQuery, getEmbeddingModel, MIN_EMBEDDING_COVERAGE, projectEmbeddingCoverage } from './embeddings.ts'

export interface SearchHit {
  id: string
  sourceType: string
  sourceId: string
  chapterId: string | null
  content: string
  summary: string
  keywords: string
  score: number
  chapterDistance?: number | null
  reason?: string
  path?: 'lexical' | 'vector'
}

type ContextItem = { kind: string; label: string; text: string; priority: number; relevance: number; tokens: number }
type ContextReport = { tokenBudget: number; estimatedTokens: number; included: Array<{ kind: string; label: string; tokens: number }>; trimmed: Array<{ kind: string; label: string; tokens: number }> }
type AssembledContext = { text: string; hits: SearchHit[]; report: ContextReport }

const searchCache = new Map<string, SearchHit[]>()
const contextCache = new Map<string, AssembledContext>()

// CJK chars tokenize to roughly one token each on mainstream models; latin text ~4 chars/token.
// The old length/2.2 heuristic underestimated Chinese-heavy context by 1.5-4x and blew the budget.
const cjpPattern = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/g
export const estimateTokens = (text: string) => {
  const cjk = (text.match(cjpPattern) || []).length
  return Math.max(1, Math.ceil(cjk + (text.length - cjk) / 4))
}
const normalize = (value: string) => value.trim().toLowerCase()

function projectVersion(projectId: string) {
  const row = sql.get<Record<string, unknown>>(`SELECT p.updated_at,
    (SELECT COALESCE(MAX(updated_at), '') FROM entities WHERE project_id=p.id) entity_version,
    (SELECT COALESCE(MAX(updated_at), '') FROM story_facts WHERE project_id=p.id) fact_version,
    (SELECT COALESCE(MAX(updated_at), '') FROM events WHERE project_id=p.id) event_version,
    (SELECT COUNT(*) FROM memory_chunks WHERE project_id=p.id) memory_count
    FROM projects p WHERE p.id=?`, projectId)
  return `${row?.updated_at || ''}:${row?.entity_version || ''}:${row?.fact_version || ''}:${row?.event_version || ''}:${row?.memory_count || 0}`
}

function cacheSet<T>(cache: Map<string, T>, key: string, value: T, max: number) {
  cache.set(key, value)
  if (cache.size > max) cache.delete(cache.keys().next().value as string)
}

function baseTerms(query: string) {
  const chunks = query.trim().split(/[\s，。！？、；：,.;:!?（）()【】\[\]"'“”]+/).filter((item) => item.length > 1)
  return [...new Set(chunks.flatMap((chunk) => {
    if (!/[\u3400-\u9fff]/.test(chunk) || chunk.length <= 4) return [chunk]
    const slices = [chunk]
    for (let index = 0; index < chunk.length - 1; index += 2) slices.push(chunk.slice(index, index + 2))
    return slices
  }))].slice(0, 24)
}

function expandedTerms(projectId: string, query: string): { terms: string[]; entityMatches: number } {
  const terms = new Set(baseTerms(query))
  const normalizedQuery = normalize(query)
  let entityMatches = 0
  const entities = sql.all<{ name: string; data: string }>('SELECT name, data FROM entities WHERE project_id = ?', projectId)
  for (const entity of entities) {
    let aliases: string[] = []
    try {
      const data = JSON.parse(entity.data) as { aliases?: unknown }
      aliases = Array.isArray(data.aliases) ? data.aliases.map(String) : []
    } catch { /* legacy data remains searchable by canonical name */ }
    const names = [entity.name, ...aliases].filter(Boolean)
    if (names.some((name) => normalizedQuery.includes(normalize(name)))) {
      names.forEach((name) => terms.add(name))
      entityMatches += 1
    }
  }
  return { terms: [...terms].slice(0, 32), entityMatches }
}

function chapterPosition(chapterId?: string) {
  if (!chapterId) return undefined
  return sql.get<{ position: number }>('SELECT position FROM chapters WHERE id = ?', chapterId)?.position
}

function distanceWeight(distance: number | null) {
  if (distance === null) return 0.82
  return 1 / (1 + 0.3 * Math.log(1 + distance))
}

export interface EntityState {
  name: string
  lastEvent: string
  lastTime: string
  lastLocation: string
  eventCount: number
}

// Deterministic character state as of a chapter position: where each participant was last
// seen, in which event, at what story time. Derived from events only — no model guessing.
export function deriveEntityStates(projectId: string, beforePosition?: number): EntityState[] {
  const rows = sql.all<{ title: string; story_time: string; participants: string; location: string; position: number | null }>(
    `SELECT e.title, e.story_time, e.participants, e.location, c.position FROM events e
     LEFT JOIN chapters c ON c.id = e.chapter_id WHERE e.project_id = ? ORDER BY e.narrative_order`, projectId)
  const states = new Map<string, EntityState>()
  for (const row of rows) {
    if (beforePosition !== undefined && row.position !== null && row.position > beforePosition) continue
    let participants: string[] = []
    try { participants = JSON.parse(String(row.participants || '[]')) } catch { /* legacy rows */ }
    for (const name of participants) {
      if (typeof name !== 'string' || name.trim().length < 2) continue
      const state = states.get(name) || { name, lastEvent: '', lastTime: '', lastLocation: '', eventCount: 0 }
      state.eventCount += 1
      state.lastEvent = row.title
      if (row.story_time) state.lastTime = row.story_time
      if (row.location) state.lastLocation = row.location
      states.set(name, state)
    }
  }
  return [...states.values()]
}

// Gated retrieval, driven by the controlled experiment in eval/reports/: queries that
// name a known entity are best served by the tuned lexical hybrid (round 1: 100% vs 94%),
// name-free paraphrase queries by pure vectors (round 2: 100% vs 89%). Blind RRF fusion
// lost in both regimes, so this is an either/or gate, not a blend.
export async function searchMemory(projectId: string, query: string, limit = 12, currentChapterId?: string): Promise<SearchHit[]> {
  // 覆盖率进缓存键：向量回填会改变可用索引但不动 projectVersion，缺少这一位
  // 会让回填后的查询继续命中回填前的词法缓存。
  const cacheKey = `${projectVersion(projectId)}:${currentChapterId || ''}:${limit}:${normalize(query)}:${projectEmbeddingCoverage(projectId).toFixed(2)}`
  const cached = searchCache.get(cacheKey)
  if (cached) return cached
  const { terms: queryTerms, entityMatches } = expandedTerms(projectId, query)
  if (!queryTerms.length) return []
  const total = sql.get<{ count: number }>('SELECT COUNT(*) count FROM chapters WHERE project_id = ?', projectId)?.count ?? 0
  const candidateLimit = Math.min(Math.max(50, total * 3), 500)
  const currentPosition = chapterPosition(currentChapterId)
  const candidates = new Map<string, Record<string, unknown> & { rank?: number }>()
  const hasTrigram = Boolean(sql.get("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_search_fts'"))

  if (hasTrigram) {
    const match = queryTerms.filter((term) => term.length >= 3).map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ')
    if (match) {
      try {
        const rows = db.prepare(`SELECT m.*, bm25(memory_search_fts, 0, 1.3, 2.2, 1.6) rank
          FROM memory_search_fts JOIN memory_chunks m ON m.id = memory_search_fts.id
          WHERE memory_search_fts MATCH ? AND m.project_id = ? ORDER BY rank LIMIT ?`).all(match, projectId, candidateLimit) as Array<Record<string, unknown> & { rank: number }>
        rows.forEach((row) => candidates.set(String(row.id), row))
      } catch { /* malformed query falls through to parameterized substring recall */ }
    }
  }

  const strongest = [...queryTerms].sort((a, b) => b.length - a.length).slice(0, 8)
  const clauses = strongest.map(() => '(m.content LIKE ? OR m.summary LIKE ? OR m.keywords LIKE ?)').join(' OR ')
  if (clauses) {
    const params = strongest.flatMap((term) => [`%${term}%`, `%${term}%`, `%${term}%`])
    const rows = db.prepare(`SELECT m.* FROM memory_chunks m WHERE m.project_id = ? AND (${clauses}) LIMIT ?`)
      .all(projectId, ...params, candidateLimit) as Array<Record<string, unknown>>
    rows.forEach((row) => { if (!candidates.has(String(row.id))) candidates.set(String(row.id), row) })
  }

  const positions = new Map(sql.all<{ id: string; position: number }>('SELECT id, position FROM chapters WHERE project_id = ?', projectId).map((row) => [row.id, row.position]))
  const hits = [...candidates.values()].map((row) => {
    const haystack = normalize(`${row.summary} ${row.keywords} ${row.content}`)
    const matched = queryTerms.filter((term) => haystack.includes(normalize(term)))
    const lexical = Math.min(1, matched.reduce((sum, term) => sum + Math.min(term.length, 8), 0) / Math.max(8, queryTerms.slice(0, 8).reduce((sum, term) => sum + Math.min(term.length, 8), 0)))
    const rank = typeof row.rank === 'number' ? 1 / (1 + Math.abs(row.rank)) : 0.35
    const rowPosition = row.chapter_id ? positions.get(String(row.chapter_id)) : undefined
    const distance = currentPosition === undefined || rowPosition === undefined ? null : Math.abs(currentPosition - rowPosition)
    const proximity = distanceWeight(distance)
    const score = Math.min(1, lexical * 0.48 + rank * 0.26 + proximity * 0.16 + Number(row.importance) / 1000)
    return {
      id: String(row.id), sourceType: String(row.source_type), sourceId: String(row.source_id),
      chapterId: row.chapter_id ? String(row.chapter_id) : null, content: String(row.content),
      summary: String(row.summary), keywords: String(row.keywords), score: Number(score.toFixed(3)),
      chapterDistance: distance, reason: `${matched.slice(0, 4).join('、') || '全文相关'}${distance === null ? '' : `；距当前章 ${distance} 章`}`,
    }
  })
  const lexicalHits = hits.sort((a, b) => b.score - a.score).slice(0, limit).map((hit) => ({
    ...hit,
    path: 'lexical' as const,
  }))

  // 向量门控：仅在查询不含任何已知实体名、向量模型就绪且该项目覆盖率达标时启用。
  let finalHits: SearchHit[] = lexicalHits
  if (entityMatches === 0 && getEmbeddingModel()) {
    try {
      if (projectEmbeddingCoverage(projectId) >= MIN_EMBEDDING_COVERAGE) {
        const queryVector = await embedQuery(query)
        const rows = sql.all<{ id: string; chapter_id: string | null; source_type: string; source_id: string; content: string; summary: string; keywords: string; importance: number; embedding: string }>(
          "SELECT id, chapter_id, source_type, source_id, content, summary, keywords, importance, embedding FROM memory_chunks WHERE project_id = ? AND embedding != ''", projectId)
        const vectorHits = rows
          .map((row) => {
            let vector: number[] = []
            try { vector = JSON.parse(row.embedding) as number[] } catch { /* corrupted row falls back below */ }
            return { row, score: vector.length ? (cosine(queryVector, vector) + 1) / 2 : -1 }
          })
          .filter((item) => item.score >= 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit)
          .map(({ row, score }) => {
            const rowPosition = row.chapter_id ? positions.get(String(row.chapter_id)) : undefined
            const distance = currentPosition === undefined || rowPosition === undefined ? null : Math.abs(currentPosition - rowPosition)
            return {
              id: String(row.id), sourceType: String(row.source_type), sourceId: String(row.source_id),
              chapterId: row.chapter_id ? String(row.chapter_id) : null, content: String(row.content),
              summary: String(row.summary), keywords: String(row.keywords),
              score: Number(score.toFixed(3)), chapterDistance: distance,
              reason: '向量语义召回', path: 'vector' as const,
            } satisfies SearchHit
          })
        // 向量候选过少说明索引不完整，保留词法结果更稳
        if (vectorHits.length >= Math.min(limit, 3)) finalHits = vectorHits
      }
    } catch { /* 向量路径任何失败都回落词法 */ }
  }

  cacheSet(searchCache, cacheKey, finalHits, 240)
  return finalHits
}

function pickWithinBudget(items: ContextItem[], budget: number) {
  const included: ContextItem[] = []
  const trimmed: ContextItem[] = []
  let used = 0
  for (const item of items.sort((a, b) => (b.priority + b.relevance) - (a.priority + a.relevance))) {
    if (used + item.tokens <= budget) { included.push(item); used += item.tokens } else trimmed.push(item)
  }
  return { included, trimmed, used }
}

export async function assembleContext(projectId: string, prompt: string, chapterId?: string, tokenBudget = 10000): Promise<AssembledContext> {
  const cacheKey = `${projectVersion(projectId)}:${chapterId || ''}:${tokenBudget}:${normalize(prompt)}`
  const cached = contextCache.get(cacheKey)
  if (cached) return cached
  const project = sql.get<Record<string, unknown>>('SELECT * FROM projects WHERE id = ?', projectId)
  const chapter = chapterId ? sql.get<Record<string, unknown>>('SELECT title, summary, content, pov, position FROM chapters WHERE id = ?', chapterId) : undefined
  const volume = chapterId ? sql.get<Record<string, unknown>>(`SELECT v.title, v.summary FROM volumes v
    JOIN chapter_volume_bindings b ON b.volume_id=v.id WHERE b.chapter_id=?`, chapterId) : undefined
  const hits = await searchMemory(projectId, prompt, 16, chapterId)
  const allFacts = sql.all<Record<string, unknown>>(`SELECT f.*, c.title chapter_title FROM story_facts f
    LEFT JOIN chapters c ON c.id=f.source_chapter_id WHERE f.project_id=? AND f.canon_status IN ('canon','candidate')
    ORDER BY CASE f.canon_status WHEN 'canon' THEN 0 ELSE 1 END, f.importance DESC LIMIT 40`, projectId)
  const allEntities = sql.all<Record<string, unknown>>(`SELECT type, name, summary, data, canon_status, confidence FROM entities
    WHERE project_id=? AND canon_status IN ('canon','candidate') ORDER BY confidence DESC LIMIT 80`, projectId)
  const plotlines = sql.all<Record<string, unknown>>('SELECT name, type, summary, status FROM plotlines WHERE project_id=? AND status IN (?, ?)', projectId, 'active', 'candidate')
  const allEvents = sql.all<Record<string, unknown>>(`SELECT e.title, e.summary, e.story_time, e.status, c.position
    FROM events e LEFT JOIN chapters c ON c.id=e.chapter_id WHERE e.project_id=? ORDER BY e.narrative_order DESC LIMIT 60`, projectId)
  const referenceText = normalize(`${prompt} ${chapter?.summary || ''} ${hits.slice(0, 8).map((hit) => `${hit.summary} ${hit.content.slice(0, 350)}`).join(' ')}`)
  const entities = allEntities.map((row, index) => {
    let meta: Record<string, unknown> = {}; try { meta = JSON.parse(String(row.data)) } catch { /* ignore */ }
    const aliases = Array.isArray(meta.aliases) ? meta.aliases.map(String) : []
    const matched = [String(row.name), ...aliases].some((name) => name.length > 1 && referenceText.includes(normalize(name)))
    const pinned = meta.pinned === true || meta.pinned === 'true'
    return { row, meta, matched, pinned, index, rank: (matched ? 100 : 0) + (pinned ? 80 : 0) + Number(meta.contextPriority || 50) / 10 + Number(row.confidence || 0) }
  }).filter((item) => (item.matched || item.pinned || item.index < 8) && (!item.meta.contextScope || item.meta.contextScope !== 'manual' || item.matched || item.pinned))
    .sort((a, b) => b.rank - a.rank).slice(0, 18)
  const currentPosition = typeof chapter?.position === 'number' ? Number(chapter.position) : undefined
  const states = deriveEntityStates(projectId, currentPosition).filter((state) => referenceText.includes(normalize(state.name)) || normalize(state.name) === normalize(String(chapter?.pov || '')))
    .slice(0, 8)
  const events = allEvents.map((row) => {
    const matched = referenceText.includes(normalize(String(row.title))) || referenceText.includes(normalize(String(row.summary)).slice(0, 16))
    const distance = currentPosition === undefined || typeof row.position !== 'number' ? null : Math.abs(currentPosition - Number(row.position))
    return { row, rank: (matched ? 100 : 0) + distanceWeight(distance) * 25 }
  }).sort((a, b) => b.rank - a.rank).slice(0, 12).map((item) => item.row)
  const facts = allFacts.map((row) => {
    const matched = referenceText.includes(normalize(String(row.subject))) || referenceText.includes(normalize(String(row.value)).slice(0, 12))
    const distance = currentPosition === undefined ? null : Math.abs(currentPosition - Number(row.introduced_position || 0))
    return { row, matched, rank: (matched ? 100 : 0) + (row.canon_status === 'canon' ? 35 : 0) + Number(row.importance) / 5 + distanceWeight(distance) * 10 }
  }).sort((a, b) => b.rank - a.rank).slice(0, 20)
  const make = (kind: string, label: string, text: string, priority: number, relevance = 0): ContextItem => ({ kind, label, text, priority, relevance, tokens: estimateTokens(text) })
  const items: ContextItem[] = [
    make('project', '项目基线', `【项目】${project?.name ?? ''}\n题材：${project?.genre ?? ''}\n核心命题：${project?.premise ?? ''}`, 100),
    ...(chapter ? [make('chapter', `当前章节：${chapter.title}`, `【当前章节】${chapter.title}\n视角：${chapter.pov}\n摘要：${chapter.summary}\n正文末尾：${String(chapter.content).slice(-1800)}`, 98)] : []),
    ...states.map((state) => make('state', `人物状态：${state.name}`,
      `【人物状态】${state.name}：最近事件「${state.lastEvent}」${state.lastTime ? `（${state.lastTime}）` : ''}${state.lastLocation ? `@${state.lastLocation}` : ''}；累计参与 ${state.eventCount} 个事件。此后未再出场，不要让其知晓之后发生的事。`, 92)),
    ...(volume ? [make('volume', `所属卷：${volume.title}`, `【所属卷】${volume.title}\n卷摘要：${volume.summary || '尚未填写'}`, 88)] : []),
    ...plotlines.map((row) => make('plotline', `剧情线：${row.name}`, `【剧情线/${row.status}】${row.name}（${row.type}）：${row.summary}`, 78)),
    ...facts.map(({ row, matched }) => make('fact', `事实：${row.subject}`, `【事实/${row.canon_status}】${row.subject}｜${row.predicate}｜${row.value}${row.evidence ? `\n证据：${row.evidence}` : ''}`, row.canon_status === 'canon' ? 82 : 58, Number(row.importance) / 10 + (matched ? 25 : 0))),
    ...entities.map(({ row, meta, matched, pinned }) => {
      const priority = Number(meta.contextPriority || 50) + (pinned ? 25 : 0)
      return make('card', `资料卡：${row.name}`, `【资料卡/${row.type}/${row.canon_status}】${row.name}：${row.summary}`, 45 + priority / 2, matched ? 25 : 0)
    }),
    ...events.map((row) => make('event', `事件：${row.title}`, `【事件】${row.story_time || ''} ${row.title}：${row.summary}`, 48)),
    ...hits.map((hit, index) => make('evidence', `R${index + 1}：${hit.summary || hit.sourceType}`, `[R${index + 1}] ${hit.summary || hit.content.slice(0, 260)}`, 55, hit.score * 35)),
  ]
  const picked = pickWithinBudget(items, tokenBudget)
  const assembled: AssembledContext = {
    text: picked.included.map((item) => item.text).join('\n\n'), hits: hits.slice(0, 8),
    report: {
      tokenBudget, estimatedTokens: picked.used,
      included: picked.included.map(({ kind, label, tokens }) => ({ kind, label, tokens })),
      trimmed: picked.trimmed.map(({ kind, label, tokens }) => ({ kind, label, tokens })),
    },
  }
  cacheSet(contextCache, cacheKey, assembled, 80)
  return assembled
}
