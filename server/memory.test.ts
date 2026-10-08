process.env.NOVELWEAVER_DATA_DIR = ':memory:'

// Static imports are hoisted before env assignment — import server modules dynamically.
import { describe, expect, it } from 'vitest'
const { sql } = await import('../server/db.ts')
const { assembleContext } = await import('../server/memory.ts')

const stamp = () => new Date().toISOString()
const projectId = 'macro-memory-0000-0000'
sql.run('INSERT INTO projects (id, name, genre, premise, status, word_goal, imported, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', projectId, '宏观记忆测试', '悬疑', '找到失踪的姐姐', 'active', 100000, 0, stamp(), stamp())
sql.run('INSERT INTO chapters (id, project_id, title, content, position, status, summary, pov, target_words, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', 'mm-ch-1', projectId, '第一章', '港口的雨夜。'.repeat(40), 0, 'draft', '林雾在石滩醒来。', '林雾', 3000, stamp(), stamp())
sql.run('INSERT INTO volumes VALUES (?, ?, ?, ?, ?, ?, ?)', 'mm-vol-1', projectId, '第一卷 潮汐之下', '林雾追查姐姐失踪的第一条线索。', 0, stamp(), stamp())
sql.run('INSERT INTO chapter_volume_bindings VALUES (?, ?, ?)', 'mm-ch-1', 'mm-vol-1', 0)
sql.run('INSERT INTO foreshadowing VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 'mm-fs-1', projectId, '渗水地图上多出的第七码头', 'mm-ch-1', null, 'open', '', stamp())

describe('全书宏观记忆', () => {
  it('上下文快照包含全书概览块', async () => {
    const assembled = await assembleContext(projectId, '林雾接下来该去哪里调查？')
    const macro = assembled.report.included.find((item) => item.label === '全书概览')
    expect(macro).toBeTruthy()
    expect(assembled.text).toContain('【全书概览】《宏观记忆测试》· 悬疑')
    expect(assembled.text).toContain('第一卷 潮汐之下')
    expect(assembled.text).toContain('渗水地图上多出的第七码头')
  })

  it('无卷无伏笔时宏观块只剩体量进度', async () => {
    sql.run('INSERT INTO projects (id, name, genre, premise, status, word_goal, imported, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', 'macro-empty-0000', '空项目', '', '', 'active', 100000, 0, stamp(), stamp())
    const assembled = await assembleContext('macro-empty-0000', '随便写点什么')
    expect(assembled.text).toContain('共 0 章 / 0 字')
    expect(assembled.text).not.toContain('【卷结构】')
    expect(assembled.text).not.toContain('【未回收伏笔】')
  })
})
