import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { pget, ppost } from '../api.js'
import { StatusPill, EmptyState } from '../../components/ui.jsx'
import { fmtDate } from '../../time.js'

export default function Projects() {
  const [projects, setProjects] = useState(null)
  const [error, setError] = useState('')
  const [requesting, setRequesting] = useState(false)

  const load = useCallback(() => {
    pget('/projects').then(setProjects).catch(e => setError(e.message))
  }, [])
  useEffect(() => { load() }, [load])

  if (error) return <div className="screen"><p className="field-error">{error}</p></div>
  if (!projects) return <div className="screen" />

  const active = projects.filter(p => p.status !== 'complete' && p.state === 'active')
  const complete = projects.filter(p => p.status === 'complete' && p.state === 'active')
  const requested = projects.filter(p => p.state !== 'active')

  return (
    <div className="screen">
      <div className="portal-detail-head">
        <h1 className="screen-title portal-detail-title">Projects</h1>
        {!requesting && (
          <button className="btn btn-sm" onClick={() => setRequesting(true)}>Request a project</button>
        )}
      </div>

      {requesting && (
        <RequestForm onDone={() => { setRequesting(false); load() }}
          onCancel={() => setRequesting(false)} />
      )}

      {projects.length === 0 && !requesting && (
        <EmptyState>No projects yet.</EmptyState>
      )}

      <Group title="In flight" projects={active} />
      <Group title="Requested" projects={requested} />
      <Group title="Complete" projects={complete} />
    </div>
  )
}

function Group({ title, projects }) {
  if (!projects.length) return null
  return (
    <section className="card rise portal-card">
      <div className="label">{title}</div>
      {projects.map(p => (
        <Link key={p.id} className="portal-project portal-project-link" to={`/portal/projects/${p.id}`}>
          <div className="portal-project-head">
            <h2 className="portal-company">
              {p.name}
              {p.unread_count > 0 && <span className="tab-badge">{p.unread_count}</span>}
            </h2>
            {p.state === 'active'
              ? <StatusPill status={p.status} />
              : <span className="pill">{p.state === 'pending' ? 'Requested' : 'Declined'}</span>}
          </div>
          {p.description && <p className="portal-brief">{p.description}</p>}
          <p className="portal-dim">
            {p.comment_count > 0
              ? `${p.comment_count} message${p.comment_count === 1 ? '' : 's'}`
              : 'No messages yet'}
            {p.completed_at ? ` · Completed ${fmtDate(p.completed_at)}` : ''}
          </p>
        </Link>
      ))}
    </section>
  )
}

// A request is a real project row from the moment it is created, but it stays
// out of Chris's board until he accepts it.
function RequestForm({ onDone, onCancel }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      await ppost('/projects', { name, description })
      onDone()
    } catch (err) {
      setError(err.message); setBusy(false)
    }
  }

  return (
    <form className="card rise portal-card" onSubmit={submit}>
      <div className="label">Request a project</div>
      <p className="portal-dim">
        This goes to Chris to accept. It won’t appear as scheduled work until he does.
      </p>
      <div className="field">
        <label className="label" htmlFor="r-name">What do you need?</label>
        <input id="r-name" className="input" maxLength={200} required autoFocus
          value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label className="label" htmlFor="r-desc">Any detail</label>
        <textarea id="r-desc" className="textarea" rows={4} maxLength={5000}
          value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      {error && <p className="field-error">{error}</p>}
      <div className="portal-publish-actions">
        <button className="btn btn-sm" type="submit" disabled={busy}>
          {busy ? 'Sending…' : 'Send request'}
        </button>
        <button className="btn btn-outline btn-sm" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}
