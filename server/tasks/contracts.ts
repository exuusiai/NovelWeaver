import { z } from 'zod'

export const TASK_SCHEMA_VERSION = 'novelweaver.tasks.v1' as const
export const operationSchema = z.enum([
  'outline',
  'chapter_outline',
  'setting',
  'plot',
  'draft',
  'continue',
  'revise',
  'review',
  'extract',
  'qa',
  'analysis',
])
export const taskInputSchema = z.object({
  projectId: z.string().min(1),
  operation: operationSchema.optional(),
  task: z.enum(['chat', 'outline', 'chapter_outline', 'prose', 'setting', 'plot', 'analysis']).optional(),
  goal: z.string().max(8000).optional(),
  prompt: z.string().max(8000).optional(),
  chapterId: z.string().optional(),
  baseRevision: z.number().int().positive().optional(),
  range: z
    .object({
      start: z.number().int().nonnegative(),
      end: z.number().int().positive(),
    })
    .optional(),
  chapterContent: z.string().max(200000).optional(),
  chapterOutline: z.string().max(30000).optional(),
  storyScale: z.enum(['short', 'medium', 'long', 'unspecified']).default('unspecified'),
  narrativeStructure: z
    .enum(['single', 'ensemble', 'episodic', 'relay', 'open', 'unspecified'])
    .default('unspecified'),
  targetLength: z
    .object({
      value: z.number().int().positive().max(100000),
      unit: z.enum(['characters', 'tokens']),
    })
    .optional(),
  targetWords: z.number().int().positive().max(100000).optional(),
  scope: z.enum(['upto', 'full']).optional(),
  knowledgeView: z.enum(['author', 'reader', 'character']).optional(),
  holderId: z.string().optional(),
  storyTick: z.number().int().optional(),
  pov: z.string().default(''),
  preserve: z.array(z.string().min(1)).max(100).default([]),
  constraints: z
    .array(
      z.object({
        id: z.string(),
        type: z.enum(['literal', 'semantic', 'knowledge', 'forbidden']),
        text: z.string().min(1),
      }),
    )
    .max(100)
    .default([]),
  allowedChanges: z.array(z.string()).default(['措辞', '节奏']),
  evidenceIds: z.array(z.string()).default([]),
  sourceFamilyId: z.string().default('author-unassigned'),
  split: z.enum(['train', 'validation', 'test']).default('train'),
  dataOrigin: z.enum(['author', 'synthetic']).default('author'),
  seed: z.number().int().default(1),
  feedbackMode: z.enum(['summary', 'fact_diff']).default('summary'),
  budget: z
    .object({
      maxCalls: z.number().int().min(1).max(100).optional(),
      maxTokens: z.number().int().positive().max(200000).optional(),
      timeoutMs: z.number().int().min(1).max(120000).optional(),
      maxRetries: z.number().int().min(0).max(3).optional(),
      maxOutputTokens: z.number().int().min(1).max(16000).optional(),
      contextTokens: z.number().int().positive().max(50000).optional(),
    })
    .optional(),
})
export type TaskInput = z.input<typeof taskInputSchema>
export type Operation = z.infer<typeof operationSchema>
export type ModelRole = 'planner' | 'writer' | 'reviewer' | 'extractor' | 'answerer'
export interface TaskSpec {
  requiredCapabilities: string[]
  schemaVersion: typeof TASK_SCHEMA_VERSION
  projectId: string
  operation: Operation
  goal: string
  chapterId?: string
  baseRevision?: number
  range?: { start: number; end: number }
  storyScale: 'short' | 'medium' | 'long' | 'unspecified'
  narrativeStructure: string
  inputSize: { characters: number; utf16: number }
  targetLength?: { value: number; unit: 'characters' | 'tokens' }
  targetScope: 'project' | 'chapter' | 'selection'
  continuityDepth: 'independent' | 'chapter' | 'cross_chapter'
  knowledgeView: {
    audience: 'author' | 'reader' | 'character'
    holderId?: string
    storyTick?: number
    chapterId?: string
  }
  preserve: string[]
  constraints: z.infer<typeof taskInputSchema>['constraints']
  allowedChanges: string[]
  artifactType: string
  fieldSources: Record<string, string>
}
export interface TaskProfile {
  id: string
  version: string
  label: string
  workflow: string
  modelRole: ModelRole
  contextPolicy: 'minimal' | 'author' | 'continuity' | 'source' | 'question'
  toolAllowlist: string[]
  evaluationSpec: string[]
  contextTokens: number
  outputTokens: number
}
export interface ExecutionPlan {
  feedbackMode: 'summary' | 'fact_diff'
  profileId: string
  profileVersion: string
  label: string
  workflow: string
  workflowVersion: string
  contextPolicy: TaskProfile['contextPolicy']
  toolAllowlist: string[]
  modelRoles: ModelRole[]
  outputContract: string
  evaluationSpec: string[]
  evaluationSpecVersion: string
  budget: {
    maxCalls: number
    maxTokens: number
    timeoutMs: number
    maxRetries: number
    maxOutputTokens: number
    contextTokens: number
  }
  segmentCount: number
  planHash: string
}
export interface TaskResolution {
  schemaVersion: typeof TASK_SCHEMA_VERSION
  routerVersion: string
  taskSpec: TaskSpec
  plan: ExecutionPlan
  routeDecision: {
    rules: string[]
    alternatives: string[]
    missing: string[]
    status: 'ready' | 'needs_input'
  }
  capabilitySnapshot: Record<string, boolean>
}
const citedText = { text: z.string().min(1), evidenceIds: z.array(z.string()) }
export const artifactSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.enum(['outline', 'chapter_outline', 'setting', 'plot', 'draft', 'answer', 'analysis']),
    ...citedText,
  }),
  z.object({
    kind: z.literal('findings'),
    text: z.string(),
    findings: z.array(
      z.object({
        title: z.string().min(1),
        detail: z.string(),
        status: z.enum(['supported', 'needs_review']),
        evidenceIds: z.array(z.string()).min(1),
        location: z
          .object({
            start: z.number().int().nonnegative(),
            end: z.number().int().positive(),
          })
          .optional(),
      }),
    ),
    evidenceIds: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('structure'),
    text: z.string(),
    scenes: z
      .array(
        z.object({
          id: z.string(),
          start: z.number().int().nonnegative(),
          end: z.number().int().positive(),
        }),
      )
      .min(1),
    events: z.array(
      z.object({
        sceneId: z.string(),
        description: z.string().min(1),
        evidenceIds: z.array(z.string()).min(1),
      }),
    ),
    outline: z.array(z.string()),
    evidenceIds: z.array(z.string()).min(1),
  }),
])
export type Artifact = z.infer<typeof artifactSchema>
