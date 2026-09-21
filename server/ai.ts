import 'dotenv/config'
import type { ModelRequest, RuntimeModelConfig } from './types.ts'
import { assembleContext } from './memory.ts'
import { sql } from './db.ts'

export function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '')
}

let runtimeConfig: RuntimeModelConfig = {
  baseUrl: normalizeBaseUrl(process.env.AI_BASE_URL || 'https://api.openai.com/v1'),
  apiKey: (process.env.AI_API_KEY || '').trim(),
  model: (process.env.AI_MODEL || 'gpt-5-mini').trim(),
}

let configSource: 'environment' | 'temporary' | 'none' = runtimeConfig.apiKey ? (process.env.AI_CONFIG_SOURCE === 'temporary' ? 'temporary' : 'environment') : 'none'
let verifiedAt = ''
let lastProbeError = ''
let lastProbedAt = ''
let thinkingSupport: 'unknown' | 'supported' | 'unsupported' = 'unknown'

export function getModelStatus() {
  return {
    baseUrl: runtimeConfig.baseUrl,
    model: runtimeConfig.model,
    configured: Boolean(runtimeConfig.apiKey),
    mode: runtimeConfig.apiKey ? 'remote' : 'local',
    source: configSource,
    persistence: configSource === 'temporary' ? 'process-only' : configSource === 'environment' ? 'environment' : 'none',
    engine: runtimeConfig.apiKey ? 'OpenAI-compatible Chat Completions' : 'local-rules-v1',
    fallbackDescription: '本地规则与模板（不是语言模型）',
    verifiedAt,
    lastProbeError,
    lastProbedAt,
  }
}

export function setRuntimeConfig(next: Partial<RuntimeModelConfig>) {
  if (next.baseUrl !== undefined) runtimeConfig.baseUrl = normalizeBaseUrl(next.baseUrl)
  if (next.model !== undefined) runtimeConfig.model = next.model.trim()
  if (next.apiKey !== undefined) {
    runtimeConfig.apiKey = next.apiKey.trim()
    configSource = runtimeConfig.apiKey ? 'temporary' : 'none'
  }
  verifiedAt = ''
  lastProbeError = ''
  thinkingSupport = 'unknown'
  return getModelStatus()
}

async function chatCompletion(messages: Array<{ role: 'system' | 'user'; content: string }>, temperature = 0.2, json = false, options: { maxTokens?: number; disableThinking?: boolean; timeoutMs?: number } = {}) {
  if (!runtimeConfig.apiKey) throw Object.assign(new Error('当前未配置模型 API。请先在设置页填写 API Key。'), { code: 'MODEL_REQUIRED' })
  const request = (strictJson: boolean, disableThinking: boolean) => fetch(`${runtimeConfig.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${runtimeConfig.apiKey}` },
    signal: AbortSignal.timeout(options.timeoutMs ?? 120000),
    body: JSON.stringify({ model: runtimeConfig.model, temperature, ...((options.maxTokens || json) ? { max_tokens: options.maxTokens ?? 16000 } : {}), ...(disableThinking ? { thinking: { type: 'disabled' } } : {}), ...(strictJson ? { response_format: { type: 'json_object' } } : {}), messages }),
  })
  let disableThinking = (options.disableThinking ?? true) && thinkingSupport !== 'unsupported'
  let response = await request(json, disableThinking)
  let rawError = response.ok ? '' : await response.text()
  if (response.ok && disableThinking) thinkingSupport = 'supported'
  if (disableThinking && response.status === 400) {
    thinkingSupport = 'unsupported'
    disableThinking = false
    response = await request(json, false)
    rawError = response.ok ? '' : await response.text()
  }
  if (json && response.status === 400 && /response[_\s-]?format|json[_\s-]?object/i.test(rawError)) {
    response = await request(false, false)
    rawError = response.ok ? '' : await response.text()
  }
  if (!response.ok) {
    let message = rawError
    let code = ''
    try {
      const parsed = JSON.parse(rawError) as { error?: { message?: string; code?: string } }
      message = parsed.error?.message || rawError
      code = parsed.error?.code || ''
    } catch { /* keep provider text */ }
    const hint = response.status === 401 ? 'API Key 无效或已过期。'
      : response.status === 403 ? 'API Key 没有调用该模型的权限。'
        : response.status === 404 ? '请检查 Base URL 和模型名称。Base URL 不应包含 /chat/completions。'
          : response.status === 429 ? '额度不足或请求频率受限。'
            : code === 'model_not_found' ? '当前令牌或分组没有该模型的可用渠道，请在服务商控制台检查模型授权、分组和余额。'
              : response.status >= 500 ? '服务商渠道当前不可用，请稍后重试或更换模型。' : ''
    throw new Error(`模型连接失败（HTTP ${response.status}）：${message}${hint ? ` ${hint}` : ''}`)
  }
  const data = await response.json() as {
    choices?: Array<{
      finish_reason?: string
      text?: string
      message?: { content?: unknown; reasoning_content?: unknown }
    }>
  }
  const choice = data.choices?.[0]
  const asText = (value: unknown): string => {
    if (typeof value === 'string') return value
    if (Array.isArray(value)) return value.map((part) => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '').join('')
    if (value && typeof value === 'object') return JSON.stringify(value)
    return ''
  }
  const content = asText(choice?.message?.content) || asText(choice?.text)
  const reasoning = asText(choice?.message?.reasoning_content)
  if (content.trim()) return content
  if (json && reasoning.includes('{')) return reasoning
  if (json && /length|max[_\s-]?tokens/i.test(choice?.finish_reason || '')) {
    throw Object.assign(new Error('模型输出达到长度上限，且没有生成最终结构化正文。'), { code: 'MODEL_OUTPUT_TRUNCATED' })
  }
  throw Object.assign(new Error(`模型返回了空内容${choice?.finish_reason ? `（结束原因：${choice.finish_reason}）` : ''}。请重试或更换模型。`), { code: 'MODEL_EMPTY_RESPONSE' })
}

export async function structuredCompletion(system: string, prompt: string) {
  return chatCompletion([{ role: 'system', content: system }, { role: 'user', content: prompt }], 0.1, true)
}

export async function probeModel() {
  const started = Date.now()
  lastProbedAt = new Date().toISOString()
  try {
    const transport = await fetch(`${runtimeConfig.baseUrl.replace(/\/$/, '')}/models`, {
      headers: { Authorization: `Bearer ${runtimeConfig.apiKey}` },
      signal: AbortSignal.timeout(6000),
    }).catch(() => null)
    if (transport?.ok) {
      const networkLatencyMs = Date.now() - started
      await transport.body?.cancel()
      verifiedAt = new Date().toISOString(); lastProbeError = ''
      return { ...getModelStatus(), ok: true, latencyMs: networkLatencyMs, networkLatencyMs, probeType: 'gateway', response: 'gateway-ok' }
    }
    if (transport && [401, 403].includes(transport.status)) throw new Error(`模型连接失败（HTTP ${transport.status}）：API Key 无效、已过期或没有访问权限。`)
    const output = await chatCompletion([
      { role: 'system', content: 'Return only the word OK.' },
      { role: 'user', content: 'Connection test.' },
    ], 0, false, { maxTokens: 2, disableThinking: true, timeoutMs: 10000 })
    verifiedAt = new Date().toISOString(); lastProbeError = ''
    return { ...getModelStatus(), ok: Boolean(output.trim()), latencyMs: Date.now() - started, probeType: 'minimal-generation', response: output.trim().slice(0, 20) }
  } catch (error) {
    lastProbeError = (error as Error).message
    throw Object.assign(error as Error, { status: 502 })
  }
}

function localResponse(request: ModelRequest, context: string) {
  const project = sql.get<{ name: string; genre: string; premise: string }>('SELECT name, genre, premise FROM projects WHERE id = ?', request.projectId)
  const base = project ?? { name: '未命名故事', genre: '未设定', premise: '尚未建立核心命题' }
  if (request.task === 'outline') return `# 《${base.name}》结构大纲\n\n## 故事组织判断\n\n根据梗概“${base.premise}”，先判断作品更适合单核推进、群像交织、单元串联、主线转移或探索式结构。没有明确唯一主角时，以反复出现的矛盾、场域变化或读者问题作为叙事引擎。\n\n## 阶段一：建立叙事支点\n\n- 呈现最能兑现题材体验的局面，不强行指定唯一主角。\n- 分别建立人物、群体或单元事件当前的欲望、压力与信息差。\n- 留下一个能跨阶段持续变化的问题。\n\n## 阶段二：驱动力更替\n\n- 让至少两条行动线互相产生后果，而不要求始终服从同一主线。\n- 明确旧目标为何失效，以及新的关注中心如何自然接管叙事。\n- 用状态变化、关系变化或世界规则变化连接各阶段。\n\n## 阶段三：聚合或开放收束\n\n- 选择汇流、接力、循环闭合或开放延展中的一种收束方式。\n- 回答核心读者问题，同时保留题材允许的不确定性。\n- 列出仍需作者决定的角色、节奏与结局选项。\n\n## 待补全\n\n1. 作品属于哪种故事形态？\n2. 哪些人物、地点或问题可以在主线变化后维持连续性？\n3. 计划按卷、阶段还是单元组织？\n\n> 这是本地规则引擎生成的可编辑初版。连接模型后会依据项目资料生成具体事件、转折和人物状态表。`
  if (request.task === 'chapter_outline') return `# 单章细纲\n\n**章节意图**：${request.prompt || '推进当前主线并制造新的信息差'}\n\n1. **开场状态**：从一个正在发生的动作进入，避免背景说明开场。\n2. **场景一**：主角带着明确目标进入场景；阻力来自已有关系或规则。\n3. **场景二**：获得线索，但线索同时提高代价或暴露风险。\n4. **情绪转折**：让角色对同一事实产生新的解释。\n5. **连续性约束**：不得越过角色当前知识边界；能力必须支付既定代价。\n6. **结尾钩子**：以具体发现、决定或迫近危险结束。\n\n预计字数：2800–3500 字。`
  if (request.task === 'prose') return `雨声沿着窗框一寸寸压低房间里的呼吸。\n\n主角没有立刻回答。那句本应脱口而出的话，在触及既有线索时忽然有了重量。桌上的物件仍停在原处，可它投下的影子已经偏离了灯光。\n\n“你也看见了，对吗？”\n\n门外传来第二次敲击。这一次，更近。\n\n> 本地模式只生成短演示文本。配置模型 API 后，系统会使用当前章节、人物状态、剧情线、设定规则和检索证据生成完整草稿。`
  if (request.task === 'setting') return `## 设定候选\n\n- **名称**：待命名设定\n- **核心功能**：直接服务于“${request.prompt || base.premise}”的冲突，而不是只增加背景信息。\n- **可见规则**：普通角色能够观察到的稳定规律。\n- **隐藏规则**：在中后段改变读者理解的机制。\n- **代价与限制**：每次使用都产生可积累、可追踪的后果。\n- **例外条件**：只保留一个，并为其准备前置伏笔。\n- **关联对象**：至少连接一名角色、一个势力和一条剧情线。`
  if (request.task === 'plot') {
    const selectedMode = request.prompt.match(/作品采用[“\"]([^”\"]+)/)?.[1] || '当前故事形态'
    if (request.prompt.includes('创作向导')) return `## ${selectedMode}的本步候选\n\n### 方案 A：后果接力（推荐）\n\n前一阶段人物留下的决定、债务或误解，成为下一阶段行动者无法回避的起点。关注中心可以变化，但因果链不断。适合主线转移、群像和跨时代故事。\n\n### 方案 B：稳定场域\n\n让地点、组织、案件类型或共同危机保持稳定，不同人物轮流进入。连续性来自场域规则及其累积变化，而不是同一个人的目标。\n\n### 方案 C：问题拼图\n\n每个视角只获得局部事实，各阶段可以拥有不同任务。读者持续追踪的是“这些局部如何组成整体”，适合多中心拼图与探索式结构。\n\n**推荐 A**：它最容易把目标变化写成前因后果，而不是突然换线。下一步可明确：上一阶段留下什么不可逆后果、谁最先承受、承受者为何采取与前人不同的行动。\n\n> 本地规则模式给出结构候选；连接模型后会结合项目人物、事件和设定填入专属内容。`
    return `## 剧情线候选\n\n- **叙事中心**：可以是人物、群体、地点、案件或反复出现的问题。\n- **触发变化**：一个可验证的异常打破当前平衡，使至少一方必须行动。\n- **递进方式**：让不同人物的行动互相制造后果，而不是都服从同一目标。\n- **更替节点**：旧任务完成、失效或暴露更大问题时，由最直接承受后果的一方接管关注中心。\n- **连续性支点**：保留共同场域、因果债务、主题问题或关键物件中的至少一项。\n- **阶段收束**：展示关系、认知、资源或世界规则发生了什么不可逆变化。`
  }
  if (request.task === 'analysis') return `## 本地分析结果\n\n当前请求：${request.prompt}\n\n系统已组装项目设定、活跃剧情线、近期事件与相关原文片段。未配置远程模型时，不对复杂事实作无依据推断。建议在审查页运行规则检查，或配置 API 后再次分析。`
  return `我已读取《${base.name}》的项目记忆。当前处于本地规则模式，可以执行结构化操作、检索原文、维护设定和生成基础候选。\n\n你的请求是：${request.prompt}\n\n相关上下文已找到 ${context.length} 个字符。配置模型 API 后，我会基于同一上下文快照返回完整推演结果。`
}

export async function generate(request: ModelRequest) {
  const assembled = assembleContext(request.projectId, request.prompt, request.chapterId)
  let output: string
  let model = 'local-rules-v1'
  if (runtimeConfig.apiKey) {
    const formatInstruction = request.task === 'analysis'
      ? '以结构清晰的 Markdown 笔记作答：使用标题、要点列表和必要的表格；先给结论，再列原文证据与不确定项。不要用 JSON，不要输出思考过程。'
      : '使用清晰的 Markdown 输出，不要输出思考过程。'
    output = await chatCompletion([
      { role: 'system', content: `你是小说创作工作台中的主动型叙事策划助手。只使用给定项目上下文，不得把推测写成正史；事实结论需引用[R编号]；输出中文。不要默认作品有唯一主角、固定主线或三幕式：先判断它属于单核推进、群像交织、单元串联、主线转移、多中心拼图或探索式结构，再给适配方案。用户信息不足时应给出可直接修改的合理候选，并把关键假设单列出来，而不是只反问用户。${formatInstruction}` },
      { role: 'user', content: `${assembled.text}\n\n【任务类型】${request.task}\n【用户要求】${request.prompt}` },
    ], request.task === 'analysis' ? 0.2 : 0.75, false, { disableThinking: true })
    if (!output) output = '模型未返回内容。'
    model = runtimeConfig.model
  } else {
    output = localResponse(request, assembled.text)
  }
  sql.run(`INSERT INTO generations VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, sql.id(), request.projectId, request.task,
    request.prompt, assembled.text, output, model, sql.now())
  return { output, model, citations: assembled.hits, contextReport: assembled.report }
}
