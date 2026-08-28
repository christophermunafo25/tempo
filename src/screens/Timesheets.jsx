import { useCallback, useEffect, useMemo, useState } from 'react'
import { del, get, patch, post } from '../api.js'
import {
  addDays, weekRange, fmtHours, fmtRange, fmtDate, fmtDuration,
  localDayKey, fmtTime, downloadCSV,
} from '../time.js'
import { WeekStepper, ClientDot, EmptyState } from '../components/ui.jsx'
import EditSessionModal from '../components/EditSessionModal.jsx'
import AddHoursModal from '../components/AddHoursModal.jsx'

// The day a manual entry starts on. Back-filling last week is the whole point,
// so it opens inside the week being looked at rather than on today: today, when
// that falls in this week, and otherwise the Friday of it — the day work is
// most often remembered as belonging to.
function defaultDateFor(range) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  if (today >= range.from && today < range.to) return today
  return addDays(range.from, 4)
}

export default function Timesheets() {
  const [clients, setClients] = useState([])
  const [sessions, setSessions] = useState([])
  const [offset, setOffset] = useState(0)
  const [adding, setAdding] = useState(null)      // { clientId } while the modal is open
  const [editing, setEditing] = useState(null)
  const [showSessions, setShowSessions] = useState(false)
  const [undoable, setUndoable] = useState(null)

  const range = useMemo(() => weekRange(offset), [offset])

  const refresh = useCallback(() => {
    get(`/sessions?from=${range.from.toISOString()}&to=${range.to.toISOString()}`)
      .then(setSessions)
  }, [range])

  useEffect(() => { get('/clients').then(setClients) }, [])
  useEffect(() => { refresh() }, [refresh])

  const openAdd = (clientId = null) => {
    setUndoable(null)
    setAdding({ clientId })
  }

  const removeSession = async (session) => {
    await del(`/sessions/${session.id}`)
    setUndoable(session)
    refresh()
  }

  const undoRemove = async () => {
    await post(`/sessions/${undoable.id}/restore`)
    setUndoable(null)
    refresh()
  }

  const loggedByClient = useMemo(() => {
    const m = new Map()
    for (const s of sessions) m.set(s.client_id, (m.get(s.client_id) || 0) + s.duration_minutes)
    return m
  }, [sessions])

  // Even daily pace: by end of day N you should be N/7 of the way to target.
  const daysElapsed = offset === 0
    ? Math.min(7, Math.floor((Date.now() - range.from.getTime()) / 86400000) + 1)
    : 7

  const saveTarget = async (client, value) => {
    const target = Math.max(0, Number(value) || 0)
    if (target === client.weekly_hours_target) return
    const next = await patch(`/clients/${client.id}`, { weekly_hours_target: target })
    setClients(cs => cs.map(c => c.id === client.id ? next : c))
  }

  const exportCSV = () => {
    const rows = [['Date', 'Client', 'Clock in', 'Clock out', 'Duration (hrs)', 'Project', 'Summary']]
    const ordered = [...sessions].sort((a, b) => a.clock_in.localeCompare(b.clock_in))
    for (const s of ordered) {
      const base = [
        localDayKey(s.clock_in), s.client_name,
        fmtTime(s.clock_in), fmtTime(s.clock_out),
      ]
      if (s.entries.length === 0) {
        rows.push([...base, fmtHours(s.duration_minutes, 2), '(untagged)', ''])
      } else {
        // Duration prorated evenly across the session's entries, one row per entry.
        const share = s.duration_minutes / s.entries.length
        for (const e of s.entries) {
          rows.push([...base, fmtHours(share, 2), e.project_name, e.summary])
        }
      }
    }
    downloadCSV(`tempo-week-${localDayKey(range.from)}.csv`, rows)
  }

  const totalLogged = [...loggedByClient.values()].reduce((a, b) => a + b, 0)
  const totalTarget = clients.reduce((a, c) => a + c.weekly_hours_target, 0)

  return (
    <div className="screen">
      <h1 className="screen-title rise">Timesheets</h1>

      <div className="filterbar rise" style={{ '--i': 1 }}>
        <WeekStepper offset={offset} onChange={setOffset} range={range} />
        <span className="spacer" />
        <button className="btn btn-outline btn-sm" onClick={() => openAdd()}
          disabled={clients.length === 0}>
          Add hours
        </button>
        <button className="btn btn-outline btn-sm" onClick={exportCSV} disabled={sessions.length === 0}>
          Download CSV
        </button>
      </div>

      {clients.length === 0 ? (
        <div className="card rise" style={{ '--i': 2 }}>
          <EmptyState>No clients yet. Add your first client on the Clock screen to see targets here.</EmptyState>
        </div>
      ) : (
        <div className="card rise" style={{ '--i': 2 }}>
          <div className="ts-table">
            <div className="ts-row head">
              <span>Client</span><span>Target</span><span>Logged</span><span>Remaining</span>
              <span>Progress</span><span>Pace</span><span />
            </div>
            {clients.map(c => (
              <TimesheetRow key={c.id} client={c}
                loggedMin={loggedByClient.get(c.id) || 0}
                daysElapsed={daysElapsed}
                isCurrentWeek={offset === 0}
                onTarget={saveTarget}
                onAdd={() => openAdd(c.id)} />
            ))}
            <div className="ts-row total">
              <span className="who">All clients</span>
              <span className="num">{totalTarget.toFixed(1)}</span>
              <span className="num">{fmtHours(totalLogged)}</span>
              <span className="num">{Math.max(0, totalTarget - totalLogged / 60).toFixed(1)}</span>
              <span /><span /><span />
            </div>
          </div>
        </div>
      )}

      <WeekSessions
        sessions={sessions}
        open={showSessions}
        onToggle={() => setShowSessions(o => !o)}
        onEdit={setEditing}
        onDelete={removeSession}
        undoable={undoable}
        onUndo={undoRemove}
        onDismissUndo={() => setUndoable(null)}
      />

      {adding && (
        <AddHoursModal
          clients={clients}
          defaultClientId={adding.clientId}
          defaultDate={defaultDateFor(range)}
          onSaved={() => { setAdding(null); refresh() }}
          onClose={() => setAdding(null)}
        />
      )}

      {editing && (
        <EditSessionModal
          session={editing}
          onSaved={() => { setEditing(null); refresh() }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

/* The week's sessions, under the totals they add up to. The screen showed one
   aggregate row per client and no way to see what was inside it, which is fine
   until you can add rows by hand and need to check what you added. */
function WeekSessions({ sessions, open, onToggle, onEdit, onDelete, undoable, onUndo, onDismissUndo }) {
  const [confirming, setConfirming] = useState(null)

  const ordered = useMemo(
    () => [...sessions].sort((a, b) => b.clock_in.localeCompare(a.clock_in)),
    [sessions])

  return (
    <div className="card rise" style={{ '--i': 3, marginTop: 'var(--space-6)' }}>
      <div className="filterbar" style={{ marginBottom: open ? 'var(--space-4)' : 0 }}>
        <button className="btn btn-ghost btn-sm" onClick={onToggle} aria-expanded={open}>
          {open ? 'Hide' : 'Show'} sessions ({sessions.length})
        </button>
        <span className="spacer" />
        {undoable && (
          <span className="label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            Session deleted
            <button className="btn btn-ghost btn-sm" onClick={onUndo}>Undo</button>
            <button className="btn btn-ghost btn-sm" onClick={onDismissUndo}>Dismiss</button>
          </span>
        )}
      </div>

      {open && (ordered.length === 0 ? (
        <EmptyState>Nothing logged this week. “Add hours” fills in a day you forgot to clock.</EmptyState>
      ) : (
        <div>
          {ordered.map(s => (
            <div className="session-row" key={s.id}>
              <span className="mono" style={{ width: 108, flexShrink: 0 }}>{fmtDate(s.clock_in)}</span>
              <span className="who" style={{ flex: '0 1 160px' }}>
                <ClientDot color={s.color_accent} />
                {s.client_name}
              </span>
              <span className="mono" style={{ width: 150, flexShrink: 0 }}>
                {fmtTime(s.clock_in)} – {fmtTime(s.clock_out)}
              </span>
              <span className="mono" style={{ width: 64, flexShrink: 0 }}>
                {fmtDuration(s.duration_minutes)}
              </span>
              <span style={{ flex: 1, minWidth: 0, color: 'var(--text-2)', fontSize: 13,
                             overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {s.entries.length === 0
                  ? <span style={{ color: 'var(--text-4)' }}>untagged</span>
                  : s.entries.map(e => e.project_name).join(', ')}
              </span>
              {/* NULL entry_method means the timer wrote it. */}
              {s.entry_method === 'manual' && <span className="pill neutral">Added</span>}
              {confirming === s.id ? (
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13 }}>Delete?</span>
                  <button className="btn btn-danger btn-sm"
                    onClick={() => { setConfirming(null); onDelete(s) }}>Delete</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setConfirming(null)}>Keep</button>
                </span>
              ) : (
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => onEdit(s)}>Edit</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setConfirming(s.id)}>Delete</button>
                </span>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function TimesheetRow({ client, loggedMin, daysElapsed, isCurrentWeek, onTarget, onAdd }) {
  const [draft, setDraft] = useState(String(client.weekly_hours_target))
  useEffect(() => { setDraft(String(client.weekly_hours_target)) }, [client.weekly_hours_target])

  const target = client.weekly_hours_target
  const logged = loggedMin / 60
  const remaining = Math.max(0, target - logged)
  const pct = target > 0 ? Math.min(100, (logged / target) * 100) : 0
  const over = target > 0 && logged > target ? logged - target : 0

  let pace = null
  if (target > 0) {
    if (isCurrentWeek) {
      const expected = target * (daysElapsed / 7)
      const diff = logged - expected
      pace = Math.abs(diff) < 0.1
        ? { cls: 'ahead', text: 'on pace' }
        : diff > 0
          ? { cls: 'ahead', text: `${diff.toFixed(1)} hrs ahead of pace` }
          : { cls: 'behind', text: `${(-diff).toFixed(1)} hrs behind pace` }
    } else {
      const diff = logged - target
      pace = Math.abs(diff) < 0.1
        ? { cls: 'ahead', text: 'met target' }
        : diff > 0
          ? { cls: 'ahead', text: `${diff.toFixed(1)} hrs over target` }
          : { cls: 'behind', text: `${(-diff).toFixed(1)} hrs short` }
    }
  }

  return (
    <div className="ts-row">
      <span className="who">
        <ClientDot color={client.color_accent} />
        {client.name}
      </span>
      <input className="ts-target" type="number" min="0" step="0.5" value={draft}
        aria-label={`${client.name} weekly target`}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => onTarget(client, draft)}
        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />
      <span className="num">{fmtHours(loggedMin)}</span>
      <span className="num">{remaining.toFixed(1)}</span>
      <span className="ts-bar">
        <span className="track">
          <span className="fill" style={{ width: `${pct}%`, background: client.color_accent }} />
        </span>
        {over > 0 && <span className="ts-over">+{over.toFixed(1)} hrs over</span>}
      </span>
      <span>{pace ? <span className={`pace ${pace.cls}`}>{pace.text}</span> : <span className="pace">no target set</span>}</span>
      <span style={{ textAlign: 'right' }}>
        <button className="btn btn-ghost btn-sm" onClick={onAdd}
          aria-label={`Add hours for ${client.name}`}>Add hours</button>
      </span>
    </div>
  )
}
