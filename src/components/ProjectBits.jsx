import { useState } from 'react'
import { post, patch, del } from '../api.js'
import { Checkbox } from './ui.jsx'

/* Live subtask editor — persists immediately against the project. */
export function SubtaskEditor({ projectId, subtasks, onChange }) {
  const [title, setTitle] = useState('')

  const add = async () => {
    if (!title.trim()) return
    const st = await post(`/projects/${projectId}/subtasks`, { title })
    onChange([...subtasks, st])
    setTitle('')
  }

  const toggle = async (st) => {
    const next = await patch(`/subtasks/${st.id}`, { is_done: !st.is_done })
    onChange(subtasks.map(s => s.id === st.id ? next : s))
  }

  const remove = async (st) => {
    await del(`/subtasks/${st.id}`)
    onChange(subtasks.filter(s => s.id !== st.id))
  }

  const move = async (index, dir) => {
    const next = [...subtasks]
    const j = index + dir
    if (j < 0 || j >= next.length) return
    ;[next[index], next[j]] = [next[j], next[index]]
    onChange(next)
    await post(`/projects/${projectId}/subtasks/reorder`, { ids: next.map(s => s.id) })
  }

  return (
    <div>
      {subtasks.map((st, i) => (
        <div key={st.id} className={`subtask-row${st.is_done ? ' done' : ''}`}>
          <Checkbox checked={!!st.is_done} onChange={() => toggle(st)} label={st.title} />
          <span className="st-title">{st.title}</span>
          <button className="st-ctl" onClick={() => move(i, -1)} aria-label="Move up" disabled={i === 0}>↑</button>
          <button className="st-ctl" onClick={() => move(i, 1)} aria-label="Move down" disabled={i === subtasks.length - 1}>↓</button>
          <button className="st-ctl del" onClick={() => remove(st)} aria-label="Delete subtask">✕</button>
        </div>
      ))}
      <div className="addline" style={{ marginTop: subtasks.length ? 8 : 0 }}>
        <input className="input" placeholder="Add a subtask…" value={title}
          onChange={e => setTitle(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') add() }} />
        <button className="btn btn-outline btn-sm" onClick={add} disabled={!title.trim()}>Add</button>
      </div>
    </div>
  )
}

/* Live asset-link editor — chips that open in a new tab. */
export function LinkEditor({ projectId, links, onChange, readOnly }) {
  const [label, setLabel] = useState('')
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')

  const add = async () => {
    if (!label.trim() || !url.trim()) return
    try {
      new URL(url)
    } catch {
      setError('That URL doesn’t look well formed — include the protocol (https://…).')
      return
    }
    try {
      const link = await post(`/projects/${projectId}/links`, { label, url })
      onChange([...links, link])
      setLabel(''); setUrl(''); setError('')
    } catch (e) {
      setError(e.message)
    }
  }

  const remove = async (link) => {
    await del(`/links/${link.id}`)
    onChange(links.filter(l => l.id !== link.id))
  }

  return (
    <div>
      {links.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: readOnly ? 0 : 10 }}>
          {links.map(l => (
            <a key={l.id} className="linkchip" href={l.url} target="_blank" rel="noreferrer">
              <span>{l.label}</span>
              {!readOnly && (
                <button className="x" aria-label={`Remove ${l.label}`}
                  onClick={(e) => { e.preventDefault(); remove(l) }}>✕</button>
              )}
            </a>
          ))}
        </div>
      )}
      {!readOnly && (
        <>
          <div className="addline">
            <input className="input" style={{ flex: '0 1 160px' }} placeholder="Label"
              value={label} onChange={e => setLabel(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') add() }} />
            <input className={`input${error ? ' input-error' : ''}`} placeholder="https://…"
              value={url} onChange={e => { setUrl(e.target.value); setError('') }}
              onKeyDown={e => { if (e.key === 'Enter') add() }} />
            <button className="btn btn-outline btn-sm" onClick={add}
              disabled={!label.trim() || !url.trim()}>Add</button>
          </div>
          {error && <div className="field-error">{error}</div>}
        </>
      )}
    </div>
  )
}
