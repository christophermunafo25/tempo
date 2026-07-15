import { useEffect, useMemo, useRef, useState } from 'react'
import { get, post } from '../api.js'
import { STATUSES, fmtDuration, toLocalInput, fromLocalInput } from '../time.js'
import { Dropdown, ClientDot } from '../components/ui.jsx'
import { SubtaskEditor, LinkEditor } from '../components/ProjectBits.jsx'

let entryKey = 0
const blankEntry = () => ({
  key: ++entryKey,
  projectId: null,
  summary: '',
  status: 'in_progress',
  questionText: '',
  prevStatus: null,
  confirmingComplete: false,
  newProjectOpen: false,
  newName: '',
  subtasks: [],
  links: [],
})

export default function ClockOutPanel({ session, initialOut, onSaved, onCancel }) {
  const [inn, setInn] = useState(toLocalInput(session.clock_in))
  const [out, setOut] = useState(toLocalInput(initialOut))
  const [projects, setProjects] = useState([])
  const [entries, setEntries] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const panelRef = useRef(null)

  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [onCancel])

  useEffect(() => {
    Promise.all([
      get(`/projects?client_id=${session.client_id}`),
      get(`/prefill?client_id=${session.client_id}`),
    ]).then(([ps, prefill]) => {
      setProjects(ps)
      // Yesterday's state is the starting point: carry forward each project,
      // its last summary, current status, subtasks, and links.
      const prefilled = prefill.map(({ project, last_summary }) => ({
        ...blankEntry(),
        projectId: project.id,
        summary: last_summary,
        status: project.status,
        questionText: project.question_text || '',
        subtasks: project.subtasks,
        links: project.asset_links,
      }))
      setEntries(prefilled.length ? prefilled : [blankEntry()])
      setLoaded(true)
    })
  }, [session.client_id])

  const durationMin = useMemo(() => {
    const ms = fromLocalInput(out) - fromLocalInput(inn)
    return Math.max(0, ms / 60000)
  }, [out, inn])

  const update = (key, patchObj) =>
    setEntries(es => es.map(e => e.key === key ? { ...e, ...patchObj } : e))

  const setStatus = (entry, status) => {
    if (status === 'complete') {
      update(entry.key, { confirmingComplete: true, prevStatus: entry.status })
    } else {
      update(entry.key, { status, confirmingComplete: false })
    }
  }

  const chooseProject = (entry, projectId) => {
    const p = projects.find(x => x.id === projectId)
    update(entry.key, {
      projectId,
      status: p.status,
      questionText: p.question_text || '',
      subtasks: p.subtasks || [],
      links: p.asset_links || [],
      newProjectOpen: false,
    })
  }

  const createProject = async (entry) => {
    if (!entry.newName.trim()) return
    const p = await post('/projects', { client_id: session.client_id, name: entry.newName })
    setProjects(ps => [...ps, p].sort((a, b) => a.name.localeCompare(b.name)))
    update(entry.key, {
      projectId: p.id, newProjectOpen: false, newName: '',
      status: 'in_progress', subtasks: [], links: [],
    })
  }

  const save = async () => {
    setError('')
    const payload = []
    for (const e of entries) {
      if (!e.projectId) continue
      if (e.confirmingComplete) {
        setError('Confirm or cancel the “Complete” status before saving.')
        return
      }
      if (e.status === 'questions' && !e.questionText.trim()) {
        setError('“Questions or Concerns” needs the question itself — fill it in before saving.')
        return
      }
      payload.push({
        project_id: e.projectId,
        summary: e.summary,
        status: e.status,
        question_text: e.questionText,
      })
    }
    setSaving(true)
    try {
      await post(`/sessions/${session.id}/clock-out`, {
        clock_in: fromLocalInput(inn).toISOString(),
        clock_out: fromLocalInput(out).toISOString(),
        entries: payload,
      })
      onSaved()
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  const usedIds = entries.map(e => e.projectId).filter(Boolean)

  return (
    <div className="panel-scrim" ref={panelRef}>
      <div className="panel">
        <div className="panel-head">
          <div>
            <span className="label" style={{ display: 'block', marginBottom: 8 }}>Session review</span>
            <h2 style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <ClientDot color={session.color_accent} size={12} />
              {session.client_name}
            </h2>
          </div>
          <div className="meta">
            <span className="panel-duration">{fmtDuration(durationMin)}</span>
            <div className="field">
              <span className="label">Clock in</span>
              <input type="datetime-local" className="input" style={{ width: 'auto' }}
                value={inn}
                onChange={e => setInn(e.target.value)} />
            </div>
            <div className="field">
              <span className="label">Clock out</span>
              <input type="datetime-local" className="input" style={{ width: 'auto' }}
                value={out}
                min={inn}
                onChange={e => setOut(e.target.value)} />
            </div>
          </div>
        </div>

        {!loaded ? null : (
          <>
            {entries.map(entry => {
              const available = projects
                .filter(p => p.id === entry.projectId || !usedIds.includes(p.id))
                .map(p => ({ value: p.id, label: p.name }))
              return (
                <div className="card entry-card" key={entry.key}>
                  <div className="entry-head">
                    {entry.newProjectOpen ? (
                      <div className="addline" style={{ flex: 1, maxWidth: 380 }}>
                        <input className="input" autoFocus placeholder="New project name"
                          value={entry.newName}
                          onChange={e => update(entry.key, { newName: e.target.value })}
                          onKeyDown={e => { if (e.key === 'Enter') createProject(entry) }} />
                        <button className="btn btn-sm" onClick={() => createProject(entry)}
                          disabled={!entry.newName.trim()}>Create</button>
                        <button className="btn btn-ghost btn-sm"
                          onClick={() => update(entry.key, { newProjectOpen: false, newName: '' })}>Cancel</button>
                      </div>
                    ) : (
                      <Dropdown
                        value={entry.projectId}
                        placeholder="Select a project"
                        options={available}
                        onSelect={(id) => chooseProject(entry, id)}
                        footer={{ label: 'New project', onClick: () => update(entry.key, { newProjectOpen: true }) }}
                      />
                    )}
                    {entries.length > 1 && (
                      <button className="entry-remove"
                        onClick={() => setEntries(es => es.filter(x => x.key !== entry.key))}>
                        Remove
                      </button>
                    )}
                  </div>

                  <div className="field">
                    <span className="label">Summary — what was worked on</span>
                    <input className="input" value={entry.summary}
                      placeholder="Short note on this session’s progress"
                      onChange={e => update(entry.key, { summary: e.target.value })} />
                  </div>

                  <div className="field">
                    <span className="label">Status</span>
                    <div className="seg" role="radiogroup" aria-label="Project status">
                      {STATUSES.map(s => (
                        <button key={s.key} role="radio"
                          aria-checked={entry.status === s.key && !entry.confirmingComplete}
                          className={`seg-btn${(entry.confirmingComplete ? s.key === 'complete' : entry.status === s.key) ? ' active' : ''}`}
                          onClick={() => setStatus(entry, s.key)}>
                          {s.short || s.label}
                        </button>
                      ))}
                    </div>
                    {entry.confirmingComplete && (
                      <div className="confirm-inline">
                        <span>Mark <strong>{projects.find(p => p.id === entry.projectId)?.name || 'this project'}</strong> complete? It leaves the board’s active flow and future dropdowns.</span>
                        <button className="btn btn-sm"
                          onClick={() => update(entry.key, { status: 'complete', confirmingComplete: false })}>
                          Complete it
                        </button>
                        <button className="btn btn-ghost btn-sm"
                          onClick={() => update(entry.key, { confirmingComplete: false, status: entry.prevStatus })}>
                          Keep as is
                        </button>
                      </div>
                    )}
                    {entry.status === 'questions' && !entry.confirmingComplete && (
                      <textarea className={`textarea${error && !entry.questionText.trim() ? ' input-error' : ''}`}
                        placeholder="What’s the question or concern? (required)"
                        value={entry.questionText}
                        onChange={e => update(entry.key, { questionText: e.target.value })} />
                    )}
                  </div>

                  {entry.projectId ? (
                    <>
                      <div className="field">
                        <span className="label">Subtasks</span>
                        <SubtaskEditor projectId={entry.projectId} subtasks={entry.subtasks}
                          onChange={(subtasks) => update(entry.key, { subtasks })} />
                      </div>
                      <div className="field">
                        <span className="label">Asset links</span>
                        <LinkEditor projectId={entry.projectId} links={entry.links}
                          onChange={(links) => update(entry.key, { links })} />
                      </div>
                    </>
                  ) : (
                    <p style={{ fontSize: 13, color: 'var(--text-4)' }}>
                      Pick or create a project to add subtasks and asset links.
                    </p>
                  )}
                </div>
              )
            })}

            <button className="btn btn-outline" onClick={() => setEntries(es => [...es, blankEntry()])}>
              + Add another project
            </button>

            {error && <div className="field-error" style={{ marginTop: 16, fontSize: 14 }}>{error}</div>}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 32, paddingTop: 24, borderTop: '1px solid var(--hairline)' }}>
              <button className="btn btn-ghost" onClick={onCancel}>Keep working</button>
              <button className="btn btn-accent" style={{ padding: '12px 32px' }} onClick={save} disabled={saving}>
                {saving ? 'Saving…' : 'Save session'}
              </button>
            </div>
            {entries.every(e => !e.projectId) && (
              <p style={{ textAlign: 'right', fontSize: 12, color: 'var(--text-4)', marginTop: 8 }}>
                No project logged — the session still saves, flagged as untagged time.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
