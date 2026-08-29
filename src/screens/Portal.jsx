import { useCallback, useEffect, useMemo, useState } from 'react'
import { get, post, patch } from '../api.js'
import { ClientDot, Checkbox, EmptyState, WeekStepper } from '../components/ui.jsx'
import Thread from '../components/Thread.jsx'
import {
  weekRange, fmtRange, fmtDate, fmtTime, fmtHours, localDayKey, CLIENT_COLORS, fmtMoney,
} from '../time.js'

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
      {tab === 'publishing' && <PublishingTab clients={clients} onChange={refreshClients} />}
      {tab === 'requests' && <RequestsTab requests={requests} onChange={refreshRequests} />}
      {tab === 'threads' && <ThreadsTab threads={threads} onChange={refreshThreads} />}
    </div>
  )
}

/* ── Access ──────────────────────────────────────────────────────────── */

function AccessTab({ clients, onChange }) {
  const [showArchived, setShowArchived] = useState(false)
  if (!clients.length) return <EmptyState>No companies yet. Add one from the Clock screen.</EmptyState>

  const active = clients.filter(c => c.is_active)
  const archived = clients.filter(c => !c.is_active)

  return (
    <div className="portal-list">
      {active.map((client, i) => (
        <CompanyCard key={client.id} client={client} onChange={onChange} style={{ '--i': i }} />
      ))}

      {archived.length > 0 && (
        <section className="card rise portal-card">
          <button className="portal-thread-head" onClick={() => setShowArchived(v => !v)}
            aria-expanded={showArchived}>
            <span className="label">
              Archived · {archived.length}
            </span>
            <span className="portal-dim">
              Hidden from the Clock picker, the Board, Timesheets, the Dashboard and their own
              portal. Nothing is deleted — restoring puts it all back.
            </span>
          </button>
          {showArchived && (
            <table className="portal-table">
              <tbody>
                {archived.map(c => (
                  <tr key={c.id} className="is-revoked">
                    <td>
                      <ClientDot color={c.color_accent} size={8} /> {c.name}
                    </td>
                    <td className="portal-actions">
                      <button className="btn-ghost btn-sm"
                        onClick={() => post(`/access/clients/${c.id}/restore`).then(onChange)}>
                        Restore
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  )
}

function CompanyCard({ client, onChange, style }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [link, setLink] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [impact, setImpact] = useState(null)
  const [editing, setEditing] = useState(false)

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

  const startArchive = async () => {
    setError('')
    try {
      setImpact(await get(`/access/clients/${client.id}/impact`))
    } catch (err) {
      setError(err.message)
    }
  }

  const archive = async () => {
    setError('')
    try {
      await post(`/access/clients/${client.id}/archive`)
      setImpact(null)
      onChange()
    } catch (err) {
      setError(err.message)
    }
  }

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
          <button className="btn-ghost btn-sm portal-rename"
            onClick={() => setEditing(v => !v)}
            aria-label={`Rename ${client.name} or change its colour`}>
            {editing ? 'Close' : 'Edit'}
          </button>
        </h2>
        <div className="portal-toggles">
          <label className="portal-toggle">
            <Checkbox checked={!!client.portal_enabled}
              onChange={() => toggle('portal_enabled', !client.portal_enabled)}
              label={`Portal access for ${client.name}`} />
            <span>Portal access</span>
          </label>
          <label className="portal-toggle">
            <Checkbox checked={!!client.portal_shows_rates}
              onChange={() => toggle('portal_shows_rates', !client.portal_shows_rates)}
              label={`Show amounts to ${client.name}`} />
            <span>Show amounts</span>
          </label>
        </div>
      </header>

      {editing && (
        <ClientDetails client={client}
          onDone={() => { setEditing(false); onChange() }}
          onCancel={() => setEditing(false)} />
      )}

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

      <RateStatus client={client} onChange={onChange} />

      <ShareLinks client={client} onChange={onChange} />

      {impact
        ? <ArchiveConfirm client={client} impact={impact}
            onConfirm={archive} onCancel={() => setImpact(null)} />
        : (
          <div className="portal-card-foot">
            <button className="btn-ghost btn-sm portal-danger" onClick={startArchive}>
              Archive this company
            </button>
          </div>
        )}
    </section>
  )
}

/* What this company's clients can see about money, and the one action that
   changes a number they may already have seen. */
function RateStatus({ client, onChange }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const rate = Number(client.hourly_rate) || 0
  const unpriced = client.unpriced_published || 0
  const showing = !!client.portal_shows_rates && rate > 0

  const apply = (mode) => async () => {
    setBusy(true); setError('')
    try {
      await post(`/access/clients/${client.id}/apply-rate`, { mode })
      onChange()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="portal-share">
      <div className="portal-publish-head">
        <div>
          <div className="label">Rate</div>
          <p className="portal-dim">
            {rate > 0 ? `${fmtMoney(rate)} an hour` : 'No rate set'} ·{' '}
            {showing
              ? 'clients see amounts alongside hours'
              : 'amounts are not sent to this company at all'}
          </p>
        </div>
      </div>

      {rate > 0 && unpriced > 0 && (
        <div className="portal-confirm">
          <div className="label">{unpriced} published session{unpriced === 1 ? '' : 's'} with no rate</div>
          <p className="portal-dim">
            Published before a rate existed, so they show a blank amount rather
            than a zero. Applying the current rate fills them in and changes
            nothing that already has one.
          </p>
          <div className="portal-publish-actions">
            <button className="btn btn-sm" disabled={busy} onClick={apply('missing')}>
              Apply {fmtMoney(rate)} to those {unpriced}
            </button>
          </div>
        </div>
      )}

      {error && <p className="field-error">{error}</p>}
    </div>
  )
}

/* Share links: a URL that opens straight into this company's hours with no
   account. Only the hash is stored, so the URL is visible once and never
   again — losing it means rotating, which is why every link carries a label. */
function ShareLinks({ client, onChange }) {
  const [minted, setMinted] = useState(null)
  const [creating, setCreating] = useState(false)
  const [label, setLabel] = useState('')
  const [days, setDays] = useState('90')
  const [showsNotes, setShowsNotes] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const links = client.share_links || []
  const live = links.filter(l => l.state === 'active')

  const run = async (fn) => {
    setBusy(true); setError('')
    try { await fn() } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  const create = (e) => {
    e.preventDefault()
    return run(async () => {
      const res = await post('/access/share-links', {
        client_id: client.id,
        label,
        expires_in_days: days === 'never' ? null : Number(days),
        shows_notes: showsNotes,
      })
      setMinted({ ...res, label })
      setLabel(''); setCreating(false)
      onChange()
    })
  }

  return (
    <div className="portal-share">
      <div className="portal-publish-head">
        <div>
          <div className="label">Share links</div>
          <p className="portal-dim">
            Opens this company’s hours with no account. Anyone holding the URL
            has the access, so treat it like a password you can’t take back —
            revoke or rotate instead.
          </p>
        </div>
        {!creating && (
          <button className="btn btn-sm" onClick={() => setCreating(true)}>New link</button>
        )}
      </div>

      {creating && (
        <form className="portal-share-form" onSubmit={create}>
          <div className="field">
            <label className="label" htmlFor={`sl-label-${client.id}`}>Who is this for?</label>
            <input id={`sl-label-${client.id}`} className="input" autoFocus maxLength={120}
              placeholder="Finance team" value={label}
              onChange={(e) => setLabel(e.target.value)} />
            <span className="auth-hint">
              A label is how you tell two links apart later — the URL itself is
              never shown again.
            </span>
          </div>
          <div className="field">
            <label className="label" htmlFor={`sl-exp-${client.id}`}>Expires</label>
            <select id={`sl-exp-${client.id}`} className="input" value={days}
              onChange={(e) => setDays(e.target.value)}>
              <option value="90">In 90 days</option>
              <option value="365">In a year</option>
              <option value="never">Never</option>
            </select>
          </div>
          <label className="portal-toggle">
            <Checkbox checked={showsNotes} onChange={() => setShowsNotes(v => !v)}
              label="Include session notes" />
            <span>Include session notes</span>
          </label>
          <div className="portal-publish-actions">
            <button className="btn btn-sm" type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create link'}
            </button>
            <button className="btn btn-outline btn-sm" type="button"
              onClick={() => setCreating(false)}>Cancel</button>
          </div>
        </form>
      )}

      {minted && <ShareUrlBox minted={minted} onDismiss={() => setMinted(null)} />}
      {error && <p className="field-error">{error}</p>}

      {links.length > 0 && (
        <table className="portal-table">
          <thead>
            <tr><th>Label</th><th>Status</th><th>Last opened</th><th /></tr>
          </thead>
          <tbody>
            {links.map(l => (
              <tr key={l.id} className={l.state === 'active' ? '' : 'is-revoked'}>
                <td>
                  <div className="portal-contact">{l.label || 'Unlabelled'}</div>
                  <div className="portal-contact-name">
                    {l.shows_notes ? 'With notes' : 'No notes'}
                    {l.expires_at
                      ? ` · ${l.state === 'expired' ? 'expired' : 'expires'} ${fmtDate(l.expires_at)}`
                      : ' · never expires'}
                  </div>
                </td>
                <td><span className="pill">{l.state}</span></td>
                <td className="mono portal-dim">
                  {l.last_viewed_at
                    ? `${fmtDate(l.last_viewed_at)} · ${l.view_count} view${l.view_count === 1 ? '' : 's'}`
                    : 'never'}
                </td>
                <td className="portal-actions">
                  {l.state === 'expired' && (
                    <button className="btn-ghost btn-sm" disabled={busy}
                      onClick={() => run(async () => {
                        await patch(`/access/share-links/${l.id}`, { expires_in_days: 90 })
                        onChange()
                      })}>Renew</button>
                  )}
                  {/* Reissue works on a dead link too: it keeps the label and
                      settings, which is the whole reason to reach for it after
                      revoking rather than starting from a blank form. */}
                  <button className="btn-ghost btn-sm" disabled={busy}
                    onClick={() => run(async () => {
                      setMinted({
                        ...(await post(`/access/share-links/${l.id}/rotate`)),
                        label: l.label,
                      })
                      onChange()
                    })}>{l.state === 'revoked' ? 'Reissue' : 'Rotate'}</button>
                  {l.state !== 'revoked' && (
                    <button className="btn-ghost btn-sm portal-danger" disabled={busy}
                      onClick={() => run(async () => {
                        await post(`/access/share-links/${l.id}/revoke`)
                        onChange()
                      })}>Revoke</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {live.length === 0 && links.length > 0 && (
        <p className="portal-dim">No live links. Rotate one to issue a fresh URL.</p>
      )}
    </div>
  )
}

// Shown once. The database holds only a hash, so there is no second chance to
// read this and no way for anyone — including the owner — to recover it later.
function ShareUrlBox({ minted, onDismiss }) {
  const [copied, setCopied] = useState(false)
  const url = `${window.location.origin}${minted.url_path}`

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
      <div className="label">
        Share link{minted.label ? ` for ${minted.label}` : ''}
      </div>
      <p className="portal-dim">
        Copy it now — this is the only time it is shown. Only a hash is stored,
        so it can’t be looked up again; if you lose it, rotate the link.
      </p>
      <div className="portal-linkrow">
        <input className="input mono" readOnly value={url} onFocus={(e) => e.target.select()} />
        <button className="btn btn-sm" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        <button className="btn-ghost btn-sm" onClick={onDismiss}>Done</button>
      </div>
    </div>
  )
}

/* Name and accent colour. The colour is what identifies a company at a glance
   on the Board, the Dashboard charts and every client dot, so it's picked from
   the same fixed palette rather than a free colour field. */
function ClientDetails({ client, onDone, onCancel }) {
  const [name, setName] = useState(client.name)
  const [color, setColor] = useState(client.color_accent)
  const [rate, setRate] = useState(String(client.hourly_rate ?? 0))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const dirty = name.trim() !== client.name
    || color !== client.color_accent
    || Number(rate) !== Number(client.hourly_rate)

  const save = async (e) => {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      await patch(`/access/clients/${client.id}`, {
        name: name.trim(), color_accent: color, hourly_rate: Number(rate) || 0,
      })
      onDone()
    } catch (err) {
      setError(err.message); setBusy(false)
    }
  }

  return (
    <form className="portal-edit" onSubmit={save}>
      <div className="field">
        <label className="label" htmlFor={`name-${client.id}`}>Name</label>
        <input id={`name-${client.id}`} className="input" autoFocus required maxLength={120}
          value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <span className="label">Accent colour</span>
        <div className="swatches">
          {CLIENT_COLORS.map(c => (
            <button key={c} type="button" aria-label={c}
              className={`swatch${color === c ? ' active' : ''}`}
              style={{ background: c }} onClick={() => setColor(c)} />
          ))}
        </div>
        <span className="auth-hint">
          Renaming changes this company everywhere, including on past
          timesheets and in the client’s own portal. Hours are untouched.
        </span>
      </div>
      <div className="field">
        <label className="label" htmlFor={`rate-${client.id}`}>Hourly rate</label>
        <input id={`rate-${client.id}`} className="input" type="number" min="0" step="0.01"
          value={rate} onChange={(e) => setRate(e.target.value)} />
        <span className="auth-hint">
          Applies to work published from now on. Sessions already published keep
          the rate they were published at, so a number a client has budgeted
          against never moves on its own.
        </span>
      </div>
      {error && <p className="field-error">{error}</p>}
      <div className="portal-publish-actions">
        <button className="btn btn-sm" type="submit" disabled={busy || !dirty}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button className="btn btn-outline btn-sm" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

/* Says what will disappear before it disappears. Archiving hides a company's
   whole history, so "5 sessions" is the difference between a safe click and a
   week of timesheets changing under you. */
function ArchiveConfirm({ client, impact, onConfirm, onCancel }) {
  return (
    <div className="portal-confirm">
      <div className="label">Archive {client.name}?</div>
      <p className="portal-dim">
        This hides {impact.sessions} session{impact.sessions === 1 ? '' : 's'}
        {impact.minutes > 0 && ` (${fmtHours(impact.minutes)} hrs)`}
        {impact.projects > 0 && `, ${impact.projects} project${impact.projects === 1 ? '' : 's'}`}
        {impact.contacts > 0 && `, and signs out ${impact.contacts} portal contact${impact.contacts === 1 ? '' : 's'}`}.
        Past weeks will stop showing this company, so an invoiced week will look
        different afterwards and its CSV will change.
      </p>
      <p className="portal-dim">
        Nothing is deleted. Restoring puts every hour back exactly as it was.
      </p>
      <div className="portal-publish-actions">
        <button className="btn btn-sm portal-danger-btn" onClick={onConfirm}>
          Archive {client.name}
        </button>
        <button className="btn btn-outline btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
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

function PublishingTab({ clients, onChange }) {
  const [clientId, setClientId] = useState(null)
  const [offset, setOffset] = useState(0)
  const [sessions, setSessions] = useState([])
  const [busy, setBusy] = useState(false)
  const [caughtUp, setCaughtUp] = useState(0)

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
    onChange?.()
  }

  // Everything completed, in one go. Sessions publish themselves as they are
  // logged now, so this exists to clear what was logged before that — work
  // predating the portal being switched on, which would otherwise mean
  // stepping through a year of weeks to release a year of hours.
  const catchUp = async () => {
    setBusy(true)
    try {
      const r = await post('/access/publish', {
        client_id: clientId,
        from: new Date(0).toISOString(),
        to: new Date(Date.now() + 86400000).toISOString(),
        publish: true,
      })
      setCaughtUp(r.affected)
      await refresh()
      onChange?.()
    } finally {
      setBusy(false)
    }
  }

  if (!enabled.length) {
    return <EmptyState>No company has portal access switched on yet. Turn one on under Access.</EmptyState>
  }

  const publishedCount = sessions.filter(s => s.is_published).length
  const total = sessions.reduce((a, s) => a + s.duration_minutes, 0)
  const selected = enabled.find(c => c.id === clientId)
  const backlog = selected?.unpublished || 0

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

      {backlog > 0 && (
        <div className="card rise" style={{ marginBottom: 'var(--space-6)' }}>
          <div className="portal-confirm">
            <div className="label">
              {backlog} completed session{backlog === 1 ? '' : 's'} this company can’t see
            </div>
            <p className="portal-dim">
              Hours publish themselves as they are logged now, so this is work from
              before that — logged before the portal was switched on for
              {' '}{selected?.name || 'this company'}, or before publishing became
              automatic. Releasing it here beats stepping through the weeks one at a
              time. Unpublishing still works afterwards, per week or per session.
              {Number(selected?.hourly_rate) > 0 && (
                <> Each one is stamped with the current rate of{' '}
                  {fmtMoney(selected.hourly_rate)} an hour as it publishes, and any
                  session that already carries a rate keeps the one it has.</>
              )}
            </p>
            <div className="portal-publish-actions">
              <button className="btn btn-sm" disabled={busy} onClick={catchUp}>
                Publish all {backlog} of them
              </button>
            </div>
          </div>
        </div>
      )}

      {caughtUp > 0 && backlog === 0 && (
        <div className="card rise" style={{ marginBottom: 'var(--space-6)' }}>
          <p className="portal-dim">
            {caughtUp} session{caughtUp === 1 ? '' : 's'} published. Everything
            completed for {selected?.name || 'this company'} is now visible to them,
            and anything logged from here on publishes itself.
          </p>
        </div>
      )}

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
