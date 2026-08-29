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
  mintToken, hashToken,
} from '../auth.js'
import { listComments, addComment, markRead, validComment } from '../portal-query.js'

const router = express.Router()
const nowISO = () => new Date().toISOString()

const inviteLink = (token) => `/portal/set-password?t=${token}`

const flag = (value, fallback) => (value === undefined ? fallback : (value ? 1 : 0))

async function shareLinksFor(clientId) {
  const rows = await q(null, `
    SELECT id, label, shows_notes, expires_at, revoked_at,
           last_viewed_at, view_count, created_at
    FROM portal_share_links
    WHERE client_id = ?
    ORDER BY id DESC`, [clientId])

  return rows.map(l => ({
    ...l,
    state: l.revoked_at ? 'revoked'
      : (l.expires_at && new Date(l.expires_at).getTime() <= Date.now()) ? 'expired'
      : 'active',
  }))
}

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
           portal_enabled, portal_shows_rates, hourly_rate
    FROM clients ORDER BY name`)
  const out = []
  for (const client of clients) {
    const contacts = await contactsFor(client.id)
    const pending = await pendingInvites(contacts.map(c => c.id))
    out.push({
      ...client,
      contacts: contacts.map(c => ({ ...c, invite_pending: pending.has(c.id) ? 1 : 0 })),
      share_links: await shareLinksFor(client.id),
      unpriced_published: Number((await q1(null, `
        SELECT COUNT(*) AS n FROM sessions
        WHERE client_id = ? AND is_published = 1 AND rate_applied IS NULL
          AND deleted_at IS NULL`,
        [client.id]))?.n || 0),
      // Completed work this company cannot see. Sessions now publish
      // themselves as they are logged for a portal-enabled company, so this
      // counts a backlog rather than a queue: work that predates the portal
      // being switched on, or the auto-publish behaviour itself.
      unpublished: Number((await q1(null, `
        SELECT COUNT(*) AS n FROM sessions
        WHERE client_id = ? AND is_published = 0 AND clock_out IS NOT NULL
          AND deleted_at IS NULL`,
        [client.id]))?.n || 0),
    })
  }
  res.json(out)
}))

const NAME_MAX = 120
const HEX = /^#[0-9a-fA-F]{6}$/

// Deliberately separate from PATCH /api/clients/:id so that route stays exactly
// as it was. Fields are read by name; anything else in the body is ignored.
router.patch('/clients/:id', h(async (req, res) => {
  const client = await q1(null, 'SELECT * FROM clients WHERE id = ?', [req.params.id])
  if (!client) throw httpError(404, 'client not found')

  let name = client.name
  if (req.body.name !== undefined) {
    name = String(req.body.name).trim()
    // An empty name would render as a blank row everywhere a client is listed.
    if (!name) throw httpError(400, 'a client needs a name')
    if (name.length > NAME_MAX) throw httpError(400, `a name can’t be longer than ${NAME_MAX} characters`)
  }

  let color = client.color_accent
  if (req.body.color_accent !== undefined) {
    color = String(req.body.color_accent).trim()
    if (!HEX.test(color)) throw httpError(400, 'accent colour must be a hex value like #6B93C4')
  }

  // Changing the rate affects only sessions published afterwards. Work a
  // client has already been shown keeps the number it was shown, unless the
  // owner deliberately re-applies it (below).
  let rate = client.hourly_rate
  if (req.body.hourly_rate !== undefined) {
    // null is not zero: JSON turns NaN and Infinity into null, so accepting it
    // would let a malformed number quietly wipe a company's rate.
    if (req.body.hourly_rate === null) throw httpError(400, 'hourly rate must be a number')
    rate = Number(req.body.hourly_rate)
    if (!Number.isFinite(rate) || rate < 0 || rate > 100000) {
      throw httpError(400, 'hourly rate must be a number between 0 and 100000')
    }
    rate = Math.round(rate * 100) / 100
  }

  const updated = await q1(null, `
    UPDATE clients SET name = ?, color_accent = ?, hourly_rate = ?,
                       portal_enabled = ?, portal_shows_rates = ?
    WHERE id = ? RETURNING *`,
    [name, color, rate,
     flag(req.body.portal_enabled, client.portal_enabled),
     flag(req.body.portal_shows_rates, client.portal_shows_rates),
     client.id])

  // One audit row per actual change: renaming a company mid-contract is
  // exactly the kind of thing worth being able to trace back later.
  if (updated.name !== client.name) {
    await audit(req, 'client_renamed', {
      user: req.portalUser, clientId: client.id,
      detail: `${client.name} → ${updated.name}`,
    })
  }
  if (updated.hourly_rate !== client.hourly_rate) {
    await audit(req, 'rate_changed', {
      user: req.portalUser, clientId: client.id,
      detail: `${client.hourly_rate} → ${updated.hourly_rate} (applies to work published from now on)`,
    })
  }
  if (updated.color_accent !== client.color_accent) {
    await audit(req, 'client_recoloured', {
      user: req.portalUser, clientId: client.id,
      detail: `${client.color_accent} → ${updated.color_accent}`,
    })
  }
  if (updated.portal_enabled !== client.portal_enabled ||
      updated.portal_shows_rates !== client.portal_shows_rates) {
    await audit(req, 'portal_toggled', {
      user: req.portalUser,
      clientId: client.id,
      detail: `portal_enabled=${updated.portal_enabled} portal_shows_rates=${updated.portal_shows_rates}`,
    })
  }

  res.json(updated)
}))

/* ── Share links ─────────────────────────────────────────────────────────
   A share link is a bearer credential: whoever holds the URL has the access.
   Only the SHA-256 hash is stored, exactly as invites and resets are, which
   means the URL can be shown once and never again. Losing it means rotating,
   not looking it up — the same trade the invite flow already makes, and the
   reason each link carries a label. */

const SHARE_MAX_DAYS = 3650

function expiryFrom(value, fallback = null) {
  if (value === undefined) return fallback
  if (value === null) return null                     // an explicit "never"
  const days = Number(value)
  if (!Number.isFinite(days) || days <= 0 || days > SHARE_MAX_DAYS) {
    throw httpError(400, 'expiry must be a positive number of days, or null for never')
  }
  return new Date(Date.now() + days * 86400000).toISOString()
}

const shareUrl = (token) => `/s/${token}`

async function createLink({ clientId, label, expiresAt, showsNotes, ownerId }) {
  const token = mintToken()
  const row = await q1(null, `
    INSERT INTO portal_share_links
      (client_id, token_hash, label, shows_notes, expires_at, created_by)
    VALUES (?,?,?,?,?,?) RETURNING *`,
    [clientId, hashToken(token), label, showsNotes ? 1 : 0, expiresAt, ownerId])
  return { row, token }
}

router.post('/share-links', h(async (req, res) => {
  const client = await q1(null, 'SELECT * FROM clients WHERE id = ?', [req.body?.client_id])
  if (!client) throw httpError(404, 'client not found')

  const label = String(req.body?.label || '').trim().slice(0, 120)
  const expiresAt = expiryFrom(req.body?.expires_in_days, expiryFrom(90))
  const { row, token } = await createLink({
    clientId: client.id,
    label,
    expiresAt,
    showsNotes: req.body?.shows_notes !== false,
    ownerId: req.portalUser.id,
  })

  // Turning access on with the first link saves a second step that would be
  // easy to forget and would make the link 404 for no visible reason.
  if (!client.portal_enabled) {
    await q(null, 'UPDATE clients SET portal_enabled = 1 WHERE id = ?', [client.id])
  }

  await audit(req, 'share_link_created', {
    user: req.portalUser, clientId: client.id, detail: label || '(unlabelled)',
  })
  res.json({ link: row, url_path: shareUrl(token) })
}))

router.patch('/share-links/:id', h(async (req, res) => {
  const link = await q1(null, 'SELECT * FROM portal_share_links WHERE id = ?', [req.params.id])
  if (!link) throw httpError(404, 'share link not found')

  const label = req.body?.label === undefined
    ? link.label
    : String(req.body.label).trim().slice(0, 120)
  const showsNotes = req.body?.shows_notes === undefined
    ? link.shows_notes
    : (req.body.shows_notes ? 1 : 0)
  const expiresAt = expiryFrom(req.body?.expires_in_days, link.expires_at)

  const updated = await q1(null, `
    UPDATE portal_share_links SET label = ?, shows_notes = ?, expires_at = ?
    WHERE id = ? RETURNING *`, [label, showsNotes, expiresAt, link.id])

  if (req.body?.expires_in_days !== undefined) {
    await audit(req, 'share_link_renewed', {
      user: req.portalUser, clientId: link.client_id,
      detail: `${link.label || '(unlabelled)'} → ${expiresAt || 'never expires'}`,
    })
  }
  res.json(updated)
}))

// Soft, like every other delete here. The row stays so the audit trail and the
// last-viewed record survive, and the URL stops working immediately.
router.post('/share-links/:id/revoke', h(async (req, res) => {
  const link = await q1(null, 'SELECT * FROM portal_share_links WHERE id = ?', [req.params.id])
  if (!link) throw httpError(404, 'share link not found')
  if (link.revoked_at) return res.json(link)

  const updated = await q1(null,
    'UPDATE portal_share_links SET revoked_at = ? WHERE id = ? RETURNING *',
    [nowISO(), link.id])
  await audit(req, 'share_link_revoked', {
    user: req.portalUser, clientId: link.client_id, detail: link.label || '(unlabelled)',
  })
  res.json(updated)
}))

// Rotation revokes the old row and issues a new one carrying the same label
// and settings, rather than swapping the token on the row in place. The point
// of rotating is usually that a URL leaked, and that is worth being able to
// see afterwards: when it was minted, when it was last opened, when it died.
router.post('/share-links/:id/rotate', h(async (req, res) => {
  const link = await q1(null, 'SELECT * FROM portal_share_links WHERE id = ?', [req.params.id])
  if (!link) throw httpError(404, 'share link not found')

  await q(null, 'UPDATE portal_share_links SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
    [nowISO(), link.id])
  const { row, token } = await createLink({
    clientId: link.client_id,
    label: link.label,
    expiresAt: link.expires_at,
    showsNotes: link.shows_notes,
    ownerId: req.portalUser.id,
  })

  await audit(req, 'share_link_rotated', {
    user: req.portalUser, clientId: link.client_id, detail: link.label || '(unlabelled)',
  })
  res.json({ link: row, url_path: shareUrl(token) })
}))

/* ── Archiving ───────────────────────────────────────────────────────────
   Soft, like everything else here. The clients row, its projects, its sessions
   and its entries all stay exactly where they are — archiving only removes the
   company from view. Restoring brings all of it back untouched.

   Archived companies drop out of the whole owner-facing app, totals included,
   which is what keeps the visible rows and the totals reconciling. The cost,
   accepted deliberately: a week you already invoiced will render differently
   afterwards, and its CSV will change. */

router.post('/clients/:id/archive', h(async (req, res) => {
  const client = await q1(null, 'SELECT * FROM clients WHERE id = ?', [req.params.id])
  if (!client) throw httpError(404, 'client not found')

  // Archiving mid-session would make the running clock vanish from the Clock
  // screen with no way to close it out.
  const running = await q1(null,
    `SELECT id FROM sessions WHERE client_id = ? AND clock_out IS NULL
       AND deleted_at IS NULL`, [client.id])
  if (running) throw httpError(409, 'clock out of this client before archiving them')

  const updated = await q1(null,
    'UPDATE clients SET is_active = 0 WHERE id = ? RETURNING *', [client.id])
  await audit(req, 'client_archived', {
    user: req.portalUser, clientId: client.id, detail: client.name,
  })
  res.json(updated)
}))

router.post('/clients/:id/restore', h(async (req, res) => {
  const client = await q1(null, 'SELECT * FROM clients WHERE id = ?', [req.params.id])
  if (!client) throw httpError(404, 'client not found')
  const updated = await q1(null,
    'UPDATE clients SET is_active = 1 WHERE id = ? RETURNING *', [client.id])
  await audit(req, 'client_restored', {
    user: req.portalUser, clientId: client.id, detail: client.name,
  })
  res.json(updated)
}))

// What archiving would hide, so the confirmation can say so rather than making
// the owner guess.
router.get('/clients/:id/impact', h(async (req, res) => {
  const client = await q1(null, 'SELECT * FROM clients WHERE id = ?', [req.params.id])
  if (!client) throw httpError(404, 'client not found')
  const one = async (sql) => Number((await q1(null, sql, [client.id]))?.n || 0)
  res.json({
    sessions: await one(
      'SELECT COUNT(*) AS n FROM sessions WHERE client_id = ? AND deleted_at IS NULL'),
    minutes: Number((await q1(null,
      `SELECT COALESCE(SUM(duration_minutes),0) AS n FROM sessions
       WHERE client_id = ? AND deleted_at IS NULL`,
      [client.id]))?.n || 0),
    projects: await one('SELECT COUNT(*) AS n FROM projects WHERE client_id = ?'),
    contacts: await one("SELECT COUNT(*) AS n FROM portal_users WHERE client_id = ? AND role = 'client'"),
    running: await one(`SELECT COUNT(*) AS n FROM sessions
      WHERE client_id = ? AND clock_out IS NULL AND deleted_at IS NULL`),
  })
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

  const where = `client_id = ? AND clock_out IS NOT NULL AND deleted_at IS NULL
    AND clock_in >= ? AND clock_in < ?`
  const args = [client.id, from, to]
  const { n } = await q1(null, `SELECT COUNT(*) AS n FROM sessions WHERE ${where}`, args)
  await q(null, `UPDATE sessions SET is_published = ? WHERE ${where}`, [publish, ...args])

  // Stamp the rate only where none is set. Publishing is the moment a number
  // becomes something a client can budget against, and un-publishing and
  // re-publishing must not quietly reprice it at whatever the rate happens to
  // be later. Deliberate repricing is the explicit action below.
  if (publish && Number(client.hourly_rate) > 0) {
    await q(null, `UPDATE sessions SET rate_applied = ?
      WHERE ${where} AND rate_applied IS NULL`, [client.hourly_rate, ...args])
  }
  await audit(req, 'publish', {
    user: req.portalUser,
    clientId: client.id,
    detail: `${publish ? 'published' : 'unpublished'} ${n} session(s) ${from}..${to}`,
  })

  res.json({ affected: Number(n), is_published: publish })
}))

router.patch('/sessions/:id', h(async (req, res) => {
  const session = await q1(null,
    'SELECT * FROM sessions WHERE id = ? AND deleted_at IS NULL', [req.params.id])
  if (!session) throw httpError(404, 'session not found')
  const publish = req.body?.is_published ? 1 : 0
  if (publish && session.rate_applied == null) {
    const client = await q1(null, 'SELECT hourly_rate FROM clients WHERE id = ?', [session.client_id])
    if (Number(client?.hourly_rate) > 0) {
      await q(null, 'UPDATE sessions SET rate_applied = ? WHERE id = ? AND rate_applied IS NULL',
        [client.hourly_rate, session.id])
    }
  }
  const updated = await q1(null,
    'UPDATE sessions SET is_published = ? WHERE id = ? RETURNING *', [publish, session.id])
  await audit(req, 'publish', {
    user: req.portalUser,
    clientId: session.client_id,
    detail: `${publish ? 'published' : 'unpublished'} session ${session.id}`,
  })
  res.json(updated)
}))

/* ── Applying a rate to work already published ───────────────────────────
   Deliberately a button rather than something that happens on its own. A
   silent backfill of billing data is the kind of thing that goes unnoticed
   until it is wrong, and repricing work a client has already budgeted against
   should take a decision. */

router.get('/clients/:id/rate-impact', h(async (req, res) => {
  const client = await q1(null, 'SELECT * FROM clients WHERE id = ?', [req.params.id])
  if (!client) throw httpError(404, 'client not found')
  const one = async (extra) => Number((await q1(null,
    `SELECT COUNT(*) AS n FROM sessions
     WHERE client_id = ? AND is_published = 1 AND clock_out IS NOT NULL
       AND deleted_at IS NULL ${extra}`,
    [client.id]))?.n || 0)

  res.json({
    hourly_rate: client.hourly_rate,
    unpriced: await one('AND rate_applied IS NULL'),
    priced: await one('AND rate_applied IS NOT NULL'),
    at_current_rate: await one(`AND rate_applied = ${Number(client.hourly_rate) || 0}`),
  })
}))

router.post('/clients/:id/apply-rate', h(async (req, res) => {
  const client = await q1(null, 'SELECT * FROM clients WHERE id = ?', [req.params.id])
  if (!client) throw httpError(404, 'client not found')
  if (!(Number(client.hourly_rate) > 0)) {
    throw httpError(400, 'set an hourly rate for this company first')
  }

  // 'missing' fills in only what has never been priced — the backfill for work
  // published before rates existed. 'all' reprices everything published, which
  // changes numbers a client may already have seen, so it is never the default.
  const all = req.body?.mode === 'all'
  const where = `client_id = ? AND is_published = 1 AND clock_out IS NOT NULL
    AND deleted_at IS NULL` + (all ? '' : ' AND rate_applied IS NULL')

  const { n } = await q1(null, `SELECT COUNT(*) AS n FROM sessions WHERE ${where}`, [client.id])
  await q(null, `UPDATE sessions SET rate_applied = ? WHERE ${where}`, [client.hourly_rate, client.id])

  await audit(req, 'rate_applied', {
    user: req.portalUser, clientId: client.id,
    detail: `${client.hourly_rate} applied to ${n} ${all ? 'published' : 'unpriced'} session(s)`,
  })
  res.json({ affected: Number(n), hourly_rate: client.hourly_rate, mode: all ? 'all' : 'missing' })
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
