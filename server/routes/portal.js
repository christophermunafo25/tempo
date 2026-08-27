// Client-facing reads. The gate has already established that req.portalUser is
// an active client with a client_id; scopeOf() is the only source of company
// scope in this file. No handler here reads client_id from a query param, a
// URL segment, or a body field.

import express from 'express'
import { h, httpError } from '../http.js'
import { scopeOf } from '../gate.js'
import { audit } from '../auth.js'
import { q1 } from '../db.js'
import {
  listSessions, totalMinutes, breakdown, listProjects, ownedProject,
  resolveRange, localToday, localWeekStart, localMonthStart, startOfLocalDay,
  addLocalDays, portalTz,
} from '../portal-query.js'

const router = express.Router()

const MAX_PER_PAGE = 100

// A project filter is resolved through the caller's own scope. Another
// company's id is not an error to explain — it simply doesn't exist here.
async function resolveProjectFilter(req, clientId) {
  const raw = req.query.project_id || req.body?.project_id
  if (!raw) return null
  const project = await ownedProject(clientId, raw)
  if (!project) throw httpError(404, 'not found')
  return project.id
}

function pageParams(req) {
  const perPage = Math.min(MAX_PER_PAGE, Math.max(1, Number(req.query.per_page) || 25))
  const page = Math.max(1, Number(req.query.page) || 1)
  return { limit: perPage, offset: (page - 1) * perPage, page, perPage }
}

/* ── Overview ────────────────────────────────────────────────────────── */

router.get('/summary', h(async (req, res) => {
  const clientId = scopeOf(req)
  const today = localToday()
  const weekStart = localWeekStart(today)
  const monthStart = localMonthStart(today)
  const tomorrow = startOfLocalDay(addLocalDays(today, 1))

  const company = await q1(null,
    'SELECT id, name, color_accent, weekly_hours_target FROM clients WHERE id = ?', [clientId])

  const [weekMinutes, monthMinutes, recent] = await Promise.all([
    totalMinutes({ clientId, from: startOfLocalDay(weekStart), to: tomorrow }),
    totalMinutes({ clientId, from: startOfLocalDay(monthStart), to: tomorrow }),
    listSessions({ clientId, limit: 5, offset: 0 }),
  ])

  res.json({
    company: {
      name: company.name,
      color_accent: company.color_accent,
      weekly_hours_target: company.weekly_hours_target,
    },
    time_zone: portalTz(),
    week: { start: weekStart, minutes: weekMinutes },
    month: { start: monthStart, minutes: monthMinutes },
    recent: recent.sessions,
    total_sessions: recent.total,
  })
}))

/* ── Hours ───────────────────────────────────────────────────────────── */

router.get('/sessions', h(async (req, res) => {
  const clientId = scopeOf(req)
  const projectId = await resolveProjectFilter(req, clientId)
  const { from, to } = resolveRange(req.query)
  const { limit, offset, page, perPage } = pageParams(req)

  const result = await listSessions({ clientId, from, to, projectId, limit, offset })
  res.json({ ...result, page, per_page: perPage })
}))

// POST rather than GET because it writes an audit row. Returns the same rows
// the table shows, from the same helper, with paging switched off — which is
// what makes the row counts provably equal rather than coincidentally equal.
router.post('/export', h(async (req, res) => {
  const clientId = scopeOf(req)
  const projectId = await resolveProjectFilter(req, clientId)
  const { from, to } = resolveRange(req.body || {})

  const result = await listSessions({ clientId, from, to, projectId })
  await audit(req, 'export', {
    user: req.portalUser,
    clientId,
    detail: `${result.total} session(s)` +
      `${req.body?.from ? ` from ${req.body.from}` : ''}${req.body?.to ? ` to ${req.body.to}` : ''}` +
      `${projectId ? ` project ${projectId}` : ''}`,
  })
  res.json(result)
}))

/* ── Projects ────────────────────────────────────────────────────────── */

router.get('/projects', h(async (req, res) => {
  res.json(await listProjects(scopeOf(req)))
}))

// Hours are clocked per company, not per project, so this is a derived
// estimate. The UI is required to say so.
router.get('/breakdown', h(async (req, res) => {
  const clientId = scopeOf(req)
  const projectId = await resolveProjectFilter(req, clientId)
  const { from, to } = resolveRange(req.query)

  res.json({
    estimate: true,
    basis: 'Each session is split evenly across the projects worked on in it.',
    projects: await breakdown({ clientId, from, to, projectId }),
  })
}))

export default router
