// Archiving a client. Soft, like every other delete here: the rows stay and
// restoring brings everything back. What these tests pin down is that an
// archived company leaves the owner's views completely — rows and totals
// together, so the two keep reconciling — and that its contacts lose the
// portal immediately.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.TEMPO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tempo-archive-'))
process.env.PORTAL_BOOTSTRAP_TOKEN = 'bootstrap-secret-for-tests'
process.env.TEMPO_TZ = 'America/Chicago'
delete process.env.DATABASE_URL
delete process.env.VERCEL

const { default: app, ready } = await import('./app.js')
const { q, q1, closeDb } = await import('./db.js')
const { hashPassword } = await import('./auth.js')

await ready
const server = app.listen(0)
await new Promise((r) => server.once('listening', r))
const base = `http://127.0.0.1:${server.address().port}`
after(async () => {
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
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
  return { status: res.status, json, text }
}

const login = async (email, password) => {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ email, password }),
  })
  return res.headers.getSetCookie().map(l => l.split(';')[0])
    .find(p => p.startsWith('tempo_portal=')) || null
}

let owner, keep, drop, dana, dropProject

test('setup: two companies with hours, one portal contact on each', async () => {
  await call('POST', '/api/auth/bootstrap', {
    body: { token: 'bootstrap-secret-for-tests', email: 'chris@example.com', password: 'owner-password-long' },
  })
  owner = await login('chris@example.com', 'owner-password-long')

  keep = (await call('POST', '/api/clients', {
    cookie: owner, body: { name: 'Keep Co', color_accent: '#6B93C4', weekly_hours_target: 20 },
  })).json
  drop = (await call('POST', '/api/clients', {
    cookie: owner, body: { name: 'Drop Co', color_accent: '#8FAE7E', weekly_hours_target: 10 },
  })).json

  const keepProject = (await call('POST', '/api/projects', {
    cookie: owner, body: { client_id: keep.id, name: 'Keep Project' },
  })).json
  dropProject = (await call('POST', '/api/projects', {
    cookie: owner, body: { client_id: drop.id, name: 'Drop Project' },
  })).json

  const mk = async (clientId, projectId, minutes) => {
    const start = new Date(Date.now() - 2 * 86400000)
    const s = await q1(null, `
      INSERT INTO sessions (client_id, clock_in, clock_out, duration_minutes, is_published)
      VALUES (?,?,?,?,1) RETURNING *`,
      [clientId, start.toISOString(), new Date(start.getTime() + minutes * 60000).toISOString(), minutes])
    await q(null, `INSERT INTO session_entries (session_id, project_id, summary, status_at_entry)
      VALUES (?,?,?,?)`, [s.id, projectId, 'work', 'in_progress'])
  }
  await mk(keep.id, keepProject.id, 120)
  await mk(drop.id, dropProject.id, 300)

  dana = await q1(null, `
    INSERT INTO portal_users (client_id, email, password_hash, role, name)
    VALUES (?,?,?,?,?) RETURNING *`,
    [drop.id, 'dana@drop.example', await hashPassword('dana-portal-password'), 'client', 'Dana'])
})

test('the impact summary says what will disappear', async () => {
  const r = await call('GET', `/api/access/clients/${drop.id}/impact`, { cookie: owner })
  assert.equal(r.status, 200)
  assert.equal(r.json.sessions, 1)
  assert.equal(r.json.minutes, 300)
  assert.equal(r.json.projects, 1)
  assert.equal(r.json.contacts, 1)
})

test('a running clock blocks archiving', async () => {
  const running = await q1(null,
    'INSERT INTO sessions (client_id, clock_in) VALUES (?,?) RETURNING *',
    [drop.id, new Date().toISOString()])
  const r = await call('POST', `/api/access/clients/${drop.id}/archive`, { cookie: owner })
  assert.equal(r.status, 409)
  assert.match(r.json.error, /clock out/)
  assert.equal((await q1(null, 'SELECT * FROM clients WHERE id = ?', [drop.id])).is_active, 1)
  await q(null, 'DELETE FROM sessions WHERE id = ?', [running.id])
})

test('archiving removes the company from every owner view', async () => {
  const before = await call('GET', '/api/sessions', { cookie: owner })
  assert.equal(before.json.length, 2, 'both companies visible first')

  const r = await call('POST', `/api/access/clients/${drop.id}/archive`, { cookie: owner })
  assert.equal(r.status, 200)
  assert.equal(r.json.is_active, 0)

  const clients = await call('GET', '/api/clients', { cookie: owner })
  assert.deepEqual(clients.json.map(c => c.name), ['Keep Co'])

  for (const url of ['/api/sessions', '/api/board', '/api/projects']) {
    const res = await call('GET', url, { cookie: owner })
    assert.ok(!res.text.includes('Drop'), `${url} still mentions the archived company`)
  }

  const prefill = await call('GET', `/api/prefill?client_id=${drop.id}`, { cookie: owner })
  assert.deepEqual(prefill.json, [], 'clock-out prefill offers nothing for an archived company')
})

// This is the whole reason "hidden everywhere" was chosen over "hidden from
// pickers only": rows and totals have to move together or the timesheet stops
// adding up.
test('hours and rows disappear together, so the totals still reconcile', async () => {
  const sessions = await call('GET', '/api/sessions', { cookie: owner })
  const total = sessions.json.reduce((a, s) => a + s.duration_minutes, 0)
  assert.equal(total, 120, "only Keep Co's hours remain in the total")

  const clients = await call('GET', '/api/clients', { cookie: owner })
  const perClient = sessions.json.reduce((m, s) => m.set(s.client_id, (m.get(s.client_id) || 0) + s.duration_minutes), new Map())
  const visible = clients.json.reduce((a, c) => a + (perClient.get(c.id) || 0), 0)
  assert.equal(visible, total, 'the sum of visible rows equals the headline total')
})

test('an archived company keeps every row it ever had', async () => {
  assert.ok(await q1(null, 'SELECT * FROM clients WHERE id = ?', [drop.id]), 'client row kept')
  assert.equal((await q(null, 'SELECT * FROM sessions WHERE client_id = ?', [drop.id])).length, 1)
  assert.equal((await q(null, 'SELECT * FROM projects WHERE client_id = ?', [drop.id])).length, 1)
  const entries = await q(null,
    'SELECT * FROM session_entries WHERE project_id = ?', [dropProject.id])
  assert.equal(entries.length, 1, 'the summary trail is untouched')
})

test('its portal contacts lose access immediately and cannot sign back in', async () => {
  const cookie = await login('dana@drop.example', 'dana-portal-password')
  assert.equal(cookie, null, 'sign-in is refused while the company is archived')

  // And a cookie issued before the archive dies on the next request.
  await q(null, 'UPDATE clients SET is_active = 1 WHERE id = ?', [drop.id])
  const live = await login('dana@drop.example', 'dana-portal-password')
  assert.ok(live)
  assert.equal((await call('GET', '/api/portal/summary', { cookie: live })).status, 200)

  await call('POST', `/api/access/clients/${drop.id}/archive`, { cookie: owner })
  const after = await call('GET', '/api/portal/summary', { cookie: live })
  assert.equal(after.status, 401, 'the live session is dead on the very next request')
})

test('an archived company cannot redeem an invite either', async () => {
  const { hashToken } = await import('./auth.js')
  const token = 'invite-for-an-archived-company'
  await q(null, `INSERT INTO portal_tokens (portal_user_id, kind, token_hash, expires_at)
    VALUES (?,?,?,?)`,
    [dana.id, 'invite', hashToken(token), new Date(Date.now() + 60000).toISOString()])

  assert.equal((await call('GET', `/api/auth/token/${token}`)).status, 404)
  const redeem = await call('POST', '/api/auth/set-password',
    { body: { token, password: 'a-brand-new-password' } })
  assert.equal(redeem.status, 404, 'a link cannot outlive its company')
})

test('restoring brings the company and its history back untouched', async () => {
  const r = await call('POST', `/api/access/clients/${drop.id}/restore`, { cookie: owner })
  assert.equal(r.status, 200)
  assert.equal(r.json.is_active, 1)

  const clients = await call('GET', '/api/clients', { cookie: owner })
  assert.deepEqual(clients.json.map(c => c.name).sort(), ['Drop Co', 'Keep Co'])

  const sessions = await call('GET', '/api/sessions', { cookie: owner })
  assert.equal(sessions.json.reduce((a, s) => a + s.duration_minutes, 0), 420,
    'every archived hour is back, to the minute')

  const cookie = await login('dana@drop.example', 'dana-portal-password')
  assert.ok(cookie, 'and the contact can sign in again')
})

test('the owner still sees archived companies, to be able to restore them', async () => {
  await call('POST', `/api/access/clients/${drop.id}/archive`, { cookie: owner })
  const r = await call('GET', '/api/access/clients', { cookie: owner })
  const row = r.json.find(c => c.id === drop.id)
  assert.ok(row, 'archived companies are listed on the Portal screen')
  assert.equal(row.is_active, 0)
  await call('POST', `/api/access/clients/${drop.id}/restore`, { cookie: owner })
})

/* ── Rename and recolour ─────────────────────────────────────────────── */

test('a client can be renamed and recoloured without touching their hours', async () => {
  const before = await call('GET', '/api/sessions', { cookie: owner })
  const beforeMinutes = before.json.reduce((a, s) => a + s.duration_minutes, 0)

  const r = await call('PATCH', `/api/access/clients/${keep.id}`, {
    cookie: owner, body: { name: 'Keep Co Ltd', color_accent: '#D9A13B' },
  })
  assert.equal(r.status, 200)
  assert.equal(r.json.name, 'Keep Co Ltd')
  assert.equal(r.json.color_accent, '#D9A13B')

  const after = await call('GET', '/api/sessions', { cookie: owner })
  assert.equal(after.json.reduce((a, s) => a + s.duration_minutes, 0), beforeMinutes,
    'not one minute moved')
  assert.ok(after.json.some(s => s.client_name === 'Keep Co Ltd'),
    'past sessions report the new name')
})

test('the rename leaves an audit trail with the old value', async () => {
  const rows = await q(null, "SELECT * FROM portal_audit WHERE action = 'client_renamed'")
  assert.ok(rows.length > 0)
  assert.match(rows[rows.length - 1].detail, /Keep Co → Keep Co Ltd/)
  const colours = await q(null, "SELECT * FROM portal_audit WHERE action = 'client_recoloured'")
  assert.ok(colours.length > 0)
})

test('an empty name or a bad colour is refused', async () => {
  for (const body of [{ name: '   ' }, { name: '' }, { color_accent: 'red' },
    { color_accent: '#GGGGGG' }, { name: 'x'.repeat(200) }]) {
    const r = await call('PATCH', `/api/access/clients/${keep.id}`, { cookie: owner, body })
    assert.equal(r.status, 400, JSON.stringify(body))
  }
  const still = await q1(null, 'SELECT * FROM clients WHERE id = ?', [keep.id])
  assert.equal(still.name, 'Keep Co Ltd', 'the row is untouched by a refused edit')
})

test('editing a client leaves its other columns alone', async () => {
  const before = await q1(null, 'SELECT * FROM clients WHERE id = ?', [keep.id])
  await call('PATCH', `/api/access/clients/${keep.id}`,
    { cookie: owner, body: { name: 'Keep Co Renamed' } })
  const after = await q1(null, 'SELECT * FROM clients WHERE id = ?', [keep.id])

  assert.equal(after.name, 'Keep Co Renamed')
  assert.equal(after.color_accent, before.color_accent, 'colour kept when only the name is sent')
  assert.equal(after.weekly_hours_target, before.weekly_hours_target)
  assert.equal(after.is_active, before.is_active)
  assert.equal(after.created_at, before.created_at)
})

test('renaming is owner-only', async () => {
  await call('POST', `/api/access/clients/${drop.id}/restore`, { cookie: owner })
  const cookie = await login('dana@drop.example', 'dana-portal-password')
  const r = await call('PATCH', `/api/access/clients/${keep.id}`,
    { cookie, body: { name: 'Renamed by a client' } })
  assert.equal(r.status, 404)
  assert.equal((await q1(null, 'SELECT * FROM clients WHERE id = ?', [keep.id])).name,
    'Keep Co Renamed')
})

test('archiving is owner-only and audited', async () => {
  const cookie = await login('dana@drop.example', 'dana-portal-password')
  for (const url of [`/api/access/clients/${keep.id}/archive`, `/api/access/clients/${keep.id}/impact`]) {
    const r = await call(url.endsWith('impact') ? 'GET' : 'POST', url, { cookie })
    assert.equal(r.status, 404, `${url} must be invisible to a client`)
  }
  assert.equal((await q1(null, 'SELECT * FROM clients WHERE id = ?', [keep.id])).is_active, 1)

  const actions = (await q(null, 'SELECT DISTINCT action FROM portal_audit')).map(a => a.action)
  assert.ok(actions.includes('client_archived'))
  assert.ok(actions.includes('client_restored'))
})
