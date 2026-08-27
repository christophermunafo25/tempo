import { useEffect, useState } from 'react'
import { NavLink, Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../auth.jsx'
import { Splash } from '../screens/Login.jsx'
import { pget } from './api.js'

/* The client's own shell. Deliberately not App.jsx: that nav is Clock, Board,
   Timesheets and Expenses, and none of it belongs in front of a client. This
   renders its own three links, so those routes are never in the tree at all. */

const NAV = [
  { to: '/portal', label: 'Overview', end: true },
  { to: '/portal/hours', label: 'Hours' },
  { to: '/portal/projects', label: 'Projects' },
]

export default function PortalApp() {
  const { user, loading, signOut } = useAuth()
  const [theme, setTheme] = useState(() => localStorage.getItem('tempo-theme') || 'light')
  const [company, setCompany] = useState(null)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('tempo-theme', theme)
  }, [theme])

  useEffect(() => {
    if (user?.role === 'client') pget('/summary').then(s => setCompany(s.company)).catch(() => {})
  }, [user])

  if (loading) return <Splash />
  if (!user) return <Navigate to="/login" replace />
  if (user.role !== 'client') return <Navigate to="/" replace />

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand"><span className="brand-dot" />TEMPO</div>
        {company && <div className="portal-whose">{company.name}</div>}
        <nav className="nav">
          {NAV.map(n => (
            <NavLink key={n.to} to={n.to} end={n.end}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="whoami">
            <span className="whoami-email" title={user.email}>{user.email}</span>
            <button className="signout" onClick={signOut}>Sign out</button>
          </div>
          <button
            className="theme-toggle"
            onClick={() => setTheme(t => (t === 'light' ? 'dark' : 'light'))}
            aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
          >
            <span className="track"><span className="knob" /></span>
            {theme === 'light' ? 'Light' : 'Dark'}
          </button>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  )
}
