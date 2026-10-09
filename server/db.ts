import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const dataDir = process.env.NOVELWEAVER_DATA_DIR || path.join(root, '.data')
if (dataDir !== ':memory:') fs.mkdirSync(dataDir, { recursive: true })

export const db = new Database(dataDir === ':memory:' ? ':memory:' : path.join(dataDir, 'novelweaver.db'))
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, genre TEXT NOT NULL DEFAULT '', premise TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active', word_goal INTEGER NOT NULL DEFAULT 100000,
  imported INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chapters (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', summary TEXT NOT NULL DEFAULT '', pov TEXT NOT NULL DEFAULT '',
  target_words INTEGER NOT NULL DEFAULT 3000, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chapter_marks (
  chapter_id TEXT PRIMARY KEY REFERENCES chapters(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  bookmarked INTEGER NOT NULL DEFAULT 0,
  importance TEXT NOT NULL DEFAULT 'normal',
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chapter_history (
  id TEXT PRIMARY KEY, chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '',
  word_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chapter_outlines (
  chapter_id TEXT PRIMARY KEY REFERENCES chapters(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_outline_id TEXT REFERENCES story_outlines(id) ON DELETE SET NULL,
  content TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'candidate',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS volumes (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', order_index INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chapter_volume_bindings (
  chapter_id TEXT PRIMARY KEY REFERENCES chapters(id) ON DELETE CASCADE,
  volume_id TEXT NOT NULL REFERENCES volumes(id) ON DELETE CASCADE,
  order_index INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL, name TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', data TEXT NOT NULL DEFAULT '{}',
  canon_status TEXT NOT NULL DEFAULT 'canon', confidence REAL NOT NULL DEFAULT 1,
  source_chapter_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plotlines (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'main', summary TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#13766f', status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS story_outlines (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1,
  parent_id TEXT REFERENCES story_outlines(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'candidate', source_prompt TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', story_time TEXT NOT NULL DEFAULT '',
  narrative_order INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'planned',
  plotline_id TEXT, chapter_id TEXT, participants TEXT NOT NULL DEFAULT '[]', location TEXT NOT NULL DEFAULT '',
  cause TEXT NOT NULL DEFAULT '', consequence TEXT NOT NULL DEFAULT '', knowledge TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS relations (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_entity_id TEXT NOT NULL, to_entity_id TEXT NOT NULL, type TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '', sentiment TEXT NOT NULL DEFAULT 'neutral', strength INTEGER NOT NULL DEFAULT 50,
  valid_from TEXT NOT NULL DEFAULT '', valid_to TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS foreshadowing (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL, setup_chapter_id TEXT, payoff_chapter_id TEXT, status TEXT NOT NULL DEFAULT 'open',
  notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_chunks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  chapter_id TEXT, source_type TEXT NOT NULL, source_id TEXT, content TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '', keywords TEXT NOT NULL DEFAULT '', importance INTEGER NOT NULL DEFAULT 50,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS story_facts (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  subject TEXT NOT NULL, predicate TEXT NOT NULL, value TEXT NOT NULL,
  source_chapter_id TEXT REFERENCES chapters(id) ON DELETE SET NULL,
  introduced_position INTEGER NOT NULL DEFAULT 0, importance INTEGER NOT NULL DEFAULT 50,
  canon_status TEXT NOT NULL DEFAULT 'candidate', evidence TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED, project_id UNINDEXED, content, summary, keywords, tokenize='unicode61');
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category TEXT NOT NULL, severity TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS generations (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_type TEXT NOT NULL, input TEXT NOT NULL, context_snapshot TEXT NOT NULL,
  output TEXT NOT NULL, model TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS imports (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  filename TEXT NOT NULL, file_hash TEXT NOT NULL, raw_text TEXT NOT NULL,
  diagnostics TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
  UNIQUE(project_id, file_hash)
);
CREATE TABLE IF NOT EXISTS analysis_runs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', details TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS analysis_jobs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued', stage TEXT NOT NULL DEFAULT 'queued', progress INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', replace_candidates INTEGER NOT NULL DEFAULT 0,
  result TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS analysis_quality (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT, pass_name TEXT NOT NULL DEFAULT 'primary', metrics TEXT NOT NULL DEFAULT '{}',
  disagreements TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entity_edits (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  action TEXT NOT NULL, target_id TEXT, snapshot TEXT NOT NULL DEFAULT '{}', payload TEXT NOT NULL DEFAULT '{}',
  undone INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS import_previews (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  filename TEXT NOT NULL, file_hash TEXT NOT NULL, raw_text TEXT NOT NULL, chapters TEXT NOT NULL DEFAULT '[]',
  diagnostics TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_chapters_project ON chapters(project_id, position);
CREATE INDEX IF NOT EXISTS idx_chapter_marks_project ON chapter_marks(project_id, bookmarked, importance);
CREATE INDEX IF NOT EXISTS idx_chapter_history_chapter ON chapter_history(chapter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chapter_outlines_project ON chapter_outlines(project_id, status);
CREATE INDEX IF NOT EXISTS idx_volumes_project ON volumes(project_id, order_index);
CREATE INDEX IF NOT EXISTS idx_volume_bindings ON chapter_volume_bindings(volume_id, order_index);
CREATE INDEX IF NOT EXISTS idx_entities_project ON entities(project_id, type);
CREATE INDEX IF NOT EXISTS idx_story_outlines_project ON story_outlines(project_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id, narrative_order);
CREATE INDEX IF NOT EXISTS idx_memory_project ON memory_chunks(project_id);
CREATE INDEX IF NOT EXISTS idx_story_facts_project ON story_facts(project_id, canon_status, introduced_position);
CREATE INDEX IF NOT EXISTS idx_imports_project ON imports(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_analysis_jobs_project ON analysis_jobs(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_entity_edits_project ON entity_edits(project_id, created_at);
`)

// Trigram FTS gives Chinese prose substring recall without a separate tokenizer service.
try {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_search_fts USING fts5(
      id UNINDEXED, project_id UNINDEXED, content, summary, keywords, tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS memory_search_insert AFTER INSERT ON memory_chunks BEGIN
      INSERT INTO memory_search_fts (id, project_id, content, summary, keywords)
      VALUES (new.id, new.project_id, new.content, new.summary, new.keywords);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_search_delete AFTER DELETE ON memory_chunks BEGIN
      DELETE FROM memory_search_fts WHERE id = old.id;
    END;
  `)
  const memoryCount = (db.prepare('SELECT COUNT(*) count FROM memory_chunks').get() as { count: number }).count
  const searchCount = (db.prepare('SELECT COUNT(*) count FROM memory_search_fts').get() as { count: number }).count
  if (memoryCount !== searchCount) {
    db.exec('DELETE FROM memory_search_fts; INSERT INTO memory_search_fts SELECT id, project_id, content, summary, keywords FROM memory_chunks;')
  }
} catch {
  // Older SQLite builds keep using the unicode FTS table and indexed fallback query.
}

const now = () => new Date().toISOString()
const id = () => randomUUID()

function addMemory(projectId: string, sourceType: string, sourceId: string, content: string, summary: string, keywords: string, chapterId?: string) {
  const memoryId = id()
  // 正文记忆与 FTS 原子写入：第二步失败不再留下有 chunk 无索引的漂移
  db.transaction(() => {
    db.prepare(`INSERT INTO memory_chunks (id, project_id, chapter_id, source_type, source_id, content, summary, keywords, importance, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(memoryId, projectId, chapterId ?? null, sourceType, sourceId, content, summary, keywords, 70, now())
    db.prepare('INSERT INTO memory_fts (id, project_id, content, summary, keywords) VALUES (?, ?, ?, ?, ?)')
      .run(memoryId, projectId, content, summary, keywords)
  })()
}

function seedDemo() {
  const count = db.prepare('SELECT COUNT(*) AS count FROM projects').get() as { count: number }
  if (count.count > 0) return

  const projectId = id()
  const stamp = now()
  db.prepare(`INSERT INTO projects (id, name, genre, premise, status, word_goal, imported, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    projectId, '雾港纪事', '蒸汽奇幻 · 悬疑', '失忆制图师在一座会改变街道的港城中，追查姐姐失踪与潮汐议会的秘密。',
    'active', 120000, 0, stamp, stamp,
  )

  const chapterSeed = [
    ['序章：退潮后的地图', '林雾在退潮后的石滩上醒来，手中攥着一张不断渗出海水的地图。远处的白塔敲了十三下钟，港城所有街道随雾移动。巡潮人季岚找到她，却声称两人从未见过。', '林雾在石滩醒来，获得异常地图，并首次遇见季岚。'],
    ['第一章：不存在的第七码头', '林雾回到旧城区的绘图铺，发现姐姐林澈的房间被人彻底清空。账本里夹着第七码头的船票，但雾港官方地图上只有六座码头。季岚警告她不要在涨潮后寻找不存在的街道。', '林雾发现第七码头线索，确认姐姐失踪与城市地图异常有关。'],
    ['第二章：潮汐议会', '潮汐议会召见林雾，议长顾衡要求她交出渗水地图。林雾谎称地图已经遗失，却在会议厅的旧壁画上看见姐姐留下的制图暗号。', '林雾与顾衡首次交锋，并从议会壁画获得姐姐留下的暗号。'],
    ['第三章：盐灯下的盟约', '季岚承认自己曾是林澈的引路人。两人在盐灯酒馆达成临时盟约：林雾负责解读地图，季岚负责带她穿过会移动的街区。酒馆老板闻舟提醒他们，白塔第十三声钟只为死人敲响。', '林雾与季岚结盟，闻舟揭示十三声钟的禁忌。'],
  ]
  const chapterIds: string[] = []
  chapterSeed.forEach(([title, content, summary], index) => {
    const chapterId = id(); chapterIds.push(chapterId)
    db.prepare(`INSERT INTO chapters (id, project_id, title, content, position, status, summary, pov, target_words, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(chapterId, projectId, title, content, index, index === 0 ? 'revised' : 'draft', summary, '林雾', 3000, stamp, stamp)
    addMemory(projectId, 'chapter', chapterId, content, summary, `${title} 林雾 雾港 地图`, chapterId)
  })

  const entitySeed: Array<[string, string, string, Record<string, unknown>]> = [
    ['character', '林雾', '失忆的年轻制图师，能够感知被城市抹去的道路。', { role: '主角', desire: '找到姐姐林澈', fear: '自己的记忆也是伪造的', secret: '曾到过第七码头', voice: '克制、观察细致' }],
    ['character', '季岚', '巡潮人，熟悉移动街区，对林澈的失踪负有愧疚。', { role: '盟友', desire: '偿还旧债', fear: '再次未能保护同行者', secret: '曾接受议会命令监视林澈' }],
    ['character', '顾衡', '潮汐议会议长，以秩序之名封锁城市历史。', { role: '对手', desire: '维持雾港稳定', fear: '旧港真相公开', secret: '知道第七码头仍然存在' }],
    ['character', '林澈', '林雾的姐姐、前任首席制图师，目前下落不明。', { role: '缺席核心人物', desire: '绘制真实雾港', status: '失踪', secret: '主动进入第七码头' }],
    ['character', '闻舟', '盐灯酒馆老板，收集码头传闻。', { role: '信息提供者', desire: '让港城记住死者', secret: '能听见白塔钟声中的名字' }],
    ['location', '雾港', '街道会随潮汐和雾气重排的海港城市。', { rule: '涨潮后不得依赖昨日地图', districts: ['旧城区', '议会区', '船坞区'] }],
    ['location', '第七码头', '被官方地图删除、只在特定退潮夜出现的码头。', { status: '被抹除', access: '白塔敲响十三声后' }],
    ['faction', '潮汐议会', '统治雾港并垄断地图、潮汐表与航路的机构。', { leader: '顾衡', goal: '维持城市结构稳定', resource: '白塔与巡潮人' }],
    ['system', '潮痕术', '制图师以记忆为代价，将不存在的道路暂时绘入现实。', { source: '退潮后的盐晶', cost: '永久失去一段个人记忆', limit: '同一路径不可连续绘制三次' }],
    ['item', '渗水地图', '林雾醒来时持有的活地图，会显示被抹去的道路。', { owner: '林雾', origin: '未知', rule: '只在接近真相时渗出海水' }],
  ]
  const entityIds: Record<string, string> = {}
  entitySeed.forEach(([type, name, summary, data]) => {
    const entityId = id(); entityIds[name] = entityId
    db.prepare(`INSERT INTO entities VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(entityId, projectId, type, name, summary, JSON.stringify(data), 'canon', 1, null, stamp, stamp)
    addMemory(projectId, 'entity', entityId, `${name}：${summary}。${Object.entries(data).map(([key, value]) => `${key}=${Array.isArray(value) ? value.join('、') : value}`).join('；')}`, summary, `${name} ${type}`)
  })

  const mainPlot = id(); const sisterPlot = id(); const arcPlot = id()
  db.prepare('INSERT INTO plotlines VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(mainPlot, projectId, '第七码头之谜', 'main', '寻找被城市删除的第七码头，揭开雾港真实历史。', '#0c6f68', 'active', stamp)
  db.prepare('INSERT INTO plotlines VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(sisterPlot, projectId, '林澈失踪', 'mystery', '追踪林澈留下的地图暗号与见证人。', '#b7613c', 'active', stamp)
  db.prepare('INSERT INTO plotlines VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(arcPlot, projectId, '林雾的记忆', 'character', '林雾逐步发现自己曾用潮痕术删除记忆。', '#5c638f', 'active', stamp)

  const events = [
    ['石滩苏醒', '林雾在退潮石滩醒来并获得渗水地图。', '雾历317年·霜潮月·初三', mainPlot, chapterIds[0], ['林雾', '季岚'], '退潮石滩'],
    ['发现船票', '林雾在姐姐遗物中发现第七码头船票。', '初四·上午', sisterPlot, chapterIds[1], ['林雾', '林澈'], '旧城区绘图铺'],
    ['议会召见', '顾衡索要地图，林雾隐瞒真相。', '初四·傍晚', mainPlot, chapterIds[2], ['林雾', '顾衡'], '潮汐议会'],
    ['盐灯盟约', '林雾与季岚决定共同寻找第七码头。', '初四·深夜', arcPlot, chapterIds[3], ['林雾', '季岚', '闻舟'], '盐灯酒馆'],
  ]
  events.forEach(([title, summary, storyTime, plotlineId, chapterId, participants, location], index) => {
    db.prepare(`INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id(), projectId, title, summary, storyTime, index + 1, 'written', plotlineId, chapterId, JSON.stringify(participants), location, '', '', '{}', stamp, stamp)
  })

  const relations = [
    ['林雾', '林澈', 'family', '姐妹', 'positive', 95], ['林雾', '季岚', 'alliance', '临时盟友', 'mixed', 58],
    ['季岚', '林澈', 'debt', '旧日引路人与同行者', 'mixed', 78], ['顾衡', '林雾', 'surveillance', '监视', 'negative', 70],
    ['顾衡', '潮汐议会', 'leadership', '议长', 'neutral', 92], ['潮汐议会', '第七码头', 'suppression', '封锁存在', 'negative', 88],
  ] as const
  relations.forEach(([from, to, type, label, sentiment, strength]) => db.prepare(`INSERT INTO relations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id(), projectId, entityIds[from], entityIds[to], type, label, sentiment, strength, '', '', stamp))

  db.prepare('INSERT INTO foreshadowing VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id(), projectId, '白塔的第十三声钟', chapterIds[0], null, 'open', '第三章再次由闻舟强调，预计在第一卷末回收。', stamp)
  db.prepare('INSERT INTO foreshadowing VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id(), projectId, '林雾缺失的航海记忆', chapterIds[0], null, 'developing', '与潮痕术代价相关。', stamp)
}

seedDemo()

// Lightweight column migrations for databases created before these fields existed.
for (const statement of [
  "ALTER TABLE generations ADD COLUMN usage TEXT NOT NULL DEFAULT ''",
  'ALTER TABLE generations ADD COLUMN used INTEGER NOT NULL DEFAULT -1',
  "ALTER TABLE memory_chunks ADD COLUMN embedding TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE reviews ADD COLUMN ai_suggestion TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE reviews ADD COLUMN fingerprint TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE chapters ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE chapters ADD COLUMN analyzed_hash TEXT NOT NULL DEFAULT ''",
  'ALTER TABLE projects ADD COLUMN import_revision INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE analysis_jobs ADD COLUMN import_revision INTEGER NOT NULL DEFAULT -1',
  "ALTER TABLE memory_chunks ADD COLUMN embedding_model TEXT NOT NULL DEFAULT ''",
]) {
  try { db.exec(statement) } catch { /* column already exists */ }
}

// 启动一致性对账：memory_fts 为手动维护的二级索引，任何写入路径漏写或
// 事务中断都会造成正文记忆与 FTS 漂移。启动时全量对齐一次（幂等、廉价）。
try {
  db.exec(`DELETE FROM memory_fts WHERE id NOT IN (SELECT id FROM memory_chunks);
    INSERT INTO memory_fts (id, project_id, content, summary, keywords)
    SELECT id, project_id, content, summary, keywords FROM memory_chunks
    WHERE id NOT IN (SELECT id FROM memory_fts);`)
} catch { /* fts rebuild skipped on fresh databases without memory */ }

function ensureVolumeStructure() {
  const stamp = now()
  const projects = db.prepare('SELECT id FROM projects').all() as Array<{ id: string }>
  const transaction = db.transaction(() => {
    for (const project of projects) {
      let volume = db.prepare('SELECT id FROM volumes WHERE project_id = ? ORDER BY order_index LIMIT 1').get(project.id) as { id: string } | undefined
      if (!volume) {
        volume = { id: id() }
        db.prepare('INSERT INTO volumes VALUES (?, ?, ?, ?, ?, ?, ?)').run(volume.id, project.id, '第一卷', '', 0, stamp, stamp)
      }
      const chapters = db.prepare(`SELECT c.id, c.position FROM chapters c
        LEFT JOIN chapter_volume_bindings b ON b.chapter_id = c.id
        WHERE c.project_id = ? AND b.chapter_id IS NULL ORDER BY c.position`).all(project.id) as Array<{ id: string; position: number }>
      chapters.forEach((chapter) => db.prepare('INSERT INTO chapter_volume_bindings VALUES (?, ?, ?)').run(chapter.id, volume!.id, chapter.position))
    }
  })
  transaction()
}

ensureVolumeStructure()

function ensureFactSummaries() {
  const stamp = now()
  const events = db.prepare(`SELECT e.project_id, e.title, e.summary, e.consequence, e.chapter_id,
    COALESCE(c.position, 0) introduced_position FROM events e LEFT JOIN chapters c ON c.id=e.chapter_id
    WHERE LENGTH(TRIM(e.summary)) > 0`).all() as Array<{ project_id: string; title: string; summary: string; consequence: string; chapter_id: string | null; introduced_position: number }>
  const insert = db.prepare('INSERT INTO story_facts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  const exists = db.prepare("SELECT id FROM story_facts WHERE project_id=? AND subject=? AND predicate='事件摘要' AND value=?")
  db.transaction(() => {
    for (const event of events) {
      if (exists.get(event.project_id, event.title, event.summary)) continue
      insert.run(id(), event.project_id, event.title, '事件摘要', event.summary, event.chapter_id, event.introduced_position, 65, 'candidate', event.consequence || event.summary, stamp, stamp)
    }
  })()
}

ensureFactSummaries()

export const sql = {
  now,
  id,
  addMemory,
  all<T = unknown>(query: string, ...params: unknown[]) { return db.prepare(query).all(...params) as T[] },
  get<T = unknown>(query: string, ...params: unknown[]) { return db.prepare(query).get(...params) as T | undefined },
  run(query: string, ...params: unknown[]) { return db.prepare(query).run(...params) },
}
