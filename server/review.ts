import { sql } from './db.ts'

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

export function runReview(projectId: string) {
  sql.run('DELETE FROM reviews WHERE project_id = ? AND status = ?', projectId, 'open')
  const issues: Array<{ category: string; severity: string; title: string; description: string; evidence: string[] }> = []
  const chapters = sql.all<Record<string, unknown>>('SELECT id, title, content, summary, pov FROM chapters WHERE project_id = ? ORDER BY position', projectId)
  const candidates = sql.all<Record<string, unknown>>("SELECT id, name, type FROM entities WHERE project_id = ? AND canon_status = 'candidate'", projectId)
  const events = sql.all<Record<string, unknown>>('SELECT id, title, story_time, participants, location FROM events WHERE project_id = ?', projectId)
  const openForeshadowing = sql.all<Record<string, unknown>>("SELECT id, title, status FROM foreshadowing WHERE project_id = ? AND status != 'resolved'", projectId)

  chapters.forEach((chapter) => {
    if (!chapter.summary) issues.push({ category: 'structure', severity: 'medium', title: `《${chapter.title}》缺少摘要`, description: '缺少章节摘要会降低跨章节检索和上层摘要质量。', evidence: [String(chapter.id)] })
    if (!chapter.pov) issues.push({ category: 'pov', severity: 'medium', title: `《${chapter.title}》未指定视角`, description: '无法可靠检查角色知识边界与视角漂移。', evidence: [String(chapter.id)] })
    if (String(chapter.content).length < 180 && String(chapter.content).length > 0) issues.push({ category: 'structure', severity: 'low', title: `《${chapter.title}》正文较短`, description: '可能是尚未完成的草稿，也可能在导入时发生了章节切分错误。', evidence: [String(chapter.id)] })
  })
  candidates.forEach((entity) => issues.push({ category: 'canon', severity: 'medium', title: `“${entity.name}”仍是候选设定`, description: `该${entity.type}尚未确认进入正史，生成时只会作为低权重参考。`, evidence: [String(entity.id)] }))
  events.forEach((event) => {
    if (!event.story_time) issues.push({ category: 'timeline', severity: 'medium', title: `事件“${event.title}”缺少故事时间`, description: '无法判断该事件与人物状态、地点移动及其他事件的先后关系。', evidence: [String(event.id)] })
    if (JSON.parse(String(event.participants || '[]')).length === 0) issues.push({ category: 'logic', severity: 'low', title: `事件“${event.title}”没有参与者`, description: '建议至少绑定一名人物或势力，以便进行影响分析。', evidence: [String(event.id)] })
  })
  openForeshadowing.forEach((item) => issues.push({ category: 'foreshadowing', severity: item.status === 'open' ? 'medium' : 'low', title: `伏笔待回收：${item.title}`, description: '该伏笔尚未标记回收。它可能是有意保留，请根据计划确认回收章节。', evidence: [String(item.id)] }))

  issues.forEach((issue) => sql.run('INSERT INTO reviews VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', sql.id(), projectId,
    issue.category, issue.severity, issue.title, issue.description, JSON.stringify(issue.evidence), 'open', sql.now()))
  return issues
}
