import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { get, post } from '../api.js'

/* Redeems an invite or a reset link. Deliberately does not sign the person in
   afterwards — they go and log in, which proves the password round-tripped
   before they rely on it. */

export default function SetPassword() {
  const [params] = useSearchParams()
  const token = params.get('t') || ''

  const [state, setState] = useState('checking')   // checking | ready | invalid | done
  const [info, setInfo] = useState(null)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    document.documentElement.dataset.theme = localStorage.getItem('tempo-theme') || 'light'
  }, [])

  useEffect(() => {
    if (!token) { setState('invalid'); return }
    get(`/auth/token/${encodeURIComponent(token)}`)
      .then((data) => { setInfo(data); setState('ready') })
      .catch(() => setState('invalid'))
  }, [token])

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (password !== confirm) { setError('the two passwords don’t match'); return }
    setBusy(true)
    try {
      await post('/auth/set-password', { token, password })
      setState('done')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (state === 'checking') {
    return <Shell><p className="auth-note">Checking your link…</p></Shell>
  }

  // An expired link and a forged one look identical here, because the server
  // can't tell the difference apart and neither should a prober.
  if (state === 'invalid') {
    return (
      <Shell>
        <p className="auth-note">
          This link is no longer valid. Invite links last 7 days and reset links
          one hour, and each one works only once. Ask Chris for a fresh link.
        </p>
        <Link className="btn btn-outline auth-submit" to="/login">Back to sign in</Link>
      </Shell>
    )
  }

  if (state === 'done') {
    return (
      <Shell>
        <p className="auth-note">Password set. You can sign in now.</p>
        <Link className="btn btn-accent auth-submit" to="/login">Sign in</Link>
      </Shell>
    )
  }

  return (
    <Shell onSubmit={submit}>
      <p className="auth-note">
        {info?.kind === 'reset' ? 'Choose a new password for ' : 'Set a password for '}
        <strong>{info?.email}</strong>
      </p>

      <div className="field">
        <label className="label" htmlFor="password">Password</label>
        <input id="password" className="input" type="password" autoComplete="new-password"
          autoFocus minLength={10} required
          value={password} onChange={(e) => setPassword(e.target.value)} />
        <span className="auth-hint">At least 10 characters.</span>
      </div>

      <div className="field">
        <label className="label" htmlFor="confirm">Confirm password</label>
        <input id="confirm" className="input" type="password" autoComplete="new-password"
          minLength={10} required
          value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </div>

      <p className="auth-error" role="alert" aria-live="polite">{error}</p>

      <button className="btn btn-accent auth-submit" type="submit" disabled={busy}>
        {busy ? 'Saving…' : 'Set password'}
      </button>
    </Shell>
  )
}

function Shell({ children, onSubmit }) {
  const Tag = onSubmit ? 'form' : 'div'
  return (
    <div className="auth-page">
      <Tag className="auth-card card rise" onSubmit={onSubmit}>
        <div className="brand"><span className="brand-dot" />TEMPO</div>
        {children}
      </Tag>
    </div>
  )
}
