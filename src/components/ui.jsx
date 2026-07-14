import { useEffect, useRef, useState } from 'react'
import { statusMeta, fmtRange } from '../time.js'

export function ClientDot({ color, size }) {
  return <span className="client-dot" style={{ background: color, width: size, height: size }} />
}

export function StatusPill({ status }) {
  const meta = statusMeta(status)
  return <span className={`pill ${meta.tone}`}>{meta.short || meta.label}</span>
}

/* Custom dropdown with optional footer action */
export function Dropdown({ value, placeholder, options, onSelect, footer, disabled }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false) }
    const esc = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  const selected = options.find(o => o.value === value)

  return (
    <div className={`dd${open ? ' open' : ''}`} ref={ref}>
      <button type="button" className="dd-trigger" disabled={disabled}
        onClick={() => setOpen(o => !o)} aria-haspopup="listbox" aria-expanded={open}>
        {selected
          ? <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {selected.dot && <ClientDot color={selected.dot} />}{selected.label}
            </span>
          : <span className="placeholder">{placeholder}</span>}
        <svg className="dd-caret" width="12" height="12" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="dd-menu" role="listbox">
          {options.length === 0 && <div className="dd-item" style={{ color: 'var(--text-4)', cursor: 'default' }}>Nothing here yet</div>}
          {options.map(o => (
            <button type="button" key={o.value} className="dd-item" role="option"
              onClick={() => { onSelect(o.value); setOpen(false) }}>
              {o.dot && <ClientDot color={o.dot} />}
              {o.label}
            </button>
          ))}
          {footer && (
            <div className="dd-footer">
              <button type="button" className="dd-item"
                onClick={() => { setOpen(false); footer.onClick() }}>
                + {footer.label}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function Modal({ title, children, onClose }) {
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [onClose])
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  )
}

export function Checkbox({ checked, onChange, label }) {
  return (
    <button type="button" className={`checkbox${checked ? ' on' : ''}`}
      role="checkbox" aria-checked={checked} aria-label={label} onClick={onChange}>
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
    </button>
  )
}

export function ClientFilter({ clients, value, onChange }) {
  return (
    <>
      <button className={`chip${value == null ? ' active' : ''}`} onClick={() => onChange(null)}>
        All clients
      </button>
      {clients.map(c => (
        <button key={c.id} className={`chip${value === c.id ? ' active' : ''}`}
          onClick={() => onChange(c.id)}>
          <ClientDot color={c.color_accent} size={8} />
          {c.name}
        </button>
      ))}
    </>
  )
}

export function WeekStepper({ offset, onChange, range }) {
  return (
    <div className="stepper">
      <button onClick={() => onChange(offset - 1)} aria-label="Previous week">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round"><path d="m15 18-6-6 6-6" /></svg>
      </button>
      <span className="range">{offset === 0 ? `This week · ${fmtRange(range)}` : fmtRange(range)}</span>
      <button onClick={() => onChange(offset + 1)} disabled={offset >= 0} aria-label="Next week">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round"><path d="m9 18 6-6-6-6" /></svg>
      </button>
      {offset !== 0 && <button className="btn-ghost btn-sm" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }} onClick={() => onChange(0)}>today</button>}
    </div>
  )
}

export function EmptyState({ children, action }) {
  return (
    <div className="empty">
      <p>{children}</p>
      {action}
    </div>
  )
}
