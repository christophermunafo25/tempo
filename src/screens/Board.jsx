import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { get, post, patch } from '../api.js'
import { STATUSES, statusMeta } from '../time.js'
import { ClientFilter, ClientDot, Dropdown, Modal, StatusPill, EmptyState } from '../components/ui.jsx'
import ProjectDrawer from './ProjectDrawer.jsx'

export default function Board() {
  const [clients, setClients] = useState([])
  const [filter, setFilter] = useState(null)
  const [projects, setProjects] = useState([])
  const [dragId, setDragId] = useState(null)
  const [overCol, setOverCol] = useState(null)
  const [pendingDrop, setPendingDrop] = useState(null) // {project, status}
  const [questionText, setQuestionText] = useState('')
  const [drawerId, setDrawerId] = useState(null)
  const [addCol, setAddCol] = useState(null) // status key of the column being added to

  const refresh = useCallback(() => {
    get(`/board${filter ? `?client_id=${filter}` : ''}`).then(setProjects)
  }, [filter])

  useEffect(() => { get('/clients').then(setClients) }, [])
  useEffect(() => { refresh() }, [refresh])

  const applyStatus = async (project, status, question) => {
    await patch(`/projects/${project.id}`, { status, question_text: question, source: 'board' })
    setPendingDrop(null)
    setQuestionText('')
    refresh()
  }

  const onDrop = (statusKey) => {
    setOverCol(null)
    const project = projects.find(p => p.id === dragId)
    setDragId(null)
    if (!project || project.status === statusKey) return
    if (statusKey === 'questions' || statusKey === 'complete') {
      setPendingDrop({ project, status: statusKey })
      setQuestionText('')
    } else {
      applyStatus(project, statusKey)
    }
  }

  return (
    <div className="screen" style={{ maxWidth: 1320 }}>
      <h1 className="screen-title rise">Board</h1>

      <div className="filterbar rise" style={{ '--i': 1 }}>
        <ClientFilter clients={clients} value={filter} onChange={setFilter} />
      </div>

      {clients.length === 0 ? (
        <div className="card rise" style={{ '--i': 2 }}>
          <EmptyState>
            No clients yet. Add your first client on the Clock screen, then build the board here.
          </EmptyState>
        </div>
      ) : (
        <div className="board rise" style={{ '--i': 2 }}>
          {STATUSES.map(col => {
            const items = projects.filter(p => p.status === col.key)
            return (
              <div key={col.key}>
                <div className="col-head">
                  <span className="label" style={{ fontSize: 10 }}>{col.short || col.label}</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <span className="col-count">{items.length}</span>
                    {col.key !== 'complete' && (
                      <button className="st-ctl" style={{ fontSize: 14, lineHeight: 1 }}
                        aria-label={`Add project to ${col.label}`}
                        onClick={() => setAddCol(col.key)}>
                        +
                      </button>
                    )}
                  </span>
                </div>
                <div
                  className={`col-body${overCol === col.key ? ' over' : ''}`}
                  onDragOver={(e) => { e.preventDefault(); setOverCol(col.key) }}
                  onDragLeave={() => setOverCol(c => c === col.key ? null : c)}
                  onDrop={() => onDrop(col.key)}
                >
                  {items.map(p => (
                    <div key={p.id}
                      className={`kcard${dragId === p.id ? ' dragging' : ''}`}
                      draggable
                      onDragStart={() => setDragId(p.id)}
                      onDragEnd={() => { setDragId(null); setOverCol(null) }}
                      onClick={() => setDrawerId(p.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter') setDrawerId(p.id) }}
                    >
                      <div className="k-name">{p.name}</div>
                      <div className="k-client">
                        <ClientDot color={p.color_accent} />
                        {p.client_name}
                      </div>
                      {p.subtask_total > 0 && (
                        <div className="k-progress">
                          <span className="mono">{p.subtask_done}/{p.subtask_total}</span>
                          <span className="track">
                            <span className="fill" style={{ width: `${(p.subtask_done / p.subtask_total) * 100}%` }} />
                          </span>
                        </div>
                      )}
                      {p.asset_links.length > 0 && (
                        <div className="k-links">
                          {p.asset_links.map(l => (
                            <a key={l.id} className="linkchip" href={l.url} target="_blank"
                              rel="noreferrer" onClick={e => e.stopPropagation()}>
                              <span>{l.label}</span>
                            </a>
                          ))}
                        </div>
                      )}
                      {p.last_summary && <div className="k-summary">{p.last_summary}</div>}
                    </div>
                  ))}
                  {col.key === 'complete' && (
                    <div className="col-foot">
                      Last 14 days · <Link to="/dashboard?view=all">full archive →</Link>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {pendingDrop?.status === 'questions' && (
        <Modal title="Questions or concerns" onClose={() => setPendingDrop(null)}>
          <div className="field">
            <span className="label">{pendingDrop.project.name} — what’s the question?</span>
            <textarea className="textarea" autoFocus value={questionText}
              onChange={e => setQuestionText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey && questionText.trim()) {
                  e.preventDefault()
                  applyStatus(pendingDrop.project, 'questions', questionText)
                }
              }} />
          </div>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setPendingDrop(null)}>Cancel</button>
            <button className="btn" disabled={!questionText.trim()}
              onClick={() => applyStatus(pendingDrop.project, 'questions', questionText)}>
              Move to Questions
            </button>
          </div>
        </Modal>
      )}

      {pendingDrop?.status === 'complete' && (
        <Modal title="Mark complete?" onClose={() => setPendingDrop(null)}>
          <p style={{ fontSize: 14, color: 'var(--text-2)' }}>
            <strong style={{ fontWeight: 400, color: 'var(--text-1)' }}>{pendingDrop.project.name}</strong> will
            leave the active board after 14 days and disappear from future session dropdowns.
            Its history stays in the dashboard archive.
          </p>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setPendingDrop(null)}>Keep it active</button>
            <button className="btn" onClick={() => applyStatus(pendingDrop.project, 'complete')}>
              Mark complete
            </button>
          </div>
        </Modal>
      )}

      {addCol && (
        <AddProjectModal
          status={addCol}
          clients={clients}
          defaultClientId={filter}
          onSaved={() => { setAddCol(null); refresh() }}
          onClose={() => setAddCol(null)}
        />
      )}

      {drawerId && (
        <ProjectDrawer projectId={drawerId} onClose={() => { setDrawerId(null); refresh() }} />
      )}
    </div>
  )
}

function AddProjectModal({ status, clients, defaultClientId, onSaved, onClose }) {
  const [name, setName] = useState('')
  const [clientId, setClientId] = useState(defaultClientId ?? (clients.length === 1 ? clients[0].id : null))
  const [question, setQuestion] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const needsQuestion = status === 'questions'
  const valid = name.trim() && clientId && (!needsQuestion || question.trim())

  const save = async () => {
    if (!valid || saving) return
    setSaving(true)
    setError('')
    try {
      await post('/projects', {
        client_id: clientId,
        name,
        status,
        question_text: question,
      })
      onSaved()
    } catch (e) {
      setError(e.message)
      setSaving(false)
    }
  }

  return (
    <Modal title="Add project" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="label">Starts in</span>
          <StatusPill status={status} />
        </div>
        <div className="field">
          <span className="label">Project name</span>
          <input className="input" autoFocus value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') save() }} />
        </div>
        <div className="field">
          <span className="label">Client</span>
          <Dropdown
            value={clientId}
            placeholder="Select a client"
            options={clients.map(c => ({ value: c.id, label: c.name, dot: c.color_accent }))}
            onSelect={setClientId}
          />
        </div>
        {needsQuestion && (
          <div className="field">
            <span className="label">What’s the question or concern?</span>
            <textarea className="textarea" value={question}
              onChange={e => setQuestion(e.target.value)} />
          </div>
        )}
      </div>
      {error && <div className="field-error" style={{ marginTop: 16, fontSize: 13 }}>{error}</div>}
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={!valid || saving}>
          {saving ? 'Adding…' : `Add to ${statusMeta(status).short || statusMeta(status).label}`}
        </button>
      </div>
    </Modal>
  )
}
