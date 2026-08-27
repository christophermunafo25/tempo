// Owner-side portal management: who can sign in, what they can see, and what
// gets published to them.
//
// Mounted at /api/access, which the gate treats as owner-only by default —
// deliberately not /api/portal-something, so it can never sit adjacent to the
// client prefix in a path matcher.

import express from 'express'
import { q, q1, withTx } from '../db.js'
import { h, httpError } from '../http.js'
import {
  normEmail, audit, revokeAllSessions,
  issueOneTimeToken, burnOutstanding, TOKEN_TTL,
} from '../auth.js'
import { listComments, addComment, markRead, validComment } from '../portal-query.js'

const router = express.Router()
const nowISO = () => new Date().toISOString()

const inviteLink = (token) => `/portal/set-password?t=${token}`

const flag = (value, fallback) => (value === undefined ? fallback : (value ? 1 : 0))

async function contactsFor(clientId) {
  return q(null, `
    SELECT id, email, name, is_active, last_login_at, created_at,
           CASE WHEN password_hash IS NOT NULL THEN 1 ELSE 0 END AS has_password
    FROM portal_users
    WHERE client_id = ? AND role = 'client'
    ORDER BY email`, [clientId])
}

// An outstanding invite is one that is unused and still in date. Shown so the
// owner can tell "invited, waiting" apart from "never invited".
async function pendingInvites(ids) {
  if (!ids.length) return new Set()
  const rows = await q(null, `
    SELECT DISTINCT portal_user_id FROM portal_tokens
    WHERE kind = 'invite' AND used_at IS NULL AND expires_at > ?`, [nowISO()])
  return new Set(rows.map(r => r.portal_user_id))
}

/* ── Companies and contacts ──────────────────────────────────────────── */

router.get('/clients', h(async (req, res) => {
  const clients = await q(null, `
    SELECT id, name, color_accent, is_active, weekly_hours_target,
           portal_enabled, portal_shows_rates
    FROM clients ORDER BY name`)
  const out = []
  for (const client of clients) {
    const contacts = await contactsFor(client.id)
    const pending = await pendingInvites(contacts.map(c => c.id))
    out.push({
      ...client,
      contacts: contacts.map(c => ({ ...c, invite_pending: pending.has(c.id) ? 1 : 0 })),
    })
  }
  res.json(out)
}))

// Deliberately separate from PATCH /api/clients/:id so that route stays exactly
// as it was. This one touches the two portal columns and nothing else.
router.patch('/clients/:id', h(async (req, res) => {
  const client = await q1(null, 'SELECT * FROM clients WHERE id = ?', [req.params.id])
  if (!client) throw httpError(404, 'client not found')
  const updated = await q1(null,
    'UPDATE clients SET portal_enabled = ?, portal_shows_rates = ? WHERE id = ? RETURNING *',
    [flag(req.body.portal_enabled, client.portal_enabled),
     flag(req.body.portal_shows_rates, client.portal_shows_rates),
     client.id])
  await audit(req, 'portal_toggled', {
    user: req.portalUser,
    clientId: client.id,
    detail: `portal_enabled=${updated.portal_enabled} portal_shows_rates=${updated.portal_shows_rates}`,
  })
  res.json(updated)
}))

/* ── Invites ─────────────────────────────────────────────────────────── */

router.post('/invite', h(async (req, res) => {
  const email = normEmail(req.body?.email)
  if (!email.includes('@')) throw httpError(400, 'a valid email is required')
  const client = await q1(null, 'SELECT * FROM clients WHERE id = ?', [req.body?.client_id])
  if (!client) throw httpError(404, 'client not found')

  // Email is globally unique, so the same address can't hold logins for two
  // companies. Saying so plainly beats a unique-constraint error.
  const existing = await q1(null, 'SELECT * FROM portal_users WHERE email = ?', [email])
  if (existing && existing.client_id !== client.id) {
    throw httpError(409, 'that email already has access to another company')
  }

  const user = await withTx(async (tx) => {
    let user = existing
    if (!user) {
      user = await q1(tx, `
        INSERT INTO portal_users (client_id, email, role, name)
        VALUES (?,?,?,?) RETURNING *`,
        [client.id, email, 'client', String(req.body?.name || '').trim()])
    }
    // Turning on access for a company the moment its first contact is invited
    // saves a second step that would be easy to forget.
    await q(tx, 'UPDATE clients SET portal_enabled = 1 WHERE id = ?', [client.id])
    return user
  })

  await burnOutstanding(user.id, 'invite')
  const token = await issueOneTimeToken(user.id, 'invite', TOKEN_TTL.invite)
  await audit(req, 'invite_sent', { user: req.portalUser, clientId: client.id, detail: email })

  res.json({ user, link: inviteLink(token), expires_in_days: TOKEN_TTL.invite / 86400000 })
}))

router.post('/invite/:id/resend', h(async (req, res) => {
  const user = await q1(null, "SELECT * FROM portal_users WHERE id = ? AND role = 'client'",
    [req.params.id])
  if (!user) throw httpError(404, 'contact not found')

  // Exactly one invite link is ever live per contact.
  await burnOutstanding(user.id, 'invite')
  const token = await issueOneTimeToken(user.id, 'invite', TOKEN_TTL.invite)
  await audit(req, 'invite_sent', { user: req.portalUser, clientId: user.client_id, detail: user.email })

  res.json({ user, link: inviteLink(token), expires_in_days: TOKEN_TTL.invite / 86400000 })
}))

/* ── Access ──────────────────────────────────────────────────────────── */

// Soft, like every other delete here. The row and its audit trail stay; the
// person just can't sign in. Their live cookies die on the next request.
router.post('/users/:id/revoke', h(async (req, res) => {
  const user = await q1(null, 'SELECT * FROM portal_users WHERE id = ?', [req.params.id])
  if (!user) throw httpError(404, 'contact not found')
  if (user.role === 'owner') throw httpError(400, 'owner accounts can’t be revoked here')

  await q(null, 'UPDATE portal_users SET is_active = 0 WHERE id = ?', [user.id])
  await revokeAllSessions(user.id)
  await burnOutstanding(user.id, 'invite')
  await burnOutstanding(user.id, 'reset')
  await audit(req, 'revoked', { user: req.portalUser, clientId: user.client_id, detail: user.email })

  res.json(await q1(null, 'SELECT * FROM portal_users WHERE id = ?', [user.id]))
}))

router.post('/users/:id/restore', h(async (req, res) => {
  const user = await q1(null, 'SELECT * FROM portal_users WHERE id = ?', [req.params.id])
  if (!user) throw httpError(404, 'contact not found')
  if (user.role === 'owner') throw httpError(400, 'owner accounts can’t be changed here')

  await q(null, 'UPDATE portal_users SET is_active = 1 WHERE id = ?', [user.id])
  await audit(req, 'restored', { user: req.portalUser, clientId: user.client_id, detail: user.email })
  res.json(await q1(null, 'SELECT * FROM portal_users WHERE id = ?', [user.id]))
}))

/* ── Publishing ──────────────────────────────────────────────────────────
   Nothing a client can see moves without one of these two routes. */

router.post('/publish', h(async (req, res) => {
  const { client_id, from, to } = req.body || {}
  const publish = req.body?.publish ? 1 : 0
  const client = await q1(null, 'SELECT * FROM clients WHERE id = ?', [client_id])
  if (!client) throw httpError(404, 'client not found')
  if (!from || !to) throw httpError(400, 'from and to are required')
  if (isNaN(new Date(from).getTime()) || isNaN(new Date(to).getTime())) {
    throw httpError(400, 'from and to must be valid times')
  }

  const where = `client_id = ? AND clock_out IS NOT NULL AND clock_in >= ? AND clock_in < ?`
  const args = [client.id, from, to]
  const { n } = await q1(null, `SELECT COUNT(*) AS n FROM sessions WHERE ${where}`, args)
  await q(null, `UPDATE sessions SET is_published = ? WHERE ${where}`, [publish, ...args])
  await audit(req, 'publish', {
    user: req.portalUser,
    clientId: client.id,
    detail: `${publish ? 'published' : 'unpublished'} ${n} session(s) ${from}..${to}`,
  })

  res.json({ affected: Number(n), is_published: publish })
}))

router.patch('/sessions/:id', h(async (req, res) => {
  const session = await q1(null, 'SELECT * FROM sessions WHERE id = ?', [req.params.id])
  if (!session) throw httpError(404, 'session not found')
  const publish = req.body?.is_published ? 1 : 0
  const updated = await q1(null,
    'UPDATE sessions SET is_published = ? WHERE id = ? RETURNING *', [publish, session.id])
  await audit(req, 'publish', {
    user: req.portalUser,
    clientId: session.client_id,
    detail: `${publish ? 'published' : 'unpublished'} session ${session.id}`,
  })
  res.json(updated)
}))

/* ── Requests ────────────────────────────────────────────────────────────
   Projects a client submitted. They exist as real rows from the moment they
   are created, but §1.3 keeps them out of the board, archive, project list and
   clock-out prefill until they are accepted. */

router.get('/requests', h(async (req, res) => {
  res.json(await q(null, `
    SELECT p.id, p.name, p.description, p.created_at, p.portal_request,
           c.id AS client_id, c.name AS client_name, c.color_accent,
           u.email AS requested_by_email, u.name AS requested_by_name
    FROM projects p
    JOIN clients c ON c.id = p.client_id
    LEFT JOIN portal_users u ON u.id = p.requested_by
    WHERE p.portal_request IS NOT NULL
    ORDER BY p.created_at DESC, p.id DESC`))
}))

router.post('/requests/:id/accept', h(async (req, res) => {
  const project = await q1(null, 'SELECT * FROM projects WHERE id = ?', [req.params.id])
  if (!project || project.portal_request !== 'pending') throw httpError(404, 'request not found')

  await withTx(async (tx) => {
    await q(tx, 'UPDATE projects SET portal_request = NULL WHERE id = ?', [project.id])
    await q(tx, 'INSERT INTO status_events (project_id, status, source) VALUES (?,?,?)',
      [project.id, project.status, 'accepted'])
  })
  await audit(req, 'request_accepted', {
    user: req.portalUser, clientId: project.client_id, detail: project.name,
  })

  res.json(await q1(null, 'SELECT * FROM projects WHERE id = ?', [project.id]))
}))

// Soft: the row stays and the client keeps seeing it, marked declined.
router.post('/requests/:id/decline', h(async (req, res) => {
  const project = await q1(null, 'SELECT * FROM projects WHERE id = ?', [req.params.id])
  if (!project || project.portal_request !== 'pending') throw httpError(404, 'request not found')

  await q(null, "UPDATE projects SET portal_request = 'declined' WHERE id = ?", [project.id])
  await audit(req, 'request_declined', {
    user: req.portalUser,
    clientId: project.client_id,
    detail: `${project.name}: ${String(req.body?.reason || '').slice(0, 500)}`,
  })

  res.json(await q1(null, 'SELECT * FROM projects WHERE id = ?', [project.id]))
}))

/* ── Threads ─────────────────────────────────────────────────────────────
   The owner half of the client comment threads. A comment feature where the
   owner never learns a comment arrived is a dead feature, so this carries an
   unread count — the only concession to notification. Nothing here sends
   email, push or webhooks. */

router.get('/threads', h(async (req, res) => {
  const viewerId = req.portalUser.id
  const rows = await q(null, `
    SELECT p.id, p.name, p.portal_request,
           c.id AS client_id, c.name AS client_name, c.color_accent,
           (SELECT COUNT(*) FROM project_comments x
             WHERE x.project_id = p.id AND x.deleted_at IS NULL) AS comment_count,
           (SELECT MAX(x.created_at) FROM project_comments x
             WHERE x.project_id = p.id AND x.deleted_at IS NULL) AS last_comment_at,
           (SELECT COUNT(*) FROM project_comments x
             LEFT JOIN project_comment_reads r
               ON r.project_id = x.project_id AND r.portal_user_id = ?
            WHERE x.project_id = p.id AND x.deleted_at IS NULL
              AND x.portal_user_id != ?
              AND (r.last_read_at IS NULL OR x.created_at > r.last_read_at)) AS unread_count
    FROM projects p
    JOIN clients c ON c.id = p.client_id
    WHERE EXISTS (SELECT 1 FROM project_comments y WHERE y.project_id = p.id)
    ORDER BY last_comment_at DESC`, [viewerId, viewerId])

  res.json(rows.map(r => ({
    ...r,
    comment_count: Number(r.comment_count || 0),
    unread_count: Number(r.unread_count || 0),
  })))
}))

router.get('/projects/:id/comments', h(async (req, res) => {
  const project = await q1(null, 'SELECT id FROM projects WHERE id = ?', [req.params.id])
  if (!project) throw httpError(404, 'project not found')
  res.json(await listComments(project.id, req.portalUser.id))
}))

router.post('/projects/:id/comments', h(async (req, res) => {
  const project = await q1(null, 'SELECT * FROM projects WHERE id = ?', [req.params.id])
  if (!project) throw httpError(404, 'project not found')
  const { body, error } = validComment(req.body?.body)
  if (error) throw httpError(400, error)

  await addComment(null, project.id, req.portalUser.id, body)
  await markRead(project.id, req.portalUser.id)
  await audit(req, 'comment', {
    user: req.portalUser, clientId: project.client_id, detail: project.name,
  })
  res.json(await listComments(project.id, req.portalUser.id))
}))

router.post('/projects/:id/read', h(async (req, res) => {
  const project = await q1(null, 'SELECT id FROM projects WHERE id = ?', [req.params.id])
  if (!project) throw httpError(404, 'project not found')
  await markRead(project.id, req.portalUser.id)
  res.json({ ok: true })
}))

/* ── Audit ───────────────────────────────────────────────────────────────
   Also where reset links surface: /api/auth/forgot has no mail transport, so
   it records the link here for the owner to relay by hand. */

router.get('/audit', h(async (req, res) => {
  res.json(await q(null, `
    SELECT a.id, a.action, a.detail, a.ip, a.created_at,
           u.email AS actor_email, c.name AS client_name
    FROM portal_audit a
    LEFT JOIN portal_users u ON u.id = a.portal_user_id
    LEFT JOIN clients c ON c.id = a.client_id
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT 100`))
}))

export default router
