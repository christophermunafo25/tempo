// Boundary tests. These cover the security boundary only — that unauthorised
// callers get nothing, that a client session cannot reach owner data, and that
// the owner's own experience is unchanged. No new dependencies: node:test,
// node's built-in fetch, and the app listening on an ephemeral port.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Must be set before db.js is imported, or the suite writes to the database
// that drives real invoices.
process.env.TEMPO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tempo-test-'))
process.env.PORTAL_BOOTSTRAP_TOKEN = 'bootstrap-secret-for-tests'
delete process.env.DATABASE_URL
delete process.env.VERCEL

const { default: app, ready } = await import('./app.js')
const { q, q1, closeDb } = await import('./db.js')
const { hashToken, hashPassword } = await import('./auth.js')

await ready
const server = app.listen(0)
await new Promise((resolve) => server.once('listening', resolve))
const base = `http://127.0.0.1:${server.address().port}`
// node's fetch keeps sockets alive, so server.close() alone never resolves.
after(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  await closeDb()
})

/* ── Helpers ─────────────────────────────────────────────────────────── */

async function call(method, url, { body, cookie, origin = base, headers = {} } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(origin === null ? {} : { Origin: origin }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, text, res }
}

function cookieFrom(res) {
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';')
    if (pair.startsWith('tempo_portal=')) return pair
  }
  return null
}

// Every /api route Express knows about, minus the public /api/auth prefix.
function apiRoutes() {
  const stack = (app._router || app.router).stack
  const out = []
  for (const layer of stack) {
    if (!layer.route || typeof layer.route.path !== 'string') continue
    const p = layer.route.path
    if (!p.startsWith('/api/') || p.startsWith('/api/auth')) continue
    for (const method of Object.keys(layer.route.methods)) {
      out.push([method.toUpperCase(), p.replace(/:[A-Za-z_]+/g, '1')])
    }
  }
  return out
}

/* ── Fixtures ────────────────────────────────────────────────────────── */

let ownerCookie = null
let clientCookie = null
let mercenary = null
let otherCo = null

/* ── 1. Bootstrap ────────────────────────────────────────────────────── */

test('a fresh deployment reports that it needs setup', async () => {
  const r = await call('GET', '/api/auth/setup')
  assert.equal(r.status, 200)
  assert.equal(r.json.needs_setup, true, 'no owner yet')
  assert.equal(r.json.token_configured, true, 'the env var is set in this suite')
})

test('the setup state never reveals the token itself', async () => {
  const r = await call('GET', '/api/auth/setup')
  assert.ok(!r.text.includes('bootstrap-secret-for-tests'))
})

test('bootstrap rejects a wrong token', async () => {
  const r = await call('POST', '/api/auth/bootstrap',
    { body: { token: 'wrong', email: 'chris@example.com', password: 'correct-horse-battery' } })
  assert.equal(r.status, 404)
})

test('bootstrap creates the first owner', async () => {
  const r = await call('POST', '/api/auth/bootstrap', {
    body: {
      token: 'bootstrap-secret-for-tests',
      email: 'Chris@Example.com',
      password: 'correct-horse-battery',
      name: 'Chris',
    },
  })
  assert.equal(r.status, 200)
  assert.equal(r.json.user.role, 'owner')
  assert.equal(r.json.user.email, 'chris@example.com', 'email is normalised')
  assert.equal(r.json.user.client_id, null, 'owner has no company scope')
})

test('bootstrap disables itself once an owner exists', async () => {
  const r = await call('POST', '/api/auth/bootstrap',
    { body: { token: 'bootstrap-secret-for-tests', email: 'second@example.com', password: 'another-long-password' } })
  assert.equal(r.status, 404)
})

test('once an owner exists the deployment stops offering setup', async () => {
  const r = await call('GET', '/api/auth/setup')
  assert.equal(r.json.needs_setup, false)
  assert.equal(r.json.token_configured, false, 'nothing about the env var leaks after setup')
})

/* ── 2. Unauthenticated access ───────────────────────────────────────── */

test('every /api route rejects an unauthenticated caller with 401', async () => {
  const routes = apiRoutes()
  assert.ok(routes.length >= 20, `expected the owner routes to be enumerated, got ${routes.length}`)
  for (const [method, url] of routes) {
    const r = await call(method, url, { body: method === 'GET' ? undefined : {} })
    assert.equal(r.status, 401, `${method} ${url} should be 401, got ${r.status}`)
    assert.equal(r.json?.error, 'not signed in', `${method} ${url} leaked a body`)
  }
})

test('paths with no route registered are still owner-only, by construction', async () => {
  // The enumeration above only sees routes declared directly on the app.
  // These are synthetic — most match nothing at all — and prove the gate's
  // default arm covers any path under /api, registered or not, including
  // router mounts like /api/access.
  const synthetic = [
    '/api/access/clients',
    '/api/access/anything/at/all',
    '/api/not-a-real-route',
    '/api/expenses/9999',
    '/api',
  ]
  for (const url of synthetic) {
    const r = await call('GET', url)
    assert.equal(r.status, 401, `${url} should be 401 when signed out, got ${r.status}`)
  }
})

test('a state-changing request without an Origin header is refused', async () => {
  const r = await call('POST', '/api/clients', { body: { name: 'x' }, origin: null })
  assert.equal(r.status, 403)
})

/* ── 3. Login ────────────────────────────────────────────────────────── */

test('a state-changing request from another site is refused', async () => {
  const r = await call('POST', '/api/clients',
    { body: { name: 'x' }, origin: 'https://evil.example' })
  assert.equal(r.status, 403)
  assert.equal(r.json.error, 'request origin not allowed')
})

test('login rejects a wrong password without saying why', async () => {
  const r = await call('POST', '/api/auth/login',
    { body: { email: 'chris@example.com', password: 'not-the-password' } })
  assert.equal(r.status, 401)
  assert.equal(r.json.error, 'email or password is incorrect')
})

test('login rejects an unknown email with the identical message', async () => {
  const r = await call('POST', '/api/auth/login',
    { body: { email: 'nobody@example.com', password: 'not-the-password' } })
  assert.equal(r.status, 401)
  assert.equal(r.json.error, 'email or password is incorrect')
})

test('login succeeds and sets an httpOnly session cookie', async () => {
  const r = await call('POST', '/api/auth/login',
    { body: { email: 'chris@example.com', password: 'correct-horse-battery' } })
  assert.equal(r.status, 200)
  const raw = r.res.headers.getSetCookie().find(c => c.startsWith('tempo_portal='))
  assert.ok(raw, 'session cookie was set')
  assert.match(raw, /HttpOnly/i)
  assert.match(raw, /SameSite=Lax/i)
  ownerCookie = cookieFrom(r.res)
})

test('the session token is never stored in the clear', async () => {
  const token = ownerCookie.split('=')[1]
  const byRaw = await q1(null, 'SELECT id FROM portal_sessions WHERE token_hash = ?', [token])
  assert.equal(byRaw, undefined, 'raw token must not match any stored row')
  const byHash = await q1(null, 'SELECT id FROM portal_sessions WHERE token_hash = ?', [hashToken(token)])
  assert.ok(byHash, 'only the hash is stored')
})

/* ── 4. Owner behaviour is unchanged ─────────────────────────────────── */

test('owner still sees everything, unchanged', async () => {
  mercenary = (await call('POST', '/api/clients', {
    cookie: ownerCookie,
    body: { name: 'Mercenary Marketing', color_accent: '#6B93C4', weekly_hours_target: 20 },
  })).json
  otherCo = (await call('POST', '/api/clients', {
    cookie: ownerCookie,
    body: { name: 'Other Co', color_accent: '#D9A13B', weekly_hours_target: 10 },
  })).json
  assert.ok(mercenary.id && otherCo.id)

  await call('POST', '/api/projects', {
    cookie: ownerCookie,
    body: { client_id: mercenary.id, name: 'Rebrand' },
  })
  await call('POST', '/api/expenses', {
    cookie: ownerCookie,
    body: { name: 'Adobe CC', cadence: 'monthly', amount: 59.99 },
  })

  const clients = await call('GET', '/api/clients', { cookie: ownerCookie })
  assert.equal(clients.status, 200)
  assert.equal(clients.json.length, 2)

  const expenses = await call('GET', '/api/expenses', { cookie: ownerCookie })
  assert.equal(expenses.status, 200)
  assert.equal(expenses.json[0].name, 'Adobe CC')

  for (const url of ['/api/board', '/api/archive', '/api/sessions', '/api/active-session', '/api/projects']) {
    const r = await call('GET', url, { cookie: ownerCookie })
    assert.equal(r.status, 200, `${url} should still answer 200 for the owner`)
  }
})

test('the owner cannot reach the client prefix', async () => {
  const r = await call('GET', '/api/portal/summary', { cookie: ownerCookie })
  assert.equal(r.status, 404)
})

/* ── 5. Client sessions ──────────────────────────────────────────────── */

test('a client user can sign in', async () => {
  await q(null, `INSERT INTO portal_users (client_id, email, password_hash, role, name)
    VALUES (?,?,?,?,?)`,
    [mercenary.id, 'contact@mercenary.example', await hashPassword('mercenary-password-1'), 'client', 'Dana'])

  const r = await call('POST', '/api/auth/login',
    { body: { email: 'contact@mercenary.example', password: 'mercenary-password-1' } })
  assert.equal(r.status, 200)
  assert.equal(r.json.user.role, 'client')
  assert.equal(r.json.user.client_id, mercenary.id)
  clientCookie = cookieFrom(r.res)
})

test('a client session gets 404, never data, on every owner route', async () => {
  for (const [method, url] of apiRoutes()) {
    const r = await call(method, url, { cookie: clientCookie, body: method === 'GET' ? undefined : {} })
    assert.equal(r.status, 404, `${method} ${url} should be 404 for a client, got ${r.status}`)
    assert.equal(r.json?.error, 'not found', `${method} ${url} leaked a body to a client`)
  }
})

test('a client gets 404 on unregistered paths and on /api/access', async () => {
  for (const url of ['/api/access/clients', '/api/access/requests', '/api/not-a-real-route', '/api']) {
    const r = await call('GET', url, { cookie: clientCookie })
    assert.equal(r.status, 404, `${url} should be 404 for a client, got ${r.status}`)
  }
})

test('/api/expenses is unreachable by a client and leaks no overhead data', async () => {
  const r = await call('GET', '/api/expenses', { cookie: clientCookie })
  assert.equal(r.status, 404)
  assert.ok(!r.text.includes('Adobe'), 'expense data must not appear in the response')
})

test('/api/clients is unreachable by a client and leaks no company names', async () => {
  const r = await call('GET', '/api/clients', { cookie: clientCookie })
  assert.equal(r.status, 404)
  assert.ok(!r.text.includes('Other Co'), 'other companies must not appear in the response')
})

test('a client cannot reach an owner route by dressing it up as a portal path', async () => {
  // The gate keys on the first path segment, so these probe whether a crafted
  // path can be classified as 'portal' and still resolve to an owner handler.
  const probes = [
    '/api/portal/../expenses',
    '/api/portal/..%2fexpenses',
    '/api//expenses',
    '/api/./expenses',
    '/api/PORTAL/../expenses',
  ]
  for (const url of probes) {
    const r = await call('GET', url, { cookie: clientCookie })
    assert.notEqual(r.status, 200, `${url} must not resolve`)
    assert.ok(!r.text.includes('Adobe'), `${url} leaked expense data`)
  }
})

test('an anonymous caller gets a null user rather than an error from /me', async () => {
  const r = await call('GET', '/api/auth/me')
  assert.equal(r.status, 200)
  assert.equal(r.json.user, null)
})

test('a forged session cookie is rejected', async () => {
  const r = await call('GET', '/api/auth/me', { cookie: 'tempo_portal=not-a-real-token' })
  assert.equal(r.json.user, null)
  const denied = await call('GET', '/api/clients', { cookie: 'tempo_portal=not-a-real-token' })
  assert.equal(denied.status, 401)
})

/* ── 6. Revocation ───────────────────────────────────────────────────── */

test("a revoked user's existing cookie fails on the very next request", async () => {
  const me = await call('GET', '/api/auth/me', { cookie: clientCookie })
  assert.equal(me.json.user.email, 'contact@mercenary.example', 'cookie works before revocation')

  await q(null, 'UPDATE portal_users SET is_active = 0 WHERE email = ?', ['contact@mercenary.example'])

  const after = await call('GET', '/api/auth/me', { cookie: clientCookie })
  assert.equal(after.json.user, null, 'the same cookie is now anonymous')

  const denied = await call('GET', '/api/portal/summary', { cookie: clientCookie })
  assert.equal(denied.status, 401)

  await q(null, 'UPDATE portal_users SET is_active = 1 WHERE email = ?', ['contact@mercenary.example'])
})

test('logout revokes the session server-side, not just the cookie', async () => {
  const login = await call('POST', '/api/auth/login',
    { body: { email: 'contact@mercenary.example', password: 'mercenary-password-1' } })
  const cookie = cookieFrom(login.res)

  await call('POST', '/api/auth/logout', { cookie })
  const after = await call('GET', '/api/auth/me', { cookie })
  assert.equal(after.json.user, null, 'replaying the cookie after logout gets nothing')
})

/* ── 7. Single-use tokens ────────────────────────────────────────────── */

test('an expired invite token cannot be redeemed', async () => {
  const user = await q1(null, 'SELECT * FROM portal_users WHERE email = ?', ['contact@mercenary.example'])
  const token = 'expired-invite-token-fixture'
  await q(null, `INSERT INTO portal_tokens (portal_user_id, kind, token_hash, expires_at)
    VALUES (?,?,?,?)`,
    [user.id, 'invite', hashToken(token), new Date(Date.now() - 1000).toISOString()])

  const look = await call('GET', `/api/auth/token/${token}`)
  assert.equal(look.status, 404)

  const redeem = await call('POST', '/api/auth/set-password',
    { body: { token, password: 'a-brand-new-password' } })
  assert.equal(redeem.status, 404)

  const still = await q1(null, 'SELECT password_hash FROM portal_users WHERE id = ?', [user.id])
  assert.ok(await (async () => {
    const { verifyPassword } = await import('./auth.js')
    return verifyPassword('mercenary-password-1', still.password_hash)
  })(), 'the original password is untouched')
})

test('a valid invite token can be redeemed exactly once', async () => {
  const user = await q1(null, 'SELECT * FROM portal_users WHERE email = ?', ['contact@mercenary.example'])
  const token = 'valid-invite-token-fixture'
  await q(null, `INSERT INTO portal_tokens (portal_user_id, kind, token_hash, expires_at)
    VALUES (?,?,?,?)`,
    [user.id, 'invite', hashToken(token), new Date(Date.now() + 60000).toISOString()])

  const look = await call('GET', `/api/auth/token/${token}`)
  assert.equal(look.status, 200)
  assert.equal(look.json.email, 'contact@mercenary.example')

  const first = await call('POST', '/api/auth/set-password',
    { body: { token, password: 'replacement-password-9' } })
  assert.equal(first.status, 200)

  const second = await call('POST', '/api/auth/set-password',
    { body: { token, password: 'yet-another-password' } })
  assert.equal(second.status, 404, 'the token is single use')
})

test('setting a password ends every existing session for that user', async () => {
  const login = await call('POST', '/api/auth/login',
    { body: { email: 'contact@mercenary.example', password: 'replacement-password-9' } })
  const cookie = cookieFrom(login.res)
  assert.ok(cookie)

  const user = await q1(null, 'SELECT * FROM portal_users WHERE email = ?', ['contact@mercenary.example'])
  const token = 'reset-token-fixture'
  await q(null, `INSERT INTO portal_tokens (portal_user_id, kind, token_hash, expires_at)
    VALUES (?,?,?,?)`,
    [user.id, 'reset', hashToken(token), new Date(Date.now() + 60000).toISOString()])
  await call('POST', '/api/auth/set-password', { body: { token, password: 'post-reset-password-2' } })

  const after = await call('GET', '/api/auth/me', { cookie })
  assert.equal(after.json.user, null, 'the pre-reset cookie is dead')
})

/* ── 8. Rate limiting ────────────────────────────────────────────────── */

test('login attempts are rate limited per email', async () => {
  const email = 'ratelimit@example.com'
  await q(null, `INSERT INTO portal_users (client_id, email, password_hash, role, name)
    VALUES (?,?,?,?,?)`, [null, email, await hashPassword('the-real-password'), 'owner', 'RL'])

  let sawLimit = false
  for (let i = 0; i < 8; i++) {
    const r = await call('POST', '/api/auth/login', { body: { email, password: 'wrong' } })
    if (r.status === 429) { sawLimit = true; break }
  }
  assert.ok(sawLimit, 'repeated failures must start answering 429')

  // The lockout holds even once the caller finds the right password.
  const correct = await call('POST', '/api/auth/login', { body: { email, password: 'the-real-password' } })
  assert.equal(correct.status, 429)
})

test('forgot-password answers identically for known and unknown addresses', async () => {
  const known = await call('POST', '/api/auth/forgot', { body: { email: 'chris@example.com' } })
  const unknown = await call('POST', '/api/auth/forgot', { body: { email: 'ghost@example.com' } })
  assert.equal(known.status, unknown.status)
  assert.deepEqual(known.json, unknown.json)
})

/* ── 9. Audit ────────────────────────────────────────────────────────── */

test('logins, failures and revocations are recorded', async () => {
  const actions = (await q(null, 'SELECT DISTINCT action FROM portal_audit')).map(r => r.action)
  for (const expected of ['login', 'login_failed', 'logout', 'invite_redeemed', 'reset_requested']) {
    assert.ok(actions.includes(expected), `expected a ${expected} audit row, saw ${actions.join(', ')}`)
  }
})
