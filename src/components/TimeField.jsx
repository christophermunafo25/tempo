import { useState } from 'react'
import { addDays, fmtDate, fmtTime, parseTimeText, withTimeOf } from '../time.js'

/* Typed time editor: free-text time ("2:30 PM", "14:30", "230pm") plus small
   ‹ › steppers to move the calendar day. Emits Date objects via onChange;
   invalid text highlights and reports through onValidity without emitting. */
export default function TimeField({ value, onChange, onValidity, onEnter, showDate = true }) {
  const date = new Date(value)
  const [text, setText] = useState(fmtTime(date))
  const [invalid, setInvalid] = useState(false)

  const handleText = (raw) => {
    setText(raw)
    const parsed = parseTimeText(raw)
    if (parsed) {
      setInvalid(false)
      onValidity?.(true)
      onChange(withTimeOf(date, parsed.h, parsed.m))
    } else {
      setInvalid(true)
      onValidity?.(false)
    }
  }

  return (
    <span className="timefield">
      <input
        className={`input${invalid ? ' input-error' : ''}`}
        style={{ width: 96, textAlign: 'center', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' }}
        value={text}
        placeholder="2:30 PM"
        aria-label="Time"
        aria-invalid={invalid}
        onChange={e => handleText(e.target.value)}
        onBlur={() => { if (!invalid) setText(fmtTime(date)) }}
        onKeyDown={e => { if (e.key === 'Enter' && !invalid) onEnter?.() }}
      />
      {showDate && <DateStepper value={date} onChange={onChange} disabled={invalid} />}
    </span>
  )
}

/* The day half of the field above, on its own. Duration-mode manual entry
   picks a calendar day and a number of hours, with no time of day to type. */
export function DateStepper({ value, onChange, disabled }) {
  const date = new Date(value)
  return (
    <span className="tf-date">
      <button type="button" className="st-ctl" aria-label="Previous day" disabled={disabled}
        onClick={() => onChange(addDays(date, -1))}>‹</button>
      <span className="mono">{fmtDate(date)}</span>
      <button type="button" className="st-ctl" aria-label="Next day" disabled={disabled}
        onClick={() => onChange(addDays(date, 1))}>›</button>
    </span>
  )
}
