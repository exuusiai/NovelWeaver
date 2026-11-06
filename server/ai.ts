import 'dotenv/config'
import type { RuntimeModelConfig } from './types.ts'
import { sql } from './db.ts'


function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((part) => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '').join('')
  if (value && typeof value === 'object') return JSON.stringify(value)
  return ''
}

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

// Function declaration (not arrow) so the embeddings module can import it across
// the ai ↔ memory ↔ embeddings module cycle safely at call time.
export function getGenerationCredentials() {
  return { baseUrl: runtimeConfig.baseUrl, apiKey: runtimeConfig.apiKey }
}

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

export interface ModelUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

async function chatCompletion(messages: Array<{ role: 'system' | 'user'; content: string }>, temperature = 0.2, json = false, options: { maxTokens?: number; disableThinking?: boolean; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ text: string; usage?: ModelUsage }> {
  const credentials={...runtimeConfig}
  if (!credentials.apiKey) throw Object.assign(new Error('当前未配置模型 API。请先在设置页填写 API Key。'), { code: 'MODEL_REQUIRED' })
  const request = (strictJson: boolean, disableThinking: boolean) => fetch(`${credentials.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.apiKey}` },
    signal: AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 120000), ...(options.signal ? [options.signal] : [])]),
    body: JSON.stringify({ model: credentials.model, temperature, ...((options.maxTokens || json) ? { max_tokens: options.maxTokens ?? 16000 } : {}), ...(disableThinking ? { thinking: { type: 'disabled' } } : {}), ...(strictJson ? { response_format: { type: 'json_object' } } : {}), messages }),
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
    usage?: ModelUsage
  }
  const choice = data.choices?.[0]
  const content = asText(choice?.message?.content) || asText(choice?.text)
  const reasoning = asText(choice?.message?.reasoning_content)
  const usage = data.usage && (data.usage.total_tokens || data.usage.prompt_tokens) ? data.usage : undefined
  if (content.trim()) return { text: content, usage }
  if (json && reasoning.includes('{')) return { text: reasoning, usage }
  if (json && /length|max[_\s-]?tokens/i.test(choice?.finish_reason || '')) {
    throw Object.assign(new Error('模型输出达到长度上限，且没有生成最终结构化正文。'), { code: 'MODEL_OUTPUT_TRUNCATED' })
  }
  throw Object.assign(new Error(`模型返回了空内容${choice?.finish_reason ? `（结束原因：${choice.finish_reason}）` : ''}。请重试或更换模型。`), { code: 'MODEL_EMPTY_RESPONSE' })
}

export async function structuredCompletion(system: string, prompt: string) {
  return (await chatCompletion([{ role: 'system', content: system }, { role: 'user', content: prompt }], 0.1, true)).text
}

export async function harnessCompletion(system: string, prompt: string, options: { signal: AbortSignal; maxOutputTokens: number }) {
  const result = await chatCompletion([{ role: 'system', content: system }, { role: 'user', content: prompt }], 0.1, true, { signal: options.signal, maxTokens: options.maxOutputTokens })
  return { text: result.text, usage: result.usage ? { inputTokens: result.usage.prompt_tokens ?? 0, outputTokens: result.usage.completion_tokens ?? 0 } : undefined }
}

// One-shot chapter summary rewrite. Pure model call — the caller owns all database updates.
export async function summarizeWithModel(title: string, content: string) {
  const { text: output } = await chatCompletion([
    { role: 'system', content: '你是严谨的中文小说编辑。为章节写一段摘要：一两句话（不超过 90 字），必须包含本章的信息增量与人物/局势的状态变化，只陈述正文中明确发生的事，不评价、不剧透后文、不使用形容词堆砌。只输出摘要文本本身。' },
    { role: 'user', content: `章节标题：${title}\n\n章节正文：\n${content.slice(0, 12000)}` },
  ], 0.3, false, { disableThinking: true, maxTokens: 500 })
  const summary = output.trim().replace(/^["“]|["”]$/g, '').split('\n').filter(Boolean).pop() || output.trim()
  return summary.slice(0, 200)
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
    const probe = await chatCompletion([
      { role: 'system', content: 'Return only the word OK.' },
      { role: 'user', content: 'Connection test.' },
    ], 0, false, { maxTokens: 2, disableThinking: true, timeoutMs: 10000 })
    verifiedAt = new Date().toISOString(); lastProbeError = ''
    return { ...getModelStatus(), ok: Boolean(probe.text.trim()), latencyMs: Date.now() - started, probeType: 'minimal-generation', response: probe.text.trim().slice(0, 20) }
  } catch (error) {
    lastProbeError = (error as Error).message
    throw Object.assign(error as Error, { status: 502 })
  }
}

// Both HTTP modes execute the same task profile. SSE publishes only validated artifacts.
export async function generate(request: import('./tasks/contracts.ts').TaskInput) {
  const { runGenerationTask } = await import('./tasks/service.ts')
  return runGenerationTask(request)
}
export type GenerateStreamEvent =
  | { type: 'delta'; text: string }
  | ({ type: 'done' } & Awaited<ReturnType<typeof generate>>)
  | { type: 'error'; message: string }
export async function* generateStream(request: import('./tasks/contracts.ts').TaskInput): AsyncGenerator<GenerateStreamEvent> {
  try {
    const result = await generate(request)
    yield { type: 'delta', text: result.output }
    yield { type: 'done', ...result }
  } catch (error) {
    yield { type: 'error', message: (error as Error).message }
  }
}
