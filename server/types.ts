export type CanonStatus = 'canon' | 'candidate' | 'rumor' | 'deprecated' | 'branch'

export interface ProjectRow {
  id: string
  name: string
  genre: string
  premise: string
  status: string
  word_goal: number
  imported: number
  created_at: string
  updated_at: string
}

export interface ParsedChapter {
  title: string
  content: string
  position: number
  summary: string
}

export interface ModelRequest {
  task: 'chat' | 'outline' | 'chapter_outline' | 'prose' | 'setting' | 'plot' | 'analysis'
  prompt: string
  projectId: string
  chapterId?: string
  context?: string
}

export interface RuntimeModelConfig {
  baseUrl: string
  apiKey: string
  model: string
}
