// Portal authentication: password hashing, opaque tokens, cookie handling,
// session lifecycle, audit logging, and rate limiting.
//
// No new dependencies. scrypt and randomBytes come from node:crypto; the
// cookie is written with Express's own res.cookie() and read with a short
// header split. Session state lives in the database because Vercel keeps no
// memory between invocations, and because immediate revocation has to be a
// lookup rather than a signature check.

import crypto from 'node:crypto'
import { q, q1 } from './db.js'

const nowISO = () => new Date().toISOString()

/* ── Passwords ───────────────────────────────────────────────────────────
   Parameters travel with the hash so they can be raised later without a
   flag day. 128 * N * r = 16MB, which sits under node's 32MB scrypt default. */

const N = 16384, R = 8, P = 1, KEYLEN = 64

const scrypt = (password, salt, keylen, opts) => new Promise((resolve, reject) =>
  crypto.scrypt(password, salt, keylen, opts, (err, dk) => err ? reject(err) : resolve(dk)))

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const dk = await scrypt(password, salt, KEYLEN, { N, r: R, p: P })
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${dk.toString('base64')}`
}

export async function verifyPassword(password, stored) {
  if (!stored) return false
  const [scheme, n, r, p, saltB64, hashB64] = String(stored).split('$')
  if (scheme !== 'scrypt') return false
  try {
    const expected = Buffer.from(hashB64, 'base64')
    const dk = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length,
      { N: Number(n), r: Number(r), p: Number(p) })
    return dk.length === expected.length && crypto.timingSafeEqual(dk, expected)
  } catch {
    return false
  }
}

// Login runs this when the email is unknown, so response timing doesn't
// separate "no such user" from "wrong password".
let dummyHash = null
export async function burnTime(password) {
  dummyHash ||= await hashPassword(crypto.randomBytes(32).toString('hex'))
  await verifyPassword(password, dummyHash)
  return false
}

export const PASSWORD_MIN = 10
export const PASSWORD_MAX = 200

/* ── Tokens ──────────────────────────────────────────────────────────────
   256 bits of entropy, so sha256 is the right storage primitive — scrypt
   would be pure cost with no benefit against a value nobody can guess. */

export const mintToken = () => crypto.randomBytes(32).toString('base64url')
export const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex')

// Constant-time compare for a shared secret. Hashing both sides first keeps
// the comparison fixed-length, so it can't leak the expected length either.
export const secretEquals = (a, b) => crypto.timingSafeEqual(
  crypto.createHash('sha256').update(String(a)).digest(),
  crypto.createHash('sha256').update(String(b)).digest(),
)

export const normEmail = (email) => String(email || '').trim().toLowerCase()

export const clientIp = (req) =>
  String(req.ip || '').replace(/^::ffff:/, '') || 'unknown'

/* ── Cookie ──────────────────────────────────────────────────────────── */

export const COOKIE = 'tempo_portal'
const SESSION_MS = 14 * 86400000
const ABSOLUTE_MS = 90 * 86400000

export function readCookie(req, name) {
  const raw = req.headers.cookie
  if (!raw) return null
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    try { return decodeURIComponent(part.slice(eq + 1).trim()) } catch { return null }
  }
  return null
}

// `secure` has to be conditional or nothing works over http on localhost.
const isSecure = (req) => !!req.secure || req.headers['x-forwarded-proto'] === 'https'

const cookieOpts = (req) => ({ httpOnly: true, sameSite: 'lax', path: '/', secure: isSecure(req) })

export const setSessionCookie = (req, res, token, expiresAt) =>
  res.cookie(COOKIE, token, { ...cookieOpts(req), expires: new Date(expiresAt) })

export const clearSessionCookie = (req, res) => res.clearCookie(COOKIE, cookieOpts(req))

/* ── Sessions ────────────────────────────────────────────────────────── */

export async function issueSession(req, res, user) {
  const token = mintToken()
  const expiresAt = new Date(Date.now() + SESSION_MS).toISOString()
  await q(null, `INSERT INTO portal_sessions (portal_user_id, token_hash, expires_at, ip, user_agent)
    VALUES (?,?,?,?,?)`,
    [user.id, hashToken(token), expiresAt, clientIp(req),
     String(req.headers['user-agent'] || '').slice(0, 300)])
  setSessionCookie(req, res, token, expiresAt)
  return token
}

// Returns null for every failure mode — missing, unknown, expired, revoked,
// past the absolute cap, or belonging to a deactivated user. The caller turns
// that into a 401; it never needs to know which.
export async function resolveSession(req, res) {
  const token = readCookie(req, COOKIE)
  if (!token) return null

  const row = await q1(null, `
    SELECT s.id AS session_id, s.expires_at, s.created_at AS started_at,
           u.id AS user_id, u.client_id, u.email, u.role, u.name, u.is_active,
           c.is_active AS company_active
    FROM portal_sessions s
    JOIN portal_users u ON u.id = s.portal_user_id
    LEFT JOIN clients c ON c.id = u.client_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL`, [hashToken(token)])
  if (!row) return null

  const now = Date.now()
  const expires = new Date(row.expires_at).getTime()
  const absolute = new Date(row.started_at).getTime() + ABSOLUTE_MS
  if (!(expires > now) || absolute <= now || !row.is_active) return null
  // A contact's access follows their company: archive the company and every
  // one of its people is locked out on their next request, restore it and they
  // are back, with no per-user bookkeeping to drift out of step.
  if (row.role === 'client' && !row.company_active) return null

  // Rolling expiry, but only past the half-life — extending on every request
  // would be a write per request through the pooler for no added safety.
  if (expires - now < SESSION_MS / 2) {
    const next = new Date(Math.min(now + SESSION_MS, absolute)).toISOString()
    await q(null, 'UPDATE portal_sessions SET expires_at = ? WHERE id = ?', [next, row.session_id])
    setSessionCookie(req, res, token, next)
  }

  return {
    sessionId: row.session_id,
    user: {
      id: row.user_id,
      client_id: row.client_id ?? null,
      email: row.email,
      role: row.role,
      name: row.name,
    },
  }
}

export const revokeSession = (id) =>
  q(null, 'UPDATE portal_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
    [nowISO(), id])

export const revokeAllSessions = (portalUserId) =>
  q(null, 'UPDATE portal_sessions SET revoked_at = ? WHERE portal_user_id = ? AND revoked_at IS NULL',
    [nowISO(), portalUserId])

/* ── Audit ───────────────────────────────────────────────────────────────
   Logins, failed logins, invites, revocations and exports all land here.
   Never throws into a request: an audit write failing must not take down the
   action it was recording. */

export async function audit(req, action, { user, clientId, detail } = {}) {
  try {
    await q(null,
      'INSERT INTO portal_audit (portal_user_id, client_id, action, detail, ip) VALUES (?,?,?,?,?)',
      [user?.id ?? null, clientId ?? user?.client_id ?? null, action,
       String(detail || '').slice(0, 1000), clientIp(req)])
  } catch (err) {
    console.error('portal_audit write failed', action, err)
  }
}

/* ── Rate limiting ───────────────────────────────────────────────────────
   In-memory counters are worthless on serverless: every invocation starts
   with an empty map, so a library-backed limiter would silently enforce
   nothing. The counter has to be in the database. */

export const LIMITS = {
  loginEmail: { limit: 5,  windowMs: 15 * 60000 },
  loginIp:    { limit: 20, windowMs: 15 * 60000 },
  write:      { limit: 60, windowMs: 10 * 60000 },
}

export async function rateCheck(bucket, { limit, windowMs }) {
  const since = new Date(Date.now() - windowMs).toISOString()
  const row = await q1(null,
    'SELECT COUNT(*) AS n FROM portal_rate_events WHERE bucket = ? AND created_at >= ?',
    [bucket, since])
  const used = Number(row?.n || 0)
  return { ok: used < limit, retryAfter: Math.ceil(windowMs / 1000) }
}

export const rateHit = (bucket) =>
  q(null, 'INSERT INTO portal_rate_events (bucket) VALUES (?)', [bucket])

export const rateClear = (bucket) =>
  q(null, 'DELETE FROM portal_rate_events WHERE bucket = ?', [bucket])

// No cron on a platform with no daemon, so pruning rides a small fraction of
// requests. Failure here is cosmetic — the window predicate already ignores
// stale rows.
export async function ratePrune() {
  if (Math.random() > 0.02) return
  try {
    await q(null, 'DELETE FROM portal_rate_events WHERE created_at < ?',
      [new Date(Date.now() - 86400000).toISOString()])
  } catch { /* pruning is best-effort */ }
}

/* ── Single-use tokens (invite / reset) ──────────────────────────────── */

export async function issueOneTimeToken(portalUserId, kind, ttlMs) {
  const token = mintToken()
  await q(null,
    'INSERT INTO portal_tokens (portal_user_id, kind, token_hash, expires_at) VALUES (?,?,?,?)',
    [portalUserId, kind, hashToken(token), new Date(Date.now() + ttlMs).toISOString()])
  return token
}

export const TOKEN_TTL = {
  invite: 7 * 86400000,
  reset: 60 * 60000,
}

// Unused, unexpired, and attached to an active user whose company is still
// active. Returns null otherwise — an expired token, a forged one and one
// belonging to an archived company are indistinguishable to the caller.
export async function consumableToken(token) {
  if (!token) return null
  const row = await q1(null, `
    SELECT t.id, t.kind, t.expires_at, t.portal_user_id,
           u.email, u.name, u.is_active, u.client_id, u.role,
           c.is_active AS company_active
    FROM portal_tokens t
    JOIN portal_users u ON u.id = t.portal_user_id
    LEFT JOIN clients c ON c.id = u.client_id
    WHERE t.token_hash = ? AND t.used_at IS NULL`, [hashToken(token)])
  if (!row) return null
  if (new Date(row.expires_at).getTime() <= Date.now()) return null
  if (!row.is_active) return null
  if (row.role === 'client' && !row.company_active) return null
  return row
}

export const burnToken = (id) =>
  q(null, 'UPDATE portal_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL', [nowISO(), id])

// Invalidates any outstanding token of a kind, so exactly one invite or reset
// link is ever live for a user at a time.
export const burnOutstanding = (portalUserId, kind) =>
  q(null, 'UPDATE portal_tokens SET used_at = ? WHERE portal_user_id = ? AND kind = ? AND used_at IS NULL',
    [nowISO(), portalUserId, kind])
