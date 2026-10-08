process.env.NOVELWEAVER_DATA_DIR = ':memory:'

// Static imports are hoisted before env assignment — import server modules dynamically.
import { describe, expect, it } from 'vitest'
const { sql } = await import('../server/db.ts')
const { runReview } = await import('../server/review.ts')

const stamp = () => new Date().toISOString()
const projectId = 'fact-conflict-0000-0000'
sql.run('INSERT INTO projects (id, name, genre, premise, status, word_goal, imported, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', projectId, '事实冲突测试', '测试', '验证候选事实差异提取器', 'active', 100000, 0, stamp(), stamp())
const insertChapter = (id: string, title: string, position: number) => {
  sql.run('INSERT INTO chapters (id, project_id, title, content, position, status, summary, pov, target_words, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, projectId, title, `第一章正文 ${id}`.repeat(30), position, 'imported', `${title}摘要`, '比尔博', 3000, stamp(), stamp())
}
insertChapter('fc-ch-1', '第一章', 0)
insertChapter('fc-ch-2', '第二章', 1)

const insertFact = (id: string, subject: string, predicate: string, value: string, canonStatus: string, chapterId: string) => {
  sql.run('INSERT INTO story_facts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, projectId, subject, predicate, value, chapterId, 1, 50, canonStatus, '', stamp(), stamp())
}

// 与正史同口径但值不同 → 高危冲突
insertFact('fc-f-1', '比尔博', '种族', '霍比特人', 'canon', 'fc-ch-1')
insertFact('fc-f-2', '比尔博', '种族', '精灵', 'candidate', 'fc-ch-2')
// 值互相包含 → 口径细化，不算冲突
insertFact('fc-f-3', '索林', '身份', '流亡王储', 'candidate', 'fc-ch-1')
insertFact('fc-f-4', '索林', '身份', '都灵一脉的流亡王储', 'candidate', 'fc-ch-2')
// 无正史时两条候选分歧 → 中危
insertFact('fc-f-5', '巴德', '职业', '守卫人', 'candidate', 'fc-ch-1')
insertFact('fc-f-6', '巴德', '职业', '弓箭手', 'candidate', 'fc-ch-2')
// 完全一致的重复候选 → 不算冲突
insertFact('fc-f-7', '甘道夫', '职业', '巫师', 'candidate', 'fc-ch-1')
insertFact('fc-f-8', '甘道夫', '职业', '巫师。', 'candidate', 'fc-ch-2')

describe('候选事实差异提取器', () => {
  const issues = runReview(projectId).filter((issue) => issue.category === 'fact-conflict')

  it('正史与候选同口径不同值 → 高危冲突，证据双链', () => {
    const conflict = issues.find((issue) => issue.title.includes('比尔博·种族'))
    expect(conflict).toBeTruthy()
    expect(conflict!.severity).toBe('high')
    expect(conflict!.evidence).toEqual(['fc-f-2', 'fc-f-1'])
    expect(conflict!.description).toContain('霍比特人')
    expect(conflict!.description).toContain('精灵')
  })

  it('无正史的候选分歧 → 中危', () => {
    const conflict = issues.find((issue) => issue.title.includes('巴德·职业'))
    expect(conflict).toBeTruthy()
    expect(conflict!.severity).toBe('medium')
  })

  it('互相包含与完全一致不算冲突', () => {
    expect(issues.find((issue) => issue.title.includes('索林·身份'))).toBeUndefined()
    expect(issues.find((issue) => issue.title.includes('甘道夫·职业'))).toBeUndefined()
  })

  it('冲突写入审查队列', () => {
    const rows = sql.all<{ category: string; status: string }>("SELECT category, status FROM reviews WHERE project_id = ? AND category = 'fact-conflict'", projectId)
    expect(rows.length).toBe(2)
    expect(rows.every((row) => row.status === 'open')).toBe(true)
  })
})
