import { useState } from 'react'
import { patch } from '../api.js'
import { fmtDuration } from '../time.js'
import { Modal, ClientDot } from './ui.jsx'
import TimeField from './TimeField.jsx'

/* Adjust a completed session's times — for the days you forgot to clock in. */
export default function EditSessionModal({ session, onSaved, onClose }) {
  const [inn, setInn] = useState(new Date(session.clock_in))
  const [out, setOut] = useState(new Date(session.clock_out))
  const [innOk, setInnOk] = useState(true)
  const [outOk, setOutOk] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const durMin = (out - inn) / 60000
  const valid = innOk && outOk && durMin > 0

  const save = async () => {
    if (!valid || saving) return
    setSaving(true)
    setError('')
    try {
      await patch(`/sessions/${session.id}`, {
        clock_in: inn.toISOString(),
        clock_out: out.toISOString(),
      })
      onSaved()
    } catch (e) {
      setError(e.message)
      setSaving(false)
    }
  }

  return (
    <Modal title="Edit session times" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
          <ClientDot color={session.color_accent} />
          {session.client_name}
        </div>
        <div className="field">
          <span className="label">Clock in</span>
          <TimeField value={inn} onChange={setInn} onValidity={setInnOk} onEnter={save} />
        </div>
        <div className="field">
          <span className="label">Clock out</span>
          <TimeField value={out} onChange={setOut} onValidity={setOutOk} onEnter={save} />
        </div>
        <div className="label" style={{ color: valid ? 'var(--text-2)' : '#e94560' }}>
          {!innOk || !outOk
            ? 'Type a time like 2:30 PM or 14:30'
            : valid ? `Duration · ${fmtDuration(durMin)}` : 'Clock-out must be after clock-in'}
        </div>
      </div>
      {error && <div className="field-error" style={{ marginTop: 16, fontSize: 13 }}>{error}</div>}
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={!valid || saving}>
          {saving ? 'Saving…' : 'Save times'}
        </button>
      </div>
    </Modal>
  )
}
