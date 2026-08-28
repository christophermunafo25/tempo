// Client-facing reads. The gate has already established that req.portalUser is
// an active client with a client_id; scopeOf() is the only source of company
// scope in this file. No handler here reads client_id from a query param, a
// URL segment, or a body field.

import express from 'express'
import { h, httpError } from '../http.js'
import { scopeOf } from '../gate.js'
import { audit, rateCheck, rateHit, LIMITS } from '../auth.js'
import { q, q1, withTx } from '../db.js'
import {
  listSessions, totalMinutes, breakdown, ownedProject,
  resolveRange, localToday, localWeekStart, localMonthStart, startOfLocalDay,
  addLocalDays, portalTz, listProjectsFor, projectDetail, unreadTotal,
  listComments, addComment, markRead, recordRevision, portalProject, validComment,
  summaryFor, moneyPolicy, pulse,
} from '../portal-query.js'

const router = express.Router()

const MAX_PER_PAGE = 100
const NAME_MAX = 200
const DESCRIPTION_MAX = 5000

/* Writes are throttled per portal user. The counter has to be in the database:
   on serverless every invocation starts with an empty map, so an in-memory
   limiter would silently enforce nothing. */
router.use(h(async (req, res, next) => {
  if (req.method === 'GET') return next()
  const bucket = `write:user:${req.portalUser.id}`
  const { ok, retryAfter } = await rateCheck(bucket, LIMITS.write)
  if (!ok) {
    res.set('Retry-After', String(retryAfter))
    throw httpError(429, 'too many changes at once — try again in a few minutes')
  }
  await rateHit(bucket)
  next()
}))

function validName(value) {
  const name = String(value ?? '').trim()
  if (!name) throw httpError(400, 'a name is required')
  if (name.length > NAME_MAX) throw httpError(400, `a name can’t be longer than ${NAME_MAX} characters`)
  return name
}

function validDescription(value) {
  const text = String(value ?? '').trim()
  if (text.length > DESCRIPTION_MAX) {
    throw httpError(400, `a description can’t be longer than ${DESCRIPTION_MAX} characters`)
  }
  return text || null
}

// Resolves a project through the caller's own scope, so a foreign id is
// indistinguishable from one that was never created.
async function mustOwn(req, clientId) {
  const project = await q1(null, `
    SELECT id, client_id, name, description, status, portal_request
    FROM projects WHERE id = ? AND client_id = ?`, [req.params.id, clientId])
  if (!project) throw httpError(404, 'not found')
  return project
}

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
  const money = await moneyPolicy(clientId)
  const [summary, unread] = await Promise.all([
    summaryFor(clientId, { money }),
    unreadTotal(clientId, req.portalUser.id),
  ])
  res.json({ ...summary, unread_comments: unread })
}))

// Polled by an open page. Deliberately tiny: one aggregate row, no payload.
router.get('/pulse', h(async (req, res) => {
  res.json({ signature: await pulse({ clientId: scopeOf(req) }) })
}))

/* ── Hours ───────────────────────────────────────────────────────────── */

router.get('/sessions', h(async (req, res) => {
  const clientId = scopeOf(req)
  const projectId = await resolveProjectFilter(req, clientId)
  const { from, to } = resolveRange(req.query)
  const { limit, offset, page, perPage } = pageParams(req)

  const money = await moneyPolicy(clientId)
  const result = await listSessions({ clientId, from, to, projectId, limit, offset, money })
  res.json({ ...result, page, per_page: perPage })
}))

// POST rather than GET because it writes an audit row. Returns the same rows
// the table shows, from the same helper, with paging switched off — which is
// what makes the row counts provably equal rather than coincidentally equal.
router.post('/export', h(async (req, res) => {
  const clientId = scopeOf(req)
  const projectId = await resolveProjectFilter(req, clientId)
  const { from, to } = resolveRange(req.body || {})

  const result = await listSessions({ clientId, from, to, projectId, money: await moneyPolicy(clientId) })
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
  res.json(await listProjectsFor(scopeOf(req), req.portalUser.id))
}))

router.get('/projects/:id', h(async (req, res) => {
  const detail = await projectDetail(scopeOf(req), req.params.id, req.portalUser.id)
  if (!detail) throw httpError(404, 'not found')
  res.json(detail)
}))

/* ── Writes ──────────────────────────────────────────────────────────────
   The writable field set is an allowlist, not a blocklist. These handlers read
   the keys they accept by name and never spread req.body, so status,
   question_text, client_id, portal_request and completed_at are not rejected
   with an error — they are simply never read, and so cannot be smuggled in
   through a casing trick, a duplicate key, or a nested object. */

router.post('/projects', h(async (req, res) => {
  const clientId = scopeOf(req)
  const name = validName(req.body?.name)
  const description = validDescription(req.body?.description)

  // Lands as a request, not a project: §1.3 keeps portal_request rows out of
  // the board, archive, project list and clock-out prefill until accepted.
  const project = await withTx(async (tx) => {
    const created = await q1(tx, `
      INSERT INTO projects (client_id, name, description, portal_request, requested_by)
      VALUES (?,?,?,?,?) RETURNING *`,
      [clientId, name, description, 'pending', req.portalUser.id])
    await q(tx, 'INSERT INTO status_events (project_id, status, source) VALUES (?,?,?)',
      [created.id, created.status, 'requested'])
    return created
  })

  await audit(req, 'request_created', { user: req.portalUser, clientId, detail: name })
  res.json(portalProject(project))
}))

router.patch('/projects/:id', h(async (req, res) => {
  const clientId = scopeOf(req)
  const project = await mustOwn(req, clientId)

  const name = req.body?.name === undefined ? project.name : validName(req.body.name)
  const description = req.body?.description === undefined
    ? project.description
    : validDescription(req.body.description)

  await withTx(async (tx) => {
    // The revision lands in the same transaction as the edit, so a change and
    // its history are never separable.
    if (name !== project.name) {
      await recordRevision(tx, project.id, req.portalUser.id, 'name', project.name, name)
    }
    if (description !== project.description) {
      await recordRevision(tx, project.id, req.portalUser.id, 'description', project.description, description)
    }
    await q(tx, 'UPDATE projects SET name = ?, description = ? WHERE id = ? AND client_id = ?',
      [name, description, project.id, clientId])
  })

  await audit(req, 'project_edited', { user: req.portalUser, clientId, detail: name })
  res.json(await projectDetail(clientId, project.id, req.portalUser.id))
}))

router.post('/projects/:id/links', h(async (req, res) => {
  const clientId = scopeOf(req)
  const project = await mustOwn(req, clientId)
  const label = String(req.body?.label ?? '').trim()
  const url = String(req.body?.url ?? '').trim()
  if (!label) throw httpError(400, 'a label is required')
  try { new URL(url) } catch { throw httpError(400, 'url is not well formed') }

  const link = await q1(null,
    'INSERT INTO asset_links (project_id, label, url) VALUES (?,?,?) RETURNING *',
    [project.id, label, url])
  await audit(req, 'link_added', { user: req.portalUser, clientId, detail: `${project.name}: ${label}` })
  res.json({ id: link.id, label: link.label, url: link.url })
}))

router.post('/projects/:id/comments', h(async (req, res) => {
  const clientId = scopeOf(req)
  const project = await mustOwn(req, clientId)
  const { body, error } = validComment(req.body?.body)
  if (error) throw httpError(400, error)

  await addComment(null, project.id, req.portalUser.id, body)
  await markRead(project.id, req.portalUser.id)
  await audit(req, 'comment', { user: req.portalUser, clientId, detail: project.name })
  res.json(await listComments(project.id, req.portalUser.id))
}))

router.post('/projects/:id/read', h(async (req, res) => {
  const clientId = scopeOf(req)
  const project = await mustOwn(req, clientId)
  await markRead(project.id, req.portalUser.id)
  res.json({ ok: true })
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
    projects: await breakdown({ clientId, from, to, projectId, money: await moneyPolicy(clientId) }),
  })
}))

export default router
