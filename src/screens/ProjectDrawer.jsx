import { useEffect, useState } from 'react'
import { get } from '../api.js'
import { fmtDate, statusMeta } from '../time.js'
import { ClientDot, StatusPill } from '../components/ui.jsx'
import { SubtaskEditor, LinkEditor } from '../components/ProjectBits.jsx'

export default function ProjectDrawer({ projectId, onClose }) {
  const [detail, setDetail] = useState(null)

  useEffect(() => {
    get(`/projects/${projectId}/detail`).then(setDetail)
  }, [projectId])

  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [onClose])

  if (!detail) return null

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" aria-label={`${detail.name} details`}>
        <button className="drawer-close" onClick={onClose} aria-label="Close">✕</button>

        <div>
          <div className="k-client" style={{ marginBottom: 10 }}>
            <ClientDot color={detail.color_accent} />
            {detail.client_name}
          </div>
          <h2>{detail.name}</h2>
          <div style={{ marginTop: 12 }}><StatusPill status={detail.status} /></div>
          {detail.status === 'questions' && detail.question_text && (
            <p style={{ marginTop: 12, fontSize: 14, color: 'var(--st-amber)' }}>
              “{detail.question_text}”
            </p>
          )}
        </div>

        <section>
          <span className="label">Subtasks</span>
          <SubtaskEditor projectId={detail.id} subtasks={detail.subtasks}
            onChange={(subtasks) => setDetail(d => ({ ...d, subtasks }))} />
        </section>

        <section>
          <span className="label">Asset links</span>
          <LinkEditor projectId={detail.id} links={detail.asset_links}
            onChange={(asset_links) => setDetail(d => ({ ...d, asset_links }))} />
        </section>

        <section>
          <span className="label">Summary history</span>
          {detail.entries.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--text-4)' }}>No sessions logged against this project yet.</p>
          ) : detail.entries.map(e => (
            <div className="hist-item" key={e.id}>
              <span className="when">{fmtDate(e.clock_in)}</span>
              <span className="what">{e.summary || '—'}</span>
              <StatusPill status={e.status_at_entry} />
            </div>
          ))}
        </section>

        <section>
          <span className="label">Status timeline</span>
          <div className="timeline">
            {detail.status_events.map(ev => (
              <div className="hist-item" key={ev.id}>
                <span className="when">{fmtDate(ev.created_at)}</span>
                <span className="what">
                  {statusMeta(ev.status).label}
                  <span style={{ color: 'var(--text-4)' }}> · via {ev.source === 'board' ? 'board drag' : ev.source === 'created' ? 'project created' : 'clock-out'}</span>
                </span>
              </div>
            ))}
          </div>
        </section>
      </aside>
    </>
  )
}
