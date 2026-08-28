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

/* ── Money ───────────────────────────────────────────────────────────────
   Rates are snapshotted onto a session when it is published, so a later rate
   change never silently reprices work a client has already seen. Amounts are
   computed in integer cents and rounded once, at the row, so the screen, the
   CSV, the spreadsheet and an invoice line item all agree — and so a quarter's
   worth of sessions cannot accumulate float error into a total that is a penny
   off the rows above it.

   Nothing here reads `expenses`. That table is the owner's personal overhead
   and has no path to a client. */

export const amountCents = (minutes, rate) =>
  rate == null ? null : Math.round((minutes / 60) * rate * 100)

// Two conditions, both required: the company has the toggle on, and a rate is
// actually configured. When either fails the money fields are omitted from the
// response entirely rather than sent and hidden in the UI.
export async function moneyPolicy(clientId) {
  const c = await q1(null,
    'SELECT portal_shows_rates, hourly_rate FROM clients WHERE id = ?', [clientId])
  return { show: !!(c && c.portal_shows_rates && Number(c.hourly_rate) > 0) }
}

/* ── Session scope ───────────────────────────────────────────────────────
   client_id and is_published are not optional and are not parameters — they
   are the definition of what a client may see.

   deleted_at joined them rather than being filtered by each caller: this
   clause is the single chokepoint every client-facing read passes through, so
   a session the owner has withdrawn disappears from the table, the totals, the
   breakdown, the exports and the pulse in one move, and a read added here
   later inherits it. */

function scopeClause({ clientId, from, to, projectId }) {
  let sql = `s.client_id = ? AND s.is_published = 1 AND s.clock_out IS NOT NULL
    AND s.deleted_at IS NULL`
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
    SELECT s.id, s.clock_in, s.duration_minutes, s.rate_applied
    FROM sessions s WHERE ${sql}
    ORDER BY s.clock_in DESC, s.id DESC${page}`, [...args, ...pageArgs])

  const entries = await entriesFor(rows.map(r => r.id), opts.clientId)
  const zone = portalTz()

  // notes:false drops the per-entry summary while keeping the project names.
  // Share links can be forwarded, and the summaries are written for the
  // owner's own recall rather than for an audience.
  const keep = (list) => opts.notes === false
    ? list.map(({ project_id, name }) => ({ project_id, name }))
    : list

  const money = opts.money?.show === true

  return {
    total,
    sessions: rows.map(r => ({
      id: r.id,
      date: localDate(r.clock_in, zone),
      duration_minutes: r.duration_minutes,
      projects: keep(entries.get(r.id) || []),
      ...(money ? {
        rate: r.rate_applied ?? null,
        amount_cents: amountCents(r.duration_minutes, r.rate_applied),
      } : {}),
    })),
  }
}

// Summed from the same per-row rounding the table shows, never from a SQL
// SUM of unrounded values — the two disagree by a penny often enough to
// matter, and SQLite and Postgres round floats differently at the half.
export async function totalAmountCents(opts) {
  const { sql, args } = scopeClause(opts)
  const rows = await q(null,
    `SELECT s.duration_minutes, s.rate_applied FROM sessions s WHERE ${sql}`, args)
  return rows.reduce((a, r) => a + (amountCents(r.duration_minutes, r.rate_applied) || 0), 0)
}

/* The overview figures. Lives here rather than in a route so the two front
   doors — the logged-in portal and a share link — cannot drift apart on what
   "this week" means or which sessions count toward it. */

export async function summaryFor(clientId, { notes = true, money } = {}) {
  const today = localToday()
  const weekStart = localWeekStart(today)
  const monthStart = localMonthStart(today)
  const tomorrow = startOfLocalDay(addLocalDays(today, 1))

  const company = await q1(null,
    'SELECT id, name, color_accent, weekly_hours_target FROM clients WHERE id = ?', [clientId])

  const weekScope = { clientId, from: startOfLocalDay(weekStart), to: tomorrow }
  const monthScope = { clientId, from: startOfLocalDay(monthStart), to: tomorrow }
  const show = money?.show === true

  const [weekMinutes, monthMinutes, recent, weekCents, monthCents] = await Promise.all([
    totalMinutes(weekScope),
    totalMinutes(monthScope),
    listSessions({ clientId, limit: 5, offset: 0, notes, money }),
    show ? totalAmountCents(weekScope) : null,
    show ? totalAmountCents(monthScope) : null,
  ])

  return {
    company: {
      name: company.name,
      color_accent: company.color_accent,
      weekly_hours_target: company.weekly_hours_target,
    },
    time_zone: portalTz(),
    week: {
      start: weekStart,
      minutes: weekMinutes,
      ...(show ? { amount_cents: weekCents } : {}),
    },
    month: {
      start: monthStart,
      minutes: monthMinutes,
      ...(show ? { amount_cents: monthCents } : {}),
    },
    recent: recent.sessions,
    total_sessions: recent.total,
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
  // Aggregated in JS rather than by SQL GROUP BY, so minutes and money are
  // derived from one pass over the same rows and cannot disagree, and so the
  // rounding happens once per project row rather than inside two engines that
  // round floats differently at the half.
  const rows = await q(null, `
    SELECT e.session_id, e.project_id, p.name AS project_name,
           s.duration_minutes, s.rate_applied, cnt.n
    FROM session_entries e
    JOIN sessions s ON s.id = e.session_id
    JOIN projects p ON p.id = e.project_id
    JOIN (SELECT session_id, COUNT(*) AS n FROM session_entries GROUP BY session_id) cnt
      ON cnt.session_id = e.session_id
    WHERE ${sql} AND p.client_id = ?`, [...args, opts.clientId])

  const money = opts.money?.show === true

  // Money is split the way a bill is split: take the session's already-rounded
  // cents and divide them as whole cents across its entries, handing the
  // remainder to the first few. Rounding each project independently instead
  // would let the column drift a few cents away from the total above it across
  // a quarter's sessions — and a breakdown that doesn't add up reads as an
  // accounting error on a screen this close to an invoice.
  const bySession = new Map()
  for (const r of rows) {
    if (!bySession.has(r.session_id)) bySession.set(r.session_id, [])
    bySession.get(r.session_id).push(r)
  }

  const acc = new Map()
  for (const entries of bySession.values()) {
    const { duration_minutes, rate_applied, n } = entries[0]
    const cents = amountCents(duration_minutes, rate_applied) || 0
    const base = Math.trunc(cents / n)
    let remainder = cents - base * n

    for (const r of entries) {
      if (!acc.has(r.project_id)) {
        acc.set(r.project_id, { project_id: r.project_id, name: r.project_name, minutes: 0, cents: 0 })
      }
      const a = acc.get(r.project_id)
      a.minutes += duration_minutes / n
      a.cents += base + (remainder > 0 ? 1 : 0)
      if (remainder > 0) remainder -= 1
    }
  }

  const projects = [...acc.values()]
    .map(a => ({
      project_id: a.project_id,
      name: a.name,
      minutes: Math.round(a.minutes * 100) / 100,
      ...(money ? { amount_cents: a.cents } : {}),
    }))
    .sort((a, b) => b.minutes - a.minutes)

  // Sessions logged without any project attached have nowhere to be prorated
  // to. Dropping them would leave the breakdown quietly summing to less than
  // the headline total, which on an invoice-adjacent screen reads as an error.
  // The residual row also absorbs the per-row rounding, so the breakdown adds
  // up to the total exactly rather than approximately.
  const attributed = projects.reduce((a, p) => a + p.minutes, 0)
  const total = await totalMinutes(opts)
  const untagged = Math.round((total - attributed) * 100) / 100

  if (untagged > 0.01) {
    const row = { project_id: null, name: '(untagged)', minutes: untagged }
    if (money) {
      const attributedCents = projects.reduce((a, p) => a + (p.amount_cents || 0), 0)
      row.amount_cents = (await totalAmountCents(opts)) - attributedCents
    }
    projects.push(row)
  }

  return projects
}

/* A compact signature of everything in scope, for a page to poll without
   refetching the payload. One aggregate row: it moves when a session is
   published or unpublished, when one is added, and when a duration or a rate
   is edited, which covers every way the client's view can change. Built on the
   same scopeClause as everything else, so it can never report a change the
   reader would not be allowed to see. */

export async function pulse(opts) {
  const { sql, args } = scopeClause(opts)
  const row = await q1(null, `
    SELECT COUNT(*) AS n,
           COALESCE(MAX(s.id), 0) AS max_id,
           COALESCE(SUM(s.duration_minutes), 0) AS minutes,
           COALESCE(SUM(s.rate_applied), 0) AS rates
    FROM sessions s WHERE ${sql}`, args)

  return [
    Number(row?.n || 0),
    Number(row?.max_id || 0),
    Math.round(Number(row?.minutes || 0) * 100),
    Math.round(Number(row?.rates || 0) * 100),
  ].join(':')
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

/* ── Comments ────────────────────────────────────────────────────────────
   One thread per project, shared by the owner and the client. The author is
   always a portal_users row — the owner gets one at bootstrap — so there is no
   polymorphic author column and no role branch at read time.

   Comments are immutable. There is no update path anywhere, and deletion is a
   soft deleted_at that renders as a placeholder, because history here is the
   record of what was actually asked and answered. */

export const COMMENT_MAX = 5000

export function validComment(value) {
  const body = String(value ?? '').trim()
  if (!body) return { error: 'a comment can’t be empty' }
  if (body.length > COMMENT_MAX) return { error: `a comment can’t be longer than ${COMMENT_MAX} characters` }
  return { body }
}

// Emails are not returned. A client sees who wrote a comment by name and by
// side, which is all a thread needs and one less identifier to hand across.
export async function listComments(projectId, viewerId) {
  const rows = await q(null, `
    SELECT c.id, c.body, c.created_at, c.deleted_at, c.portal_user_id,
           u.name AS author_name, u.role AS author_role
    FROM project_comments c
    JOIN portal_users u ON u.id = c.portal_user_id
    WHERE c.project_id = ?
    ORDER BY c.id`, [projectId])

  return rows.map(r => ({
    id: r.id,
    body: r.deleted_at ? null : r.body,
    deleted: !!r.deleted_at,
    created_at: r.created_at,
    author_name: r.author_name || (r.author_role === 'owner' ? 'Chris' : 'Someone'),
    author_role: r.author_role,
    is_mine: r.portal_user_id === viewerId,
  }))
}

export const addComment = (conn, projectId, portalUserId, body) =>
  q1(conn, `INSERT INTO project_comments (project_id, portal_user_id, body)
            VALUES (?,?,?) RETURNING *`, [projectId, portalUserId, body])

// ON CONFLICT DO UPDATE is spelled the same on SQLite 3.24+ and Postgres, and
// the unique index on (project_id, portal_user_id) is what it conflicts against.
export const markRead = (projectId, portalUserId, at = new Date().toISOString()) =>
  q(null, `
    INSERT INTO project_comment_reads (project_id, portal_user_id, last_read_at)
    VALUES (?,?,?)
    ON CONFLICT (project_id, portal_user_id)
    DO UPDATE SET last_read_at = excluded.last_read_at`, [projectId, portalUserId, at])

/* ── Revisions ───────────────────────────────────────────────────────────
   "History is never overwritten" applies to a client's edits too. Every field
   change appends here, inside the same transaction as the UPDATE, so an edit
   and its record land together or not at all. */

export const recordRevision = (conn, projectId, portalUserId, field, oldValue, newValue) =>
  q(conn, `INSERT INTO project_revisions (project_id, portal_user_id, field, old_value, new_value)
           VALUES (?,?,?,?,?)`, [projectId, portalUserId, field, oldValue ?? null, newValue ?? null])

/* ── Project shape ───────────────────────────────────────────────────────
   Nothing reaches a client except through this. INSERT … RETURNING * hands
   back every column including question_text, so a raw row must never be
   serialised into a portal response — even when the value happens to be null,
   the field name alone tells a client something exists to ask about. */

export const portalProject = (p, extra = {}) => ({
  id: p.id,
  name: p.name,
  description: p.description ?? null,
  status: portalStatus(p.status),
  state: p.portal_request || 'active',
  completed_at: p.completed_at ?? null,
  created_at: p.created_at,
  ...extra,
})

const UNREAD_SQL = `
  (SELECT COUNT(*) FROM project_comments c
    LEFT JOIN project_comment_reads r
      ON r.project_id = c.project_id AND r.portal_user_id = ?
   WHERE c.project_id = p.id AND c.deleted_at IS NULL
     AND c.portal_user_id != ?
     AND (r.last_read_at IS NULL OR c.created_at > r.last_read_at)) AS unread_count`

const COMMENT_COUNT_SQL = `
  (SELECT COUNT(*) FROM project_comments c
   WHERE c.project_id = p.id AND c.deleted_at IS NULL) AS comment_count`

// Replaces the plain project list once a viewer exists to count unread against.
export async function listProjectsFor(clientId, viewerId) {
  const rows = await q(null, `
    SELECT p.id, p.name, p.description, p.status, p.completed_at, p.created_at,
           p.portal_request,
           ${UNREAD_SQL},
           ${COMMENT_COUNT_SQL}
    FROM projects p
    WHERE p.client_id = ?
    ORDER BY CASE WHEN p.status = 'complete' THEN 1 ELSE 0 END, p.name`,
    [viewerId, viewerId, clientId])

  return rows.map(p => portalProject(p, {
    unread_count: Number(p.unread_count || 0),
    comment_count: Number(p.comment_count || 0),
  }))
}

export async function unreadTotal(clientId, viewerId) {
  const row = await q1(null, `
    SELECT COUNT(*) AS n FROM project_comments c
    JOIN projects p ON p.id = c.project_id
    LEFT JOIN project_comment_reads r
      ON r.project_id = c.project_id AND r.portal_user_id = ?
    WHERE p.client_id = ? AND c.deleted_at IS NULL
      AND c.portal_user_id != ?
      AND (r.last_read_at IS NULL OR c.created_at > r.last_read_at)`,
    [viewerId, clientId, viewerId])
  return Number(row?.n || 0)
}

// Subtasks are the owner's execution breakdown, shown read-only: a client can
// see progress without being able to tick off work items, which would put the
// board's own counts under their control.
export async function projectDetail(clientId, projectId, viewerId) {
  const p = await q1(null, `
    SELECT id, name, description, status, completed_at, created_at, portal_request
    FROM projects WHERE id = ? AND client_id = ?`, [projectId, clientId])
  if (!p) return null

  const [subtasks, links, comments] = await Promise.all([
    q(null, 'SELECT id, title, is_done FROM subtasks WHERE project_id = ? ORDER BY sort_order, id', [p.id]),
    q(null, 'SELECT id, label, url FROM asset_links WHERE project_id = ? ORDER BY id', [p.id]),
    listComments(p.id, viewerId),
  ])

  return portalProject(p, { subtasks, links, comments })
}
