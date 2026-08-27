import { useState } from 'react'
import { post } from '../api.js'
import { useAuth } from '../auth.jsx'

/* First-run setup. There is no sign-up in TEMPO — accounts come from here once,
   or from an invite — so without this screen a fresh deployment is a login form
   nobody can satisfy.

   Still gated on PORTAL_BOOTSTRAP_TOKEN, and still refused the moment an owner
   exists. Dropping the token would mean whoever loads the URL first owns the
   deployment. */

export default function Setup({ tokenConfigured, onDone }) {
  const { signIn } = useAuth()
  const [token, setToken] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  if (!tokenConfigured) {
    return (
      <div className="auth-page">
        <div className="auth-card card rise">
          <div className="brand"><span className="brand-dot" />TEMPO</div>
          <p className="auth-note">
            This deployment has no account yet, and setup is locked until a
            one-time token is configured.
          </p>
          <ol className="auth-steps">
            <li>Vercel → your project → <strong>Settings → Environment Variables</strong></li>
            <li>Add <code>PORTAL_BOOTSTRAP_TOKEN</code> with any long random string</li>
            <li>Add <code>TEMPO_TZ</code> = <code>America/Chicago</code> while you’re there</li>
            <li><strong>Deployments → ⋯ → Redeploy</strong>, then reload this page</li>
          </ol>
          <p className="auth-hint">
            The token stops whoever loads this URL first from claiming the
            account. Delete it once you’ve signed in.
          </p>
        </div>
      </div>
    )
  }

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (password !== confirm) { setError('the two passwords don’t match'); return }
    setBusy(true)
    try {
      await post('/auth/bootstrap', { token, email, password, name: 'Chris' })
      // Straight in: this is the owner setting up their own instance, and
      // bouncing them to a login form here would be ceremony for its own sake.
      await signIn(email, password)
      onDone?.()
    } catch (err) {
      setError(err.message === 'not found'
        ? 'that setup token doesn’t match the one in your environment variables'
        : err.message)
      setBusy(false)
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-card card rise" onSubmit={submit}>
        <div className="brand"><span className="brand-dot" />TEMPO</div>
        <p className="auth-note">
          Set up your owner account. This runs once — after it, this screen is
          gone for good and new people arrive by invitation.
        </p>

        <div className="field">
          <label className="label" htmlFor="token">Setup token</label>
          <input id="token" className="input mono" autoFocus required
            value={token} onChange={(e) => setToken(e.target.value)} />
          <span className="auth-hint">The value of PORTAL_BOOTSTRAP_TOKEN.</span>
        </div>

        <div className="field">
          <label className="label" htmlFor="email">Email</label>
          <input id="email" className="input" type="email" autoComplete="username" required
            value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>

        <div className="field">
          <label className="label" htmlFor="password">Password</label>
          <input id="password" className="input" type="password" autoComplete="new-password"
            minLength={10} required
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
          {busy ? 'Setting up…' : 'Create my account'}
        </button>
      </form>
    </div>
  )
}
