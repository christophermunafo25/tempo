// Step 3: what a client can actually see. This is the first surface that
// returns real data to a client session, so these tests are about leakage —
// unpublished work, another company's rows, and internal fields.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.TEMPO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tempo-portal-'))
process.env.PORTAL_BOOTSTRAP_TOKEN = 'bootstrap-secret-for-tests'
process.env.TEMPO_TZ = 'America/Chicago'
delete process.env.DATABASE_URL
delete process.env.VERCEL

const { default: app, ready } = await import('./app.js')
const { q, q1, closeDb } = await import('./db.js')
const { hashPassword } = await import('./auth.js')
const { csvRows } = await import('../src/portal/csv.js')

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
  return { status: res.status, json, text }
}

const cookieFrom = (res) =>
  res.headers.getSetCookie().map(l => l.split(';')[0]).find(p => p.startsWith('tempo_portal=')) || null

/* ── Fixtures ────────────────────────────────────────────────────────────
   Two companies. Mercenary has published and unpublished work; Northwind has
   published work that Mercenary's contact must never see. */

const SECRET_QUESTION = 'INTERNAL-QUESTION-DO-NOT-LEAK'
let dana, mercenary, northwind, mercProject, mercProject2, nwProject

async function session(clientId, daysAgo, minutes, published, entries = []) {
  const start = new Date(Date.now() - daysAgo * 86400000)
  const end = new Date(start.getTime() + minutes * 60000)
  const s = await q1(null, `
    INSERT INTO sessions (client_id, clock_in, clock_out, duration_minutes, is_published)
    VALUES (?,?,?,?,?) RETURNING *`,
    [clientId, start.toISOString(), end.toISOString(), minutes, published ? 1 : 0])
  for (const [projectId, summary] of entries) {
    await q(null, `INSERT INTO session_entries (session_id, project_id, summary, status_at_entry)
      VALUES (?,?,?,?)`, [s.id, projectId, summary, 'in_progress'])
  }
  return s
}

test('setup', async () => {
  await call('POST', '/api/auth/bootstrap', {
    body: { token: 'bootstrap-secret-for-tests', email: 'chris@example.com', password: 'owner-password-long' },
  })
  const owner = cookieFrom((await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ email: 'chris@example.com', password: 'owner-password-long' }),
  })))

  mercenary = (await call('POST', '/api/clients', {
    cookie: owner, body: { name: 'Mercenary Marketing', color_accent: '#6B93C4', weekly_hours_target: 20 },
  })).json
  northwind = (await call('POST', '/api/clients', {
    cookie: owner, body: { name: 'Northwind Studio', color_accent: '#8FAE7E', weekly_hours_target: 10 },
  })).json

  mercProject = await q1(null,
    'INSERT INTO projects (client_id, name) VALUES (?,?) RETURNING *', [mercenary.id, 'Q3 Rebrand'])
  mercProject2 = await q1(null,
    'INSERT INTO projects (client_id, name) VALUES (?,?) RETURNING *', [mercenary.id, 'Booth Graphics'])
  nwProject = await q1(null,
    'INSERT INTO projects (client_id, name) VALUES (?,?) RETURNING *', [northwind.id, 'Northwind Secret'])

  // A project the owner has parked in Questions, with the question text set.
  await q(null, "UPDATE projects SET status = 'questions', question_text = ? WHERE id = ?",
    [SECRET_QUESTION, mercProject2.id])

  // Mercenary: two published sessions, one unpublished.
  await session(mercenary.id, 2, 120, true, [[mercProject.id, 'logo round one']])
  await session(mercenary.id, 1, 60, true, [[mercProject.id, 'logo round two'], [mercProject2.id, 'booth layout']])
  await session(mercenary.id, 1, 480, false, [[mercProject.id, 'SECRET-UNPUBLISHED-WORK']])
  // Northwind: published, but belongs to someone else.
  await session(northwind.id, 1, 300, true, [[nwProject.id, 'northwind work']])

  dana = await q1(null, `
    INSERT INTO portal_users (client_id, email, password_hash, role, name)
    VALUES (?,?,?,?,?) RETURNING *`,
    [mercenary.id, 'dana@mercenary.example', await hashPassword('dana-portal-password'), 'client', 'Dana'])

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ email: 'dana@mercenary.example', password: 'dana-portal-password' }),
  })
  dana.cookie = cookieFrom(login)
  assert.ok(dana.cookie)
})

/* ── Publication ─────────────────────────────────────────────────────── */

test('the session list contains zero unpublished sessions', async () => {
  const r = await call('GET', '/api/portal/sessions?per_page=100', { cookie: dana.cookie })
  assert.equal(r.status, 200)
  assert.equal(r.json.total, 2, 'only the two published sessions')
  assert.ok(!r.text.includes('SECRET-UNPUBLISHED-WORK'), 'unpublished summaries must not leak')
  assert.equal(r.json.sessions.reduce((a, s) => a + s.duration_minutes, 0), 180)
})

test('unpublished work is absent from totals, breakdown and export too', async () => {
  const summary = await call('GET', '/api/portal/summary', { cookie: dana.cookie })
  assert.equal(summary.json.month.minutes, 180, 'the 480-minute unpublished session is excluded')
  assert.ok(!summary.text.includes('SECRET-UNPUBLISHED-WORK'))

  const breakdown = await call('GET', '/api/portal/breakdown', { cookie: dana.cookie })
  const totalEstimated = breakdown.json.projects.reduce((a, p) => a + p.minutes, 0)
  assert.equal(Math.round(totalEstimated), 180, 'breakdown sums to published time only')

  const exported = await call('POST', '/api/portal/export', { cookie: dana.cookie, body: {} })
  assert.equal(exported.json.total, 2)
  assert.ok(!exported.text.includes('SECRET-UNPUBLISHED-WORK'))
})

test('publishing a session makes it appear, and only then', async () => {
  const hidden = await q1(null, 'SELECT * FROM sessions WHERE is_published = 0')
  await q(null, 'UPDATE sessions SET is_published = 1 WHERE id = ?', [hidden.id])

  const after = await call('GET', '/api/portal/sessions?per_page=100', { cookie: dana.cookie })
  assert.equal(after.json.total, 3)

  await q(null, 'UPDATE sessions SET is_published = 0 WHERE id = ?', [hidden.id])
  const again = await call('GET', '/api/portal/sessions?per_page=100', { cookie: dana.cookie })
  assert.equal(again.json.total, 2, 'and disappears again when unpublished')
})

test('the breakdown reconciles to the headline total, untagged time included', async () => {
  const untaggedSession = await q1(null, `
    INSERT INTO sessions (client_id, clock_in, clock_out, duration_minutes, is_published)
    VALUES (?,?,?,?,1) RETURNING *`,
    [mercenary.id, new Date(Date.now() - 4 * 86400000).toISOString(),
     new Date(Date.now() - 4 * 86400000 + 3600000).toISOString(), 60])

  const list = await call('GET', '/api/portal/sessions?per_page=100', { cookie: dana.cookie })
  const shown = list.json.sessions.reduce((a, s) => a + s.duration_minutes, 0)

  const b = await call('GET', '/api/portal/breakdown', { cookie: dana.cookie })
  const summed = b.json.projects.reduce((a, p) => a + p.minutes, 0)
  assert.equal(Math.round(summed), Math.round(shown),
    'a client must never see a breakdown that disagrees with the total above it')

  const untagged = b.json.projects.find(p => p.project_id === null)
  assert.ok(untagged, 'unattributed time is named rather than dropped')
  assert.equal(untagged.minutes, 60)

  await q(null, 'DELETE FROM sessions WHERE id = ?', [untaggedSession.id])
})

/* ── Company scope ───────────────────────────────────────────────────── */

test('the session list contains zero rows belonging to another company', async () => {
  const r = await call('GET', '/api/portal/sessions?per_page=100', { cookie: dana.cookie })
  assert.ok(!r.text.includes('northwind work'))
  assert.ok(!r.text.includes('Northwind'))
  assert.equal(r.json.sessions.reduce((a, s) => a + s.duration_minutes, 0), 180,
    "Northwind's 300 published minutes are not in the total")
})

test('another company id changes nothing about the response', async () => {
  const plain = await call('GET', '/api/portal/sessions?per_page=100', { cookie: dana.cookie })
  const spoofs = [
    `/api/portal/sessions?per_page=100&client_id=${northwind.id}`,
    `/api/portal/sessions?per_page=100&clientId=${northwind.id}`,
    `/api/portal/summary?client_id=${northwind.id}`,
  ]
  for (const url of spoofs.slice(0, 2)) {
    const r = await call('GET', url, { cookie: dana.cookie })
    assert.equal(r.text, plain.text, `${url} produced a different response`)
  }
  const summaryPlain = await call('GET', '/api/portal/summary', { cookie: dana.cookie })
  const summarySpoof = await call('GET', spoofs[2], { cookie: dana.cookie })
  assert.equal(summarySpoof.text, summaryPlain.text)
})

test('a body-borne client_id is ignored by the export', async () => {
  const plain = await call('POST', '/api/portal/export', { cookie: dana.cookie, body: {} })
  const spoof = await call('POST', '/api/portal/export',
    { cookie: dana.cookie, body: { client_id: northwind.id } })
  assert.equal(spoof.text, plain.text)
})

test("filtering by another company's project id returns 404, not 403", async () => {
  const r = await call('GET', `/api/portal/sessions?project_id=${nwProject.id}`, { cookie: dana.cookie })
  assert.equal(r.status, 404)
  assert.equal(r.json.error, 'not found')

  const b = await call('GET', `/api/portal/breakdown?project_id=${nwProject.id}`, { cookie: dana.cookie })
  assert.equal(b.status, 404)
})

test('the project list is scoped to the caller’s company', async () => {
  const r = await call('GET', '/api/portal/projects', { cookie: dana.cookie })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.map(p => p.name).sort(), ['Booth Graphics', 'Q3 Rebrand'])
})

/* ── Internal fields ─────────────────────────────────────────────────── */

test('no portal response anywhere contains question_text', async () => {
  const urls = [
    '/api/portal/summary',
    '/api/portal/sessions?per_page=100',
    '/api/portal/projects',
    '/api/portal/breakdown',
  ]
  for (const url of urls) {
    const r = await call('GET', url, { cookie: dana.cookie })
    assert.ok(!r.text.includes(SECRET_QUESTION), `${url} leaked question_text`)
    assert.ok(!r.text.includes('question_text'), `${url} leaked the field name`)
  }
  const exported = await call('POST', '/api/portal/export', { cookie: dana.cookie, body: {} })
  assert.ok(!exported.text.includes(SECRET_QUESTION))
})

test('a project in Questions reports as In Progress', async () => {
  const r = await call('GET', '/api/portal/projects', { cookie: dana.cookie })
  const booth = r.json.find(p => p.name === 'Booth Graphics')
  assert.equal(booth.status, 'in_progress', 'the questions state is mapped away')
  assert.ok(!r.text.includes('questions'))
})

test('status_events and status_at_entry never appear', async () => {
  for (const url of ['/api/portal/sessions?per_page=100', '/api/portal/projects', '/api/portal/summary']) {
    const r = await call('GET', url, { cookie: dana.cookie })
    assert.ok(!r.text.includes('status_at_entry'), `${url}`)
    assert.ok(!r.text.includes('status_events'), `${url}`)
  }
})

test('clock times never leave the server', async () => {
  const r = await call('GET', '/api/portal/sessions?per_page=100', { cookie: dana.cookie })
  assert.ok(!r.text.includes('clock_in'), 'no clock_in')
  assert.ok(!r.text.includes('clock_out'), 'no clock_out')
  for (const s of r.json.sessions) {
    assert.match(s.date, /^\d{4}-\d{2}-\d{2}$/, 'a calendar date, not a timestamp')
  }
})

/* ── CSV ─────────────────────────────────────────────────────────────── */

test('CSV row count matches the on-screen filtered count exactly', async () => {
  const onScreen = await call('GET', '/api/portal/sessions?per_page=100', { cookie: dana.cookie })
  const exported = await call('POST', '/api/portal/export', { cookie: dana.cookie, body: {} })

  assert.equal(exported.json.sessions.length, onScreen.json.sessions.length)
  const rows = csvRows(exported.json.sessions)
  assert.equal(rows.length - 1, onScreen.json.total, 'one data row per visible session')
  assert.deepEqual(rows[0], ['Date', 'Hours', 'Projects', 'Notes'])
})

test('a filtered CSV matches the filtered view, not the whole set', async () => {
  const url = `/api/portal/sessions?per_page=100&project_id=${mercProject2.id}`
  const onScreen = await call('GET', url, { cookie: dana.cookie })
  const exported = await call('POST', '/api/portal/export',
    { cookie: dana.cookie, body: { project_id: mercProject2.id } })

  assert.equal(onScreen.json.total, 1, 'only the session that touched that project')
  assert.equal(csvRows(exported.json.sessions).length - 1, onScreen.json.total)
})

test('the CSV never contains unpublished or other-company rows', async () => {
  const exported = await call('POST', '/api/portal/export', { cookie: dana.cookie, body: {} })
  const text = csvRows(exported.json.sessions).map(r => r.join(',')).join('\n')
  assert.ok(!text.includes('SECRET-UNPUBLISHED-WORK'))
  assert.ok(!text.includes('northwind'))
})

test('exports are audited', async () => {
  const rows = await q(null, "SELECT * FROM portal_audit WHERE action = 'export'")
  assert.ok(rows.length > 0)
  assert.equal(rows[0].client_id, mercenary.id)
})

/* ── Pagination ──────────────────────────────────────────────────────── */

test('pagination never widens the scope', async () => {
  const first = await call('GET', '/api/portal/sessions?per_page=1&page=1', { cookie: dana.cookie })
  const second = await call('GET', '/api/portal/sessions?per_page=1&page=2', { cookie: dana.cookie })
  const third = await call('GET', '/api/portal/sessions?per_page=1&page=3', { cookie: dana.cookie })

  assert.equal(first.json.total, 2)
  assert.equal(first.json.sessions.length, 1)
  assert.equal(second.json.sessions.length, 1)
  assert.equal(third.json.sessions.length, 0, 'past the end is empty, not a wrap-around')
  assert.notEqual(first.json.sessions[0].id, second.json.sessions[0].id)

  const huge = await call('GET', '/api/portal/sessions?per_page=100000', { cookie: dana.cookie })
  assert.equal(huge.json.per_page, 100, 'per_page is capped')
})

/* ── Owner is still shut out of the client prefix ────────────────────── */

test('the owner cannot read a client view', async () => {
  const owner = cookieFrom(await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ email: 'chris@example.com', password: 'owner-password-long' }),
  }))
  for (const url of ['/api/portal/summary', '/api/portal/sessions', '/api/portal/projects']) {
    const r = await call('GET', url, { cookie: owner })
    assert.equal(r.status, 404, url)
  }
})

test('a revoked client loses the portal immediately', async () => {
  await q(null, 'UPDATE portal_users SET is_active = 0 WHERE id = ?', [dana.id])
  const r = await call('GET', '/api/portal/sessions', { cookie: dana.cookie })
  assert.equal(r.status, 401)
  await q(null, 'UPDATE portal_users SET is_active = 1 WHERE id = ?', [dana.id])
})
