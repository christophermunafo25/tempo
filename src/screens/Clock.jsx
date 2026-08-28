import { useCallback, useEffect, useMemo, useState } from 'react'
import { get, post, patch } from '../api.js'
import { CLIENT_COLORS, clockParts, fmtDuration, fmtTime } from '../time.js'
import { Dropdown, Modal, ClientDot, EmptyState } from '../components/ui.jsx'
import EditSessionModal from '../components/EditSessionModal.jsx'
import TimeField from '../components/TimeField.jsx'
import ClockOutPanel from './ClockOutPanel.jsx'

const TWELVE_HOURS = 12 * 3600 * 1000

export default function Clock() {
  const [clients, setClients] = useState([])
  const [active, setActive] = useState(null)
  const [today, setToday] = useState([])
  const [clientId, setClientId] = useState(null)
  const [addOpen, setAddOpen] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [manualOut, setManualOut] = useState(null)        // Date from the 12h banner
  const [now, setNow] = useState(Date.now())
  const [error, setError] = useState('')
  const [editingStart, setEditingStart] = useState(false)
  const [startDraft, setStartDraft] = useState(null)      // Date while editing
  const [startOk, setStartOk] = useState(true)
  const [editSession, setEditSession] = useState(null)

  const refresh = useCallback(async () => {
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0)
    const dayEnd = new Date(dayStart.getTime() + 86400000)
    const [cs, act, sessions] = await Promise.all([
      get('/clients'),
      get('/active-session'),
      get(`/sessions?from=${dayStart.toISOString()}&to=${dayEnd.toISOString()}`),
    ])
    setClients(cs)
    setActive(act)
    setToday(sessions)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [active])

  const elapsed = active ? now - new Date(active.clock_in).getTime() : 0
  const [hh, mm, ss] = clockParts(elapsed)
  const longRunning = active && elapsed > TWELVE_HOURS

  const clockIn = async () => {
    setError('')
    try {
      const s = await post('/clock-in', { client_id: clientId })
      const c = clients.find(x => x.id === clientId)
      setActive({ ...s, client_name: c?.name, color_accent: c?.color_accent })
      setNow(Date.now())
    } catch (e) {
      setError(e.message)
    }
  }

  const saveStart = async () => {
    if (!startOk) return
    setError('')
    try {
      const s = await patch(`/sessions/${active.id}`, {
        clock_in: startDraft.toISOString(),
      })
      setActive(a => ({ ...a, clock_in: s.clock_in }))
      setEditingStart(false)
    } catch (e) {
      setError(e.message)
    }
  }

  const onSaved = () => {
    setReviewing(false)
    setActive(null)
    setManualOut(null)
    refresh()
  }

  const addClient = async (data) => {
    const c = await post('/clients', data)
    setClients(cs => [...cs, c].sort((a, b) => a.name.localeCompare(b.name)))
    setClientId(c.id)
    setAddOpen(false)
  }

  const options = useMemo(() =>
    clients.map(c => ({ value: c.id, label: c.name, dot: c.color_accent })), [clients])

  return (
    <div className="screen">
      <h1 className="screen-title rise">Clock</h1>

      {!active ? (
        <div className="clock-hero rise" style={{ '--i': 1 }}>
          {clients.length === 0 ? (
            <EmptyState action={<button className="btn" onClick={() => setAddOpen(true)}>Add your first client</button>}>
              No clients yet. Add your first client to start tracking.
            </EmptyState>
          ) : (
            <>
              <Dropdown
                value={clientId}
                placeholder="Select a client"
                options={options}
                onSelect={setClientId}
                footer={{ label: 'Add client', onClick: () => setAddOpen(true) }}
              />
              <button className="clock-btn" disabled={!clientId} onClick={clockIn}>
                Clock In
              </button>
              {error && <div className="field-error" style={{ fontSize: 14, maxWidth: 420 }}>{error}</div>}
            </>
          )}
        </div>
      ) : (
        <div className="clock-hero rise" style={{ '--i': 1 }}>
          <div className="timer-client">
            <ClientDot color={active.color_accent} />
            {active.client_name}
            {editingStart ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <TimeField value={startDraft} onChange={setStartDraft}
                  onValidity={setStartOk} onEnter={saveStart} />
                <button className="btn btn-sm" onClick={saveStart} disabled={!startOk}>Save</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setEditingStart(false)}>Cancel</button>
              </span>
            ) : (
              <>
                <span style={{ color: 'var(--text-4)' }}>· since {fmtTime(active.clock_in)}</span>
                <button className="st-ctl" style={{ textTransform: 'none', letterSpacing: 0 }}
                  onClick={() => { setStartDraft(new Date(active.clock_in)); setStartOk(true); setEditingStart(true); setError('') }}>
                  edit
                </button>
              </>
            )}
          </div>
          {error && <div className="field-error" style={{ fontSize: 13 }}>{error}</div>}
          <div className="timer" aria-live="off">
            {hh}<span className="colon">:</span>{mm}<span className="colon">:</span>{ss}
          </div>
          {longRunning && (
            <div className="longrun-banner">
              <span>This session has been running for over 12 hours. Forgot to clock out? Set the real end time:</span>
              <TimeField value={manualOut || new Date()} onChange={setManualOut} />
            </div>
          )}
          <button className="clock-btn out" onClick={() => setReviewing(true)}>
            Clock Out
          </button>
        </div>
      )}

      <div className="today-list rise" style={{ '--i': 2 }}>
        <span className="label">Today</span>
        {today.length === 0 ? (
          <p style={{ fontSize: 14, color: 'var(--text-4)' }}>
            No completed sessions yet today{active ? ' — one is running now.' : '.'}
          </p>
        ) : today.map(s => (
          <div className="session-row" key={s.id}>
            <div className="who">
              <ClientDot color={s.color_accent} />
              {s.client_name}
            </div>
            <span className="mono">{fmtDuration(s.duration_minutes)}</span>
            <span className="mono">{fmtTime(s.clock_in)} – {fmtTime(s.clock_out)}</span>
            {/* Companies with the portal on see a session the moment it is
                clocked out, so say so here rather than leaving it to be
                discovered. Unpublish from Portal → Publishing. */}
            {!!s.is_published && (
              <span className="shared-mark" title={`Visible to ${s.client_name} now`}>shared</span>
            )}
            <button className="st-ctl" style={{ textTransform: 'none', letterSpacing: 0 }}
              aria-label={`Edit ${s.client_name} session times`}
              onClick={() => setEditSession(s)}>
              edit
            </button>
          </div>
        ))}
      </div>

      {addOpen && <AddClientModal onSave={addClient} onClose={() => setAddOpen(false)} usedColors={clients.map(c => c.color_accent)} />}

      {editSession && (
        <EditSessionModal session={editSession}
          onSaved={() => { setEditSession(null); refresh() }}
          onClose={() => setEditSession(null)} />
      )}

      {reviewing && active && (
        <ClockOutPanel
          session={active}
          initialOut={manualOut || new Date()}
          onSaved={onSaved}
          onCancel={() => setReviewing(false)}
        />
      )}
    </div>
  )
}

function AddClientModal({ onSave, onClose, usedColors }) {
  const firstFree = CLIENT_COLORS.find(c => !usedColors.includes(c)) || CLIENT_COLORS[0]
  const [name, setName] = useState('')
  const [color, setColor] = useState(firstFree)
  const [target, setTarget] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (!name.trim() || saving) return
    setSaving(true)
    setError('')
    try {
      await onSave({ name, color_accent: color, weekly_hours_target: Number(target) || 0 })
    } catch (e) {
      setError(e.message)
      setSaving(false)
    }
  }

  return (
    <Modal title="Add client" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div className="field">
          <span className="label">Name</span>
          <input className="input" autoFocus value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') save() }} />
        </div>
        <div className="field">
          <span className="label">Accent color</span>
          <div className="swatches">
            {CLIENT_COLORS.map(c => (
              <button key={c} className={`swatch${color === c ? ' active' : ''}`}
                style={{ background: c }} onClick={() => setColor(c)} aria-label={c} />
            ))}
          </div>
        </div>
        <div className="field">
          <span className="label">Weekly hours target</span>
          <input className="input" type="number" min="0" step="0.5" value={target}
            placeholder="e.g. 20"
            onChange={e => setTarget(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') save() }} />
        </div>
      </div>
      {error && <div className="field-error" style={{ marginTop: 16, fontSize: 13 }}>{error}</div>}
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={!name.trim() || saving}>
          {saving ? 'Adding…' : 'Add client'}
        </button>
      </div>
    </Modal>
  )
}
