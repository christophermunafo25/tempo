// The one place a client's view of the data is defined.
//
// Every read below binds client_id from the session and is_published = 1, in a
// single shared helper, so totals, table rows, CSV exports and the project
// breakdown cannot drift apart from one another.
//
// Two rules this file exists to keep:
//   • No SELECT *. Every column is named. `SELECT p.*` would ship
//     question_text to a client, and status_at_entry and status_events are
//     internal too.
//   • Clock times never leave the server. Sessions are reported as a local
//     calendar date plus a duration — a client learns how long, not which
//     hours of the day their contractor works.

import { q, q1 } from './db.js'

/* ── Time zone ───────────────────────────────────────────────────────────
   Sessions belong to the day they started, and "the day" has to mean the same
   thing on both sides of the app. The owner's screens use the browser's local
   zone; the portal has to name one explicitly because Vercel runs in UTC. */

export const portalTz = () =>
  process.env.TEMPO_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

// 'YYYY-MM-DD' for an instant, in the portal's zone. en-CA is ISO-ordered.
export const localDate = (iso, zone = portalTz()) =>
  new Date(iso).toLocaleDateString('en-CA', { timeZone: zone })

// Offset of `zone` from UTC, in ms, at a given instant — so DST is handled by
// asking Intl rather than by assuming a fixed offset.
function zoneOffset(instant, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant)
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]))
  const asUTC = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour) % 24, Number(p.minute), Number(p.second))
  return asUTC - instant.getTime()
}

// Midnight of a local 'YYYY-MM-DD', as a UTC instant.
export function startOfLocalDay(dateStr, zone = portalTz()) {
  const guess = Date.parse(`${dateStr}T00:00:00Z`)
  if (Number.isNaN(guess)) return null
  return new Date(guess - zoneOffset(new Date(guess), zone))
}

export const addLocalDays = (dateStr, n) => {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export function localToday(zone = portalTz()) {
  return new Date().toLocaleDateString('en-CA', { timeZone: zone })
}

// Monday-based, matching weekStart() in src/time.js.
export function localWeekStart(dateStr = localToday()) {
  const d = new Date(`${dateStr}T00:00:00Z`)
  const day = (d.getUTCDay() + 6) % 7
  return addLocalDays(dateStr, -day)
}

export const localMonthStart = (dateStr = localToday()) => `${dateStr.slice(0, 7)}-01`

/* ── Status ──────────────────────────────────────────────────────────────
   'questions' is an internal state: it means the owner is blocked waiting on
   this client, and the question itself lives in question_text, which is never
   selected. Clients see the project as in progress. */

const PORTAL_STATUS = { questions: 'in_progress' }
export const portalStatus = (status) => PORTAL_STATUS[status] ?? status

/* ── Session scope ───────────────────────────────────────────────────────
   client_id and is_published are not optional and are not parameters — they
   are the definition of what a client may see. */

function scopeClause({ clientId, from, to, projectId }) {
  let sql = 's.client_id = ? AND s.is_published = 1 AND s.clock_out IS NOT NULL'
  const args = [clientId]
  if (from) { sql += ' AND s.clock_in >= ?'; args.push(from.toISOString()) }
  if (to) { sql += ' AND s.clock_in < ?'; args.push(to.toISOString()) }
  if (projectId) {
    sql += ` AND EXISTS (SELECT 1 FROM session_entries e2
                         JOIN projects p2 ON p2.id = e2.project_id
                         WHERE e2.session_id = s.id AND e2.project_id = ? AND p2.client_id = ?)`
    args.push(projectId, clientId)
  }
  return { sql, args }
}

// Resolves a from/to pair of local dates into UTC instants. `to` is inclusive
// of its whole day, which is what a person means by "through the 30th".
export function resolveRange({ from, to }) {
  return {
    from: from ? startOfLocalDay(from) : null,
    to: to ? startOfLocalDay(addLocalDays(to, 1)) : null,
  }
}

async function entriesFor(sessionIds, clientId) {
  if (!sessionIds.length) return new Map()
  const holes = sessionIds.map(() => '?').join(',')
  // p.client_id = ? is redundant given the session scope, and deliberately
  // kept: it means a mis-parented entry can never widen a client's view.
  const rows = await q(null, `
    SELECT e.session_id, e.project_id, e.summary, p.name AS project_name
    FROM session_entries e
    JOIN projects p ON p.id = e.project_id
    WHERE e.session_id IN (${holes}) AND p.client_id = ?
    ORDER BY e.id`, [...sessionIds, clientId])

  const map = new Map()
  for (const r of rows) {
    if (!map.has(r.session_id)) map.set(r.session_id, [])
    map.get(r.session_id).push({
      project_id: r.project_id,
      name: r.project_name,
      summary: r.summary,
    })
  }
  return map
}

// One row per session: a local date, a duration, and the project summaries
// attached to it. No clock_in, no clock_out, no status_at_entry.
export async function listSessions(opts) {
  const { sql, args } = scopeClause(opts)
  const { n } = await q1(null, `SELECT COUNT(*) AS n FROM sessions s WHERE ${sql}`, args)
  const total = Number(n || 0)

  let page = ''
  const pageArgs = []
  if (opts.limit != null) {
    page = ' LIMIT ? OFFSET ?'
    pageArgs.push(opts.limit, opts.offset || 0)
  }

  const rows = await q(null, `
    SELECT s.id, s.clock_in, s.duration_minutes
    FROM sessions s WHERE ${sql}
    ORDER BY s.clock_in DESC, s.id DESC${page}`, [...args, ...pageArgs])

  const entries = await entriesFor(rows.map(r => r.id), opts.clientId)
  const zone = portalTz()

  return {
    total,
    sessions: rows.map(r => ({
      id: r.id,
      date: localDate(r.clock_in, zone),
      duration_minutes: r.duration_minutes,
      projects: entries.get(r.id) || [],
    })),
  }
}

export async function totalMinutes(opts) {
  const { sql, args } = scopeClause(opts)
  const row = await q1(null,
    `SELECT COALESCE(SUM(s.duration_minutes), 0) AS m FROM sessions s WHERE ${sql}`, args)
  return Number(row?.m || 0)
}

// Same even-proration as /api/archive: a session's duration is split equally
// across the entries attached to it. It is an estimate, because hours are
// clocked per company and not per project, and the UI says so.
export async function breakdown(opts) {
  const { sql, args } = scopeClause(opts)
  const rows = await q(null, `
    SELECT e.project_id, p.name AS project_name,
           SUM(s.duration_minutes / cnt.n) AS minutes
    FROM session_entries e
    JOIN sessions s ON s.id = e.session_id
    JOIN projects p ON p.id = e.project_id
    JOIN (SELECT session_id, COUNT(*) AS n FROM session_entries GROUP BY session_id) cnt
      ON cnt.session_id = e.session_id
    WHERE ${sql} AND p.client_id = ?
    GROUP BY e.project_id, p.name`, [...args, opts.clientId])

  const projects = rows
    .map(r => ({
      project_id: r.project_id,
      name: r.project_name,
      minutes: Math.round(Number(r.minutes) * 100) / 100,
    }))
    .sort((a, b) => b.minutes - a.minutes)

  // Sessions logged without any project attached have nowhere to be prorated
  // to. Dropping them would leave the breakdown quietly summing to less than
  // the headline total, which on an invoice-adjacent screen reads as an error.
  const attributed = projects.reduce((a, p) => a + p.minutes, 0)
  const total = await totalMinutes(opts)
  const untagged = Math.round((total - attributed) * 100) / 100
  if (untagged > 0.01) projects.push({ project_id: null, name: '(untagged)', minutes: untagged })

  return projects
}

/* ── Projects ────────────────────────────────────────────────────────────
   Everything for the company, completed included. question_text is not in the
   select list and never will be. */

export async function listProjects(clientId) {
  const rows = await q(null, `
    SELECT id, name, description, status, completed_at, created_at, portal_request
    FROM projects
    WHERE client_id = ?
    ORDER BY CASE WHEN status = 'complete' THEN 1 ELSE 0 END, name`, [clientId])

  return rows.map(p => ({
    id: p.id,
    name: p.name,
    description: p.description,
    status: portalStatus(p.status),
    state: p.portal_request || 'active',   // active | pending | declined
    completed_at: p.completed_at,
    created_at: p.created_at,
  }))
}

// Scoped lookup for anything addressed by id. Returns null rather than
// throwing, so callers answer 404 — never 403 — for another company's row.
export async function ownedProject(clientId, projectId) {
  if (!projectId) return null
  return await q1(null,
    'SELECT id, client_id, name FROM projects WHERE id = ? AND client_id = ?',
    [projectId, clientId]) || null
}
