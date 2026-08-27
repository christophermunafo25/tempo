import { useEffect, useState } from 'react'
import { NavLink, Navigate, Outlet } from 'react-router-dom'
import { useAuth } from './auth.jsx'
import { Splash } from './screens/Login.jsx'

const NAV = [
  { to: '/', label: 'Clock', end: true },
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/board', label: 'Board' },
  { to: '/timesheets', label: 'Timesheets' },
  { to: '/expenses', label: 'Expenses' },
  { to: '/access', label: 'Portal' },
]

export default function App() {
  const { user, loading, signOut } = useAuth()
  const [theme, setTheme] = useState(() => localStorage.getItem('tempo-theme') || 'light')

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('tempo-theme', theme)
  }, [theme])

  if (loading) return <Splash />
  if (!user) return <Navigate to="/login" replace />
  // Client contacts have no business in this shell — its nav is Expenses and
  // Board. They get their own, at /portal.
  if (user.role !== 'owner') return <Navigate to="/portal" replace />

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand"><span className="brand-dot" />TEMPO</div>
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
            onClick={() => setTheme(t => t === 'light' ? 'dark' : 'light')}
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
