import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  BarChart, Bar, Cell, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts'
import { get } from '../api.js'
import {
  weekRange, addDays, localDayKey, fmtHours, fmtDuration, fmtTime, fmtDate,
} from '../time.js'
import { ClientFilter, WeekStepper, ClientDot, StatusPill, EmptyState } from '../components/ui.jsx'

function useThemeColors() {
  const [theme, setTheme] = useState(document.documentElement.dataset.theme || 'light')
  useEffect(() => {
    const obs = new MutationObserver(() =>
      setTheme(document.documentElement.dataset.theme || 'light'))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])
  const dark = theme === 'dark'
  return {
    grid: dark ? 'rgba(247,246,245,0.08)' : 'rgba(35,31,35,0.08)',
    tick: dark ? 'rgba(247,246,245,0.48)' : 'rgba(35,31,35,0.48)',
    line: '#6B93C4',
  }
}

const MONO = 'Fragment Mono, monospace'

function ChartTooltip({ active, payload, label, unit = 'h' }) {
  if (!active || !payload?.length) return null
  const rows = payload.filter(p => p.value > 0)
  if (!rows.length) return null
  return (
    <div className="tooltip">
      <div className="t-title">{label}</div>
      {rows.map(p => (
        <div className="t-row" key={p.dataKey}>
          <ClientDot color={p.color || p.fill} size={8} />
          <span>{p.name}</span>
          <span className="t-val">{Number(p.value).toFixed(1)}{unit}</span>
        </div>
      ))}
    </div>
  )
}

export default function Dashboard() {
  const [params] = useSearchParams()
  const [clients, setClients] = useState([])
  const [filter, setFilter] = useState(null)
  const [view, setView] = useState(params.get('view') === 'all' ? 'all' : 'week')
  const [offset, setOffset] = useState(0)
  const [sessions, setSessions] = useState([])
  const [archive, setArchive] = useState([])
  const colors = useThemeColors()

  const range = useMemo(() => weekRange(offset), [offset])

  useEffect(() => { get('/clients').then(setClients) }, [])

  useEffect(() => {
    const q = filter ? `&client_id=${filter}` : ''
    const url = view === 'week'
      ? `/sessions?from=${range.from.toISOString()}&to=${range.to.toISOString()}${q}`
      : `/sessions?${q.slice(1)}`
    get(url).then(setSessions)
    get(`/archive${filter ? `?client_id=${filter}` : ''}`).then(setArchive)
  }, [view, offset, filter, range])

  /* ── Week stats ─────────────────────────────────────────────────────── */
  const totalMin = sessions.reduce((a, s) => a + s.duration_minutes, 0)
  const projectsTouched = new Set(sessions.flatMap(s => s.entries.map(e => e.project_id))).size
  const completedThisWeek = archive.filter(p => {
    const t = new Date(p.completed_at)
    return t >= range.from && t < range.to
  }).length

  const shownClients = filter ? clients.filter(c => c.id === filter) : clients

  const dailyData = useMemo(() => {
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = addDays(range.from, i)
      return { key: localDayKey(d), label: d.toLocaleDateString([], { weekday: 'short' }), day: d }
    })
    const rows = days.map(d => {
      const row = { label: d.label }
      shownClients.forEach(c => { row[c.name] = 0 })
      return row
    })
    for (const s of sessions) {
      const idx = days.findIndex(d => d.key === localDayKey(s.clock_in))
      if (idx === -1) continue
      rows[idx][s.client_name] = (rows[idx][s.client_name] || 0) + s.duration_minutes / 60
    }
    return rows
  }, [sessions, range, shownClients])

  /* ── All-time modules ───────────────────────────────────────────────── */
  const cumulative = useMemo(() => {
    const byClient = new Map()
    for (const s of sessions) {
      const cur = byClient.get(s.client_name) || { name: s.client_name, color: s.color_accent, hours: 0 }
      cur.hours += s.duration_minutes / 60
      byClient.set(s.client_name, cur)
    }
    return [...byClient.values()].sort((a, b) => b.hours - a.hours)
      .map(r => ({ ...r, hours: Math.round(r.hours * 10) / 10 }))
  }, [sessions])

  const monthly = useMemo(() => {
    const byMonth = new Map()
    for (const s of sessions) {
      const d = new Date(s.clock_in)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      byMonth.set(key, (byMonth.get(key) || 0) + s.duration_minutes / 60)
    }
    return [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([key, hours]) => ({
        label: new Date(`${key}-02`).toLocaleDateString([], { month: 'short', year: '2-digit' }),
        hours: Math.round(hours * 10) / 10,
      }))
  }, [sessions])

  const axisTick = { fill: colors.tick, fontSize: 11, fontFamily: MONO }

  return (
    <div className="screen">
      <h1 className="screen-title rise">Dashboard</h1>

      <div className="filterbar rise" style={{ '--i': 1 }}>
        <ClientFilter clients={clients} value={filter} onChange={setFilter} />
        <span className="spacer" />
        <div className="seg">
          {['week', 'all'].map(v => (
            <button key={v} className={`seg-btn${view === v ? ' active' : ''}`}
              onClick={() => setView(v)}>{v === 'week' ? 'Week' : 'All time'}</button>
          ))}
        </div>
        {view === 'week' && <WeekStepper offset={offset} onChange={setOffset} range={range} />}
      </div>

      {view === 'week' ? (
        <>
          <div className="stats-row rise" style={{ '--i': 2 }}>
            <div className="card stat">
              <span className="label">Hours this week</span>
              <span className="val">{fmtHours(totalMin)}<span className="unit">h</span></span>
            </div>
            <div className="card stat">
              <span className="label">Sessions logged</span>
              <span className="val">{sessions.length}</span>
            </div>
            <div className="card stat">
              <span className="label">Projects touched</span>
              <span className="val">{projectsTouched}</span>
            </div>
            <div className="card stat">
              <span className="label">Projects completed</span>
              <span className="val">{completedThisWeek}</span>
            </div>
          </div>

          <div className="card chart-card rise" style={{ '--i': 3 }}>
            <span className="label">Hours by day</span>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={dailyData} barSize={36} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke={colors.grid} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} tick={axisTick} dy={6} />
                <YAxis tickLine={false} axisLine={false} tick={axisTick}
                  tickFormatter={v => `${v}h`} allowDecimals={false} />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: colors.grid }} />
                {shownClients.map(c => (
                  <Bar key={c.id} dataKey={c.name} stackId="hours" fill={c.color_accent} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="rise" style={{ '--i': 4 }}>
            <span className="label" style={{ display: 'block', marginBottom: 16 }}>Work log</span>
            {sessions.length === 0 ? (
              <div className="card"><EmptyState>Nothing logged this week yet. Clock in to start the record.</EmptyState></div>
            ) : (
              <div className="worklog">
                {sessions.map(s => (
                  <div className="card worklog-card" key={s.id}>
                    <div className="wl-head">
                      <ClientDot color={s.color_accent} />
                      <strong style={{ fontWeight: 400 }}>{s.client_name}</strong>
                      <span className="mono">{fmtDate(s.clock_in)} · {fmtTime(s.clock_in)} – {fmtTime(s.clock_out)}</span>
                      {s.entries.length === 0 && <span className="pill amber">Untagged time</span>}
                      <span className="wl-dur">{fmtDuration(s.duration_minutes)}</span>
                    </div>
                    {s.entries.map(e => (
                      <div className="wl-entry" key={e.id}>
                        <span className="wl-project">{e.project_name}</span>
                        <span className="wl-summary">{e.summary || <span style={{ color: 'var(--text-4)' }}>No summary</span>}</span>
                        <StatusPill status={e.status_at_entry} />
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="card chart-card rise" style={{ '--i': 2 }}>
            <span className="label">Cumulative hours by client</span>
            {cumulative.length === 0 ? (
              <EmptyState>No hours logged yet.</EmptyState>
            ) : (
              <ResponsiveContainer width="100%" height={Math.max(120, cumulative.length * 52)}>
                <BarChart data={cumulative} layout="vertical" barSize={18}
                  margin={{ top: 0, right: 48, left: 8, bottom: 0 }}>
                  <CartesianGrid horizontal={false} stroke={colors.grid} />
                  <XAxis type="number" tickLine={false} axisLine={false} tick={axisTick}
                    tickFormatter={v => `${v}h`} />
                  <YAxis type="category" dataKey="name" tickLine={false} axisLine={false}
                    tick={{ ...axisTick, fontSize: 12 }} width={120} />
                  <Tooltip content={<ChartTooltip />} cursor={{ fill: colors.grid }} />
                  <Bar dataKey="hours" name="Hours" radius={[0, 4, 4, 0]}>
                    {cumulative.map((r, i) => (
                      <Cell key={i} fill={r.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          <div className="card chart-card rise" style={{ '--i': 3 }}>
            <span className="label">Monthly hours trend</span>
            {monthly.length === 0 ? (
              <EmptyState>No hours logged yet.</EmptyState>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={monthly} margin={{ top: 8, right: 16, left: -18, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke={colors.grid} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} tick={axisTick} dy={6} />
                  <YAxis tickLine={false} axisLine={false} tick={axisTick} tickFormatter={v => `${v}h`} />
                  <Tooltip content={<ChartTooltip />} cursor={{ stroke: colors.grid }} />
                  <Line type="monotone" dataKey="hours" name="Hours" stroke={colors.line}
                    strokeWidth={2} dot={{ r: 3, fill: colors.line, strokeWidth: 0 }} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>

          <div className="card rise" style={{ '--i': 4 }}>
            <span className="label" style={{ display: 'block', marginBottom: 8 }}>Completed projects</span>
            {archive.length === 0 ? (
              <EmptyState>Nothing completed yet. Finished projects land here with their full summary trail.</EmptyState>
            ) : archive.map(p => <ArchiveItem key={p.id} project={p} />)}
          </div>
        </>
      )}
    </div>
  )
}

function ArchiveItem({ project }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="archive-item">
      <button className="archive-row" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className="name">
          <ClientDot color={project.color_accent} size={8} />
          {project.name}
        </span>
        <span className="mono">{project.client_name}</span>
        <span className="mono">{fmtHours(project.total_minutes)}h</span>
        <span className="mono">{fmtDate(project.completed_at)}</span>
        <span style={{ color: 'var(--text-4)', fontSize: 11 }}>{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="archive-trail">
          {project.trail.length === 0 && <span style={{ fontSize: 13, color: 'var(--text-4)' }}>No session notes were logged for this project.</span>}
          {project.trail.map((t, i) => (
            <div className="wl-entry" key={i}>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-4)', minWidth: 76 }}>{fmtDate(t.clock_in)}</span>
              <span className="wl-summary">{t.summary || '—'}</span>
              <StatusPill status={t.status_at_entry} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
