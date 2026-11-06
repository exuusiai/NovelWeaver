import { z } from 'zod'
import { taskInputSchema } from '../tasks/contracts.ts'
export const rangeSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
})
export const taskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  chapterId: z.string(),
  baseRevision: z.number().int().positive(),
  goal: z.string(),
  range: rangeSchema,
  pov: z.string(),
  holderId: z.string().optional(),
  storyTick: z.number().int().optional(),
  targetWords: z.number().int().positive().optional(),
  preserve: z.array(z.string()),
  allowedChanges: z.array(z.string()),
  evidenceIds: z.array(z.string()),
  constraints: taskInputSchema.shape.constraints.optional(),
})
export const patchSchema = z.object({
  id: z.string(),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  original: z.string(),
  replacement: z.string(),
  rationale: z.string(),
  evidenceIds: z.array(z.string()),
})
export const candidateSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  chapterId: z.string(),
  baseRevision: z.number().int().positive(),
  patches: z.array(patchSchema).max(100),
  generator: z.string(),
  modelVersion: z.string(),
  parentCandidateId: z.string().optional(),
  origin: z.enum(['policy', 'author', 'adapter']).optional(),
})
export const checkSchema = z.object({
  name: z.string(),
  status: z.enum(['pass', 'fail', 'pending']),
  detail: z.string(),
  evidenceIds: z.array(z.string()),
})
export const verificationSchema = z.object({
  candidateId: z.string(),
  patchIds: z.array(z.string()),
  program: z.array(checkSchema),
  semantic: z.array(checkSchema),
  author: z.object({ rating: z.number().optional(), note: z.string().optional() }).nullable(),
  status: z.enum(['pass', 'fail', 'pending']),
  checkerVersion: z.string(),
  factDiff: z
    .array(
      z.object({
        id: z.string(),
        before: z.boolean().nullable(),
        after: z.boolean().nullable(),
        status: z.enum(['pass', 'fail', 'pending']),
        detail: z.string(),
      }),
    )
    .optional(),
})
export const sourceSchema = z.object({
  chapterId: z.string(),
  revision: z.number(),
  validity: z.string(),
  liveRevision: z.number().nullable(),
  position: z.number().nullable(),
  storyTick: z.number().nullable(),
})
export const evidenceSchema = z.object({
  id: z.string(),
  kind: z.string(),
  sourceId: z.string(),
  chapterId: z.string().nullable(),
  location: rangeSchema.nullable(),
  sourceVersion: z.string(),
  sources: z.array(sourceSchema),
  text: z.string(),
  basis: z.string(),
})
export const itemSchema = z.object({
  id: z.string(),
  kind: z.string(),
  label: z.string(),
  text: z.string(),
  priority: z.number(),
  tokens: z.number(),
  reason: z.string(),
  evidenceIds: z.array(z.string()),
})
export const exclusionSchema = z.object({
  id: z.string(),
  kind: z.string(),
  reason: z.string(),
})
export const selectionSchema = z.object({
  diagnostics: z.array(z.string()),
  items: z.array(itemSchema),
  excluded: z.array(exclusionSchema),
  evidence: z.array(evidenceSchema),
  hits: z.array(
    z.object({
      id: z.string(),
      sourceType: z.string(),
      sourceId: z.string(),
      chapterId: z.string().nullable(),
      content: z.string(),
      summary: z.string(),
      keywords: z.string(),
      score: z.number(),
      reason: z.string().optional(),
      path: z.enum(['lexical', 'vector']).optional(),
      chapterDistance: z.number().nullable().optional(),
    }),
  ),
})
export const contextSchema = z.object({
  text: z.string(),
  evidence: z.array(evidenceSchema),
  report: z.object({
    tokenBudget: z.number(),
    estimatedTokens: z.number(),
    included: z.array(itemSchema),
    trimmed: z.array(itemSchema),
    excluded: z.array(exclusionSchema),
    truncation: z.string(),
    diagnostics: z.array(z.string()),
  }),
})
export const viewSchema = z.object({
  chapterId: z.string().optional(),
  audience: z.enum(['author', 'reader', 'character']).default('character'),
  holderId: z.string().optional(),
  storyTick: z.number().int().optional(),
  entityIds: z.array(z.string()).optional(),
  manualIds: z.array(z.string()).optional(),
})
export const scopeSchema = z.object({
  manualOnly: z.boolean().optional(),
  audience: z.enum(['world', 'belief', 'reader', 'author']).optional(),
  holderId: z.string().optional(),
  entityIds: z.array(z.string()).optional(),
  knownBy: z.array(z.string()).optional(),
  chapterIds: z.array(z.string()).optional(),
  volumeId: z.string().optional(),
  validFromTick: z.number().int().optional(),
  validToTick: z.number().int().optional(),
  tags: z.array(z.enum(['state', 'goal', 'causality', 'foreshadowing'])).optional(),
})

export const costsSchema = z.object({
  calls: z.number().nonnegative(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  latencyMs: z.number().nonnegative(),
  money: z.number().nullable(),
  tokenSource: z.enum(['estimated', 'provider']),
})
export const observationSchema = z.object({
  status: z.enum(['ok', 'pending', 'error']),
  output: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
      details: z.unknown().optional(),
    })
    .optional(),
  changes: z.array(
    z.object({
      kind: z.string(),
      id: z.string(),
      before: z.unknown(),
      after: z.unknown(),
    }),
  ),
  costs: costsSchema,
})
export const stepSchema = z.object({
  id: z.string(),
  tool: z.string(),
  toolVersion: z.string(),
  input: z.unknown(),
  attempt: z.number().int().positive(),
  startedAt: z.string(),
  beforeRevision: z.string(),
  afterRevision: z.string(),
  observation: observationSchema,
})
export const projectSnapshotSchema = z.object({
  projectId: z.string(),
  tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
})
export const adaptationSchema = z.object({
  schemaVersion: z.literal('novelweaver.tasks.v1'),
  routerVersion: z.string(),
  taskSpec: z
    .object({
      projectId: z.string(),
      schemaVersion: z.literal('novelweaver.tasks.v1'),
      operation: taskInputSchema.shape.operation.unwrap(),
      goal: z.string(),
      chapterId: z.string().optional(),
      baseRevision: z.number().int().positive().optional(),
      range: rangeSchema.optional(),
      storyScale: taskInputSchema.shape.storyScale,
      narrativeStructure: taskInputSchema.shape.narrativeStructure,
      inputSize: z.object({
        characters: z.number().int().nonnegative(),
        utf16: z.number().int().nonnegative(),
      }),
      targetLength: taskInputSchema.shape.targetLength,
      targetScope: z.enum(['project', 'chapter', 'selection']),
      continuityDepth: z.enum(['independent', 'chapter', 'cross_chapter']),
      preserve: z.array(z.string()),
      constraints: taskInputSchema.shape.constraints,
      allowedChanges: z.array(z.string()),
      artifactType: z.string(),
      fieldSources: z.record(z.string(), z.string()),
      requiredCapabilities: z.array(z.string()),
      knowledgeView: z.object({
        audience: z.enum(['author', 'reader', 'character']),
        chapterId: z.string().optional(),
        holderId: z.string().optional(),
        storyTick: z.number().optional(),
      }),
    })
    .passthrough(),
  plan: z
    .object({
      profileId: z.string(),
      profileVersion: z.string(),
      workflow: z.string(),
      workflowVersion: z.string(),
      planHash: z.string(),
      toolAllowlist: z.array(z.string()),
      feedbackMode: z.enum(['summary', 'fact_diff']),
      label: z.string(),
      contextPolicy: z.enum(['minimal', 'author', 'continuity', 'source', 'question']),
      modelRoles: z.array(z.enum(['planner', 'writer', 'reviewer', 'extractor', 'answerer'])),
      outputContract: z.string(),
      evaluationSpec: z.array(z.string()),
      evaluationSpecVersion: z.string(),
      segmentCount: z.number().int().positive(),
      budget: z.object({
        maxCalls: z.number().positive(),
        maxTokens: z.number().positive(),
        timeoutMs: z.number().positive(),
        maxRetries: z.number().nonnegative(),
        maxOutputTokens: z.number().positive(),
        contextTokens: z.number().positive(),
      }),
    })
    .passthrough(),
  routeDecision: z.object({
    rules: z.array(z.string()),
    alternatives: z.array(z.string()),
    missing: z.array(z.string()),
    status: z.enum(['ready', 'needs_input']),
  }),
  capabilitySnapshot: z.record(z.string(), z.boolean()),
})
export const runSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  projectId: z.string(),
  schemaVersion: z.literal('novelweaver.harness.v1'),
  workflow: z.string(),
  workflowVersion: z.string(),
  modelVersions: z.record(z.string(), z.string()),
  sourceFamilyId: z.string(),
  split: z.enum(['train', 'validation', 'test']),
  dataOrigin: z.enum(['synthetic', 'author']),
  request: z.record(z.string(), z.unknown()),
  initialState: projectSnapshotSchema,
  state: z.record(z.string(), z.unknown()),
  steps: z.array(stepSchema),
  status: z.enum(['running', 'paused', 'completed', 'failed', 'canceled']),
  stopReason: z.string(),
  cursor: z.number().int().nonnegative(),
  budget: z.object({
    maxCalls: z.number(),
    maxTokens: z.number(),
    timeoutMs: z.number(),
    maxRetries: z.number(),
    maxOutputTokens: z.number(),
  }),
  costs: costsSchema,
  randomState: z.number(),
  interaction: z.array(z.object({ role: z.string(), content: z.unknown(), at: z.string() })),
  adoption: z.array(z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
  adaptation: adaptationSchema.optional(),
})
export const snapshotSchema = z.object({
  schemaVersion: z.literal('novelweaver.harness.v1'),
  run: runSchema,
  database: projectSnapshotSchema,
  remainingBudget: z.object({ calls: z.number(), tokens: z.number() }),
  randomState: z.number(),
})
export const exportSchema = z.object({
  taskId: z.string(),
  sourceFamilyId: z.string(),
  split: z.enum(['train', 'validation', 'test']),
  schemaVersion: z.literal('novelweaver.harness.v1'),
  dataOrigin: z.enum(['synthetic', 'author']),
  initialState: projectSnapshotSchema,
  goal: z.string(),
  constraints: z.unknown(),
  workflow: z.object({ name: z.string(), version: z.string() }),
  modelVersions: z.record(z.string(), z.string()),
  steps: z.array(stepSchema),
  outcome: z.object({
    status: runSchema.shape.status,
    stopReason: z.string(),
    state: z.record(z.string(), z.unknown()),
  }),
  costs: costsSchema,
  verification: verificationSchema.nullable(),
  adoption: z.array(z.unknown()),
  interaction: runSchema.shape.interaction,
  randomState: z.number(),
  adaptation: adaptationSchema.optional(),
})
