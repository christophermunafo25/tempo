// The share boundary. A share link is a bearer credential, so these tests are
// about what holding one does NOT get you: anything unpublished, anything
// belonging to another company, anything internal, and anything at all outside
// /api/share.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.TEMPO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tempo-share-'))
process.env.PORTAL_BOOTSTRAP_TOKEN = 'bootstrap-secret-for-tests'
process.env.TEMPO_TZ = 'America/Chicago'
delete process.env.DATABASE_URL
delete process.env.VERCEL

const { default: app, ready } = await import('./app.js')
const { q, q1, closeDb } = await import('./db.js')
const { hashToken, mintToken } = await import('./auth.js')

await ready
const server = app.listen(0)
await new Promise((r) => server.once('listening', r))
const base = `http://127.0.0.1:${server.address().port}`
after(async () => {
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
  await closeDb()
})

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
  return { status: res.status, json, text, headers: res.headers }
}

const SECRET_QUESTION = 'INTERNAL-QUESTION-DO-NOT-LEAK'
let owner, merc, north, mercProject, northProject, token, linkId

async function mintLink(clientId, extra = {}) {
  const t = mintToken()
  const row = await q1(null, `
    INSERT INTO portal_share_links (client_id, token_hash, label, shows_notes, expires_at)
    VALUES (?,?,?,?,?) RETURNING *`,
    [clientId, hashToken(t), extra.label || '', extra.shows_notes === 0 ? 0 : 1,
     extra.expires_at ?? null])
  return { token: t, id: row.id }
}

const session = async (clientId, projectId, minutes, published, summary) => {
  const start = new Date(Date.now() - 2 * 86400000)
  const s = await q1(null, `
    INSERT INTO sessions (client_id, clock_in, clock_out, duration_minutes, is_published)
    VALUES (?,?,?,?,?) RETURNING *`,
    [clientId, start.toISOString(), new Date(start.getTime() + minutes * 60000).toISOString(),
     minutes, published ? 1 : 0])
  await q(null, `INSERT INTO session_entries (session_id, project_id, summary, status_at_entry)
    VALUES (?,?,?,?)`, [s.id, projectId, summary, 'in_progress'])
  return s
}

test('setup', async () => {
  await call('POST', '/api/auth/bootstrap', {
    body: { token: 'bootstrap-secret-for-tests', email: 'chris@example.com', password: 'owner-password-long' },
  })
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ email: 'chris@example.com', password: 'owner-password-long' }),
  })
  owner = res.headers.getSetCookie().map(l => l.split(';')[0]).find(p => p.startsWith('tempo_portal='))

  merc = (await call('POST', '/api/clients', {
    cookie: owner, body: { name: 'Mercenary Marketing', color_accent: '#6B93C4', weekly_hours_target: 20 },
  })).json
  north = (await call('POST', '/api/clients', {
    cookie: owner, body: { name: 'Northwind Studio', color_accent: '#8FAE7E', weekly_hours_target: 10 },
  })).json
  await q(null, 'UPDATE clients SET portal_enabled = 1')

  mercProject = await q1(null,
    'INSERT INTO projects (client_id, name) VALUES (?,?) RETURNING *', [merc.id, 'Q3 Rebrand'])
  northProject = await q1(null,
    'INSERT INTO projects (client_id, name) VALUES (?,?) RETURNING *', [north.id, 'Northwind Secret'])
  await q(null, "UPDATE projects SET status = 'questions', question_text = ? WHERE id = ?",
    [SECRET_QUESTION, mercProject.id])

  await session(merc.id, mercProject.id, 120, true, 'published work')
  await session(merc.id, mercProject.id, 480, false, 'SECRET-UNPUBLISHED-WORK')
  await session(north.id, northProject.id, 300, true, 'northwind confidential')

  const link = await mintLink(merc.id, { label: 'Finance team' })
  token = link.token
  linkId = link.id
})

/* ── 1. A share token buys nothing outside /api/share ────────────────── */

test('holding a share token grants nothing outside /api/share', async () => {
  // The token lives in the path, so anywhere else the caller is simply
  // anonymous — and an anonymous caller gets 401, which is the existing
  // asserted behaviour of the gate's default arm.
  for (const url of ['/api/clients', '/api/expenses', '/api/board', '/api/sessions',
    '/api/portal/summary', '/api/access/clients']) {
    const plain = await call('GET', url)
    assert.equal(plain.status, 401, url)

    // And no position a token could be smuggled into changes that.
    const smuggled = await Promise.all([
      call('GET', `${url}?token=${token}`),
      call('GET', `${url}?share_token=${token}`),
      call('GET', url, { headers: { 'X-Share-Token': token } }),
      call('GET', url, { cookie: `tempo_portal=${token}` }),
    ])
    for (const r of smuggled) {
      assert.equal(r.status, 401, `${url} accepted a share token out of place`)
      assert.ok(!r.text.includes('Mercenary'), `${url} leaked data`)
    }
  }
})

test('the share surface is read-only', async () => {
  for (const method of ['POST', 'PATCH', 'DELETE', 'PUT']) {
    const r = await call(method, `/api/share/${token}/sessions`, { body: {} })
    assert.equal(r.status, 404, `${method} should not exist here`)
  }
})

/* ── 2, 3. Publication and company scope ─────────────────────────────── */

test('a share response contains zero unpublished sessions', async () => {
  const r = await call('GET', `/api/share/${token}/sessions?per_page=100`)
  assert.equal(r.status, 200)
  assert.equal(r.json.total, 1)
  assert.ok(!r.text.includes('SECRET-UNPUBLISHED-WORK'))
  assert.equal(r.json.sessions[0].duration_minutes, 120)

  const summary = await call('GET', `/api/share/${token}/summary`)
  assert.equal(summary.json.month.minutes, 120, 'unpublished time is out of the totals too')

  const b = await call('GET', `/api/share/${token}/breakdown`)
  assert.equal(Math.round(b.json.projects.reduce((a, p) => a + p.minutes, 0)), 120)
})

test('a share response contains zero rows belonging to another company', async () => {
  for (const p of ['/summary', '/sessions?per_page=100', '/projects', '/breakdown', '/export']) {
    const r = await call('GET', `/api/share/${token}${p}`)
    assert.equal(r.status, 200, p)
    assert.ok(!r.text.includes('Northwind'), `${p} leaked another company`)
    assert.ok(!r.text.includes('northwind confidential'), `${p} leaked another company's notes`)
  }
  const projects = await call('GET', `/api/share/${token}/projects`)
  assert.deepEqual(projects.json.map(x => x.name), ['Q3 Rebrand'])
})

/* ── 4. Scope cannot be steered from the request ─────────────────────── */

test('a client_id in any position changes nothing', async () => {
  const plain = await call('GET', `/api/share/${token}/sessions?per_page=100`)
  const spoofs = [
    `/api/share/${token}/sessions?per_page=100&client_id=${north.id}`,
    `/api/share/${token}/sessions?per_page=100&clientId=${north.id}`,
    `/api/share/${token}/sessions?per_page=100&scope=${north.id}`,
  ]
  for (const url of spoofs) {
    const r = await call('GET', url)
    assert.equal(r.text, plain.text, `${url} produced a different response`)
  }
  const header = await call('GET', `/api/share/${token}/sessions?per_page=100`,
    { headers: { 'X-Client-Id': String(north.id) } })
  assert.equal(header.text, plain.text)
})

test("another company's project id answers 404, not 403", async () => {
  const r = await call('GET', `/api/share/${token}/sessions?project_id=${northProject.id}`)
  assert.equal(r.status, 404)
  assert.equal(r.json.error, 'not found')
  const b = await call('GET', `/api/share/${token}/breakdown?project_id=${northProject.id}`)
  assert.equal(b.status, 404)
})

/* ── 5, 6, 7, 8. Link lifecycle ──────────────────────────────────────── */

test('an unknown token and a revoked token are indistinguishable', async () => {
  const dead = await mintLink(merc.id)
  await q(null, 'UPDATE portal_share_links SET revoked_at = ? WHERE id = ?',
    [new Date().toISOString(), dead.id])

  const revoked = await call('GET', `/api/share/${dead.token}/sessions`)
  const unknown = await call('GET', `/api/share/${'z'.repeat(43)}/sessions`)

  assert.equal(revoked.status, 404)
  assert.equal(unknown.status, 404)
  assert.equal(revoked.text, unknown.text, 'a prober cannot tell a real token from a dead one')
})

test('a revoked token fails on the very next request', async () => {
  const live = await mintLink(merc.id)
  assert.equal((await call('GET', `/api/share/${live.token}/sessions`)).status, 200)

  await q(null, 'UPDATE portal_share_links SET revoked_at = ? WHERE id = ?',
    [new Date().toISOString(), live.id])
  assert.equal((await call('GET', `/api/share/${live.token}/sessions`)).status, 404)
})

test('an expired token fails', async () => {
  const expired = await mintLink(merc.id, {
    expires_at: new Date(Date.now() - 1000).toISOString(),
  })
  assert.equal((await call('GET', `/api/share/${expired.token}/sessions`)).status, 404)

  const future = await mintLink(merc.id, {
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  })
  assert.equal((await call('GET', `/api/share/${future.token}/sessions`)).status, 200)
})

test('a link for a company with the portal switched off answers 404', async () => {
  await q(null, 'UPDATE clients SET portal_enabled = 0 WHERE id = ?', [merc.id])
  assert.equal((await call('GET', `/api/share/${token}/sessions`)).status, 404)
  await q(null, 'UPDATE clients SET portal_enabled = 1 WHERE id = ?', [merc.id])
  assert.equal((await call('GET', `/api/share/${token}/sessions`)).status, 200)
})

test('a link for an archived company answers 404', async () => {
  await q(null, 'UPDATE clients SET is_active = 0 WHERE id = ?', [merc.id])
  assert.equal((await call('GET', `/api/share/${token}/sessions`)).status, 404)
  await q(null, 'UPDATE clients SET is_active = 1 WHERE id = ?', [merc.id])
})

/* ── 9, 10. Internal fields never cross ──────────────────────────────── */

test('no share response contains the question_text sentinel', async () => {
  for (const p of ['/summary', '/sessions?per_page=100', '/projects', '/breakdown', '/export']) {
    const r = await call('GET', `/api/share/${token}${p}`)
    assert.ok(!r.text.includes(SECRET_QUESTION), `${p} leaked question_text`)
    assert.ok(!r.text.includes('question_text'), `${p} leaked the field name`)
  }
})

test('no share response contains clock times, emails or internal status fields', async () => {
  for (const p of ['/summary', '/sessions?per_page=100', '/projects', '/breakdown', '/export']) {
    const r = await call('GET', `/api/share/${token}${p}`)
    assert.ok(!r.text.includes('clock_in'), `${p} clock_in`)
    assert.ok(!r.text.includes('clock_out'), `${p} clock_out`)
    assert.ok(!r.text.includes('@'), `${p} contained an address`)
    assert.ok(!r.text.includes('status_at_entry'), `${p} status_at_entry`)
    assert.ok(!r.text.includes('status_events'), `${p} status_events`)
  }
  const sessions = await call('GET', `/api/share/${token}/sessions?per_page=100`)
  for (const s of sessions.json.sessions) {
    assert.match(s.date, /^\d{4}-\d{2}-\d{2}$/, 'a calendar date, not a timestamp')
  }
})

test('a project parked in Questions reports as In Progress', async () => {
  const r = await call('GET', `/api/share/${token}/projects`)
  assert.equal(r.json.find(p => p.name === 'Q3 Rebrand').status, 'in_progress')
})

/* ── Notes toggle, headers, audit, throttling ────────────────────────── */

test('a no-notes link keeps project names but drops the summaries', async () => {
  const quiet = await mintLink(merc.id, { shows_notes: 0 })
  const r = await call('GET', `/api/share/${quiet.token}/sessions?per_page=100`)
  assert.equal(r.status, 200)
  assert.ok(!r.text.includes('published work'), 'summaries withheld')
  assert.equal(r.json.sessions[0].projects[0].name, 'Q3 Rebrand', 'project names kept')
  assert.equal(r.json.sessions[0].projects[0].summary, undefined)

  const loud = await call('GET', `/api/share/${token}/sessions?per_page=100`)
  assert.ok(loud.text.includes('published work'), 'the default link still shows them')
})

test('every share response carries the no-index, no-referrer, no-store headers', async () => {
  const r = await call('GET', `/api/share/${token}/summary`)
  assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow')
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(r.headers.get('cache-control'), 'no-store')

  const missing = await call('GET', `/api/share/${'q'.repeat(43)}/summary`)
  assert.equal(missing.headers.get('x-robots-tag'), 'noindex, nofollow',
    'a 404 is still not indexable')
})

test('an export through a share link is audited', async () => {
  await call('GET', `/api/share/${token}/export`)
  const rows = await q(null,
    "SELECT * FROM portal_audit WHERE action = 'export' ORDER BY id DESC")
  assert.ok(rows.length > 0)
  assert.equal(rows[0].client_id, merc.id)
  assert.match(rows[0].detail, /share link "Finance team"/)
  assert.equal(rows[0].portal_user_id, null, 'a share link has no author to attribute')
})

test('failed lookups are throttled per IP, and the throttle caps its own writes', async () => {
  const { LIMITS } = await import('./auth.js')
  const attempts = LIMITS.shareIp.limit * 3

  for (let i = 0; i < attempts; i++) {
    const r = await call('GET', `/api/share/${String(i).padStart(43, 'z')}/sessions`)
    // Over the ceiling the answer is still 404, so a prober cannot even learn
    // that they tripped a limiter.
    assert.equal(r.status, 404, 'a refused lookup never says why')
  }

  const { n } = await q1(null,
    "SELECT COUNT(*) AS n FROM portal_rate_events WHERE bucket LIKE 'share:ip:%'")
  assert.equal(Number(n), LIMITS.shareIp.limit,
    'the bucket stops at the ceiling: a flood costs at most `limit` writes, then only COUNTs')

  // And a real token is refused too while the ceiling holds, which is the
  // point — guessing locks the guesser out, not just the guesses.
  assert.equal((await call('GET', `/api/share/${token}/sessions`)).status, 404)
  await q(null, "DELETE FROM portal_rate_events WHERE bucket LIKE 'share:ip:%'")
  assert.equal((await call('GET', `/api/share/${token}/sessions`)).status, 200,
    'and it recovers once the window clears')
})

test('view stats count viewing sessions, not requests', async () => {
  const before = await q1(null, 'SELECT * FROM portal_share_links WHERE id = ?', [linkId])
  for (let i = 0; i < 5; i++) await call('GET', `/api/share/${token}/summary`)
  const after = await q1(null, 'SELECT * FROM portal_share_links WHERE id = ?', [linkId])
  assert.equal(after.view_count, before.view_count,
    'a burst inside the window is one view, not five writes')
  assert.ok(after.last_viewed_at, 'and the first one did record a timestamp')
})

/* ── Owner management ────────────────────────────────────────────────────
   Minting, labelling, renewing, revoking and rotating from /access. */

test('the owner mints a link and sees the URL exactly once', async () => {
  const r = await call('POST', '/api/access/share-links', {
    cookie: owner, body: { client_id: merc.id, label: 'Finance team', expires_in_days: 90 },
  })
  assert.equal(r.status, 200)
  assert.match(r.json.url_path, /^\/s\/[A-Za-z0-9_-]{20,}$/)
  assert.ok(r.json.link.expires_at, 'the 90-day default landed')

  const fresh = r.json.url_path.split('/s/')[1]
  assert.equal((await call('GET', `/api/share/${fresh}/sessions`)).status, 200)

  // Only the hash is stored, so nothing can hand the URL back.
  const listing = await call('GET', '/api/access/clients', { cookie: owner })
  const company = listing.json.find(c => c.id === merc.id)
  const row = company.share_links.find(l => l.label === 'Finance team')
  assert.ok(row, 'the link is listed')
  assert.ok(!listing.text.includes(fresh), 'the token never appears in the listing')
  assert.equal(row.token_hash, undefined, 'not even the hash is sent to the browser')
  assert.equal(row.state, 'active')
})

test('creating the first link switches the portal on for that company', async () => {
  await q(null, 'UPDATE clients SET portal_enabled = 0 WHERE id = ?', [north.id])
  const r = await call('POST', '/api/access/share-links',
    { cookie: owner, body: { client_id: north.id, label: 'Ops' } })
  assert.equal(r.status, 200)
  const c = await q1(null, 'SELECT * FROM clients WHERE id = ?', [north.id])
  assert.equal(c.portal_enabled, 1, 'a link that 404s for no visible reason is worse')

  const t = r.json.url_path.split('/s/')[1]
  const scoped = await call('GET', `/api/share/${t}/projects`)
  assert.deepEqual(scoped.json.map(p => p.name), ['Northwind Secret'],
    "and it is scoped to its own company, not the one that came first")
})

test('an unlabelled link and a never-expiring link are both allowed', async () => {
  const r = await call('POST', '/api/access/share-links',
    { cookie: owner, body: { client_id: merc.id, expires_in_days: null } })
  assert.equal(r.status, 200)
  assert.equal(r.json.link.expires_at, null)
  assert.equal(r.json.link.label, '')
})

test('a nonsense expiry is refused', async () => {
  for (const days of [0, -5, 99999, 'soon']) {
    const r = await call('POST', '/api/access/share-links',
      { cookie: owner, body: { client_id: merc.id, expires_in_days: days } })
    assert.equal(r.status, 400, String(days))
  }
})

test('revoking kills the URL on the next request and keeps the row', async () => {
  const made = await call('POST', '/api/access/share-links',
    { cookie: owner, body: { client_id: merc.id, label: 'Temp' } })
  const t = made.json.url_path.split('/s/')[1]
  assert.equal((await call('GET', `/api/share/${t}/summary`)).status, 200)

  const revoked = await call('POST', `/api/access/share-links/${made.json.link.id}/revoke`,
    { cookie: owner })
  assert.equal(revoked.status, 200)
  assert.equal((await call('GET', `/api/share/${t}/summary`)).status, 404)

  const row = await q1(null, 'SELECT * FROM portal_share_links WHERE id = ?', [made.json.link.id])
  assert.ok(row, 'the row is kept for the trail')
  assert.ok(row.revoked_at)
})

test('rotating issues a new URL and kills the old one', async () => {
  const made = await call('POST', '/api/access/share-links',
    { cookie: owner, body: { client_id: merc.id, label: 'Dana', shows_notes: false } })
  const oldToken = made.json.url_path.split('/s/')[1]
  assert.equal((await call('GET', `/api/share/${oldToken}/summary`)).status, 200)

  const rotated = await call('POST', `/api/access/share-links/${made.json.link.id}/rotate`,
    { cookie: owner })
  assert.equal(rotated.status, 200)
  const newToken = rotated.json.url_path.split('/s/')[1]
  assert.notEqual(newToken, oldToken)

  assert.equal((await call('GET', `/api/share/${oldToken}/summary`)).status, 404, 'old URL dead')
  assert.equal((await call('GET', `/api/share/${newToken}/summary`)).status, 200, 'new URL live')

  // Settings carry over, and the old row survives so the leak is traceable.
  assert.equal(rotated.json.link.label, 'Dana')
  assert.equal(rotated.json.link.shows_notes, 0, 'the no-notes choice is preserved')
  const old = await q1(null, 'SELECT * FROM portal_share_links WHERE id = ?', [made.json.link.id])
  assert.ok(old.revoked_at, 'rotation revokes rather than overwrites')
})

test('an expired link can be renewed', async () => {
  const made = await call('POST', '/api/access/share-links',
    { cookie: owner, body: { client_id: merc.id, label: 'Lapsed' } })
  const t = made.json.url_path.split('/s/')[1]
  await q(null, 'UPDATE portal_share_links SET expires_at = ? WHERE id = ?',
    [new Date(Date.now() - 1000).toISOString(), made.json.link.id])
  assert.equal((await call('GET', `/api/share/${t}/summary`)).status, 404)

  const renewed = await call('PATCH', `/api/access/share-links/${made.json.link.id}`,
    { cookie: owner, body: { expires_in_days: 90 } })
  assert.equal(renewed.status, 200)
  assert.equal((await call('GET', `/api/share/${t}/summary`)).status, 200,
    'the same URL works again — renewing is not rotating')
})

test('the notes setting can be changed on a live link', async () => {
  const made = await call('POST', '/api/access/share-links',
    { cookie: owner, body: { client_id: merc.id, label: 'Quiet' } })
  const t = made.json.url_path.split('/s/')[1]
  assert.ok((await call('GET', `/api/share/${t}/sessions?per_page=100`)).text.includes('published work'))

  await call('PATCH', `/api/access/share-links/${made.json.link.id}`,
    { cookie: owner, body: { shows_notes: false } })
  const after = await call('GET', `/api/share/${t}/sessions?per_page=100`)
  assert.ok(!after.text.includes('published work'), 'notes withheld from the same URL')
})

test('share link management is owner-only', async () => {
  const anon = [
    ['POST', '/api/access/share-links'],
    ['PATCH', '/api/access/share-links/1'],
    ['POST', '/api/access/share-links/1/revoke'],
    ['POST', '/api/access/share-links/1/rotate'],
  ]
  for (const [method, url] of anon) {
    assert.equal((await call(method, url, { body: {} })).status, 401, `${method} ${url}`)
  }
  // And a share link cannot mint itself more links.
  for (const [method, url] of anon) {
    const r = await call(method, `${url}?token=${token}`, { body: { client_id: merc.id } })
    assert.equal(r.status, 401, `${method} ${url} accepted a share token`)
  }
})

test('every share link action is audited', async () => {
  const actions = (await q(null, 'SELECT DISTINCT action FROM portal_audit')).map(a => a.action)
  for (const expected of ['share_link_created', 'share_link_revoked',
    'share_link_rotated', 'share_link_renewed']) {
    assert.ok(actions.includes(expected), `missing ${expected}`)
  }
})
