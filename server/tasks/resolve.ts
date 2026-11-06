import { createHash } from 'node:crypto'
import { taskInputSchema, TASK_SCHEMA_VERSION, type TaskResolution, type Operation } from './contracts.ts'
import { getTaskProfile } from './profiles.ts'

export const ROUTER_VERSION = 'rules.1.0.0'
export const hashPlan = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function resolveTask(raw: unknown, capabilities: Record<string, boolean> = {}): TaskResolution {
  const i = taskInputSchema.parse(raw)
  const goal = i.goal ?? i.prompt ?? ''
  const rules: string[] = [],
    missing: string[] = []
  let operation = i.operation
  if (operation) rules.push('explicit_operation')
  else if (i.task) {
    operation = (
      {
        chat: 'qa',
        prose: i.chapterId ? 'continue' : 'draft',
        analysis: 'analysis',
        outline: 'outline',
        chapter_outline: 'chapter_outline',
        setting: 'setting',
        plot: 'plot',
      } as Record<string, Operation>
    )[i.task]
    rules.push(`legacy_task:${i.task}`)
  } else if (i.range && i.chapterId) {
    operation = 'revise'
    rules.push('legacy_edit_range')
  } else {
    const candidates: Array<[RegExp, Operation]> = [
      [/只.*检查|审查|检查.*一致|列.*问题/, 'review'],
      [/提取.*(场景|事件|结构)|结构提取/, 'extract'],
      [/润色|改写|修改|改稿/, 'revise'],
      [/续写|接着写/, 'continue'],
      [/细纲/, 'chapter_outline'],
      [/大纲/, 'outline'],
      [/写.*(短篇|故事|场景)|创作.*故事/, 'draft'],
      [/问答|谁|什么|哪里|何时|为什么/, 'qa'],
    ]
    operation = candidates.find(([regex]) => regex.test(goal))?.[1]
    rules.push(operation ? 'goal_rule' : 'ambiguous_goal')
    if (!operation) {
      operation = 'analysis'
      missing.push('operation')
    }
  }
  if (!goal.trim()) missing.push('goal')
  if (['revise', 'continue'].includes(operation) && !i.chapterId) missing.push('chapterId')
  if (operation === 'extract' && !i.chapterId && !i.chapterContent) missing.push('sourceText')
  const length =
    i.targetLength ?? (i.targetWords ? { value: i.targetWords, unit: 'characters' as const } : undefined)
  let profileId = ['outline', 'chapter_outline', 'setting', 'plot'].includes(operation)
    ? 'planning'
    : operation === 'revise'
      ? 'revision.local'
      : operation === 'review'
        ? 'review.consistency'
        : operation === 'extract'
          ? 'analysis.structure'
          : operation === 'qa'
            ? 'project.qa'
            : operation === 'analysis'
              ? 'analysis.general'
              : operation === 'continue'
                ? 'draft.continuation'
                : length && length.value > 2000
                  ? 'draft.continuation'
                  : 'draft.standalone'
  const profile = getTaskProfile(profileId)
  const view =
    i.knowledgeView ??
    (i.scope === 'full' ||
    !i.chapterId ||
    ['planning', 'review.consistency', 'analysis.structure', 'analysis.general'].includes(profileId)
      ? 'author'
      : 'character')
  const artifactType =
    operation === 'review'
      ? 'findings'
      : operation === 'extract'
        ? 'structure'
        : operation === 'qa'
          ? 'answer'
          : ['draft', 'continue', 'revise'].includes(operation)
            ? 'draft'
            : operation
  const taskSpec: TaskResolution['taskSpec'] = {
    requiredCapabilities:
      profileId === 'revision.local'
        ? ['revision_generator', 'revision_checker']
        : [profile.modelRole, 'semantic_checker'],
    schemaVersion: TASK_SCHEMA_VERSION,
    projectId: i.projectId,
    operation,
    goal,
    chapterId: i.chapterId,
    baseRevision: i.baseRevision,
    range: i.range,
    storyScale: i.storyScale,
    narrativeStructure: i.narrativeStructure,
    inputSize: {
      characters: Array.from(i.chapterContent ?? '').length,
      utf16: (i.chapterContent ?? '').length,
    },
    targetLength: length,
    targetScope: i.range ? 'selection' : i.chapterId ? 'chapter' : 'project',
    continuityDepth:
      profileId === 'draft.standalone'
        ? i.chapterId
          ? 'chapter'
          : 'independent'
        : i.chapterId
          ? 'cross_chapter'
          : 'independent',
    knowledgeView: {
      audience: view,
      chapterId: i.chapterId,
      holderId: i.holderId,
      storyTick: i.storyTick,
    },
    preserve: i.preserve,
    constraints: i.constraints,
    allowedChanges: i.allowedChanges,
    artifactType,
    fieldSources: {
      operation: rules[0],
      storyScale: i.storyScale === 'unspecified' ? 'default' : 'user',
      narrativeStructure: i.narrativeStructure === 'unspecified' ? 'default' : 'user',
      targetLength: i.targetLength ? 'user' : i.targetWords ? 'legacy_characters' : 'unspecified',
      knowledgeView: i.knowledgeView ? 'user' : 'profile_default',
    },
  }
  const segmentCount =
    profileId === 'draft.continuation' && length
      ? Math.min(
          8,
          Math.max(1, Math.ceil(length.value / (i.budget?.maxOutputTokens ?? profile.outputTokens))),
        )
      : 1
  const plan = {
    feedbackMode: i.feedbackMode,
    profileId,
    profileVersion: profile.version,
    label: profile.label,
    workflow: profile.workflow,
    workflowVersion: profile.version,
    contextPolicy: profile.contextPolicy,
    toolAllowlist: [...profile.toolAllowlist],
    modelRoles: [profile.modelRole],
    outputContract: artifactType,
    evaluationSpec: [...profile.evaluationSpec],
    evaluationSpecVersion: '1.0.0',
    budget: {
      maxCalls: i.budget?.maxCalls ?? 24,
      maxTokens: i.budget?.maxTokens ?? 40000,
      timeoutMs: i.budget?.timeoutMs ?? 30000,
      maxRetries: i.budget?.maxRetries ?? 1,
      maxOutputTokens: i.budget?.maxOutputTokens ?? profile.outputTokens,
      contextTokens: i.budget?.contextTokens ?? profile.contextTokens,
    },
    segmentCount,
  }
  return {
    schemaVersion: TASK_SCHEMA_VERSION,
    routerVersion: ROUTER_VERSION,
    taskSpec,
    plan: { ...plan, planHash: hashPlan(plan) },
    routeDecision: {
      rules,
      alternatives: missing.length ? ['planning', 'review.consistency', 'revision.local'] : [],
      missing,
      status: missing.length ? 'needs_input' : 'ready',
    },
    capabilitySnapshot: { ...capabilities },
  }
}
