import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { pget } from '../api.js'
import { usePulse } from '../usePulse.js'
import { EmptyState } from '../../components/ui.jsx'
import { fmtHours, fmtDuration, fmtMoney } from '../../time.js'
import { projectNames } from '../csv.js'

export default function Overview() {
  const [summary, setSummary] = useState(null)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    pget('/summary').then(setSummary).catch(e => setError(e.message))
  }, [])
  useEffect(() => { load() }, [load])
  usePulse(() => pget('/pulse').then(p => p.signature), load)

  if (error) return <div className="screen"><p className="field-error">{error}</p></div>
  if (!summary) return <div className="screen" />

  const target = summary.company.weekly_hours_target
  const weekHours = summary.week.minutes / 60
  const pct = target > 0 ? Math.min(100, (weekHours / target) * 100) : 0

  return (
    <div className="screen">
      <h1 className="screen-title">Overview</h1>

      <div className="stats-row">
        <div className="card stat rise" style={{ '--i': 0 }}>
          <div className="label">This week</div>
          <div className="stat-value mono">{fmtHours(summary.week.minutes)}</div>
          <div className="portal-dim">
            {target > 0 ? `of ${target} contracted hours` : 'hours logged'}
          </div>
          {target > 0 && (
            <div className="portal-meter" role="img"
              aria-label={`${fmtHours(summary.week.minutes)} of ${target} hours`}>
              <span style={{ width: `${pct}%` }} />
            </div>
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

      <section className="card rise" style={{ '--i': 3 }}>
        <div className="portal-publish-head">
          <div className="label">Recent activity</div>
          <Link className="btn-ghost btn-sm" to="/portal/hours">All hours →</Link>
        </div>

        {summary.recent.length === 0
          ? <EmptyState>No hours published yet. They’ll appear here as work is logged.</EmptyState>
          : (
            <table className="portal-table">
              <thead>
                <tr><th>Date</th><th>Hours</th><th>Projects</th><th>Notes</th></tr>
              </thead>
              <tbody>
                {summary.recent.map(s => (
                  <tr key={s.id}>
                    <td className="mono">{s.date}</td>
                    <td className="mono">{fmtDuration(s.duration_minutes)}</td>
                    <td>{projectNames(s)}</td>
                    <td className="portal-dim">
                      {s.projects.map(p => p.summary).filter(Boolean).join(' · ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </section>

      <p className="portal-footnote">
        Dates are shown in {summary.time_zone.replace(/_/g, ' ')}. Only work that
        has been published is listed here.
      </p>
    </div>
  )
}
