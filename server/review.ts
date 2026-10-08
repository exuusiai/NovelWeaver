import { z } from 'zod'
import { sql } from './db.ts'
import { parseModelJson } from './analyzer.ts'
import { structuredCompletion } from './ai.ts'

export interface PrecheckIssue {
  category: string
  severity: string
  title: string
  description: string
}

// Read-only rules check for one chapter, shown in the writing panel before generation.
// Unlike runReview() it never writes to the reviews table.
export function precheckChapter(chapterId: string): PrecheckIssue[] {
  const chapter = sql.get<{ id: string; project_id: string; title: string; content: string; summary: string; pov: string; status: string }>(
    'SELECT id, project_id, title, content, summary, pov, status FROM chapters WHERE id = ?', chapterId)
  if (!chapter) throw Object.assign(new Error('章节不存在。'), { status: 404 })
  const issues: PrecheckIssue[] = []
  if (!chapter.pov) issues.push({ category: 'pov', severity: 'medium', title: '本章未指定视角', description: '无法可靠检查角色知识边界，模型可能让未知情角色说出后文信息。' })
  if (!chapter.summary) issues.push({ category: 'structure', severity: 'medium', title: '本章缺少摘要', description: '摘要会进入后续章节的检索与上下文，缺失会降低跨章连续性。' })
  const length = chapter.content.replace(/\s/g, '').length
  if (length > 0 && length < 180) issues.push({ category: 'structure', severity: 'low', title: '正文较短', description: '可能是未完成草稿；生成前建议先确认本章目标。' })
  if (chapter.status === 'planned' && !sql.get('SELECT id FROM chapter_outlines WHERE chapter_id = ?', chapterId)) {
    issues.push({ category: 'structure', severity: 'low', title: '规划章还没有细纲', description: '可以先在写作台让 Agent 生成章节细纲，再进入正文。' })
  }
  const events = sql.all<{ id: string; title: string; story_time: string; participants: string }>('SELECT id, title, story_time, participants FROM events WHERE chapter_id = ?', chapterId)
  events.forEach((event) => {
    if (!event.story_time) issues.push({ category: 'timeline', severity: 'medium', title: `事件“${event.title}”缺少故事时间`, description: '时间缺失会导致前后章时序检查失效。' })
    if (JSON.parse(String(event.participants || '[]')).length === 0) issues.push({ category: 'logic', severity: 'low', title: `事件“${event.title}”没有参与者`, description: '无法进行人物状态与知识边界推演。' })
  })
  const openForeshadowing = sql.all<{ id: string; title: string }>(
    "SELECT id, title FROM foreshadowing WHERE project_id = ? AND setup_chapter_id = ? AND status != 'resolved'", chapter.project_id, chapterId)
  openForeshadowing.forEach((item) => issues.push({ category: 'foreshadowing', severity: 'low', title: `伏笔待回收：${item.title}`, description: '本章埋设的伏笔尚未标记回收，生成后续章节时可让它继续发酵。' }))
  return issues
}

// 候选事实差异提取器：与既有正史或同口径候选冲突的事实不改写任何数据，
// 只生成审查项交给作者裁决（架构预留边界 5 的落地）。
// 兼容判定：值完全一致或互相包含视为口径细化，不算冲突。
const normalizeValue = (value: string) => value.trim().replace(/\s+/g, '').replace(/[。.!！?？~～]+$/, '')

function valuesCompatible(a: string, b: string) {
  const left = normalizeValue(a)
  const right = normalizeValue(b)
  if (!left || !right) return true
  return left === right || left.includes(right) || right.includes(left)
}

function factConflicts(projectId: string): Array<{ category: string; severity: string; title: string; description: string; evidence: string[]; groupKey?: string }> {
  const rows = sql.all<{ id: string; subject: string; predicate: string; value: string; canon_status: string; chapter_title: string | null }>(
    `SELECT f.id, f.subject, f.predicate, f.value, f.canon_status, c.title chapter_title FROM story_facts f
     LEFT JOIN chapters c ON c.id = f.source_chapter_id WHERE f.project_id = ?`, projectId)
  const groups = new Map<string, typeof rows>()
  for (const row of rows) {
    const key = `${normalizeValue(row.subject)}|${normalizeValue(row.predicate)}`
    const group = groups.get(key)
    if (group) group.push(row)
    else groups.set(key, [row])
  }
  const issues: Array<{ category: string; severity: string; title: string; description: string; evidence: string[]; groupKey?: string }> = []
  for (const group of groups.values()) {
    if (issues.length >= 40) break
    if (group.length < 2) continue
    const canon = group.filter((row) => row.canon_status === 'canon')
    const candidates = group.filter((row) => row.canon_status === 'candidate')
    for (const candidate of candidates) {
      for (const established of canon) {
        if (valuesCompatible(candidate.value, established.value)) continue
        issues.push({
          category: 'fact-conflict', severity: 'high',
          title: `候选事实与正史冲突：${candidate.subject}·${candidate.predicate}`,
          description: `正史记载「${established.value}」（来源：${established.chapter_title || '全局资料'}），新候选为「${candidate.value}」（来源：${candidate.chapter_title || '全局资料'}）。候选不会自动改写正史；请确认候选（覆盖口径）或废弃候选。`,
          evidence: [candidate.id, established.id],
        })
      }
    }
    if (canon.length) continue
    for (let i = 0; i < candidates.length; i += 1) {
      for (let j = i + 1; j < candidates.length; j += 1) {
        if (valuesCompatible(candidates[i].value, candidates[j].value)) continue
        issues.push({
          category: 'fact-conflict', severity: 'medium',
          title: `候选事实相互分歧：${candidates[i].subject}·${candidates[i].predicate}`,
          description: `「${candidates[i].value}」（来源：${candidates[i].chapter_title || '全局资料'}）与「${candidates[j].value}」（来源：${candidates[j].chapter_title || '全局资料'}）不一致。可能是不同时间点的状态变化，也可能是提取噪声，请确认当前有效口径。`,
          evidence: [candidates[i].id, candidates[j].id],
        })
      }
    }
  }
  return issues
}

export function runReview(projectId: string) {
  sql.run('DELETE FROM reviews WHERE project_id = ? AND status = ?', projectId, 'open')
  const issues: Array<{ category: string; severity: string; title: string; description: string; evidence: string[]; groupKey?: string }> = []
  const chapters = sql.all<Record<string, unknown>>('SELECT id, title, content, summary, pov FROM chapters WHERE project_id = ? ORDER BY position', projectId)
  const candidates = sql.all<Record<string, unknown>>("SELECT id, name, type FROM entities WHERE project_id = ? AND canon_status = 'candidate'", projectId)
  const events = sql.all<Record<string, unknown>>('SELECT id, title, story_time, participants, location FROM events WHERE project_id = ?', projectId)
  const openForeshadowing = sql.all<Record<string, unknown>>("SELECT id, title, status FROM foreshadowing WHERE project_id = ? AND status != 'resolved'", projectId)

  chapters.forEach((chapter) => {
    if (!chapter.summary) issues.push({ category: 'structure', severity: 'medium', title: `《${chapter.title}》缺少摘要`, description: '缺少章节摘要会降低跨章节检索和上层摘要质量。', evidence: [String(chapter.id)], groupKey: 'chapter-missing-summary' })
    if (!chapter.pov) issues.push({ category: 'pov', severity: 'medium', title: `《${chapter.title}》未指定视角`, description: '无法可靠检查角色知识边界与视角漂移。', evidence: [String(chapter.id)], groupKey: 'chapter-missing-pov' })
    if (String(chapter.content).length < 180 && String(chapter.content).length > 0) issues.push({ category: 'structure', severity: 'low', title: `《${chapter.title}》正文较短`, description: '可能是尚未完成的草稿，也可能在导入时发生了章节切分错误。', evidence: [String(chapter.id)] })
  })
  candidates.forEach((entity) => issues.push({ category: 'canon', severity: 'medium', title: `“${entity.name}”仍是候选设定`, description: `该${entity.type}尚未确认进入正史，生成时只会作为低权重参考。`, evidence: [String(entity.id)], groupKey: 'entity-candidate' }))
  events.forEach((event) => {
    if (!event.story_time) issues.push({ category: 'timeline', severity: 'medium', title: `事件“${event.title}”缺少故事时间`, description: '无法判断该事件与人物状态、地点移动及其他事件的先后关系。', evidence: [String(event.id)], groupKey: 'event-missing-time' })
    if (JSON.parse(String(event.participants || '[]')).length === 0) issues.push({ category: 'logic', severity: 'low', title: `事件“${event.title}”没有参与者`, description: '建议至少绑定一名人物或势力，以便进行影响分析。', evidence: [String(event.id)], groupKey: 'event-no-participants' })
  })
  openForeshadowing.forEach((item) => issues.push({ category: 'foreshadowing', severity: item.status === 'open' ? 'medium' : 'low', title: `伏笔待回收：${item.title}`, description: '该伏笔尚未标记回收。它可能是有意保留，请根据计划确认回收章节。', evidence: [String(item.id)] }))
  issues.push(...factConflicts(projectId))

  // 聚合层：模式相同的机械问题（如全部事件缺时间）折叠成单条汇总，避免审查中心被
  // 数百条同质条目淹没；决策类问题（事实冲突等）永不折叠。
  const aggregated: typeof issues = []
  const groups = new Map<string, typeof issues>()
  for (const issue of issues) {
    if (!issue.groupKey) { aggregated.push(issue); continue }
    groups.set(issue.groupKey, [...(groups.get(issue.groupKey) || []), issue])
  }
  for (const [key, group] of groups) {
    if (group.length <= 3) { aggregated.push(...group); continue }
    const samples = group.slice(0, 5).map((issue) => issue.title).join('；')
    aggregated.push({
      ...group[0],
      title: `${group[0].title.split('：')[0].replace(/[《“][^》”]*[》”]/, '×N').trim()} 等 ${group.length} 项`,
      description: `${group[0].description}\n\n同类条目 ${group.length} 条，样例：${samples}${group.length > 5 ? '……' : ''}。\n【聚合模式】这一类是批量性的机械缺口，建议在对应模块统一处理，而不是逐条裁决。`,
      evidence: group.flatMap((issue) => issue.evidence).slice(0, 40),
      groupKey: key,
    })
  }
  aggregated.forEach((issue) => sql.run('INSERT INTO reviews (id, project_id, category, severity, title, description, evidence, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', sql.id(), projectId,
    issue.category, issue.severity, issue.title, issue.description, JSON.stringify(issue.evidence), 'open', sql.now()))
  return aggregated
}

// ---------- AI 自审（预判层） ----------
// 分层审查的第二层：聚合层折叠机械噪音后，决策类问题由模型做一次预判
// （可自动解决 / 建议忽略 / 需人工），连同理由写回 ai_suggestion。人仍是最终裁决者；
// 前端可一键按建议批量处理，也可逐条否决。
const auditSchema = z.object({
  verdicts: z.array(z.object({
    id: z.string(),
    verdict: z.enum(['auto_resolve', 'suggest_ignore', 'needs_human']),
    rationale: z.string().default(''),
    action: z.string().default(''),
  })).default([]),
})

export async function selfAuditReviews(projectId: string) {
  const open = sql.all<{ id: string; category: string; severity: string; title: string; description: string }>(
    "SELECT id, category, severity, title, description FROM reviews WHERE project_id = ? AND status = 'open' AND ai_suggestion = '' ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at LIMIT 24", projectId)
  if (!open.length) return { audited: 0, remaining: 0 }
  const digest = open.map((issue) => `- id=${issue.id} [${issue.category}/${issue.severity}] ${issue.title}\n  ${issue.description.replace(/\n/g, ' ').slice(0, 160)}`).join('\n')
  const system = `你是小说项目的连续性审查助手。对每个待处理审查项给出**预判**，帮助作者快速分流。判定标准：
- auto_resolve：机械性/批量性缺口或已由系统聚合的条目，处理动作明确（如"批量补时间""确认整批候选"），解决风险低；
- suggest_ignore：以现有信息看大概率是有意为之或误报（如作者刻意保留的伏笔、双胞胎"冲突"实为状态变化）；
- needs_human：涉及正史取舍、事实冲突裁决或信息不足，必须作者决定。
rationale 用一句话说明依据；action 写"作者只需做什么"（如"在剧情板批量补事件时间后重跑审查"）。只返回 JSON。`
  const prompt = `项目待处理审查项如下：\n${digest}\n\n返回 {"verdicts":[{"id":"对应id","verdict":"auto_resolve|suggest_ignore|needs_human","rationale":"一句依据","action":"作者只需做什么"}]}`
  let parsed: z.infer<typeof auditSchema>
  try {
    parsed = auditSchema.parse(parseModelJson(await structuredCompletion(system, prompt)))
  } catch (error) {
    throw Object.assign(new Error(`AI 预审失败：${(error as Error).message}`), { status: 502 })
  }
  let audited = 0
  for (const verdict of parsed.verdicts) {
    if (!open.some((issue) => issue.id === verdict.id)) continue
    sql.run("UPDATE reviews SET ai_suggestion = ? WHERE id = ?", JSON.stringify({ verdict: verdict.verdict, rationale: verdict.rationale, action: verdict.action }), verdict.id)
    audited += 1
  }
  const remaining = sql.get<{ n: number }>("SELECT COUNT(*) n FROM reviews WHERE project_id = ? AND status = 'open' AND ai_suggestion = ''", projectId)?.n ?? 0
  return { audited, remaining }
}
