import { it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { taskFixture } from '../eval/task-scenarios.ts'
import { captureProject } from './harness/store.ts'
import { TaskEnvironment } from './tasks/environment.ts'
import { sql } from './db.ts'

it('JSONL 桥接在独立进程 reset/observe/snapshot/evaluate，保持离线', async () => {
  const f = taskFixture()
  const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'eval/task-env-bridge.ts'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  async function call(message: unknown) {
    child.stdin.write(JSON.stringify(message) + '\n')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const line = await Promise.race([
        lines.next(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Bridge timeout')), 5000)
        }),
      ])
      const response = JSON.parse(line.value!)
      expect(response.error).toBeUndefined()
      return response.result
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  try {
    const first = await call({
      id: 1,
      method: 'reset',
      initialState: captureProject(f.projectId),
      task: f.input('revise'),
    })
    expect(first.profileId).toBe('revision.local')
    expect(first.initialState).toBeUndefined()
    const observed = await call({ id: 2, method: 'observe' })
    expect(observed).toEqual(first)
    const snap = await call({ id: 3, method: 'snapshot' })
    expect(snap.run.adaptation.plan.planHash).toBeTruthy()
    expect((await call({ id: 4, method: 'evaluate' })).status).toBe('unscored')
  } finally {
    child.stdin.end()
    child.kill()
    await new Promise<void>((resolve) => child.once('exit', () => resolve()))
  }
}, 10000)

it('环境克隆保留正文原始空白与 sourceFamilyId', async () => {
  const f = taskFixture(),
    text = '{"event":  "钥匙"}\n'
  sql.run('UPDATE chapters SET content=? WHERE id=?', text, f.chapters[0].id)
  const env = new TaskEnvironment(f.executor, captureProject(f.projectId))
  await env.reset(f.input('review', { sourceFamilyId: f.projectId }))
  const snap = env.snapshot(),
    chapterId = snap.run.adaptation!.taskSpec.chapterId!
  expect(snap.database.tables.chapters.find((c) => c.id === chapterId)?.content).toBe(text)
  expect(snap.run.sourceFamilyId).toBe(f.projectId)
})
