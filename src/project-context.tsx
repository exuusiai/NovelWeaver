import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from './api'
import type { Project } from './types'

interface ProjectContextValue {
  projects: Project[]
  projectId: string
  project?: Project
  loading: boolean
  setProjectId: (id: string) => void
  reloadProjects: () => Promise<void>
}

const ProjectContext = createContext<ProjectContextValue | null>(null)

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectIdState] = useState(localStorage.getItem('novelweaver.project') || '')
  const [loading, setLoading] = useState(true)

  const reloadProjects = async () => {
    const rows = await api<Project[]>('/api/projects')
    setProjects(rows)
    if (!rows.some((row) => row.id === projectId)) {
      const next = rows[0]?.id || ''
      setProjectIdState(next)
      if (next) localStorage.setItem('novelweaver.project', next)
      else localStorage.removeItem('novelweaver.project')
    }
    setLoading(false)
  }

  useEffect(() => { reloadProjects().catch(() => setLoading(false)) }, [])

  const setProjectId = (id: string) => {
    setProjectIdState(id)
    localStorage.setItem('novelweaver.project', id)
  }

  const value = useMemo(() => ({ projects, projectId, project: projects.find((row) => row.id === projectId), loading, setProjectId, reloadProjects }), [projects, projectId, loading])
  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>
}

export function useProject() {
  const value = useContext(ProjectContext)
  if (!value) throw new Error('ProjectProvider is missing')
  return value
}
