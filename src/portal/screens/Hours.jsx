import { useCallback, useEffect, useMemo, useState } from 'react'
import { pget, ppost } from '../api.js'
import { EmptyState } from '../../components/ui.jsx'
import { fmtDuration, fmtHours, downloadCSV } from '../../time.js'
import { csvRows, projectNames, sessionNotes, totalHours } from '../csv.js'

const PER_PAGE = 25

export default function Hours() {
  const [filters, setFilters] = useState({ from: '', to: '', project_id: '' })
  const [page, setPage] = useState(1)
  const [data, setData] = useState(null)
  const [projects, setProjects] = useState([])
  const [breakdown, setBreakdown] = useState(null)
  const [error, setError] = useState('')
  const [exporting, setExporting] = useState(false)

  useEffect(() => { pget('/projects').then(setProjects).catch(() => {}) }, [])

  const query = useMemo(() => {
    const p = new URLSearchParams()
    if (filters.from) p.set('from', filters.from)
    if (filters.to) p.set('to', filters.to)
    if (filters.project_id) p.set('project_id', filters.project_id)
    return p
  }, [filters])

  const load = useCallback(() => {
    const p = new URLSearchParams(query)
    p.set('page', String(page))
    p.set('per_page', String(PER_PAGE))
    setError('')
    pget(`/sessions?${p}`).then(setData).catch(e => setError(e.message))
    pget(`/breakdown?${query}`).then(setBreakdown).catch(() => setBreakdown(null))
  }, [query, page])

  useEffect(() => { load() }, [load])

  const set = (key, value) => { setFilters(f => ({ ...f, [key]: value })); setPage(1) }
  const clear = () => { setFilters({ from: '', to: '', project_id: '' }); setPage(1) }
  const filtered = filters.from || filters.to || filters.project_id

  // The export re-fetches the same filter unpaginated and writes an audit row,
  // then hands the identical array to the same row builder the table uses.
  const exportCSV = async () => {
    setExporting(true)
    try {
      const all = await ppost('/export', {
        from: filters.from || undefined,
        to: filters.to || undefined,
        project_id: filters.project_id || undefined,
      })
      const stamp = [filters.from, filters.to].filter(Boolean).join('_') || 'all'
      downloadCSV(`hours-${stamp}.csv`, csvRows(all.sessions))
    } catch (e) {
      setError(e.message)
    } finally {
      setExporting(false)
    }
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / PER_PAGE)) : 1

  return (
    <div className="screen">
      <h1 className="screen-title">Hours</h1>

      <div className="filterbar">
        <label className="portal-filter">
          <span className="label">From</span>
          <input className="input" type="date" value={filters.from}
            onChange={(e) => set('from', e.target.value)} />
        </label>
        <label className="portal-filter">
          <span className="label">To</span>
          <input className="input" type="date" value={filters.to}
            onChange={(e) => set('to', e.target.value)} />
        </label>
        <label className="portal-filter">
          <span className="label">Project</span>
          <select className="input" value={filters.project_id}
            onChange={(e) => set('project_id', e.target.value)}>
            <option value="">All projects</option>
            {projects.filter(p => p.state === 'active').map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        {filtered && <button className="btn-ghost btn-sm" onClick={clear}>Clear</button>}
        <span className="spacer" />
        <button className="btn btn-sm" onClick={exportCSV}
          disabled={exporting || !data || data.total === 0}>
          {exporting ? 'Preparing…' : 'Download CSV'}
        </button>
      </div>

      {error && <p className="field-error">{error}</p>}

      <section className="card rise">
        {!data ? null : data.sessions.length === 0
          ? <EmptyState>No published hours match this filter.</EmptyState>
          : (
            <>
              <div className="portal-publish-head">
                <div>
                  <div className="label">
                    {data.total} session{data.total === 1 ? '' : 's'}
                  </div>
                  <div className="portal-dim">
                    {totalHours(data.sessions)} hrs on this page
                  </div>
                </div>
              </div>

              <table className="portal-table">
                <thead>
                  <tr><th>Date</th><th>Hours</th><th>Projects</th><th>Notes</th></tr>
                </thead>
                <tbody>
                  {data.sessions.map(s => (
                    <tr key={s.id}>
                      <td className="mono">{s.date}</td>
                      <td className="mono">{fmtDuration(s.duration_minutes)}</td>
                      <td>{projectNames(s)}</td>
                      <td className="portal-dim">{sessionNotes(s)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {pages > 1 && (
                <div className="portal-pager">
                  <button className="btn-ghost btn-sm" disabled={page <= 1}
                    onClick={() => setPage(p => p - 1)}>← Newer</button>
                  <span className="portal-dim mono">Page {page} of {pages}</span>
                  <button className="btn-ghost btn-sm" disabled={page >= pages}
                    onClick={() => setPage(p => p + 1)}>Older →</button>
                </div>
              )}
            </>
          )}
      </section>

      {breakdown && breakdown.projects.length > 0 && (
        <section className="card rise portal-card">
          <div>
            <div className="label">By project — estimate</div>
            <p className="portal-dim">{breakdown.basis} Hours are clocked per company,
              so these figures are derived, not measured.</p>
          </div>
          <table className="portal-table">
            <tbody>
              {breakdown.projects.map(p => (
                <tr key={p.project_id ?? 'untagged'}>
                  <td>{p.name}</td>
                  <td className="mono">{fmtHours(p.minutes, 2)} hrs</td>
                </tr>
              ))}
              {/* Rows round independently, so the total is computed from the
                  raw minutes — it has to match the figure above the table. */}
              <tr className="portal-total">
                <td>Total</td>
                <td className="mono">
                  {fmtHours(breakdown.projects.reduce((a, p) => a + p.minutes, 0), 2)} hrs
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}
