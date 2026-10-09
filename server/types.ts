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
  /** 编辑中的未保存正文：让生成基于作者眼前所见，而非数据库旧稿 */
  chapterContent?: string
  /** 当前章细纲（未保存或已保存均可） */
  chapterOutline?: string
  /** upto：只看本章及之前；full：全书视角 */
  scope?: 'upto' | 'full'
}

export interface RuntimeModelConfig {
  baseUrl: string
  apiKey: string
  model: string
}
