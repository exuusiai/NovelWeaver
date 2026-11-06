import { z } from 'zod'

export const SCHEMA_VERSION = 'novelweaver.harness.v1'
export type ErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_OUTPUT'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'STALE_EVIDENCE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'TEMPORARY_FAILURE'
  | 'TIMEOUT'
  | 'CANCELED'
  | 'BUDGET_EXHAUSTED'
  | 'NEEDS_CHECK'
  | 'VERIFICATION_FAILED'
  | 'INTERNAL_ERROR'
export class ToolError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public retryable = false,
    public details?: unknown,
  ) {
    super(message)
  }
}
export interface Costs {
  calls: number
  inputTokens: number
  outputTokens: number
  latencyMs: number
  money: number | null
  tokenSource: 'estimated' | 'provider'
}
export const emptyCosts = (): Costs => ({
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  latencyMs: 0,
  money: null,
  tokenSource: 'estimated',
})
export interface Observation {
  status: 'ok' | 'pending' | 'error'
  output?: unknown
  error?: { code: ErrorCode; message: string; retryable: boolean; details?: unknown }
  changes: Array<{ kind: string; id: string; before: unknown; after: unknown }>
  costs: Costs
}
export interface StepRecord {
  id: string
  tool: string
  toolVersion: string
  input: unknown
  attempt: number
  startedAt: string
  beforeRevision: string
  afterRevision: string
  observation: Observation
}
export interface Task {
  id: string
  projectId: string
  chapterId: string
  baseRevision: number
  goal: string
  range: { start: number; end: number }
  pov: string
  holderId?: string
  storyTick?: number
  targetWords?: number
  preserve: string[]
  allowedChanges: string[]
  evidenceIds: string[]
}
export interface Patch {
  id: string
  start: number
  end: number
  original: string
  replacement: string
  rationale: string
  evidenceIds: string[]
}
export interface Candidate {
  id: string
  taskId: string
  chapterId: string
  baseRevision: number
  patches: Patch[]
  generator: string
  modelVersion: string
}
export interface Check {
  name: string
  status: 'pass' | 'fail' | 'pending'
  detail: string
  evidenceIds: string[]
}
export interface Verification {
  candidateId: string
  patchIds: string[]
  program: Check[]
  semantic: Check[]
  author: { rating?: number; note?: string } | null
  status: 'pass' | 'fail' | 'pending'
  checkerVersion: string
}
export interface Run {
  id: string
  taskId: string
  projectId: string
  schemaVersion: string
  workflow: string
  workflowVersion: string
  modelVersions: Record<string, string>
  sourceFamilyId: string
  split: 'train' | 'validation' | 'test'
  dataOrigin: 'synthetic' | 'author'
  request: Record<string, unknown>
  initialState: unknown
  state: Record<string, unknown>
  steps: StepRecord[]
  status: 'running' | 'paused' | 'completed' | 'failed' | 'canceled'
  stopReason: string
  cursor: number
  budget: { maxCalls: number; maxTokens: number; timeoutMs: number; maxRetries: number; maxOutputTokens: number }
  costs: Costs
  randomState: number
  interaction: Array<{ role: string; content: unknown; at: string }>
  adoption: unknown[]
  createdAt: string
  updatedAt: string
}
export interface ToolContext {
  run: Run
  signal: AbortSignal
  maxOutputTokens: number
  random: () => number
}
export interface ToolSpec<I = unknown, O = unknown> {
  name: string
  version: string
  source: string
  effect: 'read' | 'generate' | 'write'
  input: z.ZodType<I>
  output: z.ZodType<O>
  estimateInputTokens?: (input: I, run: Run) => number
  execute: (
    input: I,
    context: ToolContext,
  ) =>
    | Promise<{
        output: O
        status?: 'ok' | 'pending'
        changes?: Observation['changes']
        usage?: { inputTokens: number; outputTokens: number }
      }>
    | {
        output: O
        status?: 'ok' | 'pending'
        changes?: Observation['changes']
        usage?: { inputTokens: number; outputTokens: number }
      }
}
export class ToolRegistry {
  private specs = new Map<string, ToolSpec>()
  register<I, O>(spec: ToolSpec<I, O>) {
    if (this.specs.has(spec.name)) throw new Error(`Duplicate tool: ${spec.name}`)
    this.specs.set(spec.name, spec as ToolSpec)
    return this
  }
  get(name: string) {
    const spec = this.specs.get(name)
    if (!spec) throw new ToolError('NOT_FOUND', `工具不存在：${name}`)
    return spec
  }
  catalog() {
    return [...this.specs.values()].map((s) => ({
      name: s.name,
      version: s.version,
      source: s.source,
      effect: s.effect,
      inputSchema: z.toJSONSchema(s.input),
      outputSchema: z.toJSONSchema(s.output),
    }))
  }
}
export const writeGuard = z.object({
  baseRevision: z.number().int().positive(),
  idempotencyKey: z.string().min(8).max(200),
})
export function assertActive(signal: AbortSignal) {
  if (signal.aborted) throw new ToolError('CANCELED', '调用已取消。')
}
