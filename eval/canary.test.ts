process.env.NOVELWEAVER_DATA_DIR = ':memory:'

// Static imports are hoisted before the env assignment above, so every server module
// must be imported dynamically AFTER it — otherwise this test writes to the real DB.
import { describe, expect, it } from 'vitest'
const { sql } = await import('../server/db.ts')
const { runReview } = await import('../server/review.ts')

const stamp = () => new Date().toISOString()

// Canary project seeded with one of each known rule violation. If a future change
// weakens or removes a review rule, this test fails — the review engine's baseline.
const projectId = 'canary-project-0000-0000'
sql.run('INSERT INTO projects (id, name, genre, premise, status, word_goal, imported, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', projectId, '审查金丝雀', '测试', '验证审查规则', 'active', 100000, 0, stamp(), stamp())
sql.run('INSERT INTO chapters (id, project_id, title, content, position, status, summary, pov, target_words, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', 'canary-ch1', projectId, '第一章', '很短的正文。', 0, 'draft', '', '', 3000, stamp(), stamp())
sql.run('INSERT INTO chapters (id, project_id, title, content, position, status, summary, pov, target_words, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', 'canary-ch2', projectId, '第二章', '完整的正文，长度超过一百八十个字符的阈值，用来确认短章检查不会误报完全正常的章节。'.repeat(8), 1, 'revised', '有摘要', '林雾', 3000, stamp(), stamp())
sql.run(`INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 'canary-ev1', projectId, '缺时间事件', '摘要', '', 1, 'planned', null, null, '[]', '', '', '', '{}', stamp(), stamp())
sql.run('INSERT INTO foreshadowing VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 'canary-fs1', projectId, '未回收伏笔', null, null, 'open', '', stamp())
sql.run(`INSERT INTO entities VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 'canary-en1', projectId, 'character', '候选人物', '候选摘要', '{}', 'candidate', 0.8, null, stamp(), stamp())

describe('审查规则金丝雀', () => {
  const issues = runReview(projectId)
  const byCategory = (category: string) => issues.filter((issue) => issue.category === category)

  it('内存库生效：只有种子项目与金丝雀项目', () => {
    const names = sql.all<{ name: string }>('SELECT name FROM projects').map((row) => row.name).sort()
    expect(names).toEqual(['审查金丝雀', '雾港纪事'])
  })
  it('缺视角与缺摘要的章节被标记', () => {
    expect(byCategory('pov').some((issue) => issue.title.includes('第一章'))).toBe(true)
    expect(byCategory('structure').some((issue) => issue.title.includes('缺少摘要'))).toBe(true)
  })
  it('短章被标记且正常章节不误报', () => {
    expect(byCategory('structure').some((issue) => issue.title.includes('正文较短'))).toBe(true)
    expect(byCategory('structure').some((issue) => issue.title.includes('第二章'))).toBe(false)
  })
  it('候选实体进入提示', () => {
    expect(byCategory('canon').some((issue) => issue.title.includes('候选人物'))).toBe(true)
  })
  it('缺故事时间与缺参与者的事件被标记', () => {
    expect(byCategory('timeline').some((issue) => issue.title.includes('缺时间事件'))).toBe(true)
    expect(byCategory('logic').some((issue) => issue.title.includes('缺时间事件'))).toBe(true)
  })
  it('未回收伏笔被标记', () => {
    expect(byCategory('foreshadowing').some((issue) => issue.title.includes('未回收伏笔'))).toBe(true)
  })
  it('重跑会替换旧的未处理问题而不叠加', () => {
    const first = issues.length
    const second = runReview(projectId)
    expect(second.length).toBe(first)
  })
})
