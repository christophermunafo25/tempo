import { useState } from 'react'
import { fmtDate, fmtTime } from '../time.js'

/* The one component both shells share. It takes comments and a post callback
   and knows nothing about roles or scoping — all authorization lives on the
   server. Sharing a presentational component is safe in a way that sharing a
   route handler is not.

   Bodies render as text. React escapes them, and there is deliberately no
   dangerouslySetInnerHTML and no markdown pass anywhere in this file. */

export default function Thread({ comments, onPost, placeholder = 'Write a message…' }) {
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e) => {
    e.preventDefault()
    if (!body.trim()) return
    setBusy(true)
    setError('')
    try {
      await onPost(body.trim())
      setBody('')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="thread">
      {comments.length === 0
        ? <p className="portal-dim">No messages yet.</p>
        : (
          <ol className="thread-list">
            {comments.map(c => (
              <li key={c.id} className={`thread-item${c.is_mine ? ' is-mine' : ''}`}>
                <div className="thread-meta">
                  <span className="thread-author">{c.author_name}</span>
                  <span className="thread-when mono">
                    {fmtDate(c.created_at)} · {fmtTime(c.created_at)}
                  </span>
                </div>
                {/* A removed message keeps its place so the shape of the
                    conversation survives the deletion. */}
                <p className={`thread-body${c.deleted ? ' is-deleted' : ''}`}>
                  {c.deleted ? 'Message removed' : c.body}
                </p>
              </li>
            ))}
          </ol>
        )}

      <form className="thread-form" onSubmit={submit}>
        <textarea
          className="textarea"
          rows={3}
          maxLength={5000}
          placeholder={placeholder}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <div className="thread-actions">
          {error && <span className="field-error">{error}</span>}
          <span className="spacer" />
          <button className="btn btn-sm" type="submit" disabled={busy || !body.trim()}>
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  )
}
