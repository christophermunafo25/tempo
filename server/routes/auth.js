// Public auth routes. The gate lets /api/auth through without a session, so
// everything reachable here is written on the assumption that the caller is
// anonymous and possibly hostile.

import express from 'express'
import { q, q1 } from '../db.js'
import { h, httpError } from '../http.js'
import {
  hashPassword, verifyPassword, burnTime, PASSWORD_MIN, PASSWORD_MAX,
  normEmail, clientIp, issueSession, resolveSession, revokeSession, revokeAllSessions,
  clearSessionCookie, audit, rateCheck, rateHit, rateClear, ratePrune, LIMITS,
  issueOneTimeToken, consumableToken, burnToken, burnOutstanding, TOKEN_TTL,
  secretEquals,
} from '../auth.js'

const router = express.Router()
const nowISO = () => new Date().toISOString()

const publicUser = (u) => u && ({
  id: u.id, email: u.email, name: u.name, role: u.role, client_id: u.client_id ?? null,
})

function validPassword(value) {
  const password = String(value || '')
  if (password.length < PASSWORD_MIN) {
    throw httpError(400, `password must be at least ${PASSWORD_MIN} characters`)
  }
  if (password.length > PASSWORD_MAX) {
    throw httpError(400, `password must be at most ${PASSWORD_MAX} characters`)
  }
  return password
}

/* ── Session ─────────────────────────────────────────────────────────── */

// The one endpoint that answers 200 with null instead of 401, so the shell can
// decide whether to render the login screen without an error on every load.
router.get('/me', h(async (req, res) => {
  const session = await resolveSession(req, res)
  res.json({ user: publicUser(session?.user) || null })
}))

/* Tells the sign-in screen whether this deployment has been set up yet, so a
   fresh install offers first-run setup instead of a login form nobody can
   satisfy. Reveals only that an owner does or doesn't exist — never the token,
   and never anything at all once setup is done. */

router.get('/setup', h(async (req, res) => {
  const { n } = await q1(null, "SELECT COUNT(*) AS n FROM portal_users WHERE role = 'owner'")
  const needsSetup = Number(n) === 0
  res.json({
    needs_setup: needsSetup,
    // Whether the env var is configured, never its value. Without it the
    // screen can say what is missing rather than failing opaquely.
    token_configured: needsSetup ? !!process.env.PORTAL_BOOTSTRAP_TOKEN : false,
  })
}))

router.post('/login', h(async (req, res) => {
  const email = normEmail(req.body?.email)
  const password = String(req.body?.password || '')
  const ip = clientIp(req)
  const emailBucket = `login:email:${email}`
  const ipBucket = `login:ip:${ip}`

  await ratePrune()

  // Checked before any password work, so a flood costs a COUNT and not a
  // scrypt run.
  for (const [bucket, limit] of [[emailBucket, LIMITS.loginEmail], [ipBucket, LIMITS.loginIp]]) {
    const { ok, retryAfter } = await rateCheck(bucket, limit)
    if (!ok) {
      res.set('Retry-After', String(retryAfter))
      throw httpError(429, 'too many sign-in attempts — wait a few minutes and try again')
    }
  }

  const user = email
    ? await q1(null, 'SELECT * FROM portal_users WHERE email = ?', [email])
    : null

  // burnTime runs scrypt against a throwaway hash so response timing doesn't
  // separate an unknown email from a wrong password.
  const ok = user && user.is_active
    ? await verifyPassword(password, user.password_hash)
    : await burnTime(password)

  if (!ok) {
    await rateHit(emailBucket)
    await rateHit(ipBucket)
    await audit(req, 'login_failed', { user, detail: email })
    throw httpError(401, 'email or password is incorrect')
  }

  await issueSession(req, res, user)
  await q(null, 'UPDATE portal_users SET last_login_at = ? WHERE id = ?', [nowISO(), user.id])
  await rateClear(emailBucket)
  await audit(req, 'login', { user })
  res.json({ user: publicUser(user) })
}))

router.post('/logout', h(async (req, res) => {
  const session = await resolveSession(req, res)
  if (session) {
    await revokeSession(session.sessionId)
    await audit(req, 'logout', { user: session.user })
  }
  clearSessionCookie(req, res)
  res.json({ ok: true })
}))

/* ── Invite and reset redemption ─────────────────────────────────────── */

// Lets the set-password screen greet the right person. An expired token and a
// forged one both 404 — the screen can't distinguish them and neither can a
// prober.
router.get('/token/:token', h(async (req, res) => {
  const row = await consumableToken(req.params.token)
  if (!row) throw httpError(404, 'this link is no longer valid')
  res.json({ email: row.email, name: row.name, kind: row.kind })
}))

router.post('/set-password', h(async (req, res) => {
  const row = await consumableToken(req.body?.token)
  if (!row) throw httpError(404, 'this link is no longer valid')
  const password = validPassword(req.body?.password)

  const password_hash = await hashPassword(password)
  await q(null, 'UPDATE portal_users SET password_hash = ? WHERE id = ?',
    [password_hash, row.portal_user_id])
  await burnToken(row.id)
  // Setting a password ends every existing session for that user, so a reset
  // actually locks out whoever prompted it.
  await revokeAllSessions(row.portal_user_id)
  await audit(req, row.kind === 'invite' ? 'invite_redeemed' : 'reset_used',
    { user: { id: row.portal_user_id, client_id: row.client_id }, detail: row.email })

  // Deliberately no auto-login: they go and sign in, which proves the password
  // round-tripped before they rely on it.
  res.json({ ok: true })
}))

router.post('/forgot', h(async (req, res) => {
  const email = normEmail(req.body?.email)
  const user = email
    ? await q1(null, 'SELECT * FROM portal_users WHERE email = ?', [email])
    : null

  if (user && user.is_active && user.password_hash) {
    await burnOutstanding(user.id, 'reset')
    const token = await issueOneTimeToken(user.id, 'reset', TOKEN_TTL.reset)
    // No mail transport in this build. The link goes to the audit log, where
    // the owner's Portal screen surfaces it to relay by hand.
    await audit(req, 'reset_requested', { user, detail: `/portal/set-password?t=${token}` })
  } else {
    await audit(req, 'reset_requested', { detail: `unknown or inactive: ${email}` })
  }

  // Always the same answer, so this can't be used to enumerate accounts.
  res.json({ ok: true })
}))

/* ── First-run bootstrap ─────────────────────────────────────────────────
   Two conditions, both required. Without the count check a stale env var
   could re-open owner creation later; without the token check an unset env
   var would leave the route open the moment the table is empty. */

router.post('/bootstrap', h(async (req, res) => {
  const expected = process.env.PORTAL_BOOTSTRAP_TOKEN || ''
  const { n } = await q1(null, "SELECT COUNT(*) AS n FROM portal_users WHERE role = 'owner'")
  if (Number(n) > 0 || !expected) throw httpError(404, 'not found')

  if (!secretEquals(req.body?.token || '', expected)) throw httpError(404, 'not found')

  const email = normEmail(req.body?.email)
  if (!email.includes('@')) throw httpError(400, 'a valid email is required')
  const password = validPassword(req.body?.password)

  const password_hash = await hashPassword(password)
  const owner = await q1(null, `
    INSERT INTO portal_users (client_id, email, password_hash, role, name)
    VALUES (?,?,?,?,?) RETURNING *`,
    [null, email, password_hash, 'owner', String(req.body?.name || '').trim()])

  await audit(req, 'bootstrap', { user: owner, detail: email })
  res.json({ user: publicUser(owner) })
}))

export default router
