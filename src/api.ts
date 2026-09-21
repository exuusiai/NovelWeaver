const headers = { 'Content-Type': 'application/json' }

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string }
    throw new Error(body.error || `请求失败：${response.status}`)
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
