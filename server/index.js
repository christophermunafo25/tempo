import express from 'express'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', 'data')
fs.mkdirSync(DATA_DIR, { recursive: true })

const db = new Database(path.join(DATA_DIR, 'tempo.db'))
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
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
`)

const app = express()
app.use(express.json())

const nowISO = () => new Date().toISOString()
const STATUSES = ['in_queue', 'on_deck', 'in_progress', 'questions', 'sent_for_review', 'complete']

function logStatus(projectId, status, source) {
  db.prepare('INSERT INTO status_events (project_id, status, source) VALUES (?,?,?)')
    .run(projectId, status, source)
}

function applyStatus(project, status, questionText, source) {
  if (!STATUSES.includes(status)) throw httpError(400, `invalid status: ${status}`)
  if (status === 'questions' && !(questionText || '').trim()) {
    throw httpError(400, 'question_text is required when status is questions')
  }
  const completedAt = status === 'complete'
    ? (project.completed_at || nowISO())
    : null
  db.prepare('UPDATE projects SET status = ?, question_text = ?, completed_at = ? WHERE id = ?')
    .run(status, status === 'questions' ? questionText.trim() : null, completedAt, project.id)
  if (project.status !== status) logStatus(project.id, status, source)
}

function httpError(code, message) {
  const e = new Error(message)
  e.status = code
  return e
}

const projectExtras = {
  subtasks: db.prepare('SELECT * FROM subtasks WHERE project_id = ? ORDER BY sort_order, id'),
  links: db.prepare('SELECT * FROM asset_links WHERE project_id = ? ORDER BY id'),
}
function withExtras(project) {
  return {
    ...project,
    subtasks: projectExtras.subtasks.all(project.id),
    asset_links: projectExtras.links.all(project.id),
  }
}

/* ── Clients ─────────────────────────────────────────────────────────── */

app.get('/api/clients', (req, res) => {
  res.json(db.prepare('SELECT * FROM clients WHERE is_active = 1 ORDER BY name').all())
})

app.post('/api/clients', (req, res) => {
  const { name, color_accent, weekly_hours_target } = req.body
  if (!(name || '').trim()) throw httpError(400, 'name is required')
  const info = db.prepare('INSERT INTO clients (name, color_accent, weekly_hours_target) VALUES (?,?,?)')
    .run(name.trim(), color_accent || '#6B93C4', Number(weekly_hours_target) || 0)
  res.json(db.prepare('SELECT * FROM clients WHERE id = ?').get(info.lastInsertRowid))
})

app.patch('/api/clients/:id', (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id)
  if (!client) throw httpError(404, 'client not found')
  const next = { ...client, ...req.body }
  db.prepare('UPDATE clients SET name=?, color_accent=?, weekly_hours_target=?, is_active=? WHERE id=?')
    .run(next.name, next.color_accent, Number(next.weekly_hours_target) || 0, next.is_active ? 1 : 0, client.id)
  res.json(db.prepare('SELECT * FROM clients WHERE id = ?').get(client.id))
})

/* ── Projects ────────────────────────────────────────────────────────── */

app.get('/api/projects', (req, res) => {
  const { client_id, include_complete } = req.query
  let sql = 'SELECT * FROM projects WHERE 1=1'
  const args = []
  if (client_id) { sql += ' AND client_id = ?'; args.push(client_id) }
  if (!include_complete) sql += " AND status != 'complete'"
  sql += ' ORDER BY name'
  res.json(db.prepare(sql).all(...args).map(withExtras))
})

app.post('/api/projects', (req, res) => {
  const { client_id, name } = req.body
  if (!client_id || !(name || '').trim()) throw httpError(400, 'client_id and name are required')
  const info = db.prepare('INSERT INTO projects (client_id, name) VALUES (?,?)').run(client_id, name.trim())
  logStatus(info.lastInsertRowid, 'in_queue', 'created')
  res.json(withExtras(db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid)))
})

app.patch('/api/projects/:id', (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id)
  if (!project) throw httpError(404, 'project not found')
  const tx = db.transaction(() => {
    if (req.body.status) applyStatus(project, req.body.status, req.body.question_text, req.body.source || 'board')
    if (req.body.name) db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(req.body.name.trim(), project.id)
  })
  tx()
  res.json(withExtras(db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id)))
})

app.get('/api/projects/:id/detail', (req, res) => {
  const project = db.prepare(`
    SELECT p.*, c.name AS client_name, c.color_accent FROM projects p
    JOIN clients c ON c.id = p.client_id WHERE p.id = ?`).get(req.params.id)
  if (!project) throw httpError(404, 'project not found')
  const entries = db.prepare(`
    SELECT e.*, s.clock_in, s.clock_out, s.duration_minutes FROM session_entries e
    JOIN sessions s ON s.id = e.session_id
    WHERE e.project_id = ? ORDER BY s.clock_in DESC`).all(project.id)
  const statusEvents = db.prepare(
    'SELECT * FROM status_events WHERE project_id = ? ORDER BY created_at DESC, id DESC').all(project.id)
  res.json({ ...withExtras(project), entries, status_events: statusEvents })
})

/* ── Subtasks ────────────────────────────────────────────────────────── */

app.post('/api/projects/:id/subtasks', (req, res) => {
  const { title } = req.body
  if (!(title || '').trim()) throw httpError(400, 'title is required')
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM subtasks WHERE project_id = ?')
    .get(req.params.id).m
  const info = db.prepare('INSERT INTO subtasks (project_id, title, sort_order) VALUES (?,?,?)')
    .run(req.params.id, title.trim(), max + 1)
  res.json(db.prepare('SELECT * FROM subtasks WHERE id = ?').get(info.lastInsertRowid))
})

app.patch('/api/subtasks/:id', (req, res) => {
  const st = db.prepare('SELECT * FROM subtasks WHERE id = ?').get(req.params.id)
  if (!st) throw httpError(404, 'subtask not found')
  const next = { ...st, ...req.body }
  db.prepare('UPDATE subtasks SET title=?, is_done=?, sort_order=? WHERE id=?')
    .run(next.title, next.is_done ? 1 : 0, next.sort_order, st.id)
  res.json(db.prepare('SELECT * FROM subtasks WHERE id = ?').get(st.id))
})

app.post('/api/projects/:id/subtasks/reorder', (req, res) => {
  const { ids } = req.body
  const tx = db.transaction(() => {
    ids.forEach((id, i) =>
      db.prepare('UPDATE subtasks SET sort_order = ? WHERE id = ? AND project_id = ?')
        .run(i, id, req.params.id))
  })
  tx()
  res.json(projectExtras.subtasks.all(req.params.id))
})

app.delete('/api/subtasks/:id', (req, res) => {
  db.prepare('DELETE FROM subtasks WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

/* ── Asset links ─────────────────────────────────────────────────────── */

app.post('/api/projects/:id/links', (req, res) => {
  const { label, url } = req.body
  try { new URL(url) } catch { throw httpError(400, 'url is not well formed') }
  if (!(label || '').trim()) throw httpError(400, 'label is required')
  const info = db.prepare('INSERT INTO asset_links (project_id, label, url) VALUES (?,?,?)')
    .run(req.params.id, label.trim(), url)
  res.json(db.prepare('SELECT * FROM asset_links WHERE id = ?').get(info.lastInsertRowid))
})

app.delete('/api/links/:id', (req, res) => {
  db.prepare('DELETE FROM asset_links WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

/* ── Sessions / clock ────────────────────────────────────────────────── */

app.get('/api/active-session', (req, res) => {
  const s = db.prepare(`
    SELECT s.*, c.name AS client_name, c.color_accent FROM sessions s
    JOIN clients c ON c.id = s.client_id
    WHERE s.clock_out IS NULL ORDER BY s.clock_in DESC LIMIT 1`).get()
  res.json(s || null)
})

app.post('/api/clock-in', (req, res) => {
  const { client_id } = req.body
  if (!client_id) throw httpError(400, 'client_id is required')
  const active = db.prepare('SELECT id FROM sessions WHERE clock_out IS NULL').get()
  if (active) throw httpError(409, 'a session is already running')
  const info = db.prepare('INSERT INTO sessions (client_id, clock_in) VALUES (?,?)')
    .run(client_id, nowISO())
  res.json(db.prepare('SELECT * FROM sessions WHERE id = ?').get(info.lastInsertRowid))
})

// Prefill for the clock-out review panel: entries from this client's most
// recent completed session, carried forward with each project's live state.
app.get('/api/prefill', (req, res) => {
  const { client_id } = req.query
  const last = db.prepare(`
    SELECT id FROM sessions
    WHERE client_id = ? AND clock_out IS NOT NULL
    ORDER BY clock_in DESC LIMIT 1`).get(client_id)
  if (!last) return res.json([])
  const entries = db.prepare(`
    SELECT e.project_id, e.summary FROM session_entries e
    JOIN projects p ON p.id = e.project_id
    WHERE e.session_id = ? AND p.status != 'complete'
    ORDER BY e.id`).all(last.id)
  res.json(entries.map(e => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(e.project_id)
    return { project: withExtras(project), last_summary: e.summary }
  }))
})

app.post('/api/sessions/:id/clock-out', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id)
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

  const tx = db.transaction(() => {
    const duration = Math.round(((out - inn) / 60000) * 100) / 100
    db.prepare('UPDATE sessions SET clock_out = ?, duration_minutes = ? WHERE id = ?')
      .run(out.toISOString(), duration, session.id)
    for (const entry of entries) {
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(entry.project_id)
      if (!project) throw httpError(400, `project ${entry.project_id} not found`)
      applyStatus(project, entry.status, entry.question_text, 'session')
      db.prepare(`INSERT INTO session_entries (session_id, project_id, summary, status_at_entry)
        VALUES (?,?,?,?)`).run(session.id, project.id, (entry.summary || '').trim(), entry.status)
    }
  })
  tx()
  res.json(db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id))
})

// Completed sessions with their entries, optionally bounded and filtered.
app.get('/api/sessions', (req, res) => {
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
  const sessions = db.prepare(sql).all(...args)
  const entryStmt = db.prepare(`
    SELECT e.*, p.name AS project_name FROM session_entries e
    JOIN projects p ON p.id = e.project_id
    WHERE e.session_id = ? ORDER BY e.id`)
  res.json(sessions.map(s => ({ ...s, entries: entryStmt.all(s.id) })))
})

/* ── Board ───────────────────────────────────────────────────────────── */

app.get('/api/board', (req, res) => {
  const { client_id } = req.query
  const cutoff = new Date(Date.now() - 14 * 86400000).toISOString()
  let sql = `
    SELECT p.*, c.name AS client_name, c.color_accent FROM projects p
    JOIN clients c ON c.id = p.client_id
    WHERE (p.status != 'complete' OR p.completed_at >= ?)`
  const args = [cutoff]
  if (client_id) { sql += ' AND p.client_id = ?'; args.push(client_id) }
  sql += ' ORDER BY p.created_at'
  const lastSummary = db.prepare(`
    SELECT e.summary FROM session_entries e
    JOIN sessions s ON s.id = e.session_id
    WHERE e.project_id = ? AND e.summary != ''
    ORDER BY s.clock_in DESC LIMIT 1`)
  const counts = db.prepare(
    'SELECT COUNT(*) AS total, SUM(is_done) AS done FROM subtasks WHERE project_id = ?')
  res.json(db.prepare(sql).all(...args).map(p => ({
    ...withExtras(p),
    last_summary: lastSummary.get(p.id)?.summary || '',
    subtask_total: counts.get(p.id).total,
    subtask_done: counts.get(p.id).done || 0,
  })))
})

/* ── Archive (completed projects w/ prorated hours) ──────────────────── */

app.get('/api/archive', (req, res) => {
  const { client_id } = req.query
  let sql = `
    SELECT p.*, c.name AS client_name, c.color_accent FROM projects p
    JOIN clients c ON c.id = p.client_id
    WHERE p.status = 'complete'`
  const args = []
  if (client_id) { sql += ' AND p.client_id = ?'; args.push(client_id) }
  sql += ' ORDER BY p.completed_at DESC'
  const projects = db.prepare(sql).all(...args)
  // Prorate each session's duration evenly across its entries.
  const shares = db.prepare(`
    SELECT e.project_id,
           SUM(s.duration_minutes / cnt.n) AS minutes
    FROM session_entries e
    JOIN sessions s ON s.id = e.session_id
    JOIN (SELECT session_id, COUNT(*) AS n FROM session_entries GROUP BY session_id) cnt
      ON cnt.session_id = e.session_id
    GROUP BY e.project_id`).all()
  const shareMap = Object.fromEntries(shares.map(r => [r.project_id, r.minutes]))
  const trail = db.prepare(`
    SELECT e.summary, e.status_at_entry, s.clock_in FROM session_entries e
    JOIN sessions s ON s.id = e.session_id
    WHERE e.project_id = ? ORDER BY s.clock_in DESC`)
  res.json(projects.map(p => ({
    ...p,
    total_minutes: Math.round((shareMap[p.id] || 0) * 100) / 100,
    trail: trail.all(p.id),
  })))
})

/* ── Errors ──────────────────────────────────────────────────────────── */

app.use((err, req, res, next) => {
  const status = err.status || 500
  if (status === 500) console.error(err)
  res.status(status).json({ error: err.message })
})

const PORT = 3001
app.listen(PORT, () => console.log(`tempo api on :${PORT}`))
