import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { ProjectProvider } from './project-context'
import { AppShell } from './components/AppShell'

const Dashboard = lazy(() => import('./pages/Dashboard').then((m) => ({ default: m.Dashboard })))
const WritingStudio = lazy(() => import('./pages/WritingStudio').then((m) => ({ default: m.WritingStudio })))
const PlotBoard = lazy(() => import('./pages/PlotBoard').then((m) => ({ default: m.PlotBoard })))
const WorldBible = lazy(() => import('./pages/WorldBible').then((m) => ({ default: m.WorldBible })))
const MemoryLab = lazy(() => import('./pages/MemoryLab').then((m) => ({ default: m.MemoryLab })))
const ReviewCenter = lazy(() => import('./pages/ReviewCenter').then((m) => ({ default: m.ReviewCenter })))
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })))
const AnalysisCenter = lazy(() => import('./pages/AnalysisCenter').then((m) => ({ default: m.AnalysisCenter })))
const StoryGraph = lazy(() => import('./pages/StoryGraph').then((m) => ({ default: m.StoryGraph })))

function RouteLoading() {
  return <div className="route-loading"><Loader2 className="spin" size={22} /><span>正在加载页面…</span></div>
}

export default function App() {
  return <BrowserRouter><ProjectProvider><Routes><Route element={<AppShell />}>
    <Route index element={<Suspense fallback={<RouteLoading />}><Dashboard /></Suspense>} /><Route path="write" element={<Suspense fallback={<RouteLoading />}><WritingStudio /></Suspense>} /><Route path="plot" element={<Suspense fallback={<RouteLoading />}><PlotBoard /></Suspense>} />
    <Route path="bible" element={<Suspense fallback={<RouteLoading />}><WorldBible /></Suspense>} /><Route path="graph" element={<Suspense fallback={<RouteLoading />}><StoryGraph /></Suspense>} /><Route path="memory" element={<Suspense fallback={<RouteLoading />}><MemoryLab /></Suspense>} />
    <Route path="analysis" element={<Suspense fallback={<RouteLoading />}><AnalysisCenter /></Suspense>} /><Route path="review" element={<Suspense fallback={<RouteLoading />}><ReviewCenter /></Suspense>} /><Route path="settings" element={<Suspense fallback={<RouteLoading />}><SettingsPage /></Suspense>} />
  </Route></Routes></ProjectProvider></BrowserRouter>
}
