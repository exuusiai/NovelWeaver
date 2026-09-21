import { z } from 'zod'
import { jsonrepair } from 'jsonrepair'
import { structuredCompletion } from './ai.ts'

export interface AnalysisChapter {
  id: string
  title: string
  content: string
}

const entitySchema = z.object({
  type: z.enum(['character', 'location', 'faction', 'system', 'item', 'world', 'term']),
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  summary: z.string().default(''),
  data: z.record(z.string(), z.unknown()).default({}),
  evidence: z.array(z.string()).default([]),
})
const eventSchema = z.object({
  title: z.string().min(1),
  summary: z.string().default(''),
  chapterTitle: z.string().default(''),
  storyTime: z.string().default(''),
  participants: z.array(z.string()).default([]),
  location: z.string().default(''),
  cause: z.string().default(''),
  consequence: z.string().default(''),
})
const relationSchema = z.object({
  from: z.string().min(1), to: z.string().min(1), type: z.string().default('association'), label: z.string().default(''),
  sentiment: z.enum(['positive', 'neutral', 'mixed', 'negative']).default('neutral'),
  strength: z.number().min(0).max(100).default(50), evidence: z.string().default(''),
})
const batchSchema = z.object({ entities: z.array(entitySchema).default([]), events: z.array(eventSchema).default([]), relations: z.array(relationSchema).default([]) })
const plotSchema = z.object({ plotlines: z.array(z.object({
  name: z.string().min(1),
  type: z.enum(['main', 'subplot', 'character', 'mystery', 'romance']).default('subplot'),
  summary: z.string().default(''),
  eventTitles: z.array(z.string()).default([]),
})).default([]) })

export type AnalysisEntity = z.infer<typeof entitySchema>
export type AnalysisEvent = z.infer<typeof eventSchema>
export type AnalysisPlotline = z.infer<typeof plotSchema>['plotlines'][number]
export type AnalysisRelation = z.infer<typeof relationSchema>

const systemPrompt = `你是严谨的中文小说文稿分析器。只提取原文明确支持的信息，不补写、不猜测。
人物必须是有专名的个体；“我、他、巫师、巡警、可以、如果”等代词、职业或普通词绝不是人物名。
地点、势力、体系和物品同样必须有明确专名。合并同一对象的简称、全名、译名，以及仅增加职业或称谓后缀的名字（如“小明”和“小明医生”），把其他称呼放入 aliases。
必须区分“普通别称”和“独立叙事身份”：先生、医生、队长等称谓不是新人物；但作品有意把化名、人格面具或不同公开身份作为独立身份叙述时，应保留为独立人物实体，并建立 type=\"same_person\"、label=\"同一人的不同身份\"的关系。没有原文证据不得建立身份关系。
事件应是改变目标、关系、知识、资源或风险的具体情节，不要把目录和说明文字当事件。
所有提取内容都是候选，不得声称为正史。只返回有效 JSON，不要 Markdown。`

function balancedObjects(value: string) {
  const objects: string[] = []
  for (let start = value.indexOf('{'); start >= 0; start = value.indexOf('{', start + 1)) {
    let depth = 0; let quoted = false; let escaped = false
    for (let index = start; index < value.length; index += 1) {
      const char = value[index]
      if (quoted) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') quoted = false
      } else if (char === '"') quoted = true
      else if (char === '{') depth += 1
      else if (char === '}' && --depth === 0) { objects.push(value.slice(start, index + 1)); break }
    }
    if (objects.length) break
  }
  return objects
}

export function parseModelJson(raw: string) {
  if (!raw.trim()) throw new Error('模型返回了空内容。')
  const cleaned = raw.replace(/^\uFEFF/, '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<analysis>[\s\S]*?<\/analysis>/gi, '').trim()
  const fenced = [...cleaned.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1].trim())
  const sources = [...fenced, cleaned]
  const parseObject = (candidate: string) => {
    const parsed = JSON.parse(candidate) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON 顶层不是对象。')
    return parsed
  }
  for (const source of sources) {
    const start = source.indexOf('{'); const end = source.lastIndexOf('}')
    const candidates = [source, ...balancedObjects(source), ...(start >= 0 ? [source.slice(start, end >= start ? end + 1 : undefined)] : [])]
    for (const candidate of candidates) {
      try { return parseObject(candidate) } catch { /* try repaired JSON */ }
      try { return parseObject(jsonrepair(candidate)) } catch { /* try next candidate */ }
    }
  }
  throw new Error(`模型返回了 ${raw.length} 个字符，但内容不是有效 JSON。`)
}

async function structuredJson<T>(schema: z.ZodType<T>, prompt: string, stage: string, attempts = 2) {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const retry = attempt ? '\n\n上次响应无法解析。此次必须从 { 开始、以 } 结束，只输出一个符合上述字段结构的 JSON 对象；不要输出思考过程、解释或 Markdown。' : ''
    let raw: string
    try {
      raw = await structuredCompletion(systemPrompt, prompt + retry)
    } catch (error) {
      const code = (error as { code?: string }).code
      if (!['MODEL_OUTPUT_TRUNCATED', 'MODEL_EMPTY_RESPONSE'].includes(code || '')) throw error
      lastError = error
      continue
    }
    try { return schema.parse(parseModelJson(raw)) }
    catch (error) { lastError = error }
  }
  const detail = lastError instanceof z.ZodError ? '返回 JSON 的字段结构不符合约定。' : (lastError as Error)?.message || '未知解析错误。'
  throw Object.assign(new Error(`${stage}失败：模型没有返回可用的结构化结果。${detail}`), { code: 'MODEL_JSON_INVALID' })
}

function batches(chapters: AnalysisChapter[], maxChars = 18000) {
  const output: AnalysisChapter[][] = []
  let current: AnalysisChapter[] = []
  let size = 0
  for (const chapter of chapters) {
    if (current.length && size + chapter.content.length > maxChars) { output.push(current); current = []; size = 0 }
    if (chapter.content.length > maxChars) {
      for (let offset = 0; offset < chapter.content.length; offset += maxChars) {
        output.push([{ ...chapter, title: `${chapter.title}（片段 ${Math.floor(offset / maxChars) + 1}）`, content: chapter.content.slice(offset, offset + maxChars) }])
      }
    } else { current.push(chapter); size += chapter.content.length }
  }
  if (current.length) output.push(current)
  return output
}

const characterSuffixes = [
  '主任医师', '副教授', '总经理', '董事长', '掌柜的', '大祭司', '工程师', '设计师', '魔法师', '预言家',
  '医生', '医师', '护士', '老师', '教授', '校长', '警官', '警探', '巡警', '刑警', '队长', '局长',
  '先生', '女士', '小姐', '夫人', '少爷', '神父', '牧师', '侦探', '律师', '记者', '老板', '掌柜', '船长',
].sort((left, right) => right.length - left.length)

function normalizedName(value: string) {
  return value.trim().toLowerCase().replace(/[\s·•・]/g, '')
}

export function characterNameVariants(value: string) {
  const normalized = normalizedName(value)
  const variants = new Set([normalized])
  for (const suffix of characterSuffixes) {
    if (!normalized.endsWith(suffix)) continue
    const base = normalized.slice(0, -suffix.length)
    if (base.length >= 2) variants.add(base)
  }
  return variants
}

export function mergeEntities(items: AnalysisEntity[], relations: AnalysisRelation[] = []) {
  const merged: AnalysisEntity[] = []
  const identityNames = new Set(relations.filter((relation) => ['same_person', 'identity_of'].includes(relation.type)).flatMap((relation) => [normalizedName(relation.from), normalizedName(relation.to)]))
  for (const item of items) {
    const names = new Set([item.name, ...item.aliases].flatMap((name) => item.type === 'character' ? [...characterNameVariants(name)] : [normalizedName(name)]))
    const preserveIdentity = item.type === 'character' && identityNames.has(normalizedName(item.name))
    const existing = preserveIdentity ? undefined : merged.find((candidate) => {
      if (candidate.type !== item.type || (candidate.type === 'character' && identityNames.has(normalizedName(candidate.name)))) return false
      return [candidate.name, ...candidate.aliases].some((name) => {
        const variants = candidate.type === 'character' ? characterNameVariants(name) : new Set([normalizedName(name)])
        return [...variants].some((variant) => names.has(variant))
      })
    })
    if (!existing) { merged.push(item); continue }
    existing.aliases = [...new Set([...existing.aliases, item.name, ...item.aliases].filter((name) => name !== existing.name))]
    existing.evidence = [...new Set([...existing.evidence, ...item.evidence])].slice(0, 8)
    existing.summary = existing.summary.length >= item.summary.length ? existing.summary : item.summary
    existing.data = { ...existing.data, ...Object.fromEntries(Object.entries(item.data).filter(([, value]) => value !== '' && value != null)) }
  }
  return merged
}

export interface AnalysisOptions {
  continueOnError?: boolean
  onProgress?: (progress: { completed: number; total: number; chapterIds: string[]; stage: string }) => void | Promise<void>
  shouldPause?: () => boolean
}

export async function analyzeManuscript(chapters: AnalysisChapter[], options: AnalysisOptions = {}) {
  if (!chapters.length) return { entities: [], events: [], plotlines: [], relations: [], batches: 0, failures: [] as Array<{ chapterIds: string[]; message: string }> }
  const entityRows: AnalysisEntity[] = []
  const eventRows: AnalysisEvent[] = []
  const relationRows: AnalysisRelation[] = []
  const chapterBatches = batches(chapters)
  let processedBatches = 0
  const failures: Array<{ chapterIds: string[]; message: string }> = []
  const analysisPrompt = (group: AnalysisChapter[]) => {
    const manuscript = group.map((chapter) => `\n<<<章节：${chapter.title}>>>\n${chapter.content}`).join('\n')
    return `分析以下文稿。返回：
{"entities":[{"type":"character|location|faction|system|item|world|term","name":"规范专名","aliases":[],"summary":"仅含明确事实的摘要","data":{},"evidence":["章节名：不超过40字的原文证据"]}],"events":[{"title":"事件名","summary":"事件发生了什么以及造成何种状态变化","chapterTitle":"原章节名","storyTime":"原文明示的时间或空字符串","participants":["规范人物名"],"location":"规范地点名或空字符串","cause":"明确原因或空字符串","consequence":"明确结果或空字符串"}],"relations":[{"from":"实体规范名","to":"实体规范名","type":"family|alliance|enemy|same_person|member|located_at 等","label":"中文关系标签","sentiment":"positive|neutral|mixed|negative","strength":50,"evidence":"简短原文依据"}]}
data 按类型填写：人物 aliases/narrativeIdentities/role/fullName/pronouns/age/birth/species/occupation/faction/appearance/distinguishingMarks/health/personality/desire/need/fear/flaw/falseBelief/bottomLine/secret/strengths/weaknesses/abilities/knowledge/voice/mannerisms/background/trauma/arc/status/possessions；地点 geography/terrain/climate/districts/access/transport/population/species/governance/law/economy/resources/culture/language/religion/customs/food/architecture/hazards/history/currentConflict/sceneUse；势力 type/ideology/goal/leader/headquarters/hierarchy/ranks/recruitment/members/resources/territory/methods/laws/allies/enemies/reputation/internalConflict/history/status；体系 category/source/principles/tiers/acquisition/training/activation/abilities/cost/limitations/counters/exceptions/artifacts/users/institutions/socialImpact/history；物品 category/owner/creator/origin/appearance/material/function/activation/limitations/cost/status/location/history/symbolism；世界 era/calendar/geography/cosmology/species/politics/law/economy/resources/religion/technology/transport/languages/education/customs/dailyLife/conflicts/history；术语 definition/aliases/category/usage/origin/firstAppearance/relatedTerms/misconceptions。
保持精确简洁：summary、cause、consequence 和 data 中每个文本字段不超过 120 字；每个实体最多 2 条 evidence；数组去重且不超过 12 项。不要为了填满字段而推测。
${manuscript}`
  }
  const compactAnalysisPrompt = (group: AnalysisChapter[]) => {
    const manuscript = group.map((chapter) => `\n<<<章节：${chapter.title}>>>\n${chapter.content}`).join('\n')
    return `快速提取以下文稿中的专名实体、关键事件和明确关系。只输出紧凑 JSON：
{"entities":[{"type":"character|location|faction|system|item|world|term","name":"专名","aliases":[],"summary":"不超过60字","data":{},"evidence":["一条不超过30字的证据"]}],"events":[{"title":"不超过20字","summary":"不超过80字","chapterTitle":"章节名","participants":[],"location":"","cause":"","consequence":""}],"relations":[{"from":"实体名","to":"实体名","type":"association","label":"关系","sentiment":"neutral","strength":50,"evidence":"不超过30字"}]}
宁可省略次要细节，也必须返回完整闭合的 JSON。不要解释，不要思考过程，不要 Markdown。\n${manuscript}`
  }
  const analyzeGroup = async (group: AnalysisChapter[], label: string, depth = 0): Promise<z.infer<typeof batchSchema>> => {
    processedBatches += 1
    try {
      const size = group.reduce((sum, chapter) => sum + chapter.content.length, 0)
      return await structuredJson(batchSchema, analysisPrompt(group), label, size <= 6000 ? 2 : 1)
    } catch (error) {
      const code = (error as { code?: string }).code
      const size = group.reduce((sum, chapter) => sum + chapter.content.length, 0)
      const retryable = ['MODEL_JSON_INVALID', 'MODEL_OUTPUT_TRUNCATED', 'MODEL_EMPTY_RESPONSE'].includes(code || '')
      if (!retryable) throw error
      if (size <= 3500 || depth >= 3) {
        return structuredJson(batchSchema, compactAnalysisPrompt(group), `${label}（精简字段模式）`, 2)
      }
      const smaller = batches(group, Math.max(3500, Math.ceil(size / 2)))
      if (smaller.length < 2) throw error
      const combined: z.infer<typeof batchSchema> = { entities: [], events: [], relations: [] }
      for (const [partIndex, part] of smaller.entries()) {
        const parsed = await analyzeGroup(part, `${label}（自适应拆分 ${partIndex + 1}/${smaller.length}）`, depth + 1)
        combined.entities.push(...parsed.entities)
        combined.events.push(...parsed.events)
        combined.relations.push(...parsed.relations)
      }
      return combined
    }
  }
  for (const [batchIndex, group] of chapterBatches.entries()) {
    while (options.shouldPause?.()) await new Promise((resolve) => setTimeout(resolve, 800))
    try {
      const parsed = await analyzeGroup(group, `第 ${batchIndex + 1}/${chapterBatches.length} 批文稿分析`)
      entityRows.push(...parsed.entities)
      eventRows.push(...parsed.events)
      relationRows.push(...parsed.relations)
    } catch (error) {
      if (!options.continueOnError) throw error
      failures.push({ chapterIds: [...new Set(group.map((chapter) => chapter.id))], message: (error as Error).message })
    }
    await options.onProgress?.({ completed: batchIndex + 1, total: chapterBatches.length, chapterIds: group.map((chapter) => chapter.id), stage: 'extracting' })
  }

  const entities = mergeEntities(entityRows, relationRows)
  const eventKey = new Set<string>()
  const events = eventRows.filter((event) => {
    const key = `${event.chapterTitle}|${event.title}|${event.summary.slice(0, 40)}`
    if (eventKey.has(key)) return false
    eventKey.add(key); return true
  })
  const digest = events.slice(0, 220).map((event, index) => `${index + 1}. [${event.chapterTitle}] ${event.title}：${event.summary}`).join('\n')
  const plotlines = (await structuredJson(plotSchema, `根据按叙事顺序排列的事件，归纳真实存在的剧情线。不要套用三幕式，不要凭空补情节。返回：
{"plotlines":[{"name":"剧情线名称","type":"main|subplot|character|mystery|romance","summary":"核心问题、发展和当前状态","eventTitles":["完全匹配的事件名"]}]}
至少有一条主线；只保留贯穿两个以上事件的线索。若没有足够事件，返回空数组。\n\n${digest}`, '剧情线归纳')).plotlines
  const relationKeys = new Set<string>()
  const relations = relationRows.filter((relation) => {
    const key = `${relation.from}|${relation.to}|${relation.type}`
    if (relationKeys.has(key) || relation.from === relation.to) return false
    relationKeys.add(key); return true
  })
  return { entities, events, plotlines, relations, batches: processedBatches, failures }
}
