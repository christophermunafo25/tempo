// Step 2 boundary: owner-only access management, publishing, and the §1.3
// guarantee that a client's request stays out of the owner's workflow until
// it is accepted.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.TEMPO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tempo-access-'))
process.env.PORTAL_BOOTSTRAP_TOKEN = 'bootstrap-secret-for-tests'
delete process.env.DATABASE_URL
delete process.env.VERCEL

const { default: app, ready } = await import('./app.js')
const { q, q1, closeDb } = await import('./db.js')
const { hashPassword } = await import('./auth.js')

await ready
const server = app.listen(0)
await new Promise((resolve) => server.once('listening', resolve))
const base = `http://127.0.0.1:${server.address().port}`
after(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  await closeDb()
})

async function call(method, url, { body, cookie, origin = base } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(origin === null ? {} : { Origin: origin }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, text, res }
}

const cookieFrom = (res) =>
  res.headers.getSetCookie().map(l => l.split(';')[0]).find(p => p.startsWith('tempo_portal=')) || null

const ids = (rows) => rows.map(r => r.id)

/* ── Fixtures ────────────────────────────────────────────────────────── */

let owner, mercenary, other, clientCookie

test('setup: owner, two companies, a normal project', async () => {
  await call('POST', '/api/auth/bootstrap', {
    body: { token: 'bootstrap-secret-for-tests', email: 'chris@example.com', password: 'owner-password-long', name: 'Chris' },
  })
  const login = await call('POST', '/api/auth/login',
    { body: { email: 'chris@example.com', password: 'owner-password-long' } })
  owner = cookieFrom(login.res)
  assert.ok(owner)

  mercenary = (await call('POST', '/api/clients', {
    cookie: owner, body: { name: 'Mercenary Marketing', color_accent: '#6B93C4', weekly_hours_target: 20 },
  })).json
  other = (await call('POST', '/api/clients', {
    cookie: owner, body: { name: 'Northwind Studio', color_accent: '#8FAE7E', weekly_hours_target: 10 },
  })).json

  const normal = await call('POST', '/api/projects', {
    cookie: owner, body: { client_id: mercenary.id, name: 'Q3 Rebrand' },
  })
  assert.equal(normal.status, 200)
})

/* ── Access control on the new routes ────────────────────────────────── */

test('/api/access is unreachable without a session', async () => {
  for (const [method, url] of [['GET', '/api/access/clients'], ['POST', '/api/access/invite'],
    ['GET', '/api/access/requests'], ['POST', '/api/access/publish'], ['GET', '/api/access/audit']]) {
    const r = await call(method, url, { body: method === 'GET' ? undefined : {} })
    assert.equal(r.status, 401, `${method} ${url}`)
  }
})

/* ── Invites ─────────────────────────────────────────────────────────── */

let contact, inviteLink

test('inviting a contact creates a passwordless user and enables the portal', async () => {
  const r = await call('POST', '/api/access/invite', {
    cookie: owner,
    body: { client_id: mercenary.id, email: 'Dana@Mercenary.example', name: 'Dana' },
  })
  assert.equal(r.status, 200)
  contact = r.json.user
  inviteLink = r.json.link

  assert.equal(contact.email, 'dana@mercenary.example', 'email normalised')
  assert.equal(contact.client_id, mercenary.id)
  assert.equal(contact.role, 'client')
  assert.equal(contact.password_hash, null, 'no password until the invite is redeemed')
  assert.match(inviteLink, /^\/portal\/set-password\?t=/)

  const company = (await call('GET', '/api/access/clients', { cookie: owner }))
    .json.find(c => c.id === mercenary.id)
  assert.equal(company.portal_enabled, 1, 'inviting switches the portal on')
  assert.equal(company.contacts[0].invite_pending, 1)
  assert.equal(company.contacts[0].has_password, 0)
})

test('an invited contact cannot sign in until they set a password', async () => {
  const r = await call('POST', '/api/auth/login',
    { body: { email: 'dana@mercenary.example', password: '' } })
  assert.equal(r.status, 401)
})

test('the same email cannot be invited to a second company', async () => {
  const r = await call('POST', '/api/access/invite', {
    cookie: owner, body: { client_id: other.id, email: 'dana@mercenary.example', name: 'Dana' },
  })
  assert.equal(r.status, 409)
})

test('resending an invite invalidates the previous link', async () => {
  const first = inviteLink.split('t=')[1]
  const r = await call('POST', `/api/access/invite/${contact.id}/resend`, { cookie: owner })
  assert.equal(r.status, 200)
  const second = r.json.link.split('t=')[1]
  assert.notEqual(first, second)

  assert.equal((await call('GET', `/api/auth/token/${first}`)).status, 404, 'old link is dead')
  assert.equal((await call('GET', `/api/auth/token/${second}`)).status, 200, 'new link works')
  inviteLink = r.json.link
})

test('redeeming the invite lets the contact sign in', async () => {
  const token = inviteLink.split('t=')[1]
  const set = await call('POST', '/api/auth/set-password',
    { body: { token, password: 'dana-portal-password' } })
  assert.equal(set.status, 200)

  const login = await call('POST', '/api/auth/login',
    { body: { email: 'dana@mercenary.example', password: 'dana-portal-password' } })
  assert.equal(login.status, 200)
  assert.equal(login.json.user.client_id, mercenary.id)
  clientCookie = cookieFrom(login.res)
})

test('a client session gets 404 on every /api/access route', async () => {
  for (const [method, url] of [['GET', '/api/access/clients'], ['POST', '/api/access/invite'],
    ['GET', '/api/access/requests'], ['POST', '/api/access/publish'], ['GET', '/api/access/audit'],
    ['POST', '/api/access/users/1/revoke']]) {
    const r = await call(method, url, { cookie: clientCookie, body: method === 'GET' ? undefined : {} })
    assert.equal(r.status, 404, `${method} ${url} should be 404 for a client`)
    assert.ok(!r.text.includes('Northwind'), `${url} leaked another company`)
  }
})

/* ── Revocation ──────────────────────────────────────────────────────── */

test('revoking a contact kills their live session and blocks sign-in', async () => {
  const r = await call('POST', `/api/access/users/${contact.id}/revoke`, { cookie: owner })
  assert.equal(r.status, 200)
  assert.equal(r.json.is_active, 0)

  const me = await call('GET', '/api/auth/me', { cookie: clientCookie })
  assert.equal(me.json.user, null, 'the live cookie is dead on the next request')

  const login = await call('POST', '/api/auth/login',
    { body: { email: 'dana@mercenary.example', password: 'dana-portal-password' } })
  assert.equal(login.status, 401, 'and they cannot sign back in')
})

test('the row is kept, not deleted — restore brings them back', async () => {
  const still = await q1(null, 'SELECT * FROM portal_users WHERE id = ?', [contact.id])
  assert.ok(still, 'revocation is soft')

  await call('POST', `/api/access/users/${contact.id}/restore`, { cookie: owner })
  const login = await call('POST', '/api/auth/login',
    { body: { email: 'dana@mercenary.example', password: 'dana-portal-password' } })
  assert.equal(login.status, 200)
  clientCookie = cookieFrom(login.res)
})

test('an owner account cannot be revoked through this screen', async () => {
  const me = await q1(null, "SELECT * FROM portal_users WHERE role = 'owner'")
  const r = await call('POST', `/api/access/users/${me.id}/revoke`, { cookie: owner })
  assert.equal(r.status, 400)
})

/* ── Publishing ──────────────────────────────────────────────────────── */

test('sessions start unpublished and bulk publish moves a date range', async () => {
  const day = (n) => new Date(Date.UTC(2026, 7, n, 15, 0, 0)).toISOString()
  for (const n of [10, 11, 20]) {
    await q(null, `INSERT INTO sessions (client_id, clock_in, clock_out, duration_minutes)
      VALUES (?,?,?,?)`, [mercenary.id, day(n), day(n + 0.04), 60])
  }
  await q(null, `INSERT INTO sessions (client_id, clock_in, clock_out, duration_minutes)
    VALUES (?,?,?,?)`, [other.id, day(10), day(10.04), 60])

  const before = await q(null, 'SELECT COUNT(*) AS n FROM sessions WHERE is_published = 1')
  assert.equal(Number(before[0].n), 0, 'nothing is client-visible by default')

  const r = await call('POST', '/api/access/publish', {
    cookie: owner,
    body: { client_id: mercenary.id, from: day(9), to: day(15), publish: true },
  })
  assert.equal(r.status, 200)
  assert.equal(r.json.affected, 2, 'only the two in range')

  const published = await q(null, 'SELECT client_id FROM sessions WHERE is_published = 1')
  assert.equal(published.length, 2)
  assert.ok(published.every(s => s.client_id === mercenary.id), 'never another company')
})

test('a single session can be unpublished again', async () => {
  const one = await q1(null, 'SELECT * FROM sessions WHERE is_published = 1')
  const r = await call('PATCH', `/api/access/sessions/${one.id}`,
    { cookie: owner, body: { is_published: false } })
  assert.equal(r.status, 200)
  assert.equal(r.json.is_published, 0)
})

/* ── §1.3: requests stay out of the owner's workflow ─────────────────── */

let request, completeRequest

test('setup: a client submits two project requests', async () => {
  request = await q1(null, `
    INSERT INTO projects (client_id, name, description, portal_request, requested_by)
    VALUES (?,?,?,?,?) RETURNING *`,
    [mercenary.id, 'Client Requested Microsite', 'A brief', 'pending', contact.id])
  completeRequest = await q1(null, `
    INSERT INTO projects (client_id, name, status, completed_at, portal_request, requested_by)
    VALUES (?,?,?,?,?,?) RETURNING *`,
    [mercenary.id, 'Client Requested Archive Item', 'complete', new Date().toISOString(),
     'pending', contact.id])

  // An entry pointing at the pending project, so /api/prefill would surface it
  // if the filter were missing.
  const session = await q1(null, `
    INSERT INTO sessions (client_id, clock_in, clock_out, duration_minutes)
    VALUES (?,?,?,?) RETURNING *`,
    [mercenary.id, new Date(Date.now() - 3600000).toISOString(), new Date().toISOString(), 60])
  await q(null, `INSERT INTO session_entries (session_id, project_id, summary, status_at_entry)
    VALUES (?,?,?,?)`, [session.id, request.id, 'client asked for this', 'in_queue'])
})

test('a pending request is absent from every owner view', async () => {
  const projects = await call('GET', '/api/projects', { cookie: owner })
  assert.ok(!ids(projects.json).includes(request.id), '/api/projects')

  const board = await call('GET', '/api/board', { cookie: owner })
  assert.ok(!ids(board.json).includes(request.id), '/api/board')

  const archive = await call('GET', '/api/archive', { cookie: owner })
  assert.ok(!ids(archive.json).includes(completeRequest.id), '/api/archive')

  const prefill = await call('GET', `/api/prefill?client_id=${mercenary.id}`, { cookie: owner })
  const prefillIds = prefill.json.map(p => p.project.id)
  assert.ok(!prefillIds.includes(request.id), '/api/prefill')
})

test('it surfaces in the requests tray instead', async () => {
  const r = await call('GET', '/api/access/requests', { cookie: owner })
  assert.equal(r.status, 200)
  const row = r.json.find(x => x.id === request.id)
  assert.ok(row, 'the owner can still see it')
  assert.equal(row.client_name, 'Mercenary Marketing')
  assert.equal(row.requested_by_email, 'dana@mercenary.example')
  assert.equal(row.portal_request, 'pending')
})

test('accepting a request puts it into every owner view', async () => {
  assert.equal((await call('POST', `/api/access/requests/${request.id}/accept`, { cookie: owner })).status, 200)
  assert.equal((await call('POST', `/api/access/requests/${completeRequest.id}/accept`, { cookie: owner })).status, 200)

  const projects = await call('GET', '/api/projects', { cookie: owner })
  assert.ok(ids(projects.json).includes(request.id), '/api/projects')

  const board = await call('GET', '/api/board', { cookie: owner })
  assert.ok(ids(board.json).includes(request.id), '/api/board')

  const archive = await call('GET', '/api/archive', { cookie: owner })
  assert.ok(ids(archive.json).includes(completeRequest.id), '/api/archive')

  const prefill = await call('GET', `/api/prefill?client_id=${mercenary.id}`, { cookie: owner })
  assert.ok(prefill.json.map(p => p.project.id).includes(request.id), '/api/prefill')
})

test('accepting records where the project came from', async () => {
  const events = await q(null,
    "SELECT * FROM status_events WHERE project_id = ? AND source = 'accepted'", [request.id])
  assert.equal(events.length, 1)
})

test('a declined request stays out of every owner view and is never deleted', async () => {
  const declined = await q1(null, `
    INSERT INTO projects (client_id, name, portal_request, requested_by)
    VALUES (?,?,?,?) RETURNING *`, [mercenary.id, 'Not This One', 'pending', contact.id])

  const r = await call('POST', `/api/access/requests/${declined.id}/decline`,
    { cookie: owner, body: { reason: 'out of scope for this contract' } })
  assert.equal(r.status, 200)
  assert.equal(r.json.portal_request, 'declined')

  const projects = await call('GET', '/api/projects', { cookie: owner })
  assert.ok(!ids(projects.json).includes(declined.id))
  const board = await call('GET', '/api/board', { cookie: owner })
  assert.ok(!ids(board.json).includes(declined.id))

  assert.ok(await q1(null, 'SELECT * FROM projects WHERE id = ?', [declined.id]), 'row is kept')
  assert.equal((await call('POST', `/api/access/requests/${declined.id}/accept`, { cookie: owner })).status,
    404, 'a declined request cannot be accepted behind your back')
})

/* ── Owner behaviour unchanged ───────────────────────────────────────── */

test('projects that predate the portal are untouched by the filter', async () => {
  const rebrand = await q1(null, 'SELECT * FROM projects WHERE name = ?', ['Q3 Rebrand'])
  assert.equal(rebrand.portal_request, null)
  const projects = await call('GET', '/api/projects', { cookie: owner })
  assert.ok(ids(projects.json).includes(rebrand.id))
})

test('the toggles write only the two portal columns', async () => {
  const before = await q1(null, 'SELECT * FROM clients WHERE id = ?', [mercenary.id])
  await call('PATCH', `/api/access/clients/${mercenary.id}`,
    { cookie: owner, body: { portal_shows_rates: true } })
  const after = await q1(null, 'SELECT * FROM clients WHERE id = ?', [mercenary.id])

  assert.equal(after.portal_shows_rates, 1)
  assert.equal(after.name, before.name)
  assert.equal(after.weekly_hours_target, before.weekly_hours_target)
  assert.equal(after.color_accent, before.color_accent)
  assert.equal(after.is_active, before.is_active)
})

test('access actions are all audited', async () => {
  const actions = (await q(null, 'SELECT DISTINCT action FROM portal_audit')).map(r => r.action)
  for (const expected of ['invite_sent', 'revoked', 'restored', 'publish',
    'request_accepted', 'request_declined', 'portal_toggled']) {
    assert.ok(actions.includes(expected), `missing ${expected}; saw ${actions.join(', ')}`)
  }
})
