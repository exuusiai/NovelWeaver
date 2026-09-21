import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { ProjectProvider } from './project-context'
import { AppShell } from './components/AppShell'
import { Dashboard } from './pages/Dashboard'
import { WritingStudio } from './pages/WritingStudio'
import { PlotBoard } from './pages/PlotBoard'
import { WorldBible } from './pages/WorldBible'
import { MemoryLab } from './pages/MemoryLab'
import { ReviewCenter } from './pages/ReviewCenter'
import { SettingsPage } from './pages/SettingsPage'
import { AnalysisCenter } from './pages/AnalysisCenter'

export default function App() {
  return <BrowserRouter><ProjectProvider><Routes><Route element={<AppShell />}>
    <Route index element={<Dashboard />} /><Route path="write" element={<WritingStudio />} /><Route path="plot" element={<PlotBoard />} />
    <Route path="bible" element={<WorldBible />} /><Route path="graph" element={<Navigate to="/bible" replace />} /><Route path="memory" element={<MemoryLab />} />
    <Route path="analysis" element={<AnalysisCenter />} /><Route path="review" element={<ReviewCenter />} /><Route path="settings" element={<SettingsPage />} />
  </Route></Routes></ProjectProvider></BrowserRouter>
}
