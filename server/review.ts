import { sql } from './db.ts'

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
