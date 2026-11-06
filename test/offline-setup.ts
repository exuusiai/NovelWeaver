// All automatic tests use synthetic in-memory data. Remote transport must be mocked.
process.env.NOVELWEAVER_DATA_DIR = ':memory:'
process.env.AI_API_KEY = ''
process.env.AI_BASE_URL = ''
process.env.AI_EMBEDDING_MODEL = ''
process.env.HARNESS_MODEL_ENABLED = '0'
// Transport stays blocked below. Enable the semantic retrieval branch so its
// mocked-vector tests are independent of a developer/server OFFLINE=1 setting.
process.env.NOVELWEAVER_OFFLINE = '0'
const originalFetch = globalThis.fetch
if (originalFetch)
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
      throw new Error(`Offline test blocked network: ${url.origin}`)
    return originalFetch(input, init)
  }
