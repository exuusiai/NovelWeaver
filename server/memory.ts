import { db, sql } from './db.ts'
import { selectSettings, packContext } from './context-selection.ts'
import { visibilityReason } from './provenance.ts'
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

export type ContextItem = { kind: string; label: string; text: string; priority: number; relevance: number; tokens: number }
type ContextReport = { tokenBudget: number; estimatedTokens: number; included: Array<{ kind: string; label: string; tokens: number }>; trimmed: Array<{ kind: string; label: string; tokens: number }> }
type AssembledContext = { text: string; hits: SearchHit[]; report: ContextReport }

const searchCache = new Map<string, SearchHit[]>()

// 向量召回缓存：每查询全表加载并 JSON.parse embedding 在万块级语料下是主要瓶颈；
// 以 projectVersion 为失效键缓存解析后的向量矩阵（不含 content，命中后仍按需取原文）。
interface VectorRow { id: string; chapterId: string | null; sourceType: string; sourceId: string; content: string; summary: string; keywords: string; importance: number; vector: number[] }
const vectorCache = new Map<string, { version: string; rows: VectorRow[] }>()

function projectVectors(projectId: string, version: string): VectorRow[] {
  const cached = vectorCache.get(projectId)
  if (cached && cached.version === version) return cached.rows
  const rows = sql.all<{ id: string; chapter_id: string | null; source_type: string; source_id: string; content: string; summary: string; keywords: string; importance: number; embedding: string }>(
    "SELECT id, chapter_id, source_type, source_id, content, summary, keywords, importance, embedding FROM memory_chunks WHERE project_id = ? AND embedding != ''", projectId)
  const parsed: VectorRow[] = []
  for (const row of rows) {
    try {
      const vector = JSON.parse(row.embedding) as number[]
      if (!vector.length) continue
      parsed.push({ id: row.id, chapterId: row.chapter_id, sourceType: row.source_type, sourceId: row.source_id, content: row.content, summary: row.summary, keywords: row.keywords, importance: row.importance, vector })
    } catch { /* corrupted embedding rows stay out of the index until re-backfill */ }
  }
  cacheSet(vectorCache, projectId, { version, rows: parsed }, 8)
  return parsed
}

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
    (SELECT COUNT(*) FROM memory_chunks WHERE project_id=p.id) memory_count,
    (SELECT COALESCE(SUM(revision),0) FROM chapters WHERE project_id=p.id) chapter_version
    FROM projects p WHERE p.id=?`, projectId)
  return `${row?.updated_at || ''}:${row?.entity_version || ''}:${row?.fact_version || ''}:${row?.event_version || ''}:${row?.memory_count || 0}:${row?.chapter_version || 0}`
}

function cacheSet<T>(cache: Map<string, T>, key: string, value: T, max: number) {
  cache.set(key, value)
  if (cache.size > max) cache.delete(cache.keys().next().value as string)
}

export function baseTerms(query: string) {
  const chunks = query.trim().split(/[\s，。！？、；：,.;:!?（）()【】\[\]"'“”]+/).filter((item) => item.length > 1)
  return [...new Set(chunks.flatMap((chunk) => {
    if (!/[\u3400-\u9fff]/.test(chunk) || chunk.length <= 4) return [chunk]
    const slices = [chunk]
    for (let index = 0; index < chunk.length - 1; index += 2) slices.push(chunk.slice(index, index + 2))
    return slices
  }))].slice(0, 24)
}

export function expandedTerms(projectId: string, query: string): { terms: string[]; entityNames: string[] } {
  const terms = new Set(baseTerms(query))
  const normalizedQuery = normalize(query)
  const entityNames: string[] = []
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
      entityNames.push(String(entity.name))
    }
  }
  return { terms: [...terms].slice(0, 32), entityNames }
}

function chapterPosition(chapterId?: string) {
  if (!chapterId) return undefined
  return sql.get<{ position: number }>('SELECT position FROM chapters WHERE id = ?', chapterId)?.position
}

function distanceWeight(distance: number | null) {
  if (distance === null) return 0.82
  return 1 / (1 + 0.3 * Math.log(1 + distance))
}

// 词项在语料中的稀有度决定其计分权重：出现于 35% 以上记忆块的泛化词
// （"什么""出现"这类高频二字组合）线性压到 0.15 倍，专名与低频实词保持原权。
// 没有 IDF 时，泛化词与专名按字符数等权计分，是 Top-8 噪声的主要来源之一。
function idfFactor(df: number, total: number) {
  const ratio = df / Math.max(1, total)
  if (ratio <= 0.35) return 1
  return Math.max(0.15, 1 - ((ratio - 0.35) / 0.65) * 0.85)
}

const dfCache = new Map<string, number>()
function chunkDf(projectId: string, version: string, term: string): number {
  const key = `${projectId}:${version}:${term}`
  const cached = dfCache.get(key)
  if (cached !== undefined) return cached
  const like = `%${term}%`
  const df = sql.get<{ n: number }>('SELECT COUNT(*) n FROM memory_chunks WHERE project_id = ? AND (content LIKE ? OR summary LIKE ? OR keywords LIKE ?)', projectId, like, like, like)?.n ?? 0
  cacheSet(dfCache, key, df, 4000)
  return df
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
export interface SearchMemoryOptions { excludeFuture?: boolean; lexicalOnly?: boolean }

export async function searchMemory(projectId: string, query: string, limit = 12, currentChapterId?: string, opts: SearchMemoryOptions = {}): Promise<SearchHit[]> {
  const version = projectVersion(projectId)
  // 覆盖率进缓存键：向量回填会改变可用索引但不动 projectVersion，缺少这一位
  // 会让回填后的查询继续命中回填前的词法缓存。
  const cacheKey = `${projectId}:${version}:${currentChapterId || ''}:${limit}:${normalize(query)}:${Boolean(opts.excludeFuture)}:${Boolean(opts.lexicalOnly)}:${projectEmbeddingCoverage(projectId).toFixed(2)}`
  const cached = searchCache.get(cacheKey)
  if (cached) return cached
  const { terms: queryTerms, entityNames } = expandedTerms(projectId, query)
  if (!queryTerms.length) return []
  const total = sql.get<{ count: number }>('SELECT COUNT(*) count FROM chapters WHERE project_id = ?', projectId)?.count ?? 0
  const chunkTotal = sql.get<{ n: number }>('SELECT COUNT(*) n FROM memory_chunks WHERE project_id = ?', projectId)?.n ?? 0
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
  const termWeight = (term: string) => Math.min(term.length, 8) * idfFactor(chunkDf(projectId, version, term), chunkTotal)
  const denominator = Math.max(8, queryTerms.slice(0, 8).reduce((sum, term) => sum + termWeight(term), 0))
  const hits = [...candidates.values()].filter(row => !visibilityReason(projectId, String(row.source_type), String(row.source_id), { audience: 'author' })).map((row) => {
    const haystack = normalize(`${row.summary} ${row.keywords} ${row.content}`)
    const matched = queryTerms.filter((term) => haystack.includes(normalize(term)))
    const lexical = Math.min(1, matched.reduce((sum, term) => sum + termWeight(term), 0) / denominator)
    const rank = typeof row.rank === 'number' ? 1 / (1 + Math.abs(row.rank)) : 0.35
    const rowPosition = row.chapter_id ? positions.get(String(row.chapter_id)) : undefined
    const distance = currentPosition === undefined || rowPosition === undefined ? null : Math.abs(currentPosition - rowPosition)
    const proximity = distanceWeight(distance)
    // 关系类查询命中 ≥2 个已知实体时，只有多实体共现块才是关系证据；
    // 单实体块曾占首无语料 Top-8 噪声的八成，共现加成把它们压出证据区。
    const presentEntities = entityNames.filter((name) => haystack.includes(normalize(name))).length
    const pairBonus = entityNames.length >= 2 ? Math.max(0, Math.min(2, presentEntities - 1)) * 0.14 : 0
    const score = Math.min(1, lexical * 0.48 + rank * 0.26 + proximity * 0.16 + Number(row.importance) / 1000 + pairBonus)
    return {
      id: String(row.id), sourceType: String(row.source_type), sourceId: String(row.source_id),
      chapterId: row.chapter_id ? String(row.chapter_id) : null, content: String(row.content),
      summary: String(row.summary), keywords: String(row.keywords), score: Number(score.toFixed(3)),
      chapterDistance: distance, reason: `${matched.slice(0, 4).join('、') || '全文相关'}${distance === null ? '' : `；距当前章 ${distance} 章`}`,
    }
  })
  const lexicalHits = hits
    .filter((hit) => {
      if (!opts.excludeFuture || currentPosition === undefined || hit.chapterId === null) return true
      const rowPosition = positions.get(hit.chapterId)
      return rowPosition === undefined || rowPosition <= currentPosition
    })
    .sort((a, b) => b.score - a.score).slice(0, limit).map((hit) => ({
    ...hit,
    path: 'lexical' as const,
  }))

  // 向量门控：仅在查询不含任何已知实体名、向量模型就绪且该项目覆盖率达标时启用。
  let finalHits: SearchHit[] = lexicalHits
  if (!opts.lexicalOnly && process.env.NOVELWEAVER_OFFLINE !== '1' && entityNames.length === 0 && getEmbeddingModel()) {
    try {
      if (projectEmbeddingCoverage(projectId) >= MIN_EMBEDDING_COVERAGE) {
        const queryVector = await embedQuery(query)
        const vectorHits = projectVectors(projectId, version)
          .map(({ vector, ...row }) => ({ row, score: (cosine(queryVector, vector) + 1) / 2 }))
          .filter((item) => {
            if (visibilityReason(projectId, item.row.sourceType, item.row.sourceId, { audience: 'author' })) return false
            if (!opts.excludeFuture || currentPosition === undefined || item.row.chapterId === null) return true
            const rowPosition = positions.get(String(item.row.chapterId))
            return rowPosition === undefined || rowPosition <= currentPosition
          })
          .sort((a, b) => b.score - a.score)
          .slice(0, limit)
          .map(({ row, score }) => {
            const rowPosition = row.chapterId ? positions.get(String(row.chapterId)) : undefined
            const distance = currentPosition === undefined || rowPosition === undefined ? null : Math.abs(currentPosition - rowPosition)
            return {
              id: String(row.id), sourceType: String(row.sourceType), sourceId: String(row.sourceId),
              chapterId: row.chapterId ? String(row.chapterId) : null, content: String(row.content),
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

// 全书宏观记忆：超长作品"越写越散"的根因是生成上下文只有章节/实体/事件粒度，
// 缺少全书层视角。这里从结构化数据确定性拼装一个紧凑块（卷结构、未回收伏笔、体量进度），
// 不经模型、不产生幻觉，注入 assembleContext 使每次生成都带着全书坐标系。
export function buildMacroMemory(projectId: string, beforePosition?: number): string {
  const project = sql.get<{ name: string; genre: string; premise: string; word_goal: number }>('SELECT name, genre, premise, word_goal FROM projects WHERE id = ?', projectId)
  if (!project) return ''
  const stats = sql.get<{ n: number; chars: number }>('SELECT COUNT(*) n, COALESCE(SUM(LENGTH(TRIM(content))), 0) chars FROM chapters WHERE project_id = ?', projectId) ?? { n: 0, chars: 0 }
  const sections: string[] = [`【全书概览】《${project.name}》${project.genre ? `· ${project.genre}` : ''} · 共 ${stats.n} 章 / ${stats.chars.toLocaleString()} 字${project.word_goal ? `（目标 ${project.word_goal.toLocaleString()}）` : ''}`]
  const volumes = sql.all<{ title: string; summary: string; chapters: number }>(
    `SELECT v.title, v.summary, (SELECT COUNT(*) FROM chapter_volume_bindings b WHERE b.volume_id = v.id) chapters
     FROM volumes v WHERE v.project_id = ? ORDER BY v.order_index LIMIT 6`, projectId)
  if (volumes.length) {
    sections.push(`【卷结构】${volumes.map((volume) => `${volume.title}${volume.summary ? `：${volume.summary.slice(0, 60)}` : ''}（${volume.chapters} 章）`).join('；')}`)
  }
  const openForeshadowing = sql.all<{ title: string; position: number | null }>(
    `SELECT f.title, c.position FROM foreshadowing f LEFT JOIN chapters c ON c.id = f.setup_chapter_id
     WHERE f.project_id = ? AND f.status != 'resolved'
     ${beforePosition !== undefined ? 'AND (c.position IS NULL OR c.position <= ?)' : ''}
     ORDER BY c.position LIMIT 8`, beforePosition !== undefined ? [projectId, beforePosition] : [projectId])
  if (openForeshadowing.length) {
    sections.push(`【未回收伏笔】${openForeshadowing.map((item) => `${item.title}${item.position !== null ? `（第 ${item.position + 1} 章埋设）` : ''}`).join('；')}`)
  }
  return sections.join('\n')
}

export interface ContextOptions {
  /** 编辑中的未保存正文：优先于数据库正文进入上下文 */
  content?: string
  /** 当前章细纲：显式注入，保证"AI 真正读了我的细纲" */
  outline?: string
  /** upto：只看本章及之前的剧情（回头修改前章时的正确模式）；full：全书视角（规划模式） */
  scope?: 'upto' | 'full'
}

export async function assembleContext(projectId: string, prompt: string, chapterId?: string, tokenBudget = 10000, options: ContextOptions = {}): Promise<AssembledContext> {
  const scope = options.scope ?? (chapterId ? 'upto' : 'full')
  const chapter = chapterId ? sql.get<{ title: string; content: string; pov: string; summary: string; story_tick: number | null }>('SELECT title,content,pov,summary,story_tick FROM chapters WHERE id=? AND project_id=?', chapterId, projectId) : undefined
  const identities = chapter ? sql.all<{ id: string }>("SELECT id FROM entities WHERE project_id=? AND type='character' AND name=?", projectId, chapter.pov) : []
  const selection = await selectSettings(projectId, prompt, { chapterId, audience: scope === 'full' ? 'author' : 'character', holderId: identities.length === 1 ? identities[0].id : undefined, storyTick: chapter?.story_tick ?? undefined })
  const make = (id: string, kind: string, label: string, text: string, priority: number) => ({ id, kind, label, text, priority, tokens: estimateTokens(text), reason: 'explicit_context', evidenceIds: [] as string[] })
  if (scope === 'full') {
    const macro = buildMacroMemory(projectId)
    if (macro) selection.items.push(make('macro', 'macro', '全书概览', macro, 90))
    const outline = sql.get<{ content: string; version: number }>("SELECT content,version FROM story_outlines WHERE project_id=? AND status='current' ORDER BY version DESC LIMIT 1", projectId)
    if (outline) selection.items.push(make('book-outline', 'book-outline', `全书大纲 v${outline.version}`, outline.content, 94))
  }
  if (chapter) {
    selection.items.push(make(chapterId!, 'chapter', `当前章节：${chapter.title}`, `【当前章节】${chapter.title}\n视角：${chapter.pov}\n正文：${options.content ?? chapter.content}`, 98))
    const outline = options.outline ?? sql.get<{ content: string }>('SELECT content FROM chapter_outlines WHERE chapter_id=?', chapterId)?.content
    if (outline) selection.items.push(make('chapter-outline', 'outline', '本章细纲（作者计划）', `【作者计划·角色不得表现知晓】${outline}`, 96))
  }
  const packed = packContext(selection, tokenBudget)
  // Legacy generation's [Rn] labels only enumerate evidence actually packed.
  const references = packed.evidence.filter(e => e.kind === 'chapter')
  let text = packed.text
  references.forEach((e, i) => { text = text.replace(`[${e.id}]`, `[R${i + 1}]`) })
  return { text, hits: references.map(e => ({ id: e.id, sourceType: e.kind, sourceId: e.sourceId, chapterId: e.chapterId, content: e.text, summary: e.text.slice(0, 120), keywords: '', score: 1, reason: e.basis })), report: packed.report }
}
