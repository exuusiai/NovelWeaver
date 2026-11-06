import fs from 'node:fs'
import { sql } from '../server/db.ts'
import { bindSources, setMemoryScope } from '../server/provenance.ts'
import { rebuildChapterMemory } from '../server/routes/helpers.ts'
import { Executor } from '../server/harness/executor.ts'
import { createRegistry } from '../server/harness/tools.ts'
import { revisionWorkflow } from '../server/harness/workflows.ts'
import { chapterEvidence } from '../server/harness/evidence.ts'
import type { Adapters } from '../server/harness/adapters.ts'

export const story = JSON.parse(fs.readFileSync(new URL('./fixtures/harness/story.json', import.meta.url), 'utf8')) as {
  sourceFamilyId: string
  split: 'test'
  title: string
  chapters: Array<{ key: string; title: string; storyTick: number; content: string; summary: string }>
  task: { goal: string; preserve: string[]; allowedChanges: string[]; pov: string }
  golden: {
    patches: Array<{ find: string; replacement: string; rationale: string }>
    forbiddenEarly: string[]
    semanticReview: string
  }
}
// This adapter accepts only the fixed synthetic text pairs. It is installed through dependency
// injection in evaluation, never by the HTTP router or a production environment flag.
export function fixtureAdapters(): Adapters {
  return {
    generator: {
      version: 'fixture.patch.v1',
      modelVersion: 'deterministic.foglamp.v1',
      async propose({ task, original }) {
        return {
          value: story.golden.patches.flatMap((p, index) => {
            const at = original.indexOf(p.find)
            return at < 0
              ? []
              : [
                  {
                    id: `p${index + 1}`,
                    start: task.range.start + at,
                    end: task.range.start + at + p.find.length,
                    original: p.find,
                    replacement: p.replacement,
                    rationale: p.rationale,
                    evidenceIds: task.evidenceIds,
                  },
                ]
          }),
        }
      },
    },
    checker: {
      version: 'fixture-pair-checker.v1',
      async verify({ before, after }) {
        const full = story.golden.patches.reduce((s, p) => s.replace(p.find, p.replacement), before)
        const first = before.replace(story.golden.patches[0].find, story.golden.patches[0].replacement)
        const supported = after === full || after === first
        return {
          value: ['goal_repair', 'fact_preservation', 'unsupported_additions', 'pov'].map((name) => ({
            name,
            status: supported ? ('pass' as const) : ('fail' as const),
            detail: supported ? story.golden.semanticReview : '文本不属于固定 fixture 对。',
            evidenceIds: [],
          })),
        }
      },
    },
  }
}
export function setupFixture(adapters = fixtureAdapters()) {
  const projectId = `hf-${sql.id()}`
  const stamp = sql.now()
  sql.run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', projectId, story.title, stamp, stamp)
  const chapters = story.chapters.map((c, i) => {
    const id = `${projectId}-${c.key}`
    sql.run(
      'INSERT INTO chapters (id,project_id,title,content,position,summary,pov,story_tick,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id,
      projectId,
      c.title,
      c.content,
      i,
      c.summary,
      '陆宁',
      c.storyTick,
      stamp,
      stamp,
    )
    rebuildChapterMemory(projectId, id, c.title, c.content, c.summary)
    return { ...c, id }
  })
  const entityA = `${projectId}-keeper`
  const entityB = `${projectId}-traveler`
  for (const [id, chapter, summary] of [
    [entityA, chapters[0].id, '守灯人，持有铜钥匙。'],
    [entityB, chapters[1].id, '同名旅客，持有银钥匙。'],
  ]) {
    sql.run(
      'INSERT INTO entities VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      id,
      projectId,
      'character',
      '陆宁',
      summary,
      '{}',
      'canon',
      1,
      chapter,
      stamp,
      stamp,
    )
    setMemoryScope(projectId, 'entity', id, { audience: 'world', entityIds: [id], knownBy: [id] })
  }
  chapters.forEach((c, i) =>
    setMemoryScope(projectId, 'chapter', c.id, {
      audience: 'world',
      entityIds: [i === 1 ? entityB : entityA],
      knownBy: [i === 1 ? entityB : entityA],
    }),
  )
  const factId = `${projectId}-key-fact`
  sql.run(
    'INSERT INTO story_facts VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    factId,
    projectId,
    '陆宁',
    '持有物',
    '铜钥匙',
    chapters[0].id,
    0,
    90,
    'canon',
    '把铜钥匙放进蓝盒',
    stamp,
    stamp,
  )
  setMemoryScope(projectId, 'fact', factId, {
    audience: 'world',
    entityIds: [entityA],
    knownBy: [entityA],
    tags: ['state'],
  })
  const secretId = `${projectId}-secret-fact`
  sql.run(
    'INSERT INTO story_facts VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    secretId,
    projectId,
    '陆宁',
    '知道',
    '雾灯密码是七',
    chapters[3].id,
    3,
    90,
    'canon',
    '蓝盒底部的密信',
    stamp,
    stamp,
  )
  setMemoryScope(projectId, 'fact', secretId, {
    audience: 'world',
    entityIds: [entityA],
    knownBy: [entityA],
    validFromTick: 20,
  })
  const beliefId = `${projectId}-belief`
  sql.run(
    'INSERT INTO story_facts VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    beliefId,
    projectId,
    '陆宁',
    '相信',
    '盒中没有密信',
    chapters[0].id,
    0,
    70,
    'candidate',
    '角色的错误信念',
    stamp,
    stamp,
  )
  setMemoryScope(projectId, 'fact', beliefId, {
    audience: 'belief',
    holderId: entityA,
    entityIds: [entityA],
    knownBy: [entityA],
  })
  const planId = `${projectId}-plan`
  sql.run(
    'INSERT INTO story_facts VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    planId,
    projectId,
    '作者',
    '计划',
    '结尾烧毁灯塔',
    null,
    0,
    50,
    'candidate',
    '作者计划',
    stamp,
    stamp,
  )
  setMemoryScope(projectId, 'fact', planId, { audience: 'author', tags: ['goal'] })
  const eventId = `${projectId}-event`
  sql.run(
    'INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    eventId,
    projectId,
    '放入钥匙',
    '铜钥匙进入蓝盒',
    '10',
    0,
    'written',
    null,
    chapters[0].id,
    JSON.stringify([entityA]),
    '灯塔',
    '',
    '导致寻找蓝盒',
    '{}',
    stamp,
    stamp,
  )
  setMemoryScope(projectId, 'event', eventId, {
    audience: 'world',
    entityIds: [entityA],
    knownBy: [entityA],
    tags: ['causality'],
  })
  const shadowId = `${projectId}-shadow`
  sql.run(
    'INSERT INTO foreshadowing VALUES (?,?,?,?,?,?,?,?)',
    shadowId,
    projectId,
    '蓝盒的重量',
    chapters[0].id,
    chapters[3].id,
    'open',
    '未回收的重量线索',
    stamp,
  )
  bindSources('foreshadowing', shadowId, [chapters[0].id])
  setMemoryScope(projectId, 'foreshadowing', shadowId, {
    audience: 'world',
    knownBy: [entityA],
    tags: ['foreshadowing'],
  })
  sql.run(
    'INSERT INTO harness_dependencies VALUES (?,?,?,?,?,?,?)',
    `${projectId}-dep`,
    projectId,
    'chapter',
    chapters[0].id,
    chapters[3].id,
    '密信依赖蓝盒',
    '[]',
  )
  const evidence = chapterEvidence(projectId, chapters[0].id, 0, chapters[0].content.length)
  const executor = new Executor(createRegistry(adapters), [revisionWorkflow])
  const request = {
    projectId,
    chapterId: chapters[0].id,
    baseRevision: 1,
    range: { start: 0, end: chapters[0].content.length },
    ...story.task,
    holderId: entityA,
    storyTick: 10,
    evidenceIds: [evidence.id],
    sourceFamilyId: story.sourceFamilyId,
    split: story.split,
    dataOrigin: 'synthetic',
    budget: { maxCalls: 50, maxTokens: 150000, timeoutMs: 500, maxRetries: 1, maxOutputTokens: 3000 },
    seed: 7,
  }
  const run = executor.create(request)
  return {
    projectId,
    chapters,
    entityA,
    entityB,
    factId,
    secretId,
    beliefId,
    planId,
    eventId,
    shadowId,
    evidence,
    executor,
    run,
    request,
  }
}
