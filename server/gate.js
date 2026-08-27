// Deny by default.
//
// Mounted once at /api, above every route. It does not consult a per-route
// allowlist and its correctness does not depend on the order routes are
// declared in. It classifies each request by its first path segment, and the
// classification is total — every possible /api path lands in exactly one
// bucket, with owner-only as the default arm:
//
//   /api/auth/*    public   (no session; rate-limited in the route module)
//   /api/portal/*  client   (role 'client', scoped to its own client_id)
//   anything else  owner
//
// So a route added anywhere under /api is owner-only by construction. Opting
// one into client access means physically moving it under /api/portal, which
// is visible in a diff. Owner-side portal management lives under /api/access
// rather than /api/portal-something, so it can never sit adjacent to the
// client prefix in a matcher.

import { h, httpError } from './http.js'
import { resolveSession } from './auth.js'

// Same-origin fetch sends Origin on every method except GET and HEAD, so this
// costs nothing in the app and closes the gaps SameSite=Lax leaves open.
function originOk(req) {
  const origin = req.headers.origin
  if (!origin) return false
  const host = req.headers['x-forwarded-host'] || req.headers.host
  try {
    return !!host && new URL(origin).host === host
  } catch {
    return false
  }
}

// Split on segments, not string prefix: a future /api/portalthing must not be
// mistaken for something under /api/portal.
const firstSegment = (path) => path.split('/').filter(Boolean)[0] || ''

export const gate = h(async (req, res, next) => {
  const seg = firstSegment(req.path)

  if (req.method !== 'GET' && req.method !== 'HEAD' && !originOk(req)) {
    throw httpError(403, 'request origin not allowed')
  }

  if (seg === 'auth') return next()

  const session = await resolveSession(req, res)
  if (!session) throw httpError(401, 'not signed in')

  req.portalUser = session.user
  req.portalSessionId = session.sessionId

  // 404 rather than 403 everywhere below: a client session learns nothing
  // about what else this deployment hosts.
  if (seg === 'portal') {
    if (session.user.role !== 'client' || !session.user.client_id) {
      throw httpError(404, 'not found')
    }
    return next()
  }

  if (session.user.role !== 'owner') throw httpError(404, 'not found')
  next()
})

// Company scope for portal handlers. Never read from a query param, URL
// segment, or body field — the only source is the authenticated session.
export function scopeOf(req) {
  const id = req.portalUser?.client_id
  if (!id) throw httpError(500, 'unscoped portal query')
  return id
}
