// Step 4: the write surface. This is the only part of the portal that can
// corrupt data rather than merely expose it, so these tests are about what a
// client's writes cannot reach or change.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.TEMPO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tempo-write-'))
process.env.PORTAL_BOOTSTRAP_TOKEN = 'bootstrap-secret-for-tests'
process.env.TEMPO_TZ = 'America/Chicago'
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

const SECRET_QUESTION = 'INTERNAL-QUESTION-DO-NOT-LEAK'
let owner, dana, mercenary, northwind, mercProject, nwProject

test('setup', async () => {
  await call('POST', '/api/auth/bootstrap', {
    body: { token: 'bootstrap-secret-for-tests', email: 'chris@example.com', password: 'owner-password-long', name: 'Chris' },
  })
  owner = await login('chris@example.com', 'owner-password-long')

  mercenary = (await call('POST', '/api/clients', {
    cookie: owner, body: { name: 'Mercenary Marketing', color_accent: '#6B93C4', weekly_hours_target: 20 },
  })).json
  northwind = (await call('POST', '/api/clients', {
    cookie: owner, body: { name: 'Northwind Studio', color_accent: '#8FAE7E', weekly_hours_target: 10 },
  })).json

  mercProject = await q1(null, `
    INSERT INTO projects (client_id, name, description, status, question_text)
    VALUES (?,?,?,?,?) RETURNING *`,
    [mercenary.id, 'Q3 Rebrand', 'Original brief', 'questions', SECRET_QUESTION])
  nwProject = await q1(null, `
    INSERT INTO projects (client_id, name, status, completed_at)
    VALUES (?,?,?,?) RETURNING *`,
    [northwind.id, 'Northwind Secret', 'in_progress', null])

  dana = await q1(null, `
    INSERT INTO portal_users (client_id, email, password_hash, role, name)
    VALUES (?,?,?,?,?) RETURNING *`,
    [mercenary.id, 'dana@mercenary.example', await hashPassword('dana-portal-password'), 'client', 'Dana'])
  dana.cookie = await login('dana@mercenary.example', 'dana-portal-password')
  assert.ok(dana.cookie)
})

/* ── The allowlist ───────────────────────────────────────────────────── */

test('a PATCH carrying forbidden fields changes none of them', async () => {
  const before = await q1(null, 'SELECT * FROM projects WHERE id = ?', [mercProject.id])

  const r = await call('PATCH', `/api/portal/projects/${mercProject.id}`, {
    cookie: dana.cookie,
    body: {
      name: 'Renamed by the client',
      description: 'Updated brief',
      status: 'complete',
      question_text: 'rewritten by the client',
      client_id: northwind.id,
      portal_request: 'pending',
      completed_at: '2020-01-01T00:00:00.000Z',
      requested_by: 999,
      id: 4242,
    },
  })
  assert.equal(r.status, 200)

  const after = await q1(null, 'SELECT * FROM projects WHERE id = ?', [mercProject.id])
  assert.equal(after.name, 'Renamed by the client', 'the two writable fields did change')
  assert.equal(after.description, 'Updated brief')
  assert.equal(after.status, before.status, 'status untouched')
  assert.equal(after.question_text, SECRET_QUESTION, 'question_text untouched')
  assert.equal(after.client_id, before.client_id, 'company untouched')
  assert.equal(after.portal_request, before.portal_request, 'request state untouched')
  assert.equal(after.completed_at, before.completed_at, 'completed_at untouched')
  assert.equal(after.id, before.id)
})

test('case-variant and duplicate keys cannot smuggle a field through', async () => {
  const before = await q1(null, 'SELECT * FROM projects WHERE id = ?', [mercProject.id])
  const raw = JSON.stringify({
    name: 'Still fine', Status: 'complete', STATUS: 'complete',
    'question_text ': 'x', client_id: northwind.id, client_id_: northwind.id,
  })
  const res = await fetch(`${base}/api/portal/projects/${mercProject.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Origin: base, Cookie: dana.cookie },
    body: raw,
  })
  assert.equal(res.status, 200)

  const after = await q1(null, 'SELECT * FROM projects WHERE id = ?', [mercProject.id])
  assert.equal(after.status, before.status)
  assert.equal(after.question_text, SECRET_QUESTION)
  assert.equal(after.client_id, before.client_id)
})

test('a write response never carries question_text', async () => {
  const r = await call('PATCH', `/api/portal/projects/${mercProject.id}`,
    { cookie: dana.cookie, body: { name: 'Q3 Rebrand' } })
  assert.ok(!r.text.includes(SECRET_QUESTION), 'value')
  assert.ok(!r.text.includes('question_text'), 'field name')

  const detail = await call('GET', `/api/portal/projects/${mercProject.id}`, { cookie: dana.cookie })
  assert.ok(!detail.text.includes(SECRET_QUESTION))
  assert.ok(!detail.text.includes('question_text'))
  assert.equal(detail.json.status, 'in_progress', 'questions is still mapped away on the detail view')
})

/* ── Cross-company writes ────────────────────────────────────────────── */

test("writing to another company's project is 404 and changes nothing", async () => {
  const before = await q1(null, 'SELECT * FROM projects WHERE id = ?', [nwProject.id])

  const writes = [
    ['PATCH', `/api/portal/projects/${nwProject.id}`, { name: 'hijacked', description: 'hijacked' }],
    ['POST', `/api/portal/projects/${nwProject.id}/comments`, { body: 'hello from the wrong company' }],
    ['POST', `/api/portal/projects/${nwProject.id}/links`, { label: 'x', url: 'https://example.com' }],
    ['POST', `/api/portal/projects/${nwProject.id}/read`, {}],
  ]
  for (const [method, url, body] of writes) {
    const r = await call(method, url, { cookie: dana.cookie, body })
    assert.equal(r.status, 404, `${method} ${url}`)
    assert.equal(r.json.error, 'not found', 'a foreign id is indistinguishable from a missing one')
  }

  const after = await q1(null, 'SELECT * FROM projects WHERE id = ?', [nwProject.id])
  assert.deepEqual(after, before, 'the target row is byte-identical afterwards')

  const comments = await q(null, 'SELECT * FROM project_comments WHERE project_id = ?', [nwProject.id])
  assert.equal(comments.length, 0, 'and no comment was attached to it')
  const links = await q(null, 'SELECT * FROM asset_links WHERE project_id = ?', [nwProject.id])
  assert.equal(links.length, 0)
})

test('a client cannot create a project for another company', async () => {
  const r = await call('POST', '/api/portal/projects', {
    cookie: dana.cookie,
    body: { name: 'Planted', client_id: northwind.id, description: 'nope' },
  })
  assert.equal(r.status, 200)
  const created = await q1(null, 'SELECT * FROM projects WHERE name = ?', ['Planted'])
  assert.equal(created.client_id, mercenary.id, 'scope comes from the session, not the body')
  assert.equal(created.portal_request, 'pending')
  assert.equal(created.requested_by, dana.id)
})

/* ── Requests stay out of the owner's workflow ───────────────────────── */

test('a client-created project is invisible to the owner until accepted', async () => {
  const created = await q1(null, 'SELECT * FROM projects WHERE name = ?', ['Planted'])
  const ids = (rows) => rows.map(r => r.id)

  for (const url of ['/api/projects', '/api/board']) {
    const r = await call('GET', url, { cookie: owner })
    assert.ok(!ids(r.json).includes(created.id), url)
  }
  const tray = await call('GET', '/api/access/requests', { cookie: owner })
  assert.ok(ids(tray.json).includes(created.id), 'it is in the requests tray instead')

  await call('POST', `/api/access/requests/${created.id}/accept`, { cookie: owner })
  const board = await call('GET', '/api/board', { cookie: owner })
  assert.ok(ids(board.json).includes(created.id), 'and on the board once accepted')
})

/* ── Comments ────────────────────────────────────────────────────────── */

test('a client can post a comment and the owner sees it', async () => {
  const r = await call('POST', `/api/portal/projects/${mercProject.id}/comments`,
    { cookie: dana.cookie, body: { body: 'Can we see the lockup on a dark background?' } })
  assert.equal(r.status, 200)
  assert.equal(r.json.length, 1)
  assert.equal(r.json[0].author_name, 'Dana')
  assert.equal(r.json[0].author_role, 'client')

  const threads = await call('GET', '/api/access/threads', { cookie: owner })
  const thread = threads.json.find(t => t.id === mercProject.id)
  assert.ok(thread)
  assert.equal(thread.unread_count, 1, 'the owner has one unread')
})

test('comments carry no email addresses across the boundary', async () => {
  await call('POST', `/api/access/projects/${mercProject.id}/comments`,
    { cookie: owner, body: { body: 'Here it is on dark.' } })
  const r = await call('GET', `/api/portal/projects/${mercProject.id}`, { cookie: dana.cookie })
  assert.ok(!r.text.includes('chris@example.com'), "the owner's address is not in a client response")
  assert.ok(!r.text.includes('@'), 'no addresses at all')
  assert.equal(r.json.comments.length, 2)
  assert.equal(r.json.comments[1].author_role, 'owner')
})

test('unread clears on read and does not count your own comments', async () => {
  const before = await call('GET', '/api/portal/projects', { cookie: dana.cookie })
  const proj = before.json.find(p => p.id === mercProject.id)
  assert.equal(proj.unread_count, 1, "the owner's reply is unread")
  assert.equal(proj.comment_count, 2)

  await call('POST', `/api/portal/projects/${mercProject.id}/read`, { cookie: dana.cookie })
  const after = await call('GET', '/api/portal/projects', { cookie: dana.cookie })
  assert.equal(after.json.find(p => p.id === mercProject.id).unread_count, 0)

  await call('POST', `/api/portal/projects/${mercProject.id}/comments`,
    { cookie: dana.cookie, body: { body: 'Perfect, thanks.' } })
  const own = await call('GET', '/api/portal/projects', { cookie: dana.cookie })
  assert.equal(own.json.find(p => p.id === mercProject.id).unread_count, 0,
    'your own comment is never unread to you')
})

test('a client has no route to edit or delete a comment', async () => {
  const comment = await q1(null, 'SELECT * FROM project_comments WHERE project_id = ?', [mercProject.id])
  const attempts = [
    ['PATCH', `/api/portal/projects/${mercProject.id}/comments/${comment.id}`, { body: 'rewritten' }],
    ['DELETE', `/api/portal/projects/${mercProject.id}/comments/${comment.id}`, undefined],
    ['PATCH', `/api/portal/comments/${comment.id}`, { body: 'rewritten' }],
    ['DELETE', `/api/portal/comments/${comment.id}`, undefined],
  ]
  for (const [method, url, body] of attempts) {
    const r = await call(method, url, { cookie: dana.cookie, body })
    assert.ok(r.status === 404 || r.status === 405, `${method} ${url} answered ${r.status}`)
  }
  const after = await q1(null, 'SELECT * FROM project_comments WHERE id = ?', [comment.id])
  assert.equal(after.body, comment.body, 'the comment is unchanged')
  assert.equal(after.deleted_at, null)
})

/* ── Links and subtasks ──────────────────────────────────────────────── */

test('a client can add a link but cannot delete one', async () => {
  const added = await call('POST', `/api/portal/projects/${mercProject.id}/links`, {
    cookie: dana.cookie, body: { label: 'Brand deck', url: 'https://example.com/deck.pdf' },
  })
  assert.equal(added.status, 200)

  const bad = await call('POST', `/api/portal/projects/${mercProject.id}/links`, {
    cookie: dana.cookie, body: { label: 'Bad', url: 'not a url' },
  })
  assert.equal(bad.status, 400)

  for (const url of [`/api/portal/links/${added.json.id}`,
    `/api/portal/projects/${mercProject.id}/links/${added.json.id}`]) {
    const r = await call('DELETE', url, { cookie: dana.cookie })
    assert.ok(r.status === 404 || r.status === 405)
  }
  assert.ok(await q1(null, 'SELECT * FROM asset_links WHERE id = ?', [added.json.id]))
})

test('subtasks are visible but not writable by a client', async () => {
  const st = await q1(null,
    'INSERT INTO subtasks (project_id, title, is_done) VALUES (?,?,?) RETURNING *',
    [mercProject.id, 'Internal task breakdown', 0])

  const detail = await call('GET', `/api/portal/projects/${mercProject.id}`, { cookie: dana.cookie })
  assert.equal(detail.json.subtasks.length, 1)
  assert.equal(detail.json.subtasks[0].is_done, 0)

  const r = await call('PATCH', `/api/subtasks/${st.id}`, { cookie: dana.cookie, body: { is_done: 1 } })
  assert.equal(r.status, 404, 'the owner route is not reachable by a client')
  const after = await q1(null, 'SELECT * FROM subtasks WHERE id = ?', [st.id])
  assert.equal(after.is_done, 0, "the board's own counts stay out of a client's hands")
})

/* ── History ─────────────────────────────────────────────────────────── */

test('every client write leaves an audit row', async () => {
  const actions = (await q(null, 'SELECT DISTINCT action FROM portal_audit')).map(r => r.action)
  for (const expected of ['request_created', 'project_edited', 'comment', 'link_added']) {
    assert.ok(actions.includes(expected), `missing ${expected}; saw ${actions.join(', ')}`)
  }
})

test('a project edit records the old value, not just the new one', async () => {
  const target = await q1(null,
    'INSERT INTO projects (client_id, name, description) VALUES (?,?,?) RETURNING *',
    [mercenary.id, 'Before Name', 'Before description'])

  await call('PATCH', `/api/portal/projects/${target.id}`,
    { cookie: dana.cookie, body: { name: 'After Name', description: 'After description' } })

  const revisions = await q(null,
    'SELECT * FROM project_revisions WHERE project_id = ? ORDER BY id', [target.id])
  assert.equal(revisions.length, 2)
  const byField = Object.fromEntries(revisions.map(r => [r.field, r]))
  assert.equal(byField.name.old_value, 'Before Name')
  assert.equal(byField.name.new_value, 'After Name')
  assert.equal(byField.description.old_value, 'Before description')
  assert.equal(byField.portal_user_id ?? byField.name.portal_user_id, dana.id)
})

test('an unchanged field writes no revision', async () => {
  const target = await q1(null,
    'INSERT INTO projects (client_id, name, description) VALUES (?,?,?) RETURNING *',
    [mercenary.id, 'Same', 'Same description'])
  await call('PATCH', `/api/portal/projects/${target.id}`,
    { cookie: dana.cookie, body: { name: 'Same', description: 'Same description' } })
  const revisions = await q(null, 'SELECT * FROM project_revisions WHERE project_id = ?', [target.id])
  assert.equal(revisions.length, 0)
})

/* ── Validation and throttling ───────────────────────────────────────── */

test('oversized and empty input is refused', async () => {
  const long = 'x'.repeat(6000)
  const cases = [
    ['POST', `/api/portal/projects/${mercProject.id}/comments`, { body: '   ' }],
    ['POST', `/api/portal/projects/${mercProject.id}/comments`, { body: long }],
    ['PATCH', `/api/portal/projects/${mercProject.id}`, { name: '' }],
    ['PATCH', `/api/portal/projects/${mercProject.id}`, { name: long }],
    ['PATCH', `/api/portal/projects/${mercProject.id}`, { description: long }],
    ['POST', '/api/portal/projects', { name: '' }],
  ]
  for (const [method, url, body] of cases) {
    const r = await call(method, url, { cookie: dana.cookie, body })
    assert.equal(r.status, 400, `${method} ${url} ${JSON.stringify(body).slice(0, 40)}`)
  }
})

test('a revoked client cannot post a comment', async () => {
  await q(null, 'UPDATE portal_users SET is_active = 0 WHERE id = ?', [dana.id])
  const before = await q(null, 'SELECT COUNT(*) AS n FROM project_comments')

  const r = await call('POST', `/api/portal/projects/${mercProject.id}/comments`,
    { cookie: dana.cookie, body: { body: 'should never land' } })
  assert.equal(r.status, 401)

  const after = await q(null, 'SELECT COUNT(*) AS n FROM project_comments')
  assert.equal(Number(after[0].n), Number(before[0].n), 'nothing was written')
  await q(null, 'UPDATE portal_users SET is_active = 1 WHERE id = ?', [dana.id])
})

test('client writes are rate limited', async () => {
  dana.cookie = await login('dana@mercenary.example', 'dana-portal-password')
  let limited = false
  for (let i = 0; i < 70; i++) {
    const r = await call('POST', `/api/portal/projects/${mercProject.id}/comments`,
      { cookie: dana.cookie, body: { body: `flood ${i}` } })
    if (r.status === 429) { limited = true; break }
  }
  assert.ok(limited, 'a flood of writes must eventually be refused')
})
