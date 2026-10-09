export interface Project {
  id: string
  name: string
  genre: string
  premise: string
  status: string
  word_goal: number
  imported: number
  created_at: string
  updated_at: string
  chapter_count?: number
  character_count?: number
  entity_count?: number
  open_review_count?: number
  metrics?: {
    chapters: number
    characters: number
    entities: number
    events: number
    open_foreshadowing: number
    open_reviews: number
  }
}

export interface Chapter {
  id: string
  project_id: string
  title: string
  content: string
  position: number
  status: string
  summary: string
  pov: string
  target_words: number
  updated_at: string
  content_hash?: string
  analyzed_hash?: string
  bookmarked: number
  importance: 'normal' | 'important' | 'critical'
  mark_note: string
  volume_id: string | null
  volume_title: string | null
  volume_order_index: number | null
  detailed_outline: string
  outline_status: string
}

export interface ChapterHistory {
  id: string
  chapter_id: string
  title: string
  summary: string
  word_count: number
  preview: string
  created_at: string
}

export interface PrecheckIssue {
  category: string
  severity: string
  title: string
  description: string
}

export interface ProjectStats {
  chapters: number
  wordsTotal: number
  generations: { total: number; appended: number; discarded: number; acceptanceRate: number | null }
  reviews: { open: number; resolved: number; resolutionRate: number | null }
  historyVersions: number
  tokenCalibration: { samples: number; avgRatio: number } | null
}

export interface Volume {
  id: string
  project_id: string
  title: string
  summary: string
  order_index: number
  chapter_count: number
  character_count: number
}

export interface Entity {
  id: string
  project_id: string
  type: string
  name: string
  summary: string
  data: Record<string, unknown>
  canon_status: string
  confidence: number
  updated_at: string
  source_chapter_id?: string | null
}

export interface Plotline {
  id: string
  name: string
  type: string
  summary: string
  color: string
  status: string
}

export interface StoryOutline {
  id: string
  project_id: string
  title: string
  content: string
  version: number
  parent_id: string | null
  status: 'candidate' | 'current' | 'archived'
  source_prompt: string
  created_at: string
  updated_at: string
}

export interface OutlineDecomposition {
  plotlines: Array<{
    name: string
    type: string
    summary: string
    color?: string
    events: Array<{ title: string; summary: string; phase: string; participants: string[]; location: string; cause: string; consequence: string }>
  }>
  volumes: Array<{
    title: string
    summary: string
    chapters: Array<{
      title: string
      summary: string
      pov: string
      targetWords: number
      purpose: string
      entryState: string
      scenes: Array<{ title: string; objective: string; obstacle: string; information: string; turn: string }>
      exitState: string
      continuity: string[]
      plotlineNames: string[]
    }>
  }>
}

export interface StoryEvent {
  id: string
  title: string
  summary: string
  story_time: string
  narrative_order: number
  status: string
  plotline_id: string | null
  chapter_id: string | null
  participants: string[]
  location: string
  cause: string
  consequence: string
}

export interface Foreshadowing {
  id: string
  title: string
  setup_chapter_id: string | null
  payoff_chapter_id: string | null
  status: string
  notes: string
}

export interface Relation {
  id: string
  from_entity_id: string
  to_entity_id: string
  type: string
  label: string
  sentiment: string
  strength: number
}

export interface ReviewIssue {
  id: string
  category: string
  severity: string
  title: string
  description: string
  evidence: string[]
  status: string
  created_at: string
  ai_suggestion?: { verdict: 'auto_resolve' | 'suggest_ignore' | 'needs_human'; rationale: string; action: string } | null
}

export interface SearchHit {
  id: string
  sourceType: string
  sourceId: string
  chapterId: string | null
  content: string
  summary: string
  keywords: string
  score: number
  chapterDistance?: number | null
  reason?: string
  path?: 'lexical' | 'vector'
}

export interface ContextReport {
  tokenBudget: number
  estimatedTokens: number
  included: Array<{ kind: string; label: string; tokens: number }>
  trimmed: Array<{ kind: string; label: string; tokens: number }>
}

export interface StoryFact {
  id: string
  subject: string
  predicate: string
  value: string
  source_chapter_id: string | null
  source_chapter_title?: string | null
  importance: number
  canon_status: 'candidate' | 'canon' | 'deprecated'
  evidence: string
}

export interface GenerationResult {
  generationId?: string
  output: string
  model: string
  citations: SearchHit[]
  contextReport?: ContextReport
  /** 生成时绑定的章节与任务：防止跨章节/跨任务误采纳 */
  chapterId?: string
  task?: string
}

export interface AnalysisJob {
  id: string
  project_id: string
  status: 'queued' | 'running' | 'paused' | 'partial' | 'completed' | 'failed'
  stage: string
  progress: number
  message: string
  error: string
  result: { entities?: number; events?: number; plotlines?: number; relations?: number; batches?: number; failures?: Array<{ chapterIds: string[]; message: string }>; disagreements?: Array<{ kind: string; label: string; detail: string }> }
  created_at: string
  updated_at: string
}

export interface ImportPreviewChapter {
  title: string
  content: string
  summary: string
  position: number
}

export interface EntityEdit {
  id: string
  action: string
  target_id: string | null
  payload: Record<string, unknown>
  undone: number
  created_at: string
}
