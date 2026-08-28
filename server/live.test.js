// Clocking out publishes to companies with the portal on, and an open client
// page notices. The signature endpoint is the whole mechanism, so what matters
// is that it moves for every change the client can see and never reports one
// they can't.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.TEMPO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tempo-live-'))
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

let owner, live, quiet, liveProject, dana, shareToken

const clockCycle = async (clientId, projectId) => {
  const started = (await call('POST', '/api/clock-in', {
    cookie: owner, body: { client_id: clientId },
  })).json
  return (await call('POST', `/api/sessions/${started.id}/clock-out`, {
    cookie: owner,
    body: {
      clock_in: new Date(Date.now() - 90 * 60000).toISOString(),
      entries: projectId
        ? [{ project_id: projectId, status: 'in_progress', summary: 'fresh work' }]
        : [],
    },
  })).json
}

test('setup: one company with the portal on, one without', async () => {
  await call('POST', '/api/auth/bootstrap', {
    body: { token: 'bootstrap-secret-for-tests', email: 'chris@example.com', password: 'owner-password-long' },
  })
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ email: 'chris@example.com', password: 'owner-password-long' }),
  })
  owner = res.headers.getSetCookie().map(l => l.split(';')[0]).find(p => p.startsWith('tempo_portal='))

  live = (await call('POST', '/api/clients', {
    cookie: owner, body: { name: 'Mercenary Marketing', color_accent: '#6B93C4', weekly_hours_target: 20 },
  })).json
  quiet = (await call('POST', '/api/clients', {
    cookie: owner, body: { name: 'Northwind Studio', color_accent: '#8FAE7E', weekly_hours_target: 10 },
  })).json
  await q(null, 'UPDATE clients SET portal_enabled = 1, hourly_rate = 145 WHERE id = ?', [live.id])

  liveProject = (await call('POST', '/api/projects', {
    cookie: owner, body: { client_id: live.id, name: 'Q3 Rebrand' },
  })).json

  dana = await q1(null, `
    INSERT INTO portal_users (client_id, email, password_hash, role, name)
    VALUES (?,?,?,?,?) RETURNING *`,
    [live.id, 'dana@merc.example', await hashPassword('dana-portal-password'), 'client', 'Dana'])
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ email: 'dana@merc.example', password: 'dana-portal-password' }),
  })
  dana.cookie = login.headers.getSetCookie().map(l => l.split(';')[0]).find(p => p.startsWith('tempo_portal='))

  shareToken = mintToken()
  await q(null, 'INSERT INTO portal_share_links (client_id, token_hash, label) VALUES (?,?,?)',
    [live.id, hashToken(shareToken), 'Finance'])
})

/* ── Auto-publish ────────────────────────────────────────────────────── */

test('clocking out makes the session visible to a portal-enabled company', async () => {
  const before = await call('GET', '/api/portal/sessions?per_page=100', { cookie: dana.cookie })
  assert.equal(before.json.total, 0)

  const session = await clockCycle(live.id, liveProject.id)
  assert.equal(session.is_published, 1, 'published by the clock-out itself')

  const after = await call('GET', '/api/portal/sessions?per_page=100', { cookie: dana.cookie })
  assert.equal(after.json.total, 1, 'no publish step in between')
  assert.equal(after.json.sessions[0].duration_minutes, 90)
})

test('the rate is snapshotted at clock-out, like any other publish', async () => {
  const s = await q1(null, 'SELECT * FROM sessions WHERE client_id = ? ORDER BY id DESC', [live.id])
  assert.equal(s.rate_applied, 145)

  // And a later rate change leaves it alone, exactly as an explicit publish does.
  await call('PATCH', `/api/access/clients/${live.id}`, { cookie: owner, body: { hourly_rate: 300 } })
  const again = await q1(null, 'SELECT * FROM sessions WHERE id = ?', [s.id])
  assert.equal(again.rate_applied, 145)
  await call('PATCH', `/api/access/clients/${live.id}`, { cookie: owner, body: { hourly_rate: 145 } })
})

test('a company without the portal on is untouched by any of this', async () => {
  const session = await clockCycle(quiet.id, null)
  assert.equal(session.is_published, 0, 'still needs publishing by hand')
  assert.equal(session.rate_applied, null, 'and carries no rate')
})

test('switching the portal off stops new sessions publishing themselves', async () => {
  await q(null, 'UPDATE clients SET portal_enabled = 0 WHERE id = ?', [live.id])
  const session = await clockCycle(live.id, liveProject.id)
  assert.equal(session.is_published, 0)
  await q(null, 'UPDATE clients SET portal_enabled = 1 WHERE id = ?', [live.id])
})

test('an auto-published session can still be taken back', async () => {
  const s = await q1(null,
    'SELECT * FROM sessions WHERE client_id = ? AND is_published = 1 ORDER BY id DESC', [live.id])
  await call('PATCH', `/api/access/sessions/${s.id}`, { cookie: owner, body: { is_published: false } })
  const listed = await call('GET', '/api/portal/sessions?per_page=100', { cookie: dana.cookie })
  assert.ok(!listed.json.sessions.some(x => x.id === s.id), 'unpublish still works after the fact')
  await call('PATCH', `/api/access/sessions/${s.id}`, { cookie: owner, body: { is_published: true } })
})

/* ── The signature ───────────────────────────────────────────────────── */

const sig = async (surface) => (await call('GET', surface)).json.signature
const portalSig = async () =>
  (await call('GET', '/api/portal/pulse', { cookie: dana.cookie })).json.signature

test('the signature moves when a session is clocked out', async () => {
  const before = await portalSig()
  await clockCycle(live.id, liveProject.id)
  assert.notEqual(await portalSig(), before, 'an open page would notice')
})

test('it moves on publish, unpublish, a duration edit and a rate change', async () => {
  const s = await q1(null,
    'SELECT * FROM sessions WHERE client_id = ? AND is_published = 1 ORDER BY id DESC', [live.id])

  let before = await portalSig()
  await call('PATCH', `/api/access/sessions/${s.id}`, { cookie: owner, body: { is_published: false } })
  assert.notEqual(await portalSig(), before, 'unpublish')

  before = await portalSig()
  await call('PATCH', `/api/access/sessions/${s.id}`, { cookie: owner, body: { is_published: true } })
  assert.notEqual(await portalSig(), before, 'republish')

  before = await portalSig()
  await q(null, 'UPDATE sessions SET duration_minutes = duration_minutes + 5 WHERE id = ?', [s.id])
  assert.notEqual(await portalSig(), before, 'a corrected duration')

  before = await portalSig()
  await q(null, 'UPDATE sessions SET rate_applied = 999 WHERE id = ?', [s.id])
  assert.notEqual(await portalSig(), before, 'a repriced session')
})

test('it does not move for work the client cannot see', async () => {
  const before = await portalSig()
  await clockCycle(quiet.id, null)                     // another company entirely
  assert.equal(await portalSig(), before, 'another company changes nothing')

  await q1(null, `
    INSERT INTO sessions (client_id, clock_in, clock_out, duration_minutes, is_published)
    VALUES (?,?,?,?,0) RETURNING *`,
    [live.id, new Date().toISOString(), new Date().toISOString(), 60])
  assert.equal(await portalSig(), before, 'an unpublished session of their own changes nothing')
})

test('the share surface has the same signature, and the same scope', async () => {
  const viaPortal = await portalSig()
  const viaShare = await sig(`/api/share/${shareToken}/pulse`)
  assert.equal(viaShare, viaPortal, 'one query layer, one answer')

  // And it cannot be steered any more than the rest of the surface can.
  const spoof = await sig(`/api/share/${shareToken}/pulse?client_id=${quiet.id}`)
  assert.equal(spoof, viaShare)
})

test('pulse is owner-proof, anonymous-proof and dead-link-proof', async () => {
  assert.equal((await call('GET', '/api/portal/pulse')).status, 401)
  assert.equal((await call('GET', '/api/portal/pulse', { cookie: owner })).status, 404)
  assert.equal((await call('GET', `/api/share/${'z'.repeat(43)}/pulse`)).status, 404)
})

test('the signature carries no data, only a fingerprint of it', async () => {
  const r = await call('GET', '/api/portal/pulse', { cookie: dana.cookie })
  assert.deepEqual(Object.keys(r.json), ['signature'])
  assert.match(r.json.signature, /^\d+:\d+:\d+:\d+$/)
  assert.ok(!r.text.includes('fresh work'), 'no summaries')
  assert.ok(!r.text.includes('clock_in'))
})
