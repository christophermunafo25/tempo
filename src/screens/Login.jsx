import { useEffect, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { useAuth } from '../auth.jsx'
import { get } from '../api.js'
import Setup from './Setup.jsx'

export default function Login() {
  const { user, loading, signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // null while unknown: a fresh deployment has no account, and showing a login
  // form there is a dead end with no way out of it.
  const [setup, setSetup] = useState(null)

  // The login screen sits outside App.jsx, so it carries the theme itself.
  useEffect(() => {
    document.documentElement.dataset.theme = localStorage.getItem('tempo-theme') || 'light'
  }, [])

  useEffect(() => {
    get('/auth/setup').then(setSetup).catch(() => setSetup({ needs_setup: false }))
  }, [])

  if (loading || setup === null) return <Splash />
  if (setup.needs_setup && !user) {
    return <Setup tokenConfigured={setup.token_configured}
      onDone={() => setSetup({ needs_setup: false })} />
  }
  if (user) return <Navigate to={user.role === 'owner' ? '/' : '/portal'} replace />

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      await signIn(email, password)
    } catch (err) {
      setError(err.message)
      setPassword('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-card card rise" onSubmit={submit}>
        <div className="brand"><span className="brand-dot" />TEMPO</div>

        <div className="field">
          <label className="label" htmlFor="email">Email</label>
          <input
            id="email"
            className="input"
            type="email"
            autoComplete="username"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>

        <div className="field">
          <label className="label" htmlFor="password">Password</label>
          <input
            id="password"
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>

        {/* aria-live so a screen reader announces the failure without a refocus */}
        <p className="auth-error" role="alert" aria-live="polite">{error}</p>

        <button className="btn btn-accent auth-submit" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <Link className="auth-hint portal-center" to="/forgot">Forgot your password?</Link>
      </form>
    </div>
  )
}

export function Splash() {
  return (
    <div className="auth-page">
      <div className="auth-splash"><span className="brand-dot" /></div>
    </div>
  )
}
