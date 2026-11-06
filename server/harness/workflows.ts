import type { Task } from './protocol.ts'
import type { Workflow } from './executor.ts'
import { runRequest } from './executor.ts'

export const revisionWorkflow: Workflow = {
  name: 'revision.local',
  version: '1.0.0',
  steps: [
    { tool: 'task.define', input: (run) => runRequest.parse(run.request) },
    { tool: 'memory.search', input: (run) => ({ query: (run.state.task as Task).goal, view: view(run) }) },
    // Evidence-poor queries get one deterministic follow-up, then retain uncertainty.
    {
      tool: 'memory.search',
      when: (run) => !(run.state.memory as { evidence: unknown[] }).evidence.length,
      input: (run) => ({
        query: (run.state.task as Task).preserve.join(' ') || (run.state.task as Task).pov,
        view: view(run),
      }),
    },
    { tool: 'setting.select', input: (run) => ({ query: (run.state.task as Task).goal, view: view(run) }) },
    { tool: 'context.pack', input: () => ({ tokenBudget: 5000 }) },
    {
      tool: 'evidence.read',
      input: (run) => ({
        evidenceIds: [
          ...new Set([
            ...(run.state.task as Task).evidenceIds,
            ...(run.state.context as { evidence: Array<{ id: string }> }).evidence.map((e) => e.id),
          ]),
        ],
        location: (run.state.task as Task).range,
      }),
    },
    { tool: 'revision.plan', input: () => ({}) },
    { tool: 'revision.propose', input: () => ({}) },
    { tool: 'revision.verify', input: () => ({}) },
  ],
}
function view(run: Parameters<Workflow['steps'][number]['input']>[0]) {
  const task = run.state.task as Task
  return { chapterId: task.chapterId, audience: 'character', holderId: task.holderId, storyTick: task.storyTick }
}
