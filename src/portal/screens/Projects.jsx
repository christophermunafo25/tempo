import { useEffect, useState } from 'react'
import { pget } from '../api.js'
import { StatusPill, EmptyState } from '../../components/ui.jsx'
import { fmtDate } from '../../time.js'

/* Read-only for now: editing, requesting and comment threads arrive with the
   write surface. Statuses are already mapped server-side — a project the owner
   has parked in Questions reads as In Progress here. */

export default function Projects() {
  const [projects, setProjects] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    pget('/projects').then(setProjects).catch(e => setError(e.message))
  }, [])

  if (error) return <div className="screen"><p className="field-error">{error}</p></div>
  if (!projects) return <div className="screen" />

  const active = projects.filter(p => p.status !== 'complete' && p.state === 'active')
  const complete = projects.filter(p => p.status === 'complete' && p.state === 'active')
  const requested = projects.filter(p => p.state !== 'active')

  return (
    <div className="screen">
      <h1 className="screen-title">Projects</h1>

      {projects.length === 0 && <EmptyState>No projects yet.</EmptyState>}

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
        <article key={p.id} className="portal-project">
          <div className="portal-project-head">
            <h2 className="portal-company">{p.name}</h2>
            {p.state === 'active'
              ? <StatusPill status={p.status} />
              : <span className="pill">{p.state === 'pending' ? 'Requested' : 'Declined'}</span>}
          </div>
          {p.description && <p className="portal-brief">{p.description}</p>}
          {p.completed_at && (
            <p className="portal-dim">Completed {fmtDate(p.completed_at)}</p>
          )}
        </article>
      ))}
    </section>
  )
}
