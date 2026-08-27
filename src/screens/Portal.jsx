import { useCallback, useEffect, useMemo, useState } from 'react'
import { get, post, patch } from '../api.js'
import { ClientDot, Checkbox, EmptyState, WeekStepper } from '../components/ui.jsx'
import Thread from '../components/Thread.jsx'
import { weekRange, fmtRange, fmtDate, fmtTime, fmtHours, localDayKey } from '../time.js'

const TABS = [
  { key: 'access', label: 'Access' },
  { key: 'publishing', label: 'Publishing' },
  { key: 'requests', label: 'Requests' },
  { key: 'threads', label: 'Messages' },
]

export default function Portal() {
  const [tab, setTab] = useState('access')
  const [clients, setClients] = useState([])
  const [requests, setRequests] = useState([])
  const [threads, setThreads] = useState([])

  const refreshClients = useCallback(() => get('/access/clients').then(setClients), [])
  const refreshRequests = useCallback(() => get('/access/requests').then(setRequests), [])
  const refreshThreads = useCallback(() => get('/access/threads').then(setThreads), [])

  useEffect(() => {
    refreshClients(); refreshRequests(); refreshThreads()
  }, [refreshClients, refreshRequests, refreshThreads])

  const pending = requests.filter(r => r.portal_request === 'pending').length
  const unread = threads.reduce((a, t) => a + t.unread_count, 0)

  return (
    <div className="screen">
      <h1 className="screen-title">Portal</h1>

      <div className="filterbar">
        <div className="seg">
          {TABS.map(t => (
            <button key={t.key} className={`seg-btn${tab === t.key ? ' active' : ''}`}
              onClick={() => setTab(t.key)}>
              {t.label}
              {t.key === 'requests' && pending > 0 && <span className="tab-badge">{pending}</span>}
              {t.key === 'threads' && unread > 0 && <span className="tab-badge">{unread}</span>}
            </button>
          ))}
        </div>
      </div>

      {tab === 'access' && <AccessTab clients={clients} onChange={refreshClients} />}
      {tab === 'publishing' && <PublishingTab clients={clients} />}
      {tab === 'requests' && <RequestsTab requests={requests} onChange={refreshRequests} />}
      {tab === 'threads' && <ThreadsTab threads={threads} onChange={refreshThreads} />}
    </div>
  )
}

/* ── Access ──────────────────────────────────────────────────────────── */

function AccessTab({ clients, onChange }) {
  if (!clients.length) return <EmptyState>No companies yet. Add one from the Clock screen.</EmptyState>
  return (
    <div className="portal-list">
      {clients.map((client, i) => (
        <CompanyCard key={client.id} client={client} onChange={onChange} style={{ '--i': i }} />
      ))}
    </div>
  )
}

function CompanyCard({ client, onChange, style }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [link, setLink] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const toggle = async (field, value) => {
    await patch(`/access/clients/${client.id}`, { [field]: value })
    onChange()
  }

  const invite = async (e) => {
    e.preventDefault()
    setError(''); setBusy(true)
    try {
      const res = await post('/access/invite', { client_id: client.id, email, name })
      setLink({ ...res, email })
      setEmail(''); setName('')
      onChange()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const act = async (path) => { await post(path); onChange() }

  const resend = async (contact) => {
    const res = await post(`/access/invite/${contact.id}/resend`)
    setLink({ ...res, email: contact.email })
    onChange()
  }

  return (
    <section className="card rise portal-card" style={style}>
      <header className="portal-card-head">
        <h2 className="portal-company">
          <ClientDot color={client.color_accent} size={10} />
          {client.name}
        </h2>
        <div className="portal-toggles">
          <label className="portal-toggle">
            <Checkbox checked={!!client.portal_enabled}
              onChange={() => toggle('portal_enabled', !client.portal_enabled)}
              label={`Portal access for ${client.name}`} />
            <span>Portal access</span>
          </label>
          {/* This flag has nothing to reveal yet — there is no rate column on
              clients. Kept visible but labelled so it isn't mistaken for live. */}
          <label className="portal-toggle">
            <Checkbox checked={!!client.portal_shows_rates}
              onChange={() => toggle('portal_shows_rates', !client.portal_shows_rates)}
              label={`Show rates to ${client.name}`} />
            <span>Show rates <em>(not wired up)</em></span>
          </label>
        </div>
      </header>

      {client.contacts.length > 0 && (
        <table className="portal-table">
          <thead>
            <tr>
              <th>Contact</th><th>Status</th><th>Last login</th><th />
            </tr>
          </thead>
          <tbody>
            {client.contacts.map(c => (
              <tr key={c.id} className={c.is_active ? '' : 'is-revoked'}>
                <td>
                  <div className="portal-contact">{c.email}</div>
                  {c.name && <div className="portal-contact-name">{c.name}</div>}
                </td>
                <td><ContactState contact={c} /></td>
                <td className="mono portal-dim">
                  {c.last_login_at ? fmtDate(c.last_login_at) : '—'}
                </td>
                <td className="portal-actions">
                  {c.is_active
                    ? <>
                        <button className="btn-ghost btn-sm" onClick={() => resend(c)}>
                          {c.has_password ? 'Reset link' : 'Resend'}
                        </button>
                        <button className="btn-ghost btn-sm portal-danger"
                          onClick={() => act(`/access/users/${c.id}/revoke`)}>Revoke</button>
                      </>
                    : <button className="btn-ghost btn-sm"
                        onClick={() => act(`/access/users/${c.id}/restore`)}>Restore</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form className="portal-invite" onSubmit={invite}>
        <input className="input" type="email" placeholder="contact@company.com" required
          value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="input" placeholder="Name (optional)"
          value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn btn-sm" type="submit" disabled={busy}>
          {busy ? 'Inviting…' : 'Invite'}
        </button>
      </form>
      {error && <p className="field-error">{error}</p>}

      {link && <LinkBox link={link} onDismiss={() => setLink(null)} />}
    </section>
  )
}

function ContactState({ contact }) {
  if (!contact.is_active) return <span className="pill">Revoked</span>
  if (!contact.has_password) {
    return <span className="pill">{contact.invite_pending ? 'Invited' : 'Invite expired'}</span>
  }
  return <span className="pill">Active</span>
}

// There is no mail transport in this build, so the one-time link is shown once
// for the owner to relay by hand.
function LinkBox({ link, onDismiss }) {
  const [copied, setCopied] = useState(false)
  const url = `${window.location.origin}${link.link}`

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="portal-linkbox">
      <div className="label">One-time link for {link.email}</div>
      <p className="portal-dim">
        Send this to them yourself — TEMPO doesn’t email. It works once and
        expires in {link.expires_in_days} days.
      </p>
      <div className="portal-linkrow">
        <input className="input mono" readOnly value={url} onFocus={(e) => e.target.select()} />
        <button className="btn btn-sm" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        <button className="btn-ghost btn-sm" onClick={onDismiss}>Done</button>
      </div>
    </div>
  )
}

/* ── Publishing ──────────────────────────────────────────────────────────
   Nothing a client can see moves without this screen. Sessions default to
   unpublished, including every session logged before the portal existed. */

function PublishingTab({ clients }) {
  const [clientId, setClientId] = useState(null)
  const [offset, setOffset] = useState(0)
  const [sessions, setSessions] = useState([])
  const [busy, setBusy] = useState(false)

  const range = useMemo(() => weekRange(offset), [offset])
  const enabled = clients.filter(c => c.portal_enabled)

  useEffect(() => {
    if (clientId == null && enabled.length) setClientId(enabled[0].id)
  }, [enabled, clientId])

  const refresh = useCallback(() => {
    if (clientId == null) return
    get(`/sessions?from=${range.from.toISOString()}&to=${range.to.toISOString()}&client_id=${clientId}`)
      .then(setSessions)
  }, [clientId, range])

  useEffect(() => { refresh() }, [refresh])

  const bulk = async (publish) => {
    setBusy(true)
    try {
      await post('/access/publish', {
        client_id: clientId,
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        publish,
      })
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const one = async (session) => {
    await patch(`/access/sessions/${session.id}`, { is_published: !session.is_published })
    refresh()
  }

  if (!enabled.length) {
    return <EmptyState>No company has portal access switched on yet. Turn one on under Access.</EmptyState>
  }

  const publishedCount = sessions.filter(s => s.is_published).length
  const total = sessions.reduce((a, s) => a + s.duration_minutes, 0)

  return (
    <>
      <div className="filterbar">
        {enabled.map(c => (
          <button key={c.id} className={`chip${clientId === c.id ? ' active' : ''}`}
            onClick={() => setClientId(c.id)}>
            <ClientDot color={c.color_accent} size={8} />
            {c.name}
          </button>
        ))}
        <span className="spacer" />
        <WeekStepper offset={offset} onChange={setOffset} range={range} />
      </div>

      <div className="card rise">
        <div className="portal-publish-head">
          <div>
            <div className="label">{fmtRange(range)}</div>
            <div className="portal-dim">
              {publishedCount} of {sessions.length} sessions visible · {fmtHours(total)} hrs logged
            </div>
          </div>
          <div className="portal-publish-actions">
            <button className="btn btn-sm" disabled={busy || !sessions.length}
              onClick={() => bulk(true)}>Publish week</button>
            <button className="btn btn-outline btn-sm" disabled={busy || !publishedCount}
              onClick={() => bulk(false)}>Unpublish week</button>
          </div>
        </div>

        {sessions.length === 0
          ? <EmptyState>No sessions for this company that week.</EmptyState>
          : (
            <table className="portal-table">
              <thead>
                <tr><th>Visible</th><th>Date</th><th>Time</th><th>Hours</th><th>Projects</th></tr>
              </thead>
              <tbody>
                {[...sessions].reverse().map(s => (
                  <tr key={s.id} className={s.is_published ? '' : 'is-unpublished'}>
                    <td>
                      <Checkbox checked={!!s.is_published} onChange={() => one(s)}
                        label={`Publish session on ${localDayKey(s.clock_in)}`} />
                    </td>
                    <td>{fmtDate(s.clock_in)}</td>
                    <td className="mono portal-dim">
                      {fmtTime(s.clock_in)}–{fmtTime(s.clock_out)}
                    </td>
                    <td className="mono">{fmtHours(s.duration_minutes)}</td>
                    <td className="portal-dim">
                      {s.entries.length
                        ? s.entries.map(e => e.project_name).join(', ')
                        : <em>untagged</em>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
    </>
  )
}

/* ── Requests ────────────────────────────────────────────────────────────
   Projects a client submitted. They are real rows, but they stay out of the
   Board, Archive, project list and clock-out prefill until accepted. */

function RequestsTab({ requests, onChange }) {
  const pending = requests.filter(r => r.portal_request === 'pending')
  const declined = requests.filter(r => r.portal_request === 'declined')

  if (!requests.length) {
    return <EmptyState>No project requests. They’ll appear here when a client submits one.</EmptyState>
  }

  return (
    <div className="portal-list">
      {pending.map((r, i) => (
        <RequestCard key={r.id} request={r} onChange={onChange} style={{ '--i': i }} />
      ))}
      {declined.length > 0 && (
        <section className="card rise">
          <div className="label">Declined</div>
          <table className="portal-table">
            <tbody>
              {declined.map(r => (
                <tr key={r.id} className="is-revoked">
                  <td>{r.name}</td>
                  <td className="portal-dim">{r.client_name}</td>
                  <td className="mono portal-dim">{fmtDate(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}

function RequestCard({ request, onChange, style }) {
  const [declining, setDeclining] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const run = async (fn) => {
    setBusy(true)
    try { await fn(); onChange() } finally { setBusy(false) }
  }

  return (
    <section className="card rise portal-card" style={style}>
      <header className="portal-card-head">
        <h2 className="portal-company">
          <ClientDot color={request.color_accent} size={10} />
          {request.name}
        </h2>
        <span className="pill">Requested</span>
      </header>

      <p className="portal-dim">
        {request.client_name} · {request.requested_by_name || request.requested_by_email} ·{' '}
        {fmtDate(request.created_at)}
      </p>
      {request.description && <p className="portal-brief">{request.description}</p>}

      {declining
        ? (
          <div className="portal-decline">
            <input className="input" autoFocus placeholder="Why? The client will see this."
              value={reason} onChange={(e) => setReason(e.target.value)} />
            <button className="btn btn-sm" disabled={busy}
              onClick={() => run(() => post(`/access/requests/${request.id}/decline`, { reason }))}>
              Decline
            </button>
            <button className="btn-ghost btn-sm" onClick={() => setDeclining(false)}>Cancel</button>
          </div>
        )
        : (
          <div className="portal-publish-actions">
            <button className="btn btn-sm" disabled={busy}
              onClick={() => run(() => post(`/access/requests/${request.id}/accept`))}>
              Accept into Board
            </button>
            <button className="btn btn-outline btn-sm" onClick={() => setDeclining(true)}>Decline</button>
          </div>
        )}
    </section>
  )
}

/* ── Messages ────────────────────────────────────────────────────────────
   The owner half of the client comment threads. Unread counts are the only
   notification in the system — nothing sends email, push or webhooks. */

function ThreadsTab({ threads, onChange }) {
  const [openId, setOpenId] = useState(null)

  if (!threads.length) {
    return <EmptyState>No messages yet. They’ll appear here when a client writes on a project.</EmptyState>
  }

  return (
    <div className="portal-list">
      {threads.map((t, i) => (
        <ThreadCard key={t.id} thread={t} open={openId === t.id}
          onOpen={() => setOpenId(openId === t.id ? null : t.id)}
          onChange={onChange} style={{ '--i': i }} />
      ))}
    </div>
  )
}

function ThreadCard({ thread, open, onOpen, onChange, style }) {
  const [comments, setComments] = useState(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    get(`/access/projects/${thread.id}/comments`).then(async (list) => {
      if (cancelled) return
      setComments(list)
      await post(`/access/projects/${thread.id}/read`)
      onChange()
    })
    return () => { cancelled = true }
  }, [open, thread.id])

  const send = async (body) => {
    setComments(await post(`/access/projects/${thread.id}/comments`, { body }))
    onChange()
  }

  return (
    <section className="card rise portal-card" style={style}>
      <button className="portal-thread-head" onClick={onOpen} aria-expanded={open}>
        <h2 className="portal-company">
          <ClientDot color={thread.color_accent} size={10} />
          {thread.name}
          {thread.unread_count > 0 && <span className="tab-badge">{thread.unread_count}</span>}
        </h2>
        <span className="portal-dim">
          {thread.client_name} · {thread.comment_count} message{thread.comment_count === 1 ? '' : 's'}
          {thread.last_comment_at ? ` · ${fmtDate(thread.last_comment_at)}` : ''}
        </span>
      </button>

      {open && (comments
        ? <Thread comments={comments} onPost={send} placeholder="Reply to the client…" />
        : <p className="portal-dim">Loading…</p>)}
    </section>
  )
}
