import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { post } from '../api.js'

export default function Forgot() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    document.documentElement.dataset.theme = localStorage.getItem('tempo-theme') || 'light'
  }, [])

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    // The endpoint answers the same way whether or not the address is known,
    // so this screen does too — there is nothing here to enumerate accounts with.
    try { await post('/auth/forgot', { email }) } catch { /* same outcome */ }
    setSent(true)
    setBusy(false)
  }

  if (sent) {
    return (
      <div className="auth-page">
        <div className="auth-card card rise">
          <div className="brand"><span className="brand-dot" />TEMPO</div>
          <p className="auth-note">
            If that address has an account, Chris will be notified and can send
            you a reset link. TEMPO doesn’t send email itself.
          </p>
          <Link className="btn btn-outline auth-submit" to="/login">Back to sign in</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="auth-page">
      <form className="auth-card card rise" onSubmit={submit}>
        <div className="brand"><span className="brand-dot" />TEMPO</div>
        <div className="field">
          <label className="label" htmlFor="email">Email</label>
          <input id="email" className="input" type="email" autoComplete="username" autoFocus
            required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <button className="btn btn-accent auth-submit" type="submit" disabled={busy}>
          {busy ? 'Sending…' : 'Request a reset link'}
        </button>
        <Link className="auth-hint portal-center" to="/login">Back to sign in</Link>
      </form>
    </div>
  )
}
