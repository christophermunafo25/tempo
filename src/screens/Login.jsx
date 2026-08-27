import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../auth.jsx'

export default function Login() {
  const { user, loading, signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // The login screen sits outside App.jsx, so it carries the theme itself.
  useEffect(() => {
    document.documentElement.dataset.theme = localStorage.getItem('tempo-theme') || 'light'
  }, [])

  if (loading) return <Splash />
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
