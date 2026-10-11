const headers = { 'Content-Type': 'application/json' }

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string } & Record<string, unknown>
    // 冲突等场景需要读取响应体细节（如服务器版本）；status 供调用方分支处理
    const error = Object.assign(new Error(body.error || `请求失败：${response.status}`), { status: response.status, ...body })
    throw error
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export function post<T>(path: string, body: unknown) {
  return api<T>(path, { method: 'POST', headers, body: JSON.stringify(body) })
}

export function patch<T>(path: string, body: unknown) {
  return api<T>(path, { method: 'PATCH', headers, body: JSON.stringify(body) })
}

export function remove(path: string) {
  return api<void>(path, { method: 'DELETE' })
}

export async function upload<T>(path: string, file: File) {
  const form = new FormData()
  form.append('file', file)
  return api<T>(path, { method: 'POST', body: form })
}
