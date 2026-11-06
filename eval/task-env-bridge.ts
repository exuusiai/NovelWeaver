import readline from 'node:readline'
process.env.NOVELWEAVER_DATA_DIR = ':memory:'
process.env.NOVELWEAVER_OFFLINE = '1'
process.env.AI_API_KEY = ''
globalThis.fetch = async () => {
  throw new Error('Offline environment bridge blocked network')
}
const { TaskEnvironment } = await import('../server/tasks/environment.ts')
const { taskExecutor } = await import('../server/tasks/service.ts')
let env: InstanceType<typeof TaskEnvironment> | undefined
for await (const line of readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})) {
  let id: unknown = null
  try {
    const message = JSON.parse(line)
    id = message.id
    let result: unknown
    if (message.method === 'reset') {
      env = new TaskEnvironment(taskExecutor, message.initialState)
      result = await env.reset(message.task)
    } else {
      if (!env) throw new Error('reset required')
      if (message.method === 'step') result = await env.step(message.action)
      else if (message.method === 'observe') result = env.observe()
      else if (message.method === 'snapshot') result = env.snapshot()
      else if (message.method === 'restore') result = env.restore(message.snapshot)
      else if (message.method === 'evaluate') result = env.evaluate()
      else throw new Error('Unknown environment method')
    }
    process.stdout.write(JSON.stringify({ id, result }) + '\n')
  } catch (error) {
    process.stdout.write(JSON.stringify({ id, error: (error as Error).message }) + '\n')
  }
}
