// Share links: the second front door.
//
// A share link is a bearer credential. Whoever holds the URL has the access,
// forwarding is indistinguishable from legitimate use, and the only controls
// are revocation, rotation, expiry, and the fact that the surface is read-only
// and scoped to one company. That is a real downgrade from a password, and
// everything here is shaped around limiting the blast radius of a leak rather
// than pretending one can't happen.
//
// Two rules hold this together:
//   • Company scope comes from the link row and nowhere else. No handler under
//     /api/share reads a client_id from a request.
//   • Every failure — missing, unknown, expired, revoked, portal switched off,
//     company archived — answers the same 404. A caller learns nothing about
//     which of those it was, or whether the token was ever real.

import { q, q1 } from './db.js'
import { httpError } from './http.js'
import { hashToken, clientIp, rateCheck, rateHit, LIMITS } from './auth.js'

const nowISO = () => new Date().toISOString()

// view_count deliberately counts viewing sessions rather than requests: a
// single page load hits several endpoints, and one pooler write per request
// for a stat nobody reads to the minute is waste. Same shape as the rolling
// expiry in resolveSession().
const VIEW_WINDOW_MS = 60 * 60000

async function touchView(link) {
  const last = link.last_viewed_at ? new Date(link.last_viewed_at).getTime() : 0
  if (Date.now() - last < VIEW_WINDOW_MS) return
  try {
    await q(null, `UPDATE portal_share_links
      SET view_count = view_count + 1, last_viewed_at = ? WHERE id = ?`, [nowISO(), link.id])
  } catch (err) {
    // A view stat is not worth failing a read over.
    console.error('share view stat failed', err)
  }
}

export async function requireShareLink(req, res) {
  const ipBucket = `share:ip:${clientIp(req)}`

  // Checked before the lookup, so guessing costs a COUNT rather than an
  // indexed read per attempt. Only failures are counted, so ordinary reading
  // never fills this bucket.
  if (!(await rateCheck(ipBucket, LIMITS.shareIp)).ok) throw httpError(404, 'not found')

  const token = req.params.token
  const link = token ? await q1(null, `
    SELECT l.id, l.client_id, l.expires_at, l.revoked_at, l.shows_notes,
           l.last_viewed_at, l.label,
           c.portal_enabled, c.is_active AS client_active
    FROM portal_share_links l
    JOIN clients c ON c.id = l.client_id
    WHERE l.token_hash = ?`, [hashToken(token)]) : null

  const usable = !!link
    && !link.revoked_at
    && (!link.expires_at || new Date(link.expires_at).getTime() > Date.now())
    && !!link.portal_enabled
    && !!link.client_active

  if (!usable) {
    await rateHit(ipBucket)
    throw httpError(404, 'not found')
  }

  const linkBucket = `share:link:${link.id}`
  const gate = await rateCheck(linkBucket, LIMITS.share)
  if (!gate.ok) {
    res.set('Retry-After', String(gate.retryAfter))
    throw httpError(429, 'too many requests — try again in a few minutes')
  }
  await rateHit(linkBucket)
  await touchView(link)

  return link
}

// Company scope for share handlers. Deliberately a different name and a
// different source from scopeOf(): one reads an authenticated session, this
// reads a resolved link, and neither can stand in for the other by accident.
export function shareScope(req) {
  const id = req.shareLink?.client_id
  if (!id) throw httpError(500, 'unscoped share query')
  return id
}
