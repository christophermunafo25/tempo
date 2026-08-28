// Share links live outside the session world entirely: no cookie, no 401, and
// no redirect to a login screen that the holder of a link could not satisfy
// anyway. Every failure the server can produce is a 404, and this turns that
// into one recognisable shape the view can render as "this link is finished".

class LinkGone extends Error {
  constructor() {
    super('this link is no longer valid')
    this.gone = true
  }
}

export async function shareGet(token, path, params) {
  const query = params ? `?${new URLSearchParams(params)}` : ''
  let res
  try {
    res = await fetch(`/api/share/${encodeURIComponent(token)}${path}${query}`)
  } catch {
    throw new Error('Can’t reach TEMPO right now. Try again in a moment.')
  }
  if (res.status === 404) throw new LinkGone()
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return res.json()
}

export const cleanParams = (obj) =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== '' && v != null))
