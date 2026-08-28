import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { shareGet, cleanParams } from './api.js'
import { ClientDot, EmptyState } from '../components/ui.jsx'
import {
  fmtHours, fmtMoney, downloadCSV, downloadXLSX, RANGE_PRESETS, presetRange, matchPreset,
} from '../time.js'
import { csvRows, totalHours, totalAmount, hasMoney } from '../portal/csv.js'
import { hoursWorkbook, workbookFilename } from '../portal/workbook.js'
import HoursTable from '../components/HoursTable.jsx'

const PER_PAGE = 25

/* The share view: one page, no nav, no account.

   A sibling of the owner app and the client portal rather than a child of
   either, so neither navigation exists in this tree at all. Nothing here is
   writable — the server refuses every method but GET — and there is nothing to
   sign out of, so the chrome is a header and nothing more. */

export default function ShareApp() {
  const { token } = useParams()
  const [summary, setSummary] = useState(null)
  const [projects, setProjects] = useState([])
  const [gone, setGone] = useState(false)
  const [error, setError] = useState('')

  const [filters, setFilters] = useState({ from: '', to: '', project_id: '' })
  const [page, setPage] = useState(1)
  const [data, setData] = useState(null)
  const [breakdown, setBreakdown] = useState(null)
  const [exporting, setExporting] = useState('')

  const [theme, setTheme] = useState(() => localStorage.getItem('tempo-theme') || 'light')
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('tempo-theme', theme)
  }, [theme])

  const fail = useCallback((e) => {
    if (e.gone) setGone(true)
    else setError(e.message)
  }, [])

  useEffect(() => {
    shareGet(token, '/summary').then(setSummary).catch(fail)
    shareGet(token, '/projects').then(setProjects).catch(() => {})
  }, [token, fail])

  const query = useMemo(() => cleanParams(filters), [filters])

  const load = useCallback(() => {
    setError('')
    shareGet(token, '/sessions', { ...query, page, per_page: PER_PAGE })
      .then(setData).catch(fail)
    shareGet(token, '/breakdown', query).then(setBreakdown).catch(() => setBreakdown(null))
  }, [token, query, page, fail])

  useEffect(() => { load() }, [load])

  const set = (key, value) => { setFilters(f => ({ ...f, [key]: value })); setPage(1) }
  const applyPreset = (key) => {
    setFilters(f => ({ ...f, ...presetRange(key) }))
    setPage(1)
  }
  const activePreset = matchPreset(filters.from, filters.to)

  const fetchAll = () => shareGet(token, '/export', query)
  const stamp = () => [filters.from, filters.to].filter(Boolean).join('_') || 'all'

  const exportCSV = async () => {
    setExporting('csv')
    try {
      const company = (summary?.company.name || 'hours')
        .replace(/[^a-z0-9]+/gi, '-').toLowerCase()
      downloadCSV(`tempo-hours-${company}-${stamp()}.csv`, csvRows((await fetchAll()).sessions))
    } catch (e) {
      fail(e)
    } finally {
      setExporting('')
    }
  }

  const exportXLSX = async () => {
    setExporting('xlsx')
    try {
      const all = await fetchAll()
      downloadXLSX(
        workbookFilename(summary?.company.name, filters.from, filters.to),
        hoursWorkbook({
          sessions: all.sessions,
          company: summary?.company.name,
          from: filters.from,
          to: filters.to,
          timeZone: summary?.time_zone,
          breakdown: breakdown?.projects,
        }),
      )
    } catch (e) {
      fail(e)
    } finally {
      setExporting('')
    }
  }

  if (gone) return <Gone />
  if (!summary) return <div className="share-page" />

  const pages = data ? Math.max(1, Math.ceil(data.total / PER_PAGE)) : 1
  const breakdownMoney = (breakdown?.projects || []).some(p => p.amount_cents != null)
  const target = summary.company.weekly_hours_target
  const pct = target > 0 ? Math.min(100, (summary.week.minutes / 60 / target) * 100) : 0

  return (
    <div className="share-page">
      <header className="share-head">
        <div className="brand"><span className="brand-dot" />TEMPO</div>
        <div className="share-company">
          <ClientDot color={summary.company.color_accent} size={10} />
          {summary.company.name}
        </div>
        <button className="theme-toggle" onClick={() => setTheme(t => t === 'light' ? 'dark' : 'light')}
          aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}>
          <span className="track"><span className="knob" /></span>
          {theme === 'light' ? 'Light' : 'Dark'}
        </button>
      </header>

      <main className="share-main">
        <div className="stats-row">
          <div className="card stat rise" style={{ '--i': 0 }}>
            <div className="label">This week</div>
            <div className="stat-value mono">{fmtHours(summary.week.minutes)}</div>
            <div className="portal-dim">
              {target > 0 ? `of ${target} contracted hours` : 'hours logged'}
            </div>
            {target > 0 && (
              <div className="portal-meter"><span style={{ width: `${pct}%` }} /></div>
            )}
          </div>
          <div className="card stat rise" style={{ '--i': 1 }}>
            <div className="label">This month</div>
            <div className="stat-value mono">{fmtHours(summary.month.minutes)}</div>
            <div className="portal-dim">
              {summary.month.amount_cents != null
                ? `hours · ${fmtMoney(summary.month.amount_cents / 100)}`
                : 'hours logged'}
            </div>
          </div>
          <div className="card stat rise" style={{ '--i': 2 }}>
            <div className="label">Published sessions</div>
            <div className="stat-value mono">{summary.total_sessions}</div>
            <div className="portal-dim">all time</div>
          </div>
        </div>

        <div className="filterbar">
          {RANGE_PRESETS.map(p => (
            <button key={p.key} className={`chip${activePreset === p.key ? ' active' : ''}`}
              onClick={() => applyPreset(p.key)}>{p.label}</button>
          ))}
        </div>

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
          <span className="spacer" />
          <button className="btn btn-sm" onClick={exportXLSX}
            disabled={!!exporting || !data || data.total === 0}>
            {exporting === 'xlsx' ? 'Building…' : 'Download spreadsheet'}
          </button>
          <button className="btn btn-outline btn-sm" onClick={exportCSV}
            disabled={!!exporting || !data || data.total === 0}>
            {exporting === 'csv' ? 'Preparing…' : 'CSV'}
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
                      {hasMoney(data.sessions) && ` · ${fmtMoney(totalAmount(data.sessions))}`}
                    </div>
                  </div>
                </div>

                <HoursTable sessions={data.sessions} />

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
              <p className="portal-dim">
                {breakdown.basis} Hours are clocked per company, so these figures
                are derived, not measured.
              </p>
            </div>
            <table className="portal-table">
              <tbody>
                {breakdown.projects.map(p => (
                  <tr key={p.project_id ?? 'untagged'}>
                    <td>{p.name}</td>
                    <td className="mono">{fmtHours(p.minutes, 2)} hrs</td>
                    {breakdownMoney && (
                      <td className="mono">{fmtMoney((p.amount_cents || 0) / 100)}</td>
                    )}
                  </tr>
                ))}
                <tr className="portal-total">
                  <td>Total</td>
                  <td className="mono">
                    {fmtHours(breakdown.projects.reduce((a, p) => a + p.minutes, 0), 2)} hrs
                  </td>
                  {breakdownMoney && (
                    <td className="mono">
                      {fmtMoney(breakdown.projects.reduce((a, p) => a + (p.amount_cents || 0), 0) / 100)}
                    </td>
                  )}
                </tr>
              </tbody>
            </table>
          </section>
        )}

        <p className="portal-footnote">
          Dates are shown in {summary.time_zone.replace(/_/g, ' ')}. Only work that
          has been published is listed here.
        </p>
      </main>
    </div>
  )
}

// Expired, revoked, rotated, or never real — the server does not distinguish
// them and neither does this, because telling them apart is exactly what a
// prober would want.
function Gone() {
  return (
    <div className="auth-page">
      <div className="auth-card card rise">
        <div className="brand"><span className="brand-dot" />TEMPO</div>
        <p className="auth-note">
          This link is no longer valid. Shared links expire, and can be replaced
          or switched off at any time. Ask for a new one.
        </p>
      </div>
    </div>
  )
}
