import { useEffect, useMemo, useState } from 'react'
import { get, patch } from '../api.js'
import {
  weekRange, fmtHours, fmtRange, localDayKey, fmtTime, downloadCSV,
} from '../time.js'
import { WeekStepper, ClientDot, EmptyState } from '../components/ui.jsx'

export default function Timesheets() {
  const [clients, setClients] = useState([])
  const [sessions, setSessions] = useState([])
  const [offset, setOffset] = useState(0)

  const range = useMemo(() => weekRange(offset), [offset])

  useEffect(() => { get('/clients').then(setClients) }, [])
  useEffect(() => {
    get(`/sessions?from=${range.from.toISOString()}&to=${range.to.toISOString()}`)
      .then(setSessions)
  }, [range])

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
              <span>Progress</span><span>Pace</span>
            </div>
            {clients.map(c => (
              <TimesheetRow key={c.id} client={c}
                loggedMin={loggedByClient.get(c.id) || 0}
                daysElapsed={daysElapsed}
                isCurrentWeek={offset === 0}
                onTarget={saveTarget} />
            ))}
            <div className="ts-row total">
              <span className="who">All clients</span>
              <span className="num">{totalTarget.toFixed(1)}</span>
              <span className="num">{fmtHours(totalLogged)}</span>
              <span className="num">{Math.max(0, totalTarget - totalLogged / 60).toFixed(1)}</span>
              <span /><span />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function TimesheetRow({ client, loggedMin, daysElapsed, isCurrentWeek, onTarget }) {
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
    </div>
  )
}
