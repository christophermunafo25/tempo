import { useState } from 'react'
import { patch } from '../api.js'
import { toLocalInput, fromLocalInput, fmtDuration } from '../time.js'
import { Modal, ClientDot } from './ui.jsx'

/* Adjust a completed session's times — for the days you forgot to clock in. */
export default function EditSessionModal({ session, onSaved, onClose }) {
  const [inn, setInn] = useState(toLocalInput(session.clock_in))
  const [out, setOut] = useState(toLocalInput(session.clock_out))
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const durMin = (fromLocalInput(out) - fromLocalInput(inn)) / 60000
  const valid = durMin > 0

  const save = async () => {
    if (!valid || saving) return
    setSaving(true)
    setError('')
    try {
      await patch(`/sessions/${session.id}`, {
        clock_in: fromLocalInput(inn).toISOString(),
        clock_out: fromLocalInput(out).toISOString(),
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
          <input type="datetime-local" className="input" value={inn}
            onChange={e => setInn(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') save() }} />
        </div>
        <div className="field">
          <span className="label">Clock out</span>
          <input type="datetime-local" className="input" value={out}
            onChange={e => setOut(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') save() }} />
        </div>
        <div className="label" style={{ color: valid ? 'var(--text-2)' : '#e94560' }}>
          {valid ? `Duration · ${fmtDuration(durMin)}` : 'Clock-out must be after clock-in'}
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
