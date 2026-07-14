export async function api(path, opts = {}) {
  let res
  try {
    res = await fetch(`/api${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
    })
  } catch {
    throw new Error('Can’t reach the TEMPO server on localhost:3001 — make sure `npm run dev` is running (it starts both the app and the API).')
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return res.json()
}

export const get = (path) => api(path)
export const post = (path, body) => api(path, { method: 'POST', body })
export const patch = (path, body) => api(path, { method: 'PATCH', body })
export const del = (path) => api(path, { method: 'DELETE' })
