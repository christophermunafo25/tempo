// Money. Rates are snapshotted when a session is published so that a later
// rate change never silently reprices work a client has already budgeted
// against, and amounts are rounded once at the row so the screen, the export
// and an invoice line item agree to the penny.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.TEMPO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tempo-rates-'))
process.env.PORTAL_BOOTSTRAP_TOKEN = 'bootstrap-secret-for-tests'
process.env.TEMPO_TZ = 'America/Chicago'
delete process.env.DATABASE_URL
delete process.env.VERCEL

const { default: app, ready } = await import('./app.js')
const { q, q1, closeDb } = await import('./db.js')
const { hashPassword, mintToken, hashToken } = await import('./auth.js')
const { amountCents } = await import('./portal-query.js')

await ready
const server = app.listen(0)
await new Promise((r) => server.once('listening', r))
const base = `http://127.0.0.1:${server.address().port}`
after(async () => {
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
  await closeDb()
})

async function call(method, url, { body, cookie } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'Content-Type': 'application/json', Origin: base,
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

let owner, client, project, dana, shareToken

const mkSession = async (minutes, daysAgo) => {
  const start = new Date(Date.now() - daysAgo * 86400000)
  const s = await q1(null, `
    INSERT INTO sessions (client_id, clock_in, clock_out, duration_minutes)
    VALUES (?,?,?,?) RETURNING *`,
    [client.id, start.toISOString(),
     new Date(start.getTime() + minutes * 60000).toISOString(), minutes])
  await q(null, `INSERT INTO session_entries (session_id, project_id, summary, status_at_entry)
    VALUES (?,?,?,?)`, [s.id, project.id, 'work', 'in_progress'])
  return s
}

test('setup', async () => {
  await call('POST', '/api/auth/bootstrap', {
    body: { token: 'bootstrap-secret-for-tests', email: 'chris@example.com', password: 'owner-password-long' },
  })
  owner = await login('chris@example.com', 'owner-password-long')

  client = (await call('POST', '/api/clients', {
    cookie: owner, body: { name: 'Mercenary Marketing', color_accent: '#6B93C4', weekly_hours_target: 20 },
  })).json
  await q(null, 'UPDATE clients SET portal_enabled = 1 WHERE id = ?', [client.id])
  project = await q1(null,
    'INSERT INTO projects (client_id, name) VALUES (?,?) RETURNING *', [client.id, 'Q3 Rebrand'])

  dana = await q1(null, `
    INSERT INTO portal_users (client_id, email, password_hash, role, name)
    VALUES (?,?,?,?,?) RETURNING *`,
    [client.id, 'dana@merc.example', await hashPassword('dana-portal-password'), 'client', 'Dana'])
  dana.cookie = await login('dana@merc.example', 'dana-portal-password')

  shareToken = mintToken()
  await q(null, 'INSERT INTO portal_share_links (client_id, token_hash, label) VALUES (?,?,?)',
    [client.id, hashToken(shareToken), 'Finance'])
})

/* ── 11. The toggle actually gates ───────────────────────────────────── */

test('with portal_shows_rates off, no money field appears anywhere', async () => {
  await call('PATCH', `/api/access/clients/${client.id}`,
    { cookie: owner, body: { hourly_rate: 150 } })
  await mkSession(120, 2)
  await call('POST', '/api/access/publish', {
    cookie: owner,
    body: {
      client_id: client.id, publish: true,
      from: new Date(Date.now() - 30 * 86400000).toISOString(),
      to: new Date(Date.now() + 86400000).toISOString(),
    },
  })

  const surfaces = [
    ['GET', `/api/portal/summary`, dana.cookie],
    ['GET', `/api/portal/sessions?per_page=100`, dana.cookie],
    ['GET', `/api/portal/breakdown`, dana.cookie],
    ['GET', `/api/share/${shareToken}/summary`, null],
    ['GET', `/api/share/${shareToken}/sessions?per_page=100`, null],
    ['GET', `/api/share/${shareToken}/breakdown`, null],
    ['GET', `/api/share/${shareToken}/export`, null],
  ]
  for (const [method, url, cookie] of surfaces) {
    const r = await call(method, url, { cookie })
    assert.equal(r.status, 200, url)
    for (const field of ['amount_cents', 'rate', 'hourly_rate', 'rate_applied']) {
      assert.ok(!r.text.includes(field), `${url} leaked ${field} with rates switched off`)
    }
  }
  const post = await call('POST', '/api/portal/export', { cookie: dana.cookie, body: {} })
  assert.ok(!post.text.includes('amount_cents'))
})

test('rates on but no rate set still shows nothing', async () => {
  await call('PATCH', `/api/access/clients/${client.id}`,
    { cookie: owner, body: { portal_shows_rates: true, hourly_rate: 0 } })
  const r = await call('GET', '/api/portal/sessions?per_page=100', { cookie: dana.cookie })
  assert.ok(!r.text.includes('amount_cents'), 'a zero rate has nothing to report')
  await call('PATCH', `/api/access/clients/${client.id}`,
    { cookie: owner, body: { hourly_rate: 150 } })
})

/* ── 12. Rounding once, at the row ───────────────────────────────────── */

test('the sum of row amounts equals the reported total, exactly', async () => {
  // Durations chosen so that hours × rate lands on fractions of a cent, and
  // enough of them that accumulating float error would show.
  const awkward = [7, 13, 23, 41, 53, 67, 83, 97, 101, 113, 127, 149]
  for (let i = 0; i < 60; i++) await mkSession(awkward[i % awkward.length], 3 + i)

  await call('PATCH', `/api/access/clients/${client.id}`,
    { cookie: owner, body: { hourly_rate: 137.77, portal_shows_rates: true } })
  await call('POST', '/api/access/publish', {
    cookie: owner,
    body: {
      client_id: client.id, publish: true,
      from: new Date(Date.now() - 400 * 86400000).toISOString(),
      to: new Date(Date.now() + 86400000).toISOString(),
    },
  })

  const list = await call('GET', '/api/portal/sessions?per_page=100', { cookie: dana.cookie })
  assert.ok(list.json.total > 50, 'enough rows for float error to accumulate')

  const rowSum = list.json.sessions.reduce((a, s) => a + (s.amount_cents || 0), 0)
  const expected = list.json.sessions
    .reduce((a, s) => a + amountCents(s.duration_minutes, s.rate), 0)
  assert.equal(rowSum, expected, 'each row rounds independently')

  // And the same array through the share surface agrees to the penny.
  const shared = await call('GET', `/api/share/${shareToken}/sessions?per_page=100`)
  assert.equal(
    shared.json.sessions.reduce((a, s) => a + (s.amount_cents || 0), 0), rowSum,
    'both front doors report the same money')

  const breakdown = await call('GET', '/api/portal/breakdown', { cookie: dana.cookie })
  const breakdownSum = breakdown.json.projects.reduce((a, p) => a + (p.amount_cents || 0), 0)
  const everything = await call('POST', '/api/portal/export', { cookie: dana.cookie, body: {} })
  const totalCents = everything.json.sessions.reduce((a, s) => a + (s.amount_cents || 0), 0)
  assert.equal(breakdownSum, totalCents,
    'the by-project breakdown adds up to the total above it, to the cent')
})

test('amounts are integers of cents, never floats', async () => {
  const r = await call('GET', '/api/portal/sessions?per_page=100', { cookie: dana.cookie })
  for (const s of r.json.sessions) {
    if (s.amount_cents == null) continue
    assert.ok(Number.isInteger(s.amount_cents), `${s.amount_cents} is not an integer`)
  }
})

/* ── 13. A published number does not move ────────────────────────────── */

test('changing the hourly rate does not reprice already-published work', async () => {
  const before = await call('GET', '/api/portal/sessions?per_page=100', { cookie: dana.cookie })
  const beforeTotal = before.json.sessions.reduce((a, s) => a + (s.amount_cents || 0), 0)

  await call('PATCH', `/api/access/clients/${client.id}`,
    { cookie: owner, body: { hourly_rate: 500 } })

  const after = await call('GET', '/api/portal/sessions?per_page=100', { cookie: dana.cookie })
  assert.equal(after.json.sessions.reduce((a, s) => a + (s.amount_cents || 0), 0), beforeTotal,
    'a client budgeting against these numbers sees them hold still')
  // Not every row is 137.77 — one was published earlier at 150 — but none of
  // them moved to the new rate, which is the property that matters.
  assert.ok(after.json.sessions.every(s => s.rate !== 500))
})

test('unpublishing and republishing does not reprice either', async () => {
  const one = await q1(null,
    'SELECT * FROM sessions WHERE client_id = ? AND rate_applied IS NOT NULL', [client.id])
  const originalRate = one.rate_applied

  await call('PATCH', `/api/access/sessions/${one.id}`,
    { cookie: owner, body: { is_published: false } })
  const unpublished = await q1(null, 'SELECT * FROM sessions WHERE id = ?', [one.id])
  assert.equal(unpublished.rate_applied, originalRate, 'unpublishing leaves the snapshot alone')

  await call('PATCH', `/api/access/sessions/${one.id}`,
    { cookie: owner, body: { is_published: true } })
  const republished = await q1(null, 'SELECT * FROM sessions WHERE id = ?', [one.id])
  assert.equal(republished.rate_applied, originalRate,
    'and republishing at a new rate does not quietly change what was already shown')
})

test('newly published work takes the current rate', async () => {
  await mkSession(60, 1)
  await call('POST', '/api/access/publish', {
    cookie: owner,
    body: {
      client_id: client.id, publish: true,
      from: new Date(Date.now() - 2 * 86400000).toISOString(),
      to: new Date(Date.now() + 86400000).toISOString(),
    },
  })
  const fresh = await q1(null,
    'SELECT * FROM sessions WHERE client_id = ? ORDER BY id DESC', [client.id])
  assert.equal(fresh.rate_applied, 500, 'the rate in force when it was published')
})

/* ── 14. Null is not zero ────────────────────────────────────────────── */

test('a session with no rate reports a null amount, not zero', async () => {
  const orphan = await mkSession(90, 200)
  await q(null, 'UPDATE sessions SET is_published = 1, rate_applied = NULL WHERE id = ?',
    [orphan.id])

  const r = await call('GET', '/api/portal/sessions?per_page=100', { cookie: dana.cookie })
  const row = r.json.sessions.find(s => s.id === orphan.id)
  assert.ok(row, 'the session is visible')
  assert.equal(row.amount_cents, null, 'blank, not zero — zero is a claim')
  assert.equal(row.rate, null)
  assert.notEqual(row.amount_cents, 0)
})

/* ── The explicit backfill ───────────────────────────────────────────── */

test('the impact preview counts what would change', async () => {
  const r = await call('GET', `/api/access/clients/${client.id}/rate-impact`, { cookie: owner })
  assert.equal(r.status, 200)
  assert.equal(r.json.hourly_rate, 500)
  assert.ok(r.json.unpriced >= 1, 'the unpriced session is counted')
  assert.ok(r.json.priced > 50)
})

test('applying a rate fills the gaps without touching what is already priced', async () => {
  const before = await q(null,
    'SELECT id, rate_applied FROM sessions WHERE client_id = ? AND rate_applied IS NOT NULL',
    [client.id])

  const r = await call('POST', `/api/access/clients/${client.id}/apply-rate`, { cookie: owner })
  assert.equal(r.status, 200)
  assert.equal(r.json.mode, 'missing')
  assert.ok(r.json.affected >= 1)

  const still = await q1(null,
    'SELECT COUNT(*) AS n FROM sessions WHERE client_id = ? AND is_published = 1 AND rate_applied IS NULL',
    [client.id])
  assert.equal(Number(still.n), 0, 'nothing published is left unpriced')

  for (const row of before) {
    const now = await q1(null, 'SELECT rate_applied FROM sessions WHERE id = ?', [row.id])
    assert.equal(now.rate_applied, row.rate_applied, 'already-priced work is untouched')
  }
})

test('mode "all" reprices everything, and only when asked', async () => {
  const r = await call('POST', `/api/access/clients/${client.id}/apply-rate`,
    { cookie: owner, body: { mode: 'all' } })
  assert.equal(r.json.mode, 'all')

  const rates = await q(null,
    'SELECT DISTINCT rate_applied FROM sessions WHERE client_id = ? AND is_published = 1',
    [client.id])
  assert.deepEqual(rates.map(x => x.rate_applied), [500])
})

test('applying a rate with none set is refused', async () => {
  await call('PATCH', `/api/access/clients/${client.id}`,
    { cookie: owner, body: { hourly_rate: 0 } })
  const r = await call('POST', `/api/access/clients/${client.id}/apply-rate`, { cookie: owner })
  assert.equal(r.status, 400)
  await call('PATCH', `/api/access/clients/${client.id}`,
    { cookie: owner, body: { hourly_rate: 500 } })
})

test('a nonsense rate is refused and the row is untouched', async () => {
  // NaN and Infinity cannot survive JSON — they arrive as null, which is why
  // null is refused explicitly rather than read as zero.
  for (const hourly_rate of [-1, 'lots', 1e9, null]) {
    const r = await call('PATCH', `/api/access/clients/${client.id}`,
      { cookie: owner, body: { hourly_rate } })
    assert.equal(r.status, 400, String(hourly_rate))
  }
  assert.equal((await q1(null, 'SELECT * FROM clients WHERE id = ?', [client.id])).hourly_rate, 500)
})

/* ── Rates are owner-only, and expenses stay out of reach ────────────── */

test('rate management is unreachable by a client or a share link', async () => {
  const attempts = [
    ['PATCH', `/api/access/clients/${client.id}`],
    ['POST', `/api/access/clients/${client.id}/apply-rate`],
    ['GET', `/api/access/clients/${client.id}/rate-impact`],
  ]
  for (const [method, url] of attempts) {
    const body = method === 'GET' ? undefined : { hourly_rate: 1 }
    assert.equal((await call(method, url, { cookie: dana.cookie, body })).status,
      404, `${method} ${url} for a client`)
    assert.equal((await call(method, url, { body })).status,
      401, `${method} ${url} anonymous`)
  }
  assert.equal((await q1(null, 'SELECT * FROM clients WHERE id = ?', [client.id])).hourly_rate, 500)
})

test('no money path ever touches expenses', async () => {
  await call('POST', '/api/expenses', {
    cookie: owner, body: { name: 'PERSONAL-OVERHEAD-SENTINEL', cadence: 'monthly', amount: 59.99 },
  })
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
    assert.ok(!r.text.includes('PERSONAL-OVERHEAD-SENTINEL'), `${url} leaked overhead`)
    assert.ok(!r.text.includes('59.99'), `${url} leaked an expense amount`)
  }
})
