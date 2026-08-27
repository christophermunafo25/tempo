import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { pget, ppost } from '../api.js'
import { api } from '../../api.js'
import { StatusPill, Checkbox } from '../../components/ui.jsx'
import Thread from '../../components/Thread.jsx'
import { fmtDate } from '../../time.js'

export default function ProjectDetail() {
  const { id } = useParams()
  const [project, setProject] = useState(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)

  const load = useCallback(async (markRead) => {
    try {
      const data = await pget(`/projects/${id}`)
      setProject(data)
      if (markRead) await ppost(`/projects/${id}/read`)
    } catch (e) {
      setError(e.message)
    }
  }, [id])

  useEffect(() => { load(true) }, [load])

  if (error) return <div className="screen"><p className="field-error">{error}</p></div>
  if (!project) return <div className="screen" />

  const post = async (body) => {
    setProject(await ppost(`/projects/${id}/comments`, { body }).then(async (comments) => {
      const fresh = await pget(`/projects/${id}`)
      return { ...fresh, comments }
    }))
  }

  return (
    <div className="screen">
      <Link className="btn-ghost btn-sm portal-back" to="/portal/projects">← All projects</Link>

      <div className="portal-detail-head">
        <h1 className="screen-title portal-detail-title">{project.name}</h1>
        {project.state === 'active'
          ? <StatusPill status={project.status} />
          : <span className="pill">{project.state === 'pending' ? 'Requested' : 'Declined'}</span>}
      </div>

      {project.completed_at && (
        <p className="portal-dim">Completed {fmtDate(project.completed_at)}</p>
      )}

      <section className="card rise portal-card">
        <div className="portal-publish-head">
          <div className="label">Brief</div>
          {!editing && <button className="btn-ghost btn-sm" onClick={() => setEditing(true)}>Edit</button>}
        </div>
        {editing
          ? <EditForm project={project} onDone={(next) => { setProject(next); setEditing(false) }}
              onCancel={() => setEditing(false)} />
          : (
            <p className={project.description ? 'portal-brief' : 'portal-dim'}>
              {project.description || 'No brief yet. Add one so everyone is working from the same page.'}
            </p>
          )}
      </section>

      {project.subtasks.length > 0 && (
        <section className="card rise portal-card">
          <div className="label">Progress</div>
          {/* Read-only on purpose: this is Chris's own task breakdown. */}
          <ul className="portal-subtasks">
            {project.subtasks.map(st => (
              <li key={st.id}>
                <Checkbox checked={!!st.is_done} onChange={() => {}} label={st.title} />
                <span className={st.is_done ? 'is-done' : ''}>{st.title}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <LinksCard project={project} onChange={() => load(false)} />

      <section className="card rise portal-card">
        <div className="label">Messages</div>
        <Thread comments={project.comments} onPost={post}
          placeholder="Ask a question or leave a note…" />
      </section>
    </div>
  )
}

function EditForm({ project, onDone, onCancel }) {
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const save = async (e) => {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      onDone(await api(`/portal/projects/${project.id}`,
        { method: 'PATCH', body: { name, description } }))
    } catch (err) {
      setError(err.message); setBusy(false)
    }
  }

  return (
    <form className="portal-edit" onSubmit={save}>
      <div className="field">
        <label className="label" htmlFor="p-name">Name</label>
        <input id="p-name" className="input" maxLength={200} required
          value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label className="label" htmlFor="p-desc">Brief</label>
        <textarea id="p-desc" className="textarea" rows={5} maxLength={5000}
          value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      {error && <p className="field-error">{error}</p>}
      <div className="portal-publish-actions">
        <button className="btn btn-sm" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button className="btn btn-outline btn-sm" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

// Clients add links but never remove them — removal was not part of the ask,
// and every delete path would need its own soft-delete column.
function LinksCard({ project, onChange }) {
  const [label, setLabel] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const add = async (e) => {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      await ppost(`/projects/${project.id}/links`, { label, url })
      setLabel(''); setUrl('')
      onChange()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card rise portal-card">
      <div className="label">Files and links</div>
      {project.links.length > 0 && (
        <ul className="portal-links">
          {project.links.map(l => (
            <li key={l.id}>
              <a className="linkchip" href={l.url} target="_blank" rel="noreferrer noopener">
                {l.label}
              </a>
            </li>
          ))}
        </ul>
      )}
      <form className="portal-invite" onSubmit={add}>
        <input className="input" placeholder="Label" required
          value={label} onChange={(e) => setLabel(e.target.value)} />
        <input className="input" type="url" placeholder="https://…" required
          value={url} onChange={(e) => setUrl(e.target.value)} />
        <button className="btn btn-sm" type="submit" disabled={busy}>Add</button>
      </form>
      {error && <p className="field-error">{error}</p>}
    </section>
  )
}
