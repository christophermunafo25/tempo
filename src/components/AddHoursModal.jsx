import { useEffect, useMemo, useState } from 'react'
import { get, post } from '../api.js'
import { addDays, fmtDate, fmtDuration, fmtTime, withTimeOf } from '../time.js'
import { Modal, ClientDot, Dropdown } from './ui.jsx'
import TimeField, { DateStepper } from './TimeField.jsx'

/* Log a session for a day that was never clocked.
   Two ways in. Start and end times is the default and writes exactly what is
   typed. Duration mode is for the days the clock times are genuinely gone: it
   takes a day and a number of hours and anchors the block to a fixed start,
   which it shows resolved before saving — the schema derives everything from
   clock_in and clock_out, so a duration has to become real times somewhere,
   and that had better be somewhere visible. */

const ANCHOR_HOUR = 9          // 9:00 AM, named in the UI rather than implied.

let entryKey = 0
const blankEntry = () => ({ key: ++entryKey, projectId: null, summary: '', newProjectOpen: false, newName: '' })

export default function AddHoursModal({ clients, defaultDate, defaultClientId, onSaved, onClose }) {
  const [clientId, setClientId] = useState(defaultClientId ?? null)
  const [mode, setMode] = useState('times')

  const [inn, setInn] = useState(() => withTimeOf(defaultDate, ANCHOR_HOUR, 0))
  const [out, setOut] = useState(() => withTimeOf(defaultDate, ANCHOR_HOUR + 3, 0))
  const [timesOk, setTimesOk] = useState({ inn: true, out: true })

  const [day, setDay] = useState(() => new Date(defaultDate))
  const [hours, setHours] = useState('')

  const [projects, setProjects] = useState([])
  const [entries, setEntries] = useState([blankEntry()])
  const [conflicts, setConflicts] = useState(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!clientId) { setProjects([]); return }
    get(`/projects?client_id=${clientId}`).then(setProjects)
  }, [clientId])

  // Duration mode resolves to real times against the anchor, and the result is
  // shown rather than assumed.
  const resolved = useMemo(() => {
    if (mode === 'times') return { inn, out }
    const n = Number(hours)
    if (!Number.isFinite(n) || n <= 0) return null
    const start = withTimeOf(day, ANCHOR_HOUR, 0)
    return { inn: start, out: new Date(start.getTime() + n * 3600000) }
  }, [mode, inn, out, day, hours])

  const durationMin = resolved ? (resolved.out - resolved.inn) / 60000 : 0
  const timesValid = mode === 'times' ? (timesOk.inn && timesOk.out) : true
  const valid = !!clientId && !!resolved && timesValid && durationMin > 0

  // Any edit invalidates a standing overlap confirmation: the window it was
  // about is no longer the window being saved.
  const touch = (fn) => (...args) => { setConflicts(null); setError(''); fn(...args) }

  const update = (key, patchObj) =>
    setEntries(es => es.map(e => e.key === key ? { ...e, ...patchObj } : e))

  const createProject = async (entry) => {
    if (!entry.newName.trim()) return
    const p = await post('/projects', { client_id: clientId, name: entry.newName })
    setProjects(ps => [...ps, p].sort((a, b) => a.name.localeCompare(b.name)))
    update(entry.key, { projectId: p.id, newProjectOpen: false, newName: '' })
  }

  const save = async (allowOverlap = false) => {
    if (!valid || saving) return
    setSaving(true)
    setError('')
    try {
      await post('/sessions', {
        client_id: clientId,
        clock_in: resolved.inn.toISOString(),
        clock_out: resolved.out.toISOString(),
        entries: entries
          .filter(e => e.projectId)
          .map(e => ({ project_id: e.projectId, summary: e.summary })),
        ...(allowOverlap ? { allow_overlap: true } : {}),
      })
      onSaved()
    } catch (e) {
      // 409 is the overlap warning, not a failure: it comes back naming what it
      // clashed with so the confirmation can say which session that is.
      if (e.status === 409 && e.data?.conflicts?.length) setConflicts(e.data.conflicts)
      else setError(e.message)
      setSaving(false)
    }
  }

  const usedIds = entries.map(e => e.projectId).filter(Boolean)
  const client = clients.find(c => c.id === clientId)
  const spansDays = resolved &&
    resolved.inn.toDateString() !== resolved.out.toDateString()

  return (
    <Modal title="Add hours" onClose={onClose} wide>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

        <div className="field">
          <span className="label">Client</span>
          <Dropdown
            value={clientId}
            placeholder="Select a client"
            options={clients.map(c => ({ value: c.id, label: c.name, dot: c.color_accent }))}
            onSelect={touch(setClientId)}
          />
        </div>

        <div className="field">
          <span className="label">How do you want to enter it</span>
          <div className="seg" role="radiogroup" aria-label="Entry mode">
            <button role="radio" aria-checked={mode === 'times'}
              className={`seg-btn${mode === 'times' ? ' active' : ''}`}
              onClick={touch(() => setMode('times'))}>Start and end</button>
            <button role="radio" aria-checked={mode === 'duration'}
              className={`seg-btn${mode === 'duration' ? ' active' : ''}`}
              onClick={touch(() => setMode('duration'))}>Duration</button>
          </div>
        </div>

        {mode === 'times' ? (
          <>
            <div className="field">
              <span className="label">Clock in</span>
              <TimeField value={inn} onChange={touch(setInn)}
                onValidity={(ok) => setTimesOk(t => ({ ...t, inn: ok }))} />
            </div>
            <div className="field">
              <span className="label">Clock out</span>
              <TimeField value={out} onChange={touch(setOut)}
                onValidity={(ok) => setTimesOk(t => ({ ...t, out: ok }))} />
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <span className="label">Day</span>
              <DateStepper value={day} onChange={touch(setDay)} />
            </div>
            <div className="field">
              <span className="label">Hours worked</span>
              <input className="input" type="number" min="0" step="0.25" autoFocus
                style={{ width: 96, fontFamily: 'var(--font-mono)' }}
                placeholder="3.5" value={hours}
                aria-label="Hours worked"
                onChange={e => touch(setHours)(e.target.value)} />
            </div>
            <div className="label" style={{ lineHeight: 1.6 }}>
              {resolved
                ? <>Writes <strong className="mono">{fmtTime(resolved.inn)} – {fmtTime(resolved.out)}</strong>
                    {' '}on <strong className="mono">{fmtDate(resolved.inn)}</strong>
                    {spansDays && <> , ending <strong className="mono">{fmtDate(resolved.out)}</strong></>}
                    . Anchored to {fmtTime(withTimeOf(day, ANCHOR_HOUR, 0))} — switch to
                    start and end to place it exactly.</>
                : <>Anchored to {fmtTime(withTimeOf(day, ANCHOR_HOUR, 0))}. Enter hours to see
                    the times this will write.</>}
            </div>
          </>
        )}

        <div className="label" style={{ color: valid ? 'var(--text-2)' : 'var(--text-4)' }}>
          {!timesValid
            ? 'Type a time like 2:30 PM or 14:30'
            : !clientId ? 'Pick a client'
            : durationMin > 0 ? `Duration · ${fmtDuration(durationMin)}`
            : mode === 'duration' ? 'Enter the hours worked'
            : 'Clock-out must be after clock-in'}
        </div>

        {clientId && (
          <div className="field">
            <span className="label">Projects worked on (optional)</span>
            {entries.map(entry => {
              const available = projects
                .filter(p => p.id === entry.projectId || !usedIds.includes(p.id))
                .map(p => ({ value: p.id, label: p.name }))
              return (
                <div key={entry.key} style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
                  <div className="entry-head">
                    {entry.newProjectOpen ? (
                      <div className="addline" style={{ flex: 1 }}>
                        <input className="input" autoFocus placeholder="New project name"
                          value={entry.newName}
                          onChange={e => update(entry.key, { newName: e.target.value })}
                          onKeyDown={e => { if (e.key === 'Enter') createProject(entry) }} />
                        <button className="btn btn-sm" onClick={() => createProject(entry)}
                          disabled={!entry.newName.trim()}>Create</button>
                        <button className="btn btn-ghost btn-sm"
                          onClick={() => update(entry.key, { newProjectOpen: false, newName: '' })}>Cancel</button>
                      </div>
                    ) : (
                      <Dropdown
                        value={entry.projectId}
                        placeholder="Select a project"
                        options={available}
                        onSelect={(id) => update(entry.key, { projectId: id })}
                        footer={{ label: 'New project', onClick: () => update(entry.key, { newProjectOpen: true }) }}
                      />
                    )}
                    {entries.length > 1 && (
                      <button className="entry-remove"
                        onClick={() => setEntries(es => es.filter(x => x.key !== entry.key))}>Remove</button>
                    )}
                  </div>
                  {entry.projectId && (
                    <input className="input" value={entry.summary}
                      placeholder="Short note on what was worked on"
                      onChange={e => update(entry.key, { summary: e.target.value })} />
                  )}
                </div>
              )
            })}
            <button className="btn btn-ghost btn-sm"
              onClick={() => setEntries(es => [...es, blankEntry()])}>+ Add another project</button>
            <p style={{ fontSize: 12, color: 'var(--text-4)', marginTop: 8 }}>
              Recording work here doesn’t move a project on the board — it has probably
              moved on since.
            </p>
          </div>
        )}

        {conflicts && (
          <div className="confirm-inline" style={{ display: 'block' }}>
            <strong>This overlaps time already logged.</strong>
            <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
              {conflicts.map(c => (
                <li key={c.id} style={{ marginBottom: 2 }}>
                  <span className="mono">{fmtDate(c.clock_in)} · {fmtTime(c.clock_in)}
                    {' – '}{c.clock_out ? fmtTime(c.clock_out) : 'still running'}</span>
                  {' · '}{c.client_name}
                </li>
              ))}
            </ul>
            <p style={{ marginTop: 8 }}>
              Save anyway if you’re replacing one of these; otherwise fix the times.
            </p>
          </div>
        )}
      </div>

      {error && <div className="field-error" style={{ marginTop: 16, fontSize: 13 }}>{error}</div>}

      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={() => save(!!conflicts)} disabled={!valid || saving}>
          {saving ? 'Saving…' : conflicts ? 'Save anyway' : 'Add hours'}
        </button>
      </div>

      {client && !conflicts && (
        <p style={{ textAlign: 'right', fontSize: 12, color: 'var(--text-4)', marginTop: 8,
                    display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
          <ClientDot color={client.color_accent} size={8} />
          Saved unpublished — publish it on the Portal screen before {client.name} sees it.
        </p>
      )}
    </Modal>
  )
}
