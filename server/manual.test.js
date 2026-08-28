// Manual time entry: POST /api/sessions.
//
// The forgot-to-clock-in case. A manual session is always a completed one, is
// never published by its own creation, records that it was reconstructed
// rather than clocked, and moves no project's board status — back-filling
// Tuesday's work on Friday should not drag a column backwards to match a
// three-day-old memory.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.TEMPO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tempo-manual-'))
process.env.PORTAL_BOOTSTRAP_TOKEN = 'bootstrap-secret-for-tests'
process.env.TEMPO_TZ = 'America/Chicago'
delete process.env.DATABASE_URL
delete process.env.VERCEL

const { default: app, ready } = await import('./app.js')
const { q, q1, closeDb } = await import('./db.js')
const { hashPassword, mintToken, hashToken } = await import('./auth.js')

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

/* ── Fixtures ────────────────────────────────────────────────────────────
   One company with a contact and a share link, plus a second company whose
   project is used to prove an entry can't be mis-parented across companies. */

let owner, merc, northwind, mercProject, nwProject, dana, shareToken

const sessionCount = async () =>
  Number((await q1(null, 'SELECT COUNT(*) AS n FROM sessions'))?.n || 0)
const entryCount = async () =>
  Number((await q1(null, 'SELECT COUNT(*) AS n FROM session_entries'))?.n || 0)
const statusEventCount = async (projectId) =>
  Number((await q1(null,
    'SELECT COUNT(*) AS n FROM status_events WHERE project_id = ?', [projectId]))?.n || 0)

// A fixed, unambiguously-past window so nothing here races the clock.
const daysAgo = (n, hour, minute = 0) => {
  const d = new Date(Date.now() - n * 86400000)
  d.setHours(hour, minute, 0, 0)
  return d
}

test('setup', async () => {
  await call('POST', '/api/auth/bootstrap', {
    body: { token: 'bootstrap-secret-for-tests', email: 'chris@example.com', password: 'owner-password-long' },
  })
  owner = await login('chris@example.com', 'owner-password-long')

  merc = (await call('POST', '/api/clients', {
    cookie: owner, body: { name: 'Mercenary Marketing', color_accent: '#6B93C4', weekly_hours_target: 20 },
  })).json
  northwind = (await call('POST', '/api/clients', {
    cookie: owner, body: { name: 'Northwind Studio', color_accent: '#8FAE7E' },
  })).json
  await q(null, 'UPDATE clients SET portal_enabled = 1 WHERE id = ?', [merc.id])

  mercProject = (await call('POST', '/api/projects', {
    cookie: owner, body: { client_id: merc.id, name: 'Q3 Rebrand', status: 'sent_for_review' },
  })).json
  nwProject = (await call('POST', '/api/projects', {
    cookie: owner, body: { client_id: northwind.id, name: 'Northwind Secret' },
  })).json

  dana = await q1(null, `
    INSERT INTO portal_users (client_id, email, password_hash, role, name)
    VALUES (?,?,?,?,?) RETURNING *`,
    [merc.id, 'dana@merc.example', await hashPassword('dana-portal-password'), 'client', 'Dana'])
  dana.cookie = await login('dana@merc.example', 'dana-portal-password')
  assert.ok(dana.cookie)

  shareToken = mintToken()
  await q(null, 'INSERT INTO portal_share_links (client_id, token_hash, label) VALUES (?,?,?)',
    [merc.id, hashToken(shareToken), 'Finance'])
})

/* ── 1, 2. The gate, confirmed rather than inspected ─────────────────── */

test('an unauthenticated POST /api/sessions answers 401', async () => {
  const before = await sessionCount()
  const r = await call('POST', '/api/sessions', {
    body: {
      client_id: merc.id,
      clock_in: daysAgo(2, 9).toISOString(),
      clock_out: daysAgo(2, 11).toISOString(),
    },
  })
  assert.equal(r.status, 401)
  assert.equal(r.json?.error, 'not signed in')
  assert.equal(await sessionCount(), before, 'nothing was written')
})

test('a client session posting to POST /api/sessions answers 404, with no data', async () => {
  const before = await sessionCount()
  const r = await call('POST', '/api/sessions', {
    cookie: dana.cookie,
    body: {
      client_id: merc.id,
      clock_in: daysAgo(2, 9).toISOString(),
      clock_out: daysAgo(2, 11).toISOString(),
    },
  })
  // 404 rather than 403: a client learns nothing about what else is hosted
  // here, and the body carries the gate's own message and nothing of the row.
  assert.equal(r.status, 404)
  assert.equal(r.json?.error, 'not found')
  assert.equal(Object.keys(r.json).length, 1, 'no session fields came back')
  assert.ok(!r.text.includes('entry_method'))
  assert.equal(await sessionCount(), before, 'nothing was written')
})

/* ── 4. Duration ─────────────────────────────────────────────────────── */

test('duration_minutes is the minute difference, rounded to two places', async () => {
  const cases = [
    [daysAgo(3, 9, 0), daysAgo(3, 11, 30), 150],
    [daysAgo(4, 13, 0), daysAgo(4, 13, 1), 1],
    [daysAgo(5, 8, 15), daysAgo(5, 17, 45), 570],
  ]
  for (const [inn, out, expected] of cases) {
    const r = await call('POST', '/api/sessions', {
      cookie: owner,
      body: { client_id: merc.id, clock_in: inn.toISOString(), clock_out: out.toISOString() },
    })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.duration_minutes, expected)
    assert.equal(r.json.duration_minutes, Math.round(((out - inn) / 60000) * 100) / 100)
  }

  // Seconds survive the rounding rather than being truncated away.
  const inn = daysAgo(6, 10, 0)
  const out = new Date(inn.getTime() + 90 * 1000 + 400)   // 1.5 minutes and change
  const r = await call('POST', '/api/sessions', {
    cookie: owner,
    body: { client_id: merc.id, clock_in: inn.toISOString(), clock_out: out.toISOString() },
  })
  assert.equal(r.json.duration_minutes, 1.51)
})

/* ── 5, 6, 7. Refusals, and nothing written by a refused request ─────── */

test('a request with no clock_out is rejected, and no row is created', async () => {
  const before = await sessionCount()
  for (const body of [
    { client_id: merc.id, clock_in: daysAgo(2, 9).toISOString() },
    { client_id: merc.id, clock_in: daysAgo(2, 9).toISOString(), clock_out: null },
    { client_id: merc.id, clock_in: daysAgo(2, 9).toISOString(), clock_out: '' },
  ]) {
    const r = await call('POST', '/api/sessions', { cookie: owner, body })
    assert.equal(r.status, 400, JSON.stringify(body))
    assert.match(r.json.error, /clock_out is required/)
  }
  assert.equal(await sessionCount(), before)

  // And the reason it matters: an open row would surface as the running timer.
  assert.equal((await call('GET', '/api/active-session', { cookie: owner })).json, null)
})

test('a clock_out at or before clock_in is rejected', async () => {
  const before = await sessionCount()
  const inn = daysAgo(2, 14, 0)
  for (const out of [inn, daysAgo(2, 13, 59), daysAgo(2, 9, 0), daysAgo(3, 14, 0)]) {
    const r = await call('POST', '/api/sessions', {
      cookie: owner,
      body: { client_id: merc.id, clock_in: inn.toISOString(), clock_out: out.toISOString() },
    })
    assert.equal(r.status, 400, out.toISOString())
    assert.equal(r.json.error, 'clock_out must be after clock_in')
  }
  assert.equal(await sessionCount(), before)
})

test('a future clock_in is rejected', async () => {
  const before = await sessionCount()
  const inn = new Date(Date.now() + 2 * 86400000)
  const r = await call('POST', '/api/sessions', {
    cookie: owner,
    body: {
      client_id: merc.id,
      clock_in: inn.toISOString(),
      clock_out: new Date(inn.getTime() + 3600000).toISOString(),
    },
  })
  assert.equal(r.status, 400)
  assert.match(r.json.error, /clock_in can/)
  assert.equal(await sessionCount(), before)
})

test('a future clock_out is rejected too, and the minute of grace is real', async () => {
  const before = await sessionCount()
  const far = await call('POST', '/api/sessions', {
    cookie: owner,
    body: {
      client_id: merc.id,
      clock_in: daysAgo(0, 0, 1).toISOString(),
      clock_out: new Date(Date.now() + 6 * 3600000).toISOString(),
    },
  })
  assert.equal(far.status, 400)
  assert.match(far.json.error, /clock_out can/)
  assert.equal(await sessionCount(), before)

  // TimeField rounds to the minute, so a clock-out typed as the current minute
  // can land a few seconds ahead of the clock. That is the obvious meaning and
  // must still save.
  const soon = await call('POST', '/api/sessions', {
    cookie: owner,
    body: {
      client_id: merc.id,
      clock_in: new Date(Date.now() - 3600000).toISOString(),
      clock_out: new Date(Date.now() + 20000).toISOString(),
      allow_overlap: true,
    },
  })
  assert.equal(soon.status, 200, soon.text)
})

test('a nonsense time and an unknown client are refused', async () => {
  const before = await sessionCount()
  const bad = await call('POST', '/api/sessions', {
    cookie: owner,
    body: { client_id: merc.id, clock_in: 'last tuesday', clock_out: daysAgo(2, 11).toISOString() },
  })
  assert.equal(bad.status, 400)
  assert.equal(bad.json.error, 'clock_in is not a valid time')

  const noClient = await call('POST', '/api/sessions', {
    cookie: owner,
    body: {
      client_id: 999999,
      clock_in: daysAgo(2, 9).toISOString(),
      clock_out: daysAgo(2, 11).toISOString(),
    },
  })
  assert.equal(noClient.status, 404)
  assert.equal(await sessionCount(), before)
})

/* ── 9. Entries land in the same transaction as the session ──────────── */

test('a failure partway through the entries leaves no session row behind', async () => {
  const sessionsBefore = await sessionCount()
  const entriesBefore = await entryCount()

  // The first entry is good and the second is not, so the insert has already
  // happened by the time the route throws.
  const r = await call('POST', '/api/sessions', {
    cookie: owner,
    body: {
      client_id: merc.id,
      clock_in: daysAgo(7, 9).toISOString(),
      clock_out: daysAgo(7, 12).toISOString(),
      entries: [
        { project_id: mercProject.id, summary: 'good entry' },
        { project_id: 999999, summary: 'this one blows up' },
      ],
    },
  })
  assert.equal(r.status, 400)
  assert.match(r.json.error, /project 999999 not found/)
  assert.equal(await sessionCount(), sessionsBefore, 'the session rolled back')
  assert.equal(await entryCount(), entriesBefore, 'so did the entry that had succeeded')

  const orphan = await q1(null,
    "SELECT COUNT(*) AS n FROM session_entries WHERE summary = 'good entry'")
  assert.equal(Number(orphan.n), 0)
})

test("an entry naming another company's project is refused", async () => {
  const before = await sessionCount()
  const r = await call('POST', '/api/sessions', {
    cookie: owner,
    body: {
      client_id: merc.id,
      clock_in: daysAgo(7, 9).toISOString(),
      clock_out: daysAgo(7, 12).toISOString(),
      entries: [{ project_id: nwProject.id, summary: 'wrong company' }],
    },
  })
  assert.equal(r.status, 400)
  assert.match(r.json.error, /belongs to another client/)
  assert.equal(await sessionCount(), before)
})

/* ── 10. A manual session moves no project ───────────────────────────── */

test('a manual session leaves the project status and its status_events alone', async () => {
  const statusBefore = (await q1(null, 'SELECT status FROM projects WHERE id = ?', [mercProject.id])).status
  const eventsBefore = await statusEventCount(mercProject.id)
  assert.equal(statusBefore, 'sent_for_review', 'the fixture parked it somewhere specific')

  const inn = daysAgo(8, 9)
  const r = await call('POST', '/api/sessions', {
    cookie: owner,
    body: {
      client_id: merc.id,
      clock_in: inn.toISOString(),
      clock_out: daysAgo(8, 12).toISOString(),
      entries: [{ project_id: mercProject.id, summary: 'back-filled work' }],
    },
  })
  assert.equal(r.status, 200, r.text)

  const after = await q1(null, 'SELECT status FROM projects WHERE id = ?', [mercProject.id])
  assert.equal(after.status, statusBefore, 'the board column did not move')
  assert.equal(await statusEventCount(mercProject.id), eventsBefore, 'no status_events row')

  // status_at_entry is NOT NULL, so it took the project's current status.
  const entry = await q1(null,
    'SELECT * FROM session_entries WHERE session_id = ?', [r.json.id])
  assert.equal(entry.status_at_entry, 'sent_for_review')
  assert.equal(entry.summary, 'back-filled work')
})

/* ── 3. Unpublished by creation, invisible until published ───────────── */

test('a manual session is created unpublished and reaches no client until published', async () => {
  const inn = daysAgo(9, 10)
  const created = (await call('POST', '/api/sessions', {
    cookie: owner,
    body: {
      client_id: merc.id,
      clock_in: inn.toISOString(),
      clock_out: daysAgo(9, 13, 21).toISOString(),
      entries: [{ project_id: mercProject.id, summary: 'BACKFILLED-SENTINEL' }],
    },
  })).json
  assert.equal(created.is_published, 0)
  assert.equal(created.rate_applied, null)
  assert.equal(created.entry_method, 'manual')

  // Mercenary has portal_enabled on, so a *clocked* session for this company
  // would have auto-published at clock-out. A manual one deliberately does not.
  assert.equal((await q1(null, 'SELECT portal_enabled FROM clients WHERE id = ?',
    [merc.id])).portal_enabled, 1)

  const surfaces = [
    ['/api/portal/summary', dana.cookie],
    ['/api/portal/sessions?per_page=100', dana.cookie],
    ['/api/portal/breakdown', dana.cookie],
    [`/api/share/${shareToken}/summary`, null],
    [`/api/share/${shareToken}/sessions?per_page=100`, null],
    [`/api/share/${shareToken}/breakdown`, null],
    [`/api/share/${shareToken}/export`, null],
  ]
  for (const [url, cookie] of surfaces) {
    const r = await call('GET', url, { cookie })
    assert.equal(r.status, 200, url)
    assert.ok(!r.text.includes('BACKFILLED-SENTINEL'), `${url} showed an unpublished session`)
  }

  // Published by hand, the same way a clocked session is, it appears.
  await call('PATCH', `/api/access/sessions/${created.id}`,
    { cookie: owner, body: { is_published: true } })
  const after = await call('GET', '/api/portal/sessions?per_page=100', { cookie: dana.cookie })
  assert.ok(after.text.includes('BACKFILLED-SENTINEL'), 'visible once published')
})

/* ── 8. entry_method never reaches a client ──────────────────────────── */

test('entry_method never appears in a client-reachable response', async () => {
  // The published manual session from the test above is in scope for all of
  // these, so the scan has something to leak.
  const published = await q1(null,
    "SELECT COUNT(*) AS n FROM sessions WHERE entry_method = 'manual' AND is_published = 1")
  assert.ok(Number(published.n) > 0, 'a published manual session is in scope')

  for (const [url, cookie] of [
    ['/api/portal/summary', dana.cookie],
    ['/api/portal/sessions?per_page=100', dana.cookie],
    ['/api/portal/projects', dana.cookie],
    ['/api/portal/breakdown', dana.cookie],
    ['/api/portal/pulse', dana.cookie],
    [`/api/portal/projects/${mercProject.id}`, dana.cookie],
    [`/api/share/${shareToken}/summary`, null],
    [`/api/share/${shareToken}/sessions?per_page=100`, null],
    [`/api/share/${shareToken}/projects`, null],
    [`/api/share/${shareToken}/breakdown`, null],
    [`/api/share/${shareToken}/export`, null],
  ]) {
    const r = await call('GET', url, { cookie })
    assert.equal(r.status, 200, url)
    assert.ok(!r.text.includes('entry_method'), `${url} leaked the field name`)
    assert.ok(!r.text.includes('manual'), `${url} leaked the value`)
  }
})

test('a clocked session records no entry_method at all', async () => {
  const clocked = (await call('POST', '/api/clock-in', {
    cookie: owner, body: { client_id: northwind.id },
  })).json
  await call('POST', `/api/sessions/${clocked.id}/clock-out`, { cookie: owner, body: { entries: [] } })
  const row = await q1(null, 'SELECT entry_method FROM sessions WHERE id = ?', [clocked.id])
  assert.equal(row.entry_method, null, 'NULL keeps meaning clocked')
})

/* ── Overlap: warn, name the conflict, let it through on confirmation ── */

test('an overlapping window answers 409 and names the conflicting session', async () => {
  const inn = daysAgo(12, 9)
  const out = daysAgo(12, 17)
  const first = (await call('POST', '/api/sessions', {
    cookie: owner, body: { client_id: merc.id, clock_in: inn.toISOString(), clock_out: out.toISOString() },
  })).json
  assert.ok(first.id)

  const before = await sessionCount()
  const clash = await call('POST', '/api/sessions', {
    cookie: owner,
    body: {
      client_id: merc.id,
      clock_in: daysAgo(12, 15).toISOString(),
      clock_out: daysAgo(12, 18).toISOString(),
    },
  })
  assert.equal(clash.status, 409)
  assert.equal(clash.json.conflicts.length, 1)
  assert.equal(clash.json.conflicts[0].id, first.id)
  assert.equal(clash.json.conflicts[0].client_name, 'Mercenary Marketing',
    'the warning can name the session')
  assert.equal(await sessionCount(), before, 'a warning writes nothing')
})

test('overlap is detected across every client, not just the one being entered', async () => {
  const clash = await call('POST', '/api/sessions', {
    cookie: owner,
    body: {
      client_id: northwind.id,          // a different company entirely
      clock_in: daysAgo(12, 10).toISOString(),
      clock_out: daysAgo(12, 12).toISOString(),
    },
  })
  assert.equal(clash.status, 409)
  assert.equal(clash.json.conflicts[0].client_name, 'Mercenary Marketing',
    'I cannot be in two places, whoever is being billed')
})

test('confirming with allow_overlap writes the session', async () => {
  const before = await sessionCount()
  const r = await call('POST', '/api/sessions', {
    cookie: owner,
    body: {
      client_id: northwind.id,
      clock_in: daysAgo(12, 10).toISOString(),
      clock_out: daysAgo(12, 12).toISOString(),
      allow_overlap: true,
    },
  })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.json.entry_method, 'manual')
  assert.equal(await sessionCount(), before + 1)
})

test('sessions that merely touch at an endpoint do not overlap', async () => {
  const r = await call('POST', '/api/sessions', {
    cookie: owner,
    body: {
      client_id: merc.id,
      clock_in: daysAgo(12, 17).toISOString(),   // the 9–17 session ends here
      clock_out: daysAgo(12, 19).toISOString(),
    },
  })
  assert.equal(r.status, 200, r.text)
})

test('a running timer counts as occupied time, up to now', async () => {
  const running = (await call('POST', '/api/clock-in', {
    cookie: owner, body: { client_id: merc.id },
  })).json
  // Started two hours ago and still going, which is the case that matters:
  // the open session occupies everything from its clock_in up to this moment.
  const startedAt = new Date(Date.now() - 2 * 3600000).toISOString()
  await q(null, 'UPDATE sessions SET clock_in = ? WHERE id = ?', [startedAt, running.id])

  const clash = await call('POST', '/api/sessions', {
    cookie: owner,
    body: {
      client_id: northwind.id,
      clock_in: new Date(Date.now() - 90 * 60000).toISOString(),
      clock_out: new Date(Date.now() - 60 * 60000).toISOString(),
    },
  })
  assert.equal(clash.status, 409)
  const open = clash.json.conflicts.find(c => c.id === running.id)
  assert.ok(open, 'the running session is reported as a conflict')
  assert.equal(open.clock_out, null, 'still running')

  // A window that ends before the timer started is not a conflict.
  const clear = await call('POST', '/api/sessions', {
    cookie: owner,
    body: {
      client_id: northwind.id,
      clock_in: new Date(Date.now() - 5 * 3600000).toISOString(),
      clock_out: new Date(Date.now() - 4 * 3600000).toISOString(),
    },
  })
  assert.equal(clear.status, 200, clear.text)

  await call('POST', `/api/sessions/${running.id}/clock-out`, { cookie: owner, body: { entries: [] } })
})

/* ── The tightened PATCH, which now shares one validator ─────────────── */

test('PATCH now refuses to move a completed session into the future', async () => {
  const s = (await call('POST', '/api/sessions', {
    cookie: owner,
    body: {
      client_id: merc.id,
      clock_in: daysAgo(14, 9).toISOString(),
      clock_out: daysAgo(14, 11).toISOString(),
    },
  })).json

  const future = new Date(Date.now() + 10 * 86400000)
  const r = await call('PATCH', `/api/sessions/${s.id}`, {
    cookie: owner,
    body: {
      clock_in: future.toISOString(),
      clock_out: new Date(future.getTime() + 3600000).toISOString(),
    },
  })
  assert.equal(r.status, 400)
  assert.match(r.json.error, /clock_in can/)

  const unchanged = await q1(null, 'SELECT clock_in FROM sessions WHERE id = ?', [s.id])
  assert.equal(unchanged.clock_in, s.clock_in)
})

test('PATCH still adjusts one end of a session without restating the other', async () => {
  const s = (await call('POST', '/api/sessions', {
    cookie: owner,
    body: {
      client_id: merc.id,
      clock_in: daysAgo(15, 9).toISOString(),
      clock_out: daysAgo(15, 11).toISOString(),
      allow_overlap: true,
    },
  })).json
  assert.equal(s.duration_minutes, 120)

  const r = await call('PATCH', `/api/sessions/${s.id}`, {
    cookie: owner, body: { clock_out: daysAgo(15, 12).toISOString() },
  })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.json.duration_minutes, 180)
  assert.equal(r.json.clock_in, s.clock_in, 'the untouched end stayed put')
  assert.equal(r.json.entry_method, 'manual', 'correcting a session does not relabel it')
})

/* ── 11. Soft delete ─────────────────────────────────────────────────────
   A wrong row is easy to create through manual entry and nothing else could
   remove one: PATCH moves a session's times but never its client_id. Deleting
   hides it from everything that counts hours; the row itself stays, because
   these are the hours an invoice was built from. */

let doomed, completedProject

test('soft delete: a published session vanishes from every surface, and survives', async () => {
  completedProject = (await call('POST', '/api/projects', {
    cookie: owner, body: { client_id: merc.id, name: 'Deletable Work' },
  })).json

  doomed = (await call('POST', '/api/sessions', {
    cookie: owner,
    body: {
      client_id: merc.id,
      clock_in: daysAgo(20, 9).toISOString(),
      clock_out: daysAgo(20, 14).toISOString(),      // 300 minutes
      entries: [{ project_id: completedProject.id, summary: 'DOOMED-SESSION-SENTINEL' }],
      allow_overlap: true,
    },
  })).json
  assert.equal(doomed.duration_minutes, 300)

  await call('PATCH', `/api/access/sessions/${doomed.id}`,
    { cookie: owner, body: { is_published: true } })
  // Complete the project so it shows up in the archive's prorated hours.
  await call('PATCH', `/api/projects/${completedProject.id}`,
    { cookie: owner, body: { status: 'complete' } })

  const ownerSurfaces = async () => ({
    sessions: (await call('GET', '/api/sessions', { cookie: owner })).text,
    archiveMinutes: ((await call('GET', '/api/archive', { cookie: owner })).json
      .find(p => p.id === completedProject.id) || {}).total_minutes,
    detail: (await call('GET', `/api/projects/${completedProject.id}/detail`, { cookie: owner })).text,
  })
  const CLIENT_SURFACES = [
    ['/api/portal/summary', dana.cookie],
    ['/api/portal/sessions?per_page=100', dana.cookie],
    ['/api/portal/breakdown', dana.cookie],
    ['/api/portal/pulse', dana.cookie],
    [`/api/share/${shareToken}/summary`, null],
    [`/api/share/${shareToken}/sessions?per_page=100`, null],
    [`/api/share/${shareToken}/breakdown`, null],
    [`/api/share/${shareToken}/export`, null],
  ]
  const clientSurfaces = async () => {
    const out = {}
    for (const [url, cookie] of CLIENT_SURFACES) {
      const r = await call('GET', url, { cookie })
      assert.equal(r.status, 200, url)
      out[url] = r.text
    }
    return out
  }
  // The breakdown aggregates by project rather than listing summaries, so it
  // carries the session's hours under the project's name instead.
  const breakdownMinutes = async () => {
    const r = await call('GET', '/api/portal/breakdown', { cookie: dana.cookie })
    return (r.json.projects.find(p => p.name === 'Deletable Work') || {}).minutes ?? null
  }

  /* ── Before ── */
  const beforeOwner = await ownerSurfaces()
  const beforeClient = await clientSurfaces()
  assert.ok(beforeOwner.sessions.includes('DOOMED-SESSION-SENTINEL'), 'in the timesheet')
  assert.equal(beforeOwner.archiveMinutes, 300, 'in the archive’s prorated hours')
  assert.ok(beforeOwner.detail.includes('DOOMED-SESSION-SENTINEL'), 'in the project drawer')
  // The session lists and the export quote the summary verbatim, so those are
  // where presence is provable; the rest are checked for absence afterwards.
  for (const url of ['/api/portal/sessions?per_page=100',
                     `/api/share/${shareToken}/sessions?per_page=100`,
                     `/api/share/${shareToken}/export`]) {
    assert.ok(beforeClient[url].includes('DOOMED-SESSION-SENTINEL'), `${url} shows it while published`)
  }
  assert.equal(await breakdownMinutes(), 300, 'and its hours are in the client’s breakdown')
  const pulseBefore = beforeClient['/api/portal/pulse']

  /* ── Delete ── */
  const gone = await call('DELETE', `/api/sessions/${doomed.id}`, { cookie: owner })
  assert.equal(gone.status, 200)
  assert.ok(gone.json.deleted_at, 'the route stamps a time rather than removing the row')

  const afterOwner = await ownerSurfaces()
  const afterClient = await clientSurfaces()
  assert.ok(!afterOwner.sessions.includes('DOOMED-SESSION-SENTINEL'), 'out of the timesheet')
  assert.equal(afterOwner.archiveMinutes, 0, 'its minutes stopped counting toward the project')
  assert.ok(!afterOwner.detail.includes('DOOMED-SESSION-SENTINEL'), 'out of the project drawer')
  for (const [url, text] of Object.entries(afterClient)) {
    if (url.includes('pulse')) continue
    assert.ok(!text.includes('DOOMED-SESSION-SENTINEL'), `${url} still shows a deleted session`)
  }
  assert.equal(await breakdownMinutes(), null, 'its hours left the client’s breakdown')
  assert.notEqual(afterClient['/api/portal/pulse'], pulseBefore,
    'the pulse moves, so a client page polling it refreshes rather than sitting on stale hours')

  /* ── But the row is all still there ── */
  const row = await q1(null, 'SELECT * FROM sessions WHERE id = ?', [doomed.id])
  assert.ok(row, 'the session row survives')
  assert.ok(row.deleted_at)
  assert.equal(row.duration_minutes, 300, 'the hours are not rewritten')
  assert.equal(row.is_published, 1, 'nor is its published state')
  assert.equal(row.entry_method, 'manual')
  const entries = await q(null, 'SELECT * FROM session_entries WHERE session_id = ?', [doomed.id])
  assert.equal(entries.length, 1, 'its entries survive too')
  assert.equal(entries[0].summary, 'DOOMED-SESSION-SENTINEL')
})

test('a deleted session is not there to be edited, closed or published', async () => {
  const patched = await call('PATCH', `/api/sessions/${doomed.id}`, {
    cookie: owner, body: { clock_out: daysAgo(20, 15).toISOString() },
  })
  assert.equal(patched.status, 404)

  const closed = await call('POST', `/api/sessions/${doomed.id}/clock-out`,
    { cookie: owner, body: { entries: [] } })
  assert.equal(closed.status, 404)

  const published = await call('PATCH', `/api/access/sessions/${doomed.id}`,
    { cookie: owner, body: { is_published: true } })
  assert.equal(published.status, 404, 'a deleted session cannot be pushed to a client')

  const row = await q1(null, 'SELECT * FROM sessions WHERE id = ?', [doomed.id])
  assert.equal(row.duration_minutes, 300, 'and none of that touched the row')
})

test('deleted sessions drop out of the counts the owner is shown', async () => {
  const impact = await call('GET', `/api/access/clients/${merc.id}/impact`, { cookie: owner })
  const live = await q1(null,
    'SELECT COUNT(*) AS n FROM sessions WHERE client_id = ? AND deleted_at IS NULL', [merc.id])
  const all = await q1(null, 'SELECT COUNT(*) AS n FROM sessions WHERE client_id = ?', [merc.id])
  assert.equal(impact.json.sessions, Number(live.n))
  assert.ok(Number(all.n) > Number(live.n), 'there is a deleted row it could have counted')

  // A publish sweep over the whole period reports what it actually moved.
  const sweep = await call('POST', '/api/access/publish', {
    cookie: owner,
    body: {
      client_id: merc.id, publish: true,
      from: new Date(Date.now() - 400 * 86400000).toISOString(),
      to: new Date(Date.now() + 86400000).toISOString(),
    },
  })
  const publishable = await q1(null, `SELECT COUNT(*) AS n FROM sessions
    WHERE client_id = ? AND clock_out IS NOT NULL AND deleted_at IS NULL`, [merc.id])
  assert.equal(sweep.json.affected, Number(publishable.n),
    'the number on screen counts only rows it could actually publish')
})

test('a deleted session is not a scheduling conflict', async () => {
  // The doomed session ran 09:00–14:00; that window is free again.
  const r = await call('POST', '/api/sessions', {
    cookie: owner,
    body: {
      client_id: merc.id,
      clock_in: daysAgo(20, 10).toISOString(),
      clock_out: daysAgo(20, 12).toISOString(),
    },
  })
  assert.equal(r.status, 200, r.text)
  await call('DELETE', `/api/sessions/${r.json.id}`, { cookie: owner })
})

test('a deleted open session does not block the next clock-in forever', async () => {
  const stuck = (await call('POST', '/api/clock-in', {
    cookie: owner, body: { client_id: merc.id },
  })).json
  assert.equal((await call('POST', '/api/clock-in',
    { cookie: owner, body: { client_id: merc.id } })).status, 409, 'blocked while it runs')

  await call('DELETE', `/api/sessions/${stuck.id}`, { cookie: owner })
  assert.equal((await call('GET', '/api/active-session', { cookie: owner })).json, null,
    'the Clock screen stops showing it')

  const next = await call('POST', '/api/clock-in', { cookie: owner, body: { client_id: merc.id } })
  assert.equal(next.status, 200, 'and the timer can start again')
  await call('DELETE', `/api/sessions/${next.json.id}`, { cookie: owner })
})

test('restore puts it back exactly as it was', async () => {
  const r = await call('POST', `/api/sessions/${doomed.id}/restore`, { cookie: owner })
  assert.equal(r.status, 200)
  assert.equal(r.json.deleted_at, null)
  assert.equal(r.json.duration_minutes, 300)
  assert.equal(r.json.is_published, 1, 'still published, so it returns to the client view too')

  const sessions = await call('GET', '/api/sessions', { cookie: owner })
  assert.ok(sessions.text.includes('DOOMED-SESSION-SENTINEL'), 'back in the timesheet')

  const archive = (await call('GET', '/api/archive', { cookie: owner })).json
    .find(p => p.id === completedProject.id)
  assert.equal(archive.total_minutes, 300, 'its hours count again')

  const portal = await call('GET', '/api/portal/sessions?per_page=100', { cookie: dana.cookie })
  assert.ok(portal.text.includes('DOOMED-SESSION-SENTINEL'), 'back in the client view')

  // Restoring something that was never deleted is not a way to change it.
  assert.equal((await call('POST', `/api/sessions/${doomed.id}/restore`, { cookie: owner })).status, 404)
})

test('delete and restore are owner-only, and 404 for a client', async () => {
  for (const [method, url] of [
    ['DELETE', `/api/sessions/${doomed.id}`],
    ['POST', `/api/sessions/${doomed.id}/restore`],
  ]) {
    assert.equal((await call(method, url)).status, 401, `${method} anonymous`)
    assert.equal((await call(method, url, { cookie: dana.cookie })).status, 404, `${method} as a client`)
  }
  const row = await q1(null, 'SELECT deleted_at FROM sessions WHERE id = ?', [doomed.id])
  assert.equal(row.deleted_at, null, 'and none of those attempts touched it')
})

test('deleted_at never appears in a client-reachable response', async () => {
  for (const [url, cookie] of [
    ['/api/portal/summary', dana.cookie],
    ['/api/portal/sessions?per_page=100', dana.cookie],
    ['/api/portal/breakdown', dana.cookie],
    [`/api/share/${shareToken}/summary`, null],
    [`/api/share/${shareToken}/sessions?per_page=100`, null],
    [`/api/share/${shareToken}/breakdown`, null],
    [`/api/share/${shareToken}/export`, null],
  ]) {
    const r = await call('GET', url, { cookie })
    assert.equal(r.status, 200, url)
    assert.ok(!r.text.includes('deleted_at'), `${url} leaked deleted_at`)
  }
})
