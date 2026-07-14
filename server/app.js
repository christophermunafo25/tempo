import express from 'express'
import { createClient } from '@libsql/client'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ON_VERCEL = !!process.env.VERCEL

/* ── Database ────────────────────────────────────────────────────────────
   Local (default): a SQLite file at ./data/tempo.db, same as always.
   Vercel: Turso via TURSO_DATABASE_URL + TURSO_AUTH_TOKEN — serverless has
   no persistent disk, so a hosted database is required there.            */

let db = null
let dbError = null
if (process.env.TURSO_DATABASE_URL) {
  db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  })
} else if (!ON_VERCEL) {
  const DATA_DIR = path.join(__dirname, '..', 'data')
  fs.mkdirSync(DATA_DIR, { recursive: true })
  db = createClient({ url: `file:${path.join(DATA_DIR, 'tempo.db')}` })
} else {
  dbError = 'No database configured. Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in the Vercel project settings — see README.'
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color_accent TEXT NOT NULL,
  weekly_hours_target REAL NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_queue'
    CHECK (status IN ('in_queue','on_deck','in_progress','questions','sent_for_review','complete')),
  question_text TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS subtasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  is_done INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS asset_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  clock_in TEXT NOT NULL,
  clock_out TEXT,
  duration_minutes REAL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS session_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  project_id INTEGER NOT NULL REFERENCES projects(id),
  summary TEXT NOT NULL DEFAULT '',
  status_at_entry TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS status_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  status TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'session',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`

export const ready = db ? db.executeMultiple(SCHEMA) : Promise.resolve()

/* ── Query helpers (work on the client or an open transaction) ─────────── */

const toObjs = (res) =>
  res.rows.map(row => Object.fromEntries(res.columns.map((c, i) => [c, row[i]])))
const q = async (conn, sql, args = []) => toObjs(await conn.execute({ sql, args }))
const q1 = async (conn, sql, args = []) => (await q(conn, sql, args))[0]
const run = async (conn, sql, args = []) => {
  const res = await conn.execute({ sql, args })
  return { lastId: res.lastInsertRowid != null ? Number(res.lastInsertRowid) : undefined }
}

const nowISO = () => new Date().toISOString()
const STATUSES = ['in_queue', 'on_deck', 'in_progress', 'questions', 'sent_for_review', 'complete']

function httpError(code, message) {
  const e = new Error(message)
  e.status = code
  return e
}

async function logStatus(conn, projectId, status, source) {
  await run(conn, 'INSERT INTO status_events (project_id, status, source) VALUES (?,?,?)',
    [projectId, status, source])
}

async function applyStatus(conn, project, status, questionText, source) {
  if (!STATUSES.includes(status)) throw httpError(400, `invalid status: ${status}`)
  if (status === 'questions' && !(questionText || '').trim()) {
    throw httpError(400, 'question_text is required when status is questions')
  }
  const completedAt = status === 'complete' ? (project.completed_at || nowISO()) : null
  await run(conn, 'UPDATE projects SET status = ?, question_text = ?, completed_at = ? WHERE id = ?',
    [status, status === 'questions' ? questionText.trim() : null, completedAt, project.id])
  if (project.status !== status) await logStatus(conn, project.id, status, source)
}

async function withExtras(conn, project) {
  return {
    ...project,
    subtasks: await q(conn, 'SELECT * FROM subtasks WHERE project_id = ? ORDER BY sort_order, id', [project.id]),
    asset_links: await q(conn, 'SELECT * FROM asset_links WHERE project_id = ? ORDER BY id', [project.id]),
  }
}

/* ── App ────────────────────────────────────────────────────────────────── */

const app = express()
app.use(express.json())

// Express 4 doesn't catch async errors — every handler goes through this.
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

app.use('/api', (req, res, next) => {
  if (dbError) return res.status(503).json({ error: dbError })
  next()
})

/* ── Clients ─────────────────────────────────────────────────────────── */

app.get('/api/clients', h(async (req, res) => {
  res.json(await q(db, 'SELECT * FROM clients WHERE is_active = 1 ORDER BY name'))
}))

app.post('/api/clients', h(async (req, res) => {
  const { name, color_accent, weekly_hours_target } = req.body
  if (!(name || '').trim()) throw httpError(400, 'name is required')
  const { lastId } = await run(db,
    'INSERT INTO clients (name, color_accent, weekly_hours_target) VALUES (?,?,?)',
    [name.trim(), color_accent || '#6B93C4', Number(weekly_hours_target) || 0])
  res.json(await q1(db, 'SELECT * FROM clients WHERE id = ?', [lastId]))
}))

app.patch('/api/clients/:id', h(async (req, res) => {
  const client = await q1(db, 'SELECT * FROM clients WHERE id = ?', [req.params.id])
  if (!client) throw httpError(404, 'client not found')
  const next = { ...client, ...req.body }
  await run(db, 'UPDATE clients SET name=?, color_accent=?, weekly_hours_target=?, is_active=? WHERE id=?',
    [next.name, next.color_accent, Number(next.weekly_hours_target) || 0, next.is_active ? 1 : 0, client.id])
  res.json(await q1(db, 'SELECT * FROM clients WHERE id = ?', [client.id]))
}))

/* ── Projects ────────────────────────────────────────────────────────── */

app.get('/api/projects', h(async (req, res) => {
  const { client_id, include_complete } = req.query
  let sql = 'SELECT * FROM projects WHERE 1=1'
  const args = []
  if (client_id) { sql += ' AND client_id = ?'; args.push(client_id) }
  if (!include_complete) sql += " AND status != 'complete'"
  sql += ' ORDER BY name'
  const projects = await q(db, sql, args)
  res.json(await Promise.all(projects.map(p => withExtras(db, p))))
}))

app.post('/api/projects', h(async (req, res) => {
  const { client_id, name } = req.body
  if (!client_id || !(name || '').trim()) throw httpError(400, 'client_id and name are required')
  const { lastId } = await run(db, 'INSERT INTO projects (client_id, name) VALUES (?,?)',
    [client_id, name.trim()])
  await logStatus(db, lastId, 'in_queue', 'created')
  res.json(await withExtras(db, await q1(db, 'SELECT * FROM projects WHERE id = ?', [lastId])))
}))

app.patch('/api/projects/:id', h(async (req, res) => {
  const project = await q1(db, 'SELECT * FROM projects WHERE id = ?', [req.params.id])
  if (!project) throw httpError(404, 'project not found')
  const tx = await db.transaction('write')
  try {
    if (req.body.status) {
      await applyStatus(tx, project, req.body.status, req.body.question_text, req.body.source || 'board')
    }
    if (req.body.name) {
      await run(tx, 'UPDATE projects SET name = ? WHERE id = ?', [req.body.name.trim(), project.id])
    }
    await tx.commit()
  } finally {
    tx.close()
  }
  res.json(await withExtras(db, await q1(db, 'SELECT * FROM projects WHERE id = ?', [project.id])))
}))

app.get('/api/projects/:id/detail', h(async (req, res) => {
  const project = await q1(db, `
    SELECT p.*, c.name AS client_name, c.color_accent FROM projects p
    JOIN clients c ON c.id = p.client_id WHERE p.id = ?`, [req.params.id])
  if (!project) throw httpError(404, 'project not found')
  const entries = await q(db, `
    SELECT e.*, s.clock_in, s.clock_out, s.duration_minutes FROM session_entries e
    JOIN sessions s ON s.id = e.session_id
    WHERE e.project_id = ? ORDER BY s.clock_in DESC`, [project.id])
  const statusEvents = await q(db,
    'SELECT * FROM status_events WHERE project_id = ? ORDER BY created_at DESC, id DESC', [project.id])
  res.json({ ...(await withExtras(db, project)), entries, status_events: statusEvents })
}))

/* ── Subtasks ────────────────────────────────────────────────────────── */

app.post('/api/projects/:id/subtasks', h(async (req, res) => {
  const { title } = req.body
  if (!(title || '').trim()) throw httpError(400, 'title is required')
  const max = (await q1(db,
    'SELECT COALESCE(MAX(sort_order), -1) AS m FROM subtasks WHERE project_id = ?',
    [req.params.id])).m
  const { lastId } = await run(db,
    'INSERT INTO subtasks (project_id, title, sort_order) VALUES (?,?,?)',
    [req.params.id, title.trim(), max + 1])
  res.json(await q1(db, 'SELECT * FROM subtasks WHERE id = ?', [lastId]))
}))

app.patch('/api/subtasks/:id', h(async (req, res) => {
  const st = await q1(db, 'SELECT * FROM subtasks WHERE id = ?', [req.params.id])
  if (!st) throw httpError(404, 'subtask not found')
  const next = { ...st, ...req.body }
  await run(db, 'UPDATE subtasks SET title=?, is_done=?, sort_order=? WHERE id=?',
    [next.title, next.is_done ? 1 : 0, next.sort_order, st.id])
  res.json(await q1(db, 'SELECT * FROM subtasks WHERE id = ?', [st.id]))
}))

app.post('/api/projects/:id/subtasks/reorder', h(async (req, res) => {
  const { ids } = req.body
  await db.batch(ids.map((id, i) => ({
    sql: 'UPDATE subtasks SET sort_order = ? WHERE id = ? AND project_id = ?',
    args: [i, id, req.params.id],
  })), 'write')
  res.json(await q(db, 'SELECT * FROM subtasks WHERE project_id = ? ORDER BY sort_order, id', [req.params.id]))
}))

app.delete('/api/subtasks/:id', h(async (req, res) => {
  await run(db, 'DELETE FROM subtasks WHERE id = ?', [req.params.id])
  res.json({ ok: true })
}))

/* ── Asset links ─────────────────────────────────────────────────────── */

app.post('/api/projects/:id/links', h(async (req, res) => {
  const { label, url } = req.body
  try { new URL(url) } catch { throw httpError(400, 'url is not well formed') }
  if (!(label || '').trim()) throw httpError(400, 'label is required')
  const { lastId } = await run(db,
    'INSERT INTO asset_links (project_id, label, url) VALUES (?,?,?)',
    [req.params.id, label.trim(), url])
  res.json(await q1(db, 'SELECT * FROM asset_links WHERE id = ?', [lastId]))
}))

app.delete('/api/links/:id', h(async (req, res) => {
  await run(db, 'DELETE FROM asset_links WHERE id = ?', [req.params.id])
  res.json({ ok: true })
}))

/* ── Sessions / clock ────────────────────────────────────────────────── */

app.get('/api/active-session', h(async (req, res) => {
  const s = await q1(db, `
    SELECT s.*, c.name AS client_name, c.color_accent FROM sessions s
    JOIN clients c ON c.id = s.client_id
    WHERE s.clock_out IS NULL ORDER BY s.clock_in DESC LIMIT 1`)
  res.json(s || null)
}))

app.post('/api/clock-in', h(async (req, res) => {
  const { client_id } = req.body
  if (!client_id) throw httpError(400, 'client_id is required')
  const active = await q1(db, 'SELECT id FROM sessions WHERE clock_out IS NULL')
  if (active) throw httpError(409, 'a session is already running')
  const { lastId } = await run(db, 'INSERT INTO sessions (client_id, clock_in) VALUES (?,?)',
    [client_id, nowISO()])
  res.json(await q1(db, 'SELECT * FROM sessions WHERE id = ?', [lastId]))
}))

// Prefill for the clock-out review panel: entries from this client's most
// recent completed session, carried forward with each project's live state.
app.get('/api/prefill', h(async (req, res) => {
  const { client_id } = req.query
  // Most recent session that logged entries — an untagged quick session in
  // between shouldn't blank out the carried-forward state.
  const last = await q1(db, `
    SELECT s.id FROM sessions s
    WHERE s.client_id = ? AND s.clock_out IS NOT NULL
      AND EXISTS (SELECT 1 FROM session_entries e WHERE e.session_id = s.id)
    ORDER BY s.clock_in DESC LIMIT 1`, [client_id])
  if (!last) return res.json([])
  const entries = await q(db, `
    SELECT e.project_id, e.summary FROM session_entries e
    JOIN projects p ON p.id = e.project_id
    WHERE e.session_id = ? AND p.status != 'complete'
    ORDER BY e.id`, [last.id])
  res.json(await Promise.all(entries.map(async (e) => {
    const project = await q1(db, 'SELECT * FROM projects WHERE id = ?', [e.project_id])
    return { project: await withExtras(db, project), last_summary: e.summary }
  })))
}))

app.post('/api/sessions/:id/clock-out', h(async (req, res) => {
  const session = await q1(db, 'SELECT * FROM sessions WHERE id = ?', [req.params.id])
  if (!session) throw httpError(404, 'session not found')
  if (session.clock_out) throw httpError(409, 'session is already clocked out')
  const { clock_out, entries = [] } = req.body
  let out = clock_out ? new Date(clock_out) : new Date()
  const inn = new Date(session.clock_in)
  if (isNaN(out.getTime())) throw httpError(400, 'clock_out is not a valid time')
  if (out <= inn) {
    // Editable clock-out has minute precision; a same-minute clock-out can
    // truncate to just before clock_in. Treat it as an immediate clock-out.
    if (inn - out < 60000) out = new Date(inn.getTime() + 1000)
    else throw httpError(400, 'clock_out must be after clock_in')
  }

  const tx = await db.transaction('write')
  try {
    const duration = Math.round(((out - inn) / 60000) * 100) / 100
    await run(tx, 'UPDATE sessions SET clock_out = ?, duration_minutes = ? WHERE id = ?',
      [out.toISOString(), duration, session.id])
    for (const entry of entries) {
      const project = await q1(tx, 'SELECT * FROM projects WHERE id = ?', [entry.project_id])
      if (!project) throw httpError(400, `project ${entry.project_id} not found`)
      await applyStatus(tx, project, entry.status, entry.question_text, 'session')
      await run(tx, `INSERT INTO session_entries (session_id, project_id, summary, status_at_entry)
        VALUES (?,?,?,?)`, [session.id, project.id, (entry.summary || '').trim(), entry.status])
    }
    await tx.commit()
  } finally {
    tx.close()
  }
  res.json(await q1(db, 'SELECT * FROM sessions WHERE id = ?', [session.id]))
}))

// Completed sessions with their entries, optionally bounded and filtered.
app.get('/api/sessions', h(async (req, res) => {
  const { from, to, client_id } = req.query
  let sql = `
    SELECT s.*, c.name AS client_name, c.color_accent FROM sessions s
    JOIN clients c ON c.id = s.client_id
    WHERE s.clock_out IS NOT NULL`
  const args = []
  if (from) { sql += ' AND s.clock_in >= ?'; args.push(from) }
  if (to) { sql += ' AND s.clock_in < ?'; args.push(to) }
  if (client_id) { sql += ' AND s.client_id = ?'; args.push(client_id) }
  sql += ' ORDER BY s.clock_in DESC'
  const sessions = await q(db, sql, args)
  res.json(await Promise.all(sessions.map(async (s) => ({
    ...s,
    entries: await q(db, `
      SELECT e.*, p.name AS project_name FROM session_entries e
      JOIN projects p ON p.id = e.project_id
      WHERE e.session_id = ? ORDER BY e.id`, [s.id]),
  }))))
}))

/* ── Board ───────────────────────────────────────────────────────────── */

app.get('/api/board', h(async (req, res) => {
  const { client_id } = req.query
  const cutoff = new Date(Date.now() - 14 * 86400000).toISOString()
  let sql = `
    SELECT p.*, c.name AS client_name, c.color_accent FROM projects p
    JOIN clients c ON c.id = p.client_id
    WHERE (p.status != 'complete' OR p.completed_at >= ?)`
  const args = [cutoff]
  if (client_id) { sql += ' AND p.client_id = ?'; args.push(client_id) }
  sql += ' ORDER BY p.created_at'
  const projects = await q(db, sql, args)
  res.json(await Promise.all(projects.map(async (p) => {
    const last = await q1(db, `
      SELECT e.summary FROM session_entries e
      JOIN sessions s ON s.id = e.session_id
      WHERE e.project_id = ? AND e.summary != ''
      ORDER BY s.clock_in DESC LIMIT 1`, [p.id])
    const counts = await q1(db,
      'SELECT COUNT(*) AS total, SUM(is_done) AS done FROM subtasks WHERE project_id = ?', [p.id])
    return {
      ...(await withExtras(db, p)),
      last_summary: last?.summary || '',
      subtask_total: counts.total,
      subtask_done: counts.done || 0,
    }
  })))
}))

/* ── Archive (completed projects w/ prorated hours) ──────────────────── */

app.get('/api/archive', h(async (req, res) => {
  const { client_id } = req.query
  let sql = `
    SELECT p.*, c.name AS client_name, c.color_accent FROM projects p
    JOIN clients c ON c.id = p.client_id
    WHERE p.status = 'complete'`
  const args = []
  if (client_id) { sql += ' AND p.client_id = ?'; args.push(client_id) }
  sql += ' ORDER BY p.completed_at DESC'
  const projects = await q(db, sql, args)
  // Prorate each session's duration evenly across its entries.
  const shares = await q(db, `
    SELECT e.project_id,
           SUM(s.duration_minutes / cnt.n) AS minutes
    FROM session_entries e
    JOIN sessions s ON s.id = e.session_id
    JOIN (SELECT session_id, COUNT(*) AS n FROM session_entries GROUP BY session_id) cnt
      ON cnt.session_id = e.session_id
    GROUP BY e.project_id`)
  const shareMap = Object.fromEntries(shares.map(r => [r.project_id, r.minutes]))
  res.json(await Promise.all(projects.map(async (p) => ({
    ...p,
    total_minutes: Math.round((shareMap[p.id] || 0) * 100) / 100,
    trail: await q(db, `
      SELECT e.summary, e.status_at_entry, s.clock_in FROM session_entries e
      JOIN sessions s ON s.id = e.session_id
      WHERE e.project_id = ? ORDER BY s.clock_in DESC`, [p.id]),
  }))))
}))

/* ── Static app (local production: `npm start` serves built UI + API) ── */

const DIST = path.join(__dirname, '..', 'dist')
if (!ON_VERCEL && fs.existsSync(DIST)) {
  app.use(express.static(DIST))
  app.get(/^\/(?!api\/).*/, (req, res) => {
    res.sendFile(path.join(DIST, 'index.html'))
  })
}

/* ── Errors ──────────────────────────────────────────────────────────── */

app.use((err, req, res, next) => {
  const status = err.status || 500
  if (status === 500) console.error(err)
  res.status(status).json({ error: err.message })
})

export default app
