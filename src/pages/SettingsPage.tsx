import { useEffect, useState } from 'react'
import { AlertTriangle, Check, CheckCircle2, CloudCog, Database, Download, Eye, EyeOff, KeyRound, Loader2, RefreshCw, Save, Server, ShieldCheck, Sparkles, Trash2 } from 'lucide-react'
import { api, patch, post, remove } from '../api'
import { useProject } from '../project-context'
import type { Project } from '../types'
import { Badge, Button, Field, Input, Modal, Textarea } from '../components/ui'

interface ModelStatus { baseUrl: string; model: string; configured: boolean; mode: string; source?: string; persistence?: string; engine?: string; fallbackDescription?: string; verifiedAt?: string; lastProbeError?: string; lastProbedAt?: string; latencyMs?: number; networkLatencyMs?: number; probeType?: 'gateway' | 'minimal-generation'; embedding?: { model: string | null; enabled: boolean; total: number; embedded: number; coverage: number } }
type Notice = { tone: 'success' | 'error' | 'info'; message: string }

const providers = {
  micu: { label: '米醋 API', baseUrl: 'https://www.micuapi.ai/v1', model: 'deepseek-v4-flash' },
  deepseek: { label: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini' },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/auto' },
  zhipu: { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  ollama: { label: 'Ollama（本机）', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b' },
} as const

function detectProvider(baseUrl: string, model: string) {
  return (Object.entries(providers).find(([, preset]) => preset.baseUrl === baseUrl && preset.model === model)?.[0] || 'custom') as keyof typeof providers | 'custom'
}

export function SettingsPage() {
  const { projectId, reloadProjects } = useProject()
  const [project, setProject] = useState<Project | null>(null)
  const [model, setModel] = useState<ModelStatus | null>(null)
  const [projectForm, setProjectForm] = useState({ name: '', genre: '', premise: '', wordGoal: 100000, status: 'active' as 'active' | 'completed' })
  const [modelForm, setModelForm] = useState({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini', apiKey: '', embeddingModel: '' })
  const [provider, setProvider] = useState<keyof typeof providers | 'custom'>('openai')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [probing, setProbing] = useState(false)
  const [catalog, setCatalog] = useState<string[]>([])
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [keyVisible, setKeyVisible] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState('')
  const [deleting, setDeleting] = useState(false)

  const load = async () => {
    const [projectRow, modelRow] = await Promise.all([api<Project>(`/api/projects/${projectId}`), api<ModelStatus>('/api/model')])
    setProject(projectRow)
    setModel(modelRow)
    setProjectForm({ name: projectRow.name, genre: projectRow.genre, premise: projectRow.premise, wordGoal: projectRow.word_goal, status: projectRow.status === 'completed' ? 'completed' : 'active' })
    setModelForm((form) => ({ ...form, baseUrl: modelRow.baseUrl, model: modelRow.model, embeddingModel: modelRow.embedding?.model || '' }))
    setProvider(detectProvider(modelRow.baseUrl, modelRow.model))
  }

  useEffect(() => { load() }, [projectId])

  const showNotice = (next: Notice, timeout = 5000) => {
    setNotice(next)
    window.setTimeout(() => setNotice((current) => current === next ? null : current), timeout)
  }

  const saveProject = async () => {
    await patch(`/api/projects/${projectId}`, projectForm)
    await reloadProjects()
    showNotice({ tone: 'success', message: '项目设置已保存' }, 2200)
  }

  const selectProvider = (value: keyof typeof providers | 'custom') => {
    setProvider(value)
    if (value !== 'custom') setModelForm((form) => ({ ...form, baseUrl: providers[value].baseUrl, model: providers[value].model }))
  }

  const saveAndProbe = async () => {
    setProbing(true)
    setNotice(null)
    try {
      const payload = {
        baseUrl: modelForm.baseUrl.trim(),
        model: modelForm.model.trim(),
        embeddingModel: modelForm.embeddingModel.trim(),
        ...(modelForm.apiKey.trim() ? { apiKey: modelForm.apiKey.trim() } : {}),
      }
      const configured = await post<ModelStatus>('/api/model', payload)
      setModel(configured)
      setModelForm((form) => ({ ...form, apiKey: '' }))
      if (!configured.configured) throw new Error('尚未填写 API Key，无法发起连接测试。')
      const verified = await post<ModelStatus>('/api/model/probe', {})
      setModel(verified)
      showNotice({ tone: 'success', message: verified.probeType === 'gateway'
        ? `网关连接成功：${verified.model}，网络延迟 ${verified.networkLatencyMs ?? verified.latencyMs} ms`
        : `模型连接成功：${verified.model}，最小响应 ${verified.latencyMs} ms` })
    } catch (caught) {
      const current = await api<ModelStatus>('/api/model').catch(() => null)
      if (current) setModel(current)
      showNotice({ tone: 'error', message: `连接失败：${(caught as Error).message}` }, 9000)
    } finally {
      setProbing(false)
    }
  }

  const fetchCatalog = async () => {
    if (!modelForm.baseUrl.trim()) { showNotice({ tone: 'error', message: '请先填写 API Base URL。' }); return }
    setCatalogLoading(true)
    try {
      const data = await post<{ models: string[] }>('/api/model/catalog', { baseUrl: modelForm.baseUrl.trim(), apiKey: modelForm.apiKey.trim() || undefined })
      setCatalog(data.models)
      showNotice({ tone: data.models.length ? 'success' : 'info', message: data.models.length ? `已拉取 ${data.models.length} 个可用模型，点击即可填入。` : '网关返回了空的模型列表。' })
    } catch (caught) {
      setCatalog([])
      showNotice({ tone: 'error', message: `模型列表拉取失败：${(caught as Error).message}` }, 8000)
    } finally { setCatalogLoading(false) }
  }

  const clearKey = async () => {
    const status = await post<ModelStatus>('/api/model', { clearKey: true })
    setModel(status)
    setModelForm((form) => ({ ...form, apiKey: '' }))
    showNotice({ tone: 'info', message: '临时密钥已清除，当前使用本地规则模式。' })
  }

  const deleteProject = async () => {
    if (!project || deleteConfirm !== project.name) return
    setDeleting(true)
    try {
      await remove(`/api/projects/${projectId}`)
      setDeleteOpen(false)
      setDeleteConfirm('')
      await reloadProjects()
    } catch (caught) {
      showNotice({ tone: 'error', message: `删除失败：${(caught as Error).message}` }, 8000)
    } finally {
      setDeleting(false)
    }
  }

  const exportProject = () => { window.location.href = `/api/projects/${projectId}/export` }

  return <div className="settings-page">
    {notice && <div className={`saved-toast ${notice.tone}`}><Check size={15} /> <span>{notice.message}</span></div>}

    <section className="surface settings-section">
      <header><div><Database size={19} /><div><h2>项目基线</h2><p>这些信息会进入每次上下文组装</p></div></div><Button onClick={saveProject}><Save size={15} /> 保存</Button></header>
      <div className="settings-form two-col"><Field label="项目名称"><Input value={projectForm.name} onChange={(event) => setProjectForm({ ...projectForm, name: event.target.value })} /></Field><Field label="题材"><Input value={projectForm.genre} onChange={(event) => setProjectForm({ ...projectForm, genre: event.target.value })} /></Field><Field label="目标字数"><Input type="number" value={projectForm.wordGoal} onChange={(event) => setProjectForm({ ...projectForm, wordGoal: Number(event.target.value) })} /></Field><label className={`completion-toggle ${projectForm.status === 'completed' ? 'active' : ''}`}><input type="checkbox" checked={projectForm.status === 'completed'} onChange={(event) => setProjectForm({ ...projectForm, status: event.target.checked ? 'completed' : 'active' })} /><CheckCircle2 size={18} /><span><strong>项目已完结</strong><small>标记作品正文已经完成；仍可继续编辑和分析。</small></span></label><Field label="核心命题"><Textarea rows={4} value={projectForm.premise} onChange={(event) => setProjectForm({ ...projectForm, premise: event.target.value })} /></Field></div>
    </section>

    <section className="surface settings-section">
      <header><div><CloudCog size={19} /><div><h2>模型网关</h2><p>兼容 OpenAI Chat Completions 协议</p></div></div><Badge tone={model?.verifiedAt ? 'teal' : model?.configured ? 'amber' : 'neutral'}>{model?.verifiedAt ? '连接已验证' : model?.configured ? '已配置，未连通' : '本地规则模式'}</Badge></header>
      <div className="model-mode"><div className={model?.configured ? '' : 'active'}><Server size={20} /><strong>本地模式</strong><p>{model?.fallbackDescription || '规则与模板，不是本地小模型。'}</p></div><div className={model?.configured ? 'active' : ''}><Sparkles size={20} /><strong>{model?.model || 'API 模型'}</strong><p>{model?.source === 'temporary' ? '临时进程配置，服务重启后失效' : model?.source === 'environment' ? '由 .env / 环境变量配置' : '尚未配置密钥'}{model?.verifiedAt ? ` · 已于 ${new Date(model.verifiedAt).toLocaleTimeString('zh-CN')} 实测` : model?.lastProbeError ? ` · 最近测试失败：${model.lastProbeError}` : ' · 尚未实测连通性'}</p></div></div>
      <div className="settings-form two-col model-settings-grid">
        <Field label="API 服务商"><select className="input" value={provider} onChange={(event) => selectProvider(event.target.value as keyof typeof providers | 'custom')}><option value="micu">米醋 API</option><option value="deepseek">DeepSeek 官方</option><option value="openai">OpenAI</option><option value="openrouter">OpenRouter</option><option value="zhipu">智谱 GLM</option><option value="ollama">Ollama（本机）</option><option value="custom">自定义兼容接口</option></select></Field>
        <Field label="模型名称" hint="不确定模型名时，先「拉取列表」再点选。">
          <div className="model-name-row">
            <Input value={modelForm.model} onChange={(event) => { setProvider('custom'); setModelForm({ ...modelForm, model: event.target.value }) }} />
            <Button variant="ghost" onClick={fetchCatalog} disabled={catalogLoading}>{catalogLoading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />} 拉取列表</Button>
          </div>
          {catalog.length > 0 && <div className="model-catalog">{catalog.slice(0, 30).map((name) => <button key={name} type="button" className={name === modelForm.model ? 'active' : ''} onClick={() => { setProvider('custom'); setModelForm({ ...modelForm, model: name }) }}>{name}</button>)}{catalog.length > 30 && <span>…共 {catalog.length} 个</span>}</div>}
        </Field>
        <Field label="API Base URL" hint="只填到服务商的 /v1；若误粘贴 /chat/completions，系统会自动移除。"><Input value={modelForm.baseUrl} onChange={(event) => { setProvider('custom'); setModelForm({ ...modelForm, baseUrl: event.target.value }) }} placeholder="https://example.com/v1" /></Field>
        <Field label="临时 API Key" hint={model?.configured ? '留空会保留当前密钥。临时密钥仅存在服务进程内，重启后失效。' : '仅存在当前服务进程内。需要重启后保留，请配置项目根目录的 .env。'}><div className="secret-input"><KeyRound size={15} /><Input type={keyVisible ? 'text' : 'password'} autoComplete="off" value={modelForm.apiKey} onChange={(event) => setModelForm({ ...modelForm, apiKey: event.target.value })} placeholder={model?.configured ? '已配置；留空保持不变' : '粘贴 API Key'} /><button type="button" className="key-toggle" onClick={() => setKeyVisible((visible) => !visible)} title={keyVisible ? '隐藏密钥' : '显示密钥'}>{keyVisible ? <EyeOff size={14} /> : <Eye size={14} />}</button></div></Field>
        <Field label="Embedding 模型（可选）" hint={model?.embedding ? `已向量化 ${model.embedding.embedded}/${model.embedding.total} 块记忆（覆盖率 ${(model.embedding.coverage * 100).toFixed(0)}%）。检索按查询形态自动门控：含实体名走词法，否则走向量。` : '填写后启用向量语义检索；留空则全部使用词法检索。'}><Input value={modelForm.embeddingModel} onChange={(event) => setModelForm({ ...modelForm, embeddingModel: event.target.value })} placeholder="例如 GLM-Embedding-3" /></Field>
        <div className="settings-actions"><Button onClick={saveAndProbe} disabled={probing || !modelForm.baseUrl.trim() || !modelForm.model.trim()}><Sparkles size={15} /> {probing ? '正在实测…' : '保存并测试'}</Button>{model?.configured && <Button variant="ghost" onClick={clearKey}>清除临时密钥</Button>}</div>
      </div>
      <p className="config-note">连接测试优先使用轻量 <code>/models</code> 网关探测；服务商不支持时才发送限制为 2 tokens 的最小生成。实际创作仍通过 <code>/chat/completions</code>。</p>
    </section>

    <div className="settings-split"><section className="surface settings-section compact"><header><div><ShieldCheck size={19} /><div><h2>数据与隐私</h2><p>本地 SQLite 数据库</p></div></div></header><ul><li><Check size={14} /> 仅在触发模型生成或分析时发送所需上下文</li><li><Check size={14} /> API Key 不写入数据库</li><li><Check size={14} /> 每次生成保留上下文快照</li><li><Check size={14} /> AI 候选不会自动写入正史</li></ul></section><section className="surface settings-section compact"><header><div><Download size={19} /><div><h2>备份与导出</h2><p>完整可迁移的项目数据</p></div></div></header><p>导出章节、设定、事件、关系、伏笔与项目元数据。文件不包含 API Key。</p><Button variant="secondary" onClick={exportProject}><Download size={15} /> 导出 JSON 备份</Button></section></div>

    <section className="surface settings-section danger-zone"><header><div><AlertTriangle size={19} /><div><h2>危险操作</h2><p>删除后无法从应用内恢复</p></div></div><Button variant="danger" onClick={() => setDeleteOpen(true)}><Trash2 size={15} /> 删除项目</Button></header><p>永久删除当前项目的章节、设定档案、剧情线、事件、事实摘要、记忆索引和审查记录。建议先导出 JSON 备份。</p></section>

    {deleteOpen && project && <Modal title="删除项目" onClose={() => { if (!deleting) { setDeleteOpen(false); setDeleteConfirm('') } }} footer={<><Button variant="ghost" onClick={() => { setDeleteOpen(false); setDeleteConfirm('') }} disabled={deleting}>取消</Button><Button variant="danger" onClick={deleteProject} disabled={deleting || deleteConfirm !== project.name}><Trash2 size={15} /> {deleting ? '正在删除…' : '永久删除'}</Button></>}>
      <div className="delete-confirm"><AlertTriangle size={28} /><p>这会永久删除 <strong>{project.name}</strong> 及其全部创作数据，无法撤销。</p><Field label={`请输入项目名称“${project.name}”以确认`}><Input autoFocus value={deleteConfirm} onChange={(event) => setDeleteConfirm(event.target.value)} /></Field></div>
    </Modal>}
  </div>
}
