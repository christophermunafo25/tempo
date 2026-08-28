// Read-only company view behind a bearer link. Every read goes through
// portal-query.js, the same helpers the logged-in portal uses, so the
// published-only rule and the company scope are defined in exactly one place
// and this surface inherits any change to them.

import express from 'express'
import { h, httpError } from '../http.js'
import { requireShareLink, shareScope } from '../share.js'
import { audit } from '../auth.js'
import {
  listSessions, breakdown, listProjects, ownedProject, resolveRange, summaryFor, moneyPolicy,
  pulse,
} from '../portal-query.js'

const router = express.Router()

const MAX_PER_PAGE = 100

router.use(h(async (req, res, next) => {
  // A share URL is meant to be pasted into an email, not crawled or cached by
  // an intermediary, and must not leak into the Referer of anything it links to.
  res.set('X-Robots-Tag', 'noindex, nofollow')
  res.set('Referrer-Policy', 'no-referrer')
  res.set('Cache-Control', 'no-store')

  // Read-only by construction rather than by there happening to be no write
  // routes. With no writes, the gate's Origin check isn't load-bearing here
  // and CSRF has no surface at all.
  if (req.method !== 'GET' && req.method !== 'HEAD') throw httpError(404, 'not found')
  next()
}))

router.use('/:token', h(async (req, res, next) => {
  req.shareLink = await requireShareLink(req, res)
  next()
}))

// Notes follow the link's own setting; money follows the company's toggle.
// Both resolved once per request and handed to portal-query, never decided in
// a template.
const readOptions = async (req) => ({
  notes: !!req.shareLink.shows_notes,
  money: await moneyPolicy(shareScope(req)),
})

// A project filter resolves through the link's own company, so another
// company's id is not an error to explain — it simply isn't here.
async function resolveProjectFilter(req, clientId) {
  if (!req.query.project_id) return null
  const project = await ownedProject(clientId, req.query.project_id)
  if (!project) throw httpError(404, 'not found')
  return project.id
}

function pageParams(req) {
  const perPage = Math.min(MAX_PER_PAGE, Math.max(1, Number(req.query.per_page) || 25))
  const page = Math.max(1, Number(req.query.page) || 1)
  return { limit: perPage, offset: (page - 1) * perPage, page, perPage }
}

router.get('/:token/summary', h(async (req, res) => {
  res.json(await summaryFor(shareScope(req), await readOptions(req)))
}))

router.get('/:token/pulse', h(async (req, res) => {
  res.json({ signature: await pulse({ clientId: shareScope(req) }) })
}))

router.get('/:token/sessions', h(async (req, res) => {
  const clientId = shareScope(req)
  const projectId = await resolveProjectFilter(req, clientId)
  const { from, to } = resolveRange(req.query)
  const { limit, offset, page, perPage } = pageParams(req)

  const result = await listSessions({
    clientId, from, to, projectId, limit, offset, ...(await readOptions(req)),
  })
  res.json({ ...result, page, per_page: perPage })
}))

router.get('/:token/projects', h(async (req, res) => {
  res.json(await listProjects(shareScope(req)))
}))

router.get('/:token/breakdown', h(async (req, res) => {
  const clientId = shareScope(req)
  const projectId = await resolveProjectFilter(req, clientId)
  const { from, to } = resolveRange(req.query)

  res.json({
    estimate: true,
    basis: 'Each session is split evenly across the projects worked on in it.',
    projects: await breakdown({
      clientId, from, to, projectId, money: await moneyPolicy(clientId),
    }),
  })
}))

// The logged-in portal makes this a POST because it writes an audit row. Here
// the surface is GET-only on purpose, so this is a GET that happens to log —
// the write is a record of the read, not state the caller controls.
router.get('/:token/export', h(async (req, res) => {
  const clientId = shareScope(req)
  const projectId = await resolveProjectFilter(req, clientId)
  const { from, to } = resolveRange(req.query)

  const result = await listSessions({
    clientId, from, to, projectId, ...(await readOptions(req)),
  })
  await audit(req, 'export', {
    clientId,
    detail: `share link${req.shareLink.label ? ` "${req.shareLink.label}"` : ''}: ` +
      `${result.total} session(s)` +
      `${req.query.from ? ` from ${req.query.from}` : ''}${req.query.to ? ` to ${req.query.to}` : ''}` +
      `${projectId ? ` project ${projectId}` : ''}`,
  })
  res.json(result)
}))

export default router
