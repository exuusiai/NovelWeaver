import { afterEach, describe, expect, it, vi } from 'vitest'
import { probeModel, setRuntimeConfig, structuredCompletion } from './ai.ts'

describe('structuredCompletion compatibility', () => {
  afterEach(() => {
    setRuntimeConfig({ apiKey: '' })
    vi.unstubAllGlobals()
  })

  it('uses complete content even when the provider reports a length finish reason', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: 'length', message: { content: '{"entities":[]}' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    setRuntimeConfig({ baseUrl: 'https://example.test/v1', apiKey: 'test-key', model: 'test-model' })

    await expect(structuredCompletion('system', 'prompt')).resolves.toBe('{"entities":[]}')
  })

  it('retries without thinking controls when a compatible gateway rejects them', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'unknown parameter: thinking' } }), { status: 400, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    setRuntimeConfig({ baseUrl: 'https://example.test/v1', apiKey: 'test-key', model: 'test-model' })

    await expect(structuredCompletion('system', 'prompt')).resolves.toBe('{}')
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body))
    expect(firstBody.thinking).toEqual({ type: 'disabled' })
    expect(secondBody.thinking).toBeUndefined()
  })

  it('uses the lightweight models endpoint for connection probes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    setRuntimeConfig({ baseUrl: 'https://example.test/v1', apiKey: 'test-key', model: 'test-model' })

    const result = await probeModel()

    expect(result.ok).toBe(true)
    expect(result.probeType).toBe('gateway')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://example.test/v1/models')
  })
})
