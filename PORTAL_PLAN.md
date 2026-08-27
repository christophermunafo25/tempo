# TEMPO client portal — implementation plan (v2)

Status: **plan only, nothing implemented.** Awaiting approval before Phase 2.

v2 revises v1 after the decision to give client contacts a limited write
surface. The security architecture (§3) is unchanged from v1 and remains the
load-bearing part; §4.5, §5, and §9 are new or substantially rewritten.

The premise, restated so the plan can be judged against it: shipping this
portal means turning off Vercel Deployment Protection, which is currently the
only thing standing between `/api/expenses` and the open internet. After that
switch, application-level authorization is the entire security boundary. So
the boundary gets built and tested first, and screens come after.

**Read-only became read-write.** v1's out-of-scope list named comment threads,
approvals, and client-side entry. Those are now in scope, by decision. What
stays out: invoicing, payments, client-side *time* entry (clients never touch
`sessions`), and notifications beyond an unread badge in your own UI.

---

## 0. Decisions taken

| # | Question | Decision |
|---|----------|----------|
| 1 | Who controls project status? | **Owner only.** Clients comment; they never move a project between columns. |
| 2 | Client-created projects? | **Land as requests you accept.** Invisible to your board until accepted. |
| 3 | Which projects can a client see? | **All of their company's, including completed.** No per-project publish step. |
| 4 | `question_text` / Questions status? | **Stays internal, status hidden.** Clients see `questions` rendered as In Progress. |

Decisions 3 and 4 interact in a way that sets an implementation rule:

> **No portal query may use `SELECT *`.** Every column in a portal response is
> named explicitly. `SELECT p.*` would ship `question_text` to a client, and
> decision 3 means every project row for that company flows through these
> queries. The existing owner code uses `SELECT *` freely; portal code must
> not, and a test asserts no portal response body ever contains a known
> `question_text` value.

---

## 1. Schema

### 1.1 New tables — appended to `SCHEMA_COMMON(idCol, nowDefault)`

These ride the existing `CREATE TABLE IF NOT EXISTS` mechanism, which is
already idempotent on both dialects and already re-runs on every cold start.

```sql
CREATE TABLE IF NOT EXISTS portal_users (
  id ${idCol},
  client_id INTEGER REFERENCES clients(id),   -- NULL = owner (you)
  email TEXT NOT NULL,
  password_hash TEXT,                          -- NULL until invite redeemed
  role TEXT NOT NULL DEFAULT 'client'
    CHECK (role IN ('owner','client')),
  name TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT ${nowDefault}
);
CREATE UNIQUE INDEX IF NOT EXISTS portal_users_email ON portal_users (email);

CREATE TABLE IF NOT EXISTS portal_sessions (
  id ${idCol},
  portal_user_id INTEGER NOT NULL REFERENCES portal_users(id),
  token_hash TEXT NOT NULL,                    -- sha256 hex, never the token
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT ${nowDefault}
);
CREATE UNIQUE INDEX IF NOT EXISTS portal_sessions_token ON portal_sessions (token_hash);
CREATE INDEX IF NOT EXISTS portal_sessions_user ON portal_sessions (portal_user_id);

CREATE TABLE IF NOT EXISTS portal_tokens (
  id ${idCol},
  portal_user_id INTEGER NOT NULL REFERENCES portal_users(id),
  kind TEXT NOT NULL CHECK (kind IN ('invite','reset')),
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT ${nowDefault}
);
CREATE UNIQUE INDEX IF NOT EXISTS portal_tokens_token ON portal_tokens (token_hash);

CREATE TABLE IF NOT EXISTS portal_audit (
  id ${idCol},
  portal_user_id INTEGER REFERENCES portal_users(id),
  client_id INTEGER REFERENCES clients(id),
  action TEXT NOT NULL,       -- login | login_failed | logout | invite_sent |
                              -- invite_redeemed | reset_requested | reset_used |
                              -- revoked | export | publish | comment |
                              -- project_edited | request_created |
                              -- request_accepted | request_declined | link_added
  detail TEXT NOT NULL DEFAULT '',
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT ${nowDefault}
);
CREATE INDEX IF NOT EXISTS portal_audit_created ON portal_audit (created_at);

-- Generalised in v2: was portal_login_attempts. Now also throttles portal
-- writes, since a client session can create comments and requests.
CREATE TABLE IF NOT EXISTS portal_rate_events (
  id ${idCol},
  bucket TEXT NOT NULL,       -- 'login:email:a@b.com' | 'login:ip:1.2.3.4'
                              -- | 'write:user:12'
  created_at TEXT NOT NULL DEFAULT ${nowDefault}
);
CREATE INDEX IF NOT EXISTS portal_rate_events_bucket
  ON portal_rate_events (bucket, created_at);

-- Shared thread: both you and the client post here. Author is always a
-- portal_users row (you get one at bootstrap), so there is no polymorphic
-- author column and no "is this an owner or a client" branch at read time.
CREATE TABLE IF NOT EXISTS project_comments (
  id ${idCol},
  project_id INTEGER NOT NULL REFERENCES projects(id),
  portal_user_id INTEGER NOT NULL REFERENCES portal_users(id),
  body TEXT NOT NULL,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT ${nowDefault}
);
CREATE INDEX IF NOT EXISTS project_comments_project
  ON project_comments (project_id, id);

CREATE TABLE IF NOT EXISTS project_comment_reads (
  id ${idCol},
  project_id INTEGER NOT NULL REFERENCES projects(id),
  portal_user_id INTEGER NOT NULL REFERENCES portal_users(id),
  last_read_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT ${nowDefault}
);
CREATE UNIQUE INDEX IF NOT EXISTS project_comment_reads_pair
  ON project_comment_reads (project_id, portal_user_id);

-- "History is never overwritten" applies to client edits too. Every field
-- change on a project appends here before the UPDATE runs.
CREATE TABLE IF NOT EXISTS project_revisions (
  id ${idCol},
  project_id INTEGER NOT NULL REFERENCES projects(id),
  portal_user_id INTEGER REFERENCES portal_users(id),
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  created_at TEXT NOT NULL DEFAULT ${nowDefault}
);
CREATE INDEX IF NOT EXISTS project_revisions_project
  ON project_revisions (project_id, id);
```

Notes:

- `email` uniqueness is a separate `CREATE UNIQUE INDEX IF NOT EXISTS` rather
  than an inline `UNIQUE`, so it is independently idempotent. Emails are
  stored lowercased and trimmed.
- `portal_users.client_id` is nullable with no CHECK, because SQLite and PG
  disagree about CHECK-over-NULL ergonomics. The invariant (`role='owner'` ⟺
  `client_id IS NULL`) is enforced in `auth.js` at write time and asserted in
  tests.
- **Comments are immutable.** There is no `edited_at` and no update path.
  They can be soft-deleted (`deleted_at`), which renders as a removed-message
  placeholder so the thread's shape survives. This is the cheapest honest
  reading of "history is never overwritten" — the alternative is a second
  revisions table for comment bodies, which is not worth it for a thread
  between two people who talk to each other anyway.
- `portal_rate_events` exists because serverless has no shared memory. It is
  append-only and pruned opportunistically (§5.3).

### 1.2 New columns — via `ensureColumn()`

SQLite has no `ADD COLUMN IF NOT EXISTS`, so each backend introspects first
and then issues a plain `ADD COLUMN`. No error-swallowing, no `try/catch`
around DDL that could hide a real failure.

| Table      | Column                | DDL                          | Why |
|------------|-----------------------|------------------------------|-----|
| `clients`  | `portal_enabled`      | `INTEGER NOT NULL DEFAULT 0` | Portal on/off per company |
| `clients`  | `portal_shows_rates`  | `INTEGER NOT NULL DEFAULT 0` | See open question 1 — currently gates nothing |
| `sessions` | `is_published`        | `INTEGER NOT NULL DEFAULT 0` | Nothing client-visible until published |
| `projects` | `description`         | `TEXT`                       | The brief. New — clients need something to actually edit |
| `projects` | `portal_request`      | `TEXT`                       | NULL = real project, `'pending'`, `'declined'` |
| `projects` | `requested_by`        | `INTEGER`                    | `portal_users.id` of the requester |

```js
const ADD_COLUMNS = [
  ['clients',  'portal_enabled',     'INTEGER NOT NULL DEFAULT 0'],
  ['clients',  'portal_shows_rates', 'INTEGER NOT NULL DEFAULT 0'],
  ['sessions', 'is_published',       'INTEGER NOT NULL DEFAULT 0'],
  ['projects', 'description',        'TEXT'],
  ['projects', 'portal_request',     'TEXT'],
  ['projects', 'requested_by',       'INTEGER'],
]

async function ensureColumns() {
  for (const [table, col, ddl] of ADD_COLUMNS) {
    if ((await backend.columns(table)).has(col)) continue
    await backend.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`)
  }
}
```

Backend introspection, called from each `backend.init()` after the
`CREATE TABLE` pass:

```js
// SQLite
async columns(table) {
  const r = await client.execute({ sql: `PRAGMA table_info(${table})` })
  return new Set(toObjs(r).map(c => c.name))
}
// Postgres
async columns(table) {
  const r = await pool.query(
    'SELECT column_name FROM information_schema.columns WHERE table_name = $1', [table])
  return new Set(r.rows.map(c => c.column_name))
}
```

Dialect constraints that shape the DDL above:

- **SQLite forbids a non-constant default in `ADD COLUMN`.** Added columns use
  literal defaults only, never the `nowDefault` expression. Any future
  `created_at`-style column must arrive on a new table.
- **SQLite forbids `UNIQUE` and `PRIMARY KEY` in `ADD COLUMN`,** and its
  `CHECK` support there is version-dependent. So `portal_request` is a plain
  nullable `TEXT` with its three legal values enforced in code, the same way
  the `portal_users` role invariant is. Uniqueness always arrives as a
  separate `CREATE UNIQUE INDEX IF NOT EXISTS`.
- All three `projects` columns are nullable with no default, which is the
  safest possible `ADD COLUMN` on both engines and means every existing row
  reads as "normal project, no description" with no backfill.

`DEFAULT 0` on `sessions.is_published` means every historical session is
unpublished on the first cold start after deploy. That is intended: nothing
becomes client-visible until you publish it. Bulk publish-by-date-range
(§4.2) is how you backfill.

There is deliberately **no `projects.portal_visible` column** — decision 3
made per-project publishing unnecessary. Consequence worth stating out loud:
once a company has `portal_enabled = 1`, every project you create with that
`client_id` is visible to their contact the moment it exists, including its
name. If you ever need to scope a project out of a client's view, the answer
under this design is to not give it that `client_id`.

### 1.3 Effect on existing owner queries

`portal_request` is the one new column that existing owner queries must
respect, so that a client's request does not appear in your workflow before
you accept it. Four queries gain `AND p.portal_request IS NULL`:

| File / route | Change |
|--------------|--------|
| `GET /api/projects`   | `+ AND portal_request IS NULL` |
| `GET /api/board`      | `+ AND p.portal_request IS NULL` |
| `GET /api/archive`    | `+ AND p.portal_request IS NULL` |
| `GET /api/prefill`    | `+ AND p.portal_request IS NULL` (in the join to `projects`) |

**This is the "tell me first" flag from your constraints.** Every project row
that exists today has `portal_request` NULL, so all four routes return
byte-identical results to what they return now. The filter only ever excludes
rows created through the portal. Accepted requests get `portal_request` set
back to NULL and flow into all four normally. I'd like a nod on this before I
touch those four queries.

Pending and declined requests are not orphaned — they surface in a new
Requests tray on the new owner Portal screen (§7), not on your Board.

### 1.4 Cold-start concurrency

Parallel Vercel cold starts run `init()` simultaneously. On Postgres, racing
`CREATE TABLE IF NOT EXISTS` can raise `42P07` or a `pg_type` `23505`, and
racing `ADD COLUMN` widens that window. Fix: wrap the PG `init()` in
`SELECT pg_advisory_lock(...)` / `pg_advisory_unlock(...)` on a fixed key.
SQLite is single-writer and needs nothing. This hazard predates the portal;
adding six columns and eight tables makes it likelier, so it gets fixed here.

---

## 2. Auth mechanics

No new dependencies. Everything below is `node:crypto` plus Express core.

**Password hashing.** `crypto.scrypt` (async, never `scryptSync` — it blocks
the event loop) with N=16384, r=8, p=1, keylen=64, and a 16-byte random salt.
Stored as `scrypt$16384$8$1$<salt-b64>$<hash-b64>` so parameters travel with
the hash and can be raised later without a flag day. Verification via
`crypto.timingSafeEqual`. At these parameters a hash costs roughly 100ms and
16MB, comfortably inside Vercel's limits and under the default `maxmem`.

**Tokens.** `crypto.randomBytes(32).toString('base64url')` for session,
invite, and reset tokens — 256 bits, URL-safe. The database stores only
`sha256(token)` hex. A token is high-entropy already, so sha256 is the right
primitive; scrypt would be pure cost with no benefit. Lookups hit a unique
index on the hash.

**Cookie.** Name `tempo_portal`. `httpOnly`, `sameSite: 'lax'`, `path: '/'`,
`secure` on when not localhost, `maxAge` 14 days. Written with Express core's
`res.cookie()`. Reading needs `req.headers.cookie` split by `;` — about six
lines, so `cookie-parser` is not worth a dependency.

**Rolling expiry.** On each authenticated request, if the session has less
than half its window left, `expires_at` is pushed to now + 14 days and the
cookie is re-set. Writing every request would be needless amplification
through the pooler; the half-life threshold keeps it rare. An absolute cap of
90 days from `created_at` applies regardless of activity.

**Revocation.** Session validity is a database read, not a signature check.
That is what makes "revoked user's existing cookie fails on the next request"
true rather than eventually-true. A stateless signed cookie would need a
denylist that ends up being this table with worse semantics.

**CSRF.** Materially more important in v2 than v1, because there are now
state-changing portal endpoints a forged cross-site request could reach.
`SameSite=Lax` blocks cross-site cookie-bearing POSTs. On top of that, every
non-GET `/api` request must carry an `Origin` header matching the request
host or it is rejected 403 in the gate, before any handler runs. Cheap, no
dependency, closes the `Lax` gaps.

**User enumeration.** Login runs scrypt against a fixed dummy hash when the
email does not exist, so timing does not distinguish "no such user" from
"wrong password". Both answer the same generic 401. Forgot-password always
answers 200.

**Payload size.** `express.json()` keeps its 100kb default, which is itself
the first line of defence on comment bodies. Field-level caps in §4.5.

---

## 3. The gate

*Unchanged from v1. This is the part that has to be right.*

### 3.1 Design

One middleware, mounted once, at `/api`, **before any route is registered**.
It does not consult a per-route allowlist and its correctness does not depend
on the order in which routes are declared. It classifies the request by URL
prefix, and the classification is total — every possible `/api` path falls
into exactly one bucket, with the owner-only bucket as the default arm:

```
/api/auth/*    → public   (no session; heavily rate-limited)
/api/portal/*  → client   (session with role 'client'; scoped to its client_id)
everything else under /api → owner (session with role 'owner')
```

The security property that matters: a new route added anywhere under `/api`
is owner-only **by construction**. There is nothing to remember, nothing to
annotate, and no way for a forgotten decorator to leave a route open. Opting
a route into client access requires physically moving it under `/api/portal`,
which is a visible, reviewable act.

Prefix matching is on path segments, not raw string prefix, so a future
`/api/portalthing` cannot be mistaken for `/api/portal/...`. Owner-side
management routes live under `/api/access`, not `/api/portal-admin`, so they
can never sit adjacent to the client prefix in a matcher.

```js
// server/gate.js — mounted as app.use('/api', gate) above every route
export const gate = h(async (req, res, next) => {
  const seg = req.path.split('/').filter(Boolean)[0] || ''

  if (req.method !== 'GET' && !originOk(req)) throw httpError(403, 'bad origin')

  if (seg === 'auth') return next()                 // public

  const session = await resolveSession(req, res)    // null | { user, session }
  if (!session) throw httpError(401, 'not signed in')
  req.portalUser = session.user

  if (seg === 'portal') {
    if (session.user.role !== 'client') throw httpError(404, 'not found')
    if (!session.user.client_id) throw httpError(404, 'not found')
    return next()
  }
  if (session.user.role !== 'owner') throw httpError(404, 'not found')
  next()
})
```

A client session that reaches `/api/expenses` gets **404, not 403** — the
same shape as a path that does not exist. It learns nothing about what else
the deployment hosts.

### 3.2 Mount point

`server/app.js`, in this exact sequence:

```js
app.set('trust proxy', 1)     // Vercel terminates TLS; needed for req.ip + secure
app.use(express.json())
app.use('/api', dbReadyGate)  // existing 503-on-db-down middleware
app.use('/api', gate)         // deny by default
app.use('/api/auth',   authRoutes)
app.use('/api/portal', portalRoutes)
app.use('/api/access', accessRoutes)
/* …existing owner routes, unchanged except §1.3… */
```

### 3.3 Scoping

```js
export const scopeOf = (req) => {
  const id = req.portalUser?.client_id
  if (!id) throw httpError(500, 'unscoped portal query')   // never reachable
  return id
}
```

Every portal SQL statement binds `client_id = ?` from `scopeOf(req)`. No
portal route reads `client_id` from `req.query`, `req.params`, or `req.body` —
the parameter does not exist in any portal handler signature. Passing another
company's id therefore cannot change a response, because nothing reads it.
Asserted by test, not left to inspection.

For **writes**, prefix scope is not enough — every mutation resolves its
target row through a scoped read first:

```js
// server/routes/portal.js
async function ownedProject(req, id) {
  const p = await q1(null,
    'SELECT id, client_id, name, description, portal_request FROM projects WHERE id = ? AND client_id = ?',
    [id, scopeOf(req)])
  if (!p) throw httpError(404, 'not found')     // 404, never 403
  return p
}
```

Mercenary Marketing's contact PATCHing a project belonging to another company
gets exactly what they get for a project id that was never created.

Every portal query that touches `sessions` also carries
`AND s.is_published = 1`, applied inside one shared helper that builds the
portal session scope, so totals, table rows, CSV exports, and the project
breakdown cannot drift apart from each other.

---

## 4. Route map

### 4.1 Public — `/api/auth/*`

| Method | Path                    | Purpose                                    |
|--------|-------------------------|--------------------------------------------|
| POST   | `/api/auth/login`       | email + password → session cookie           |
| POST   | `/api/auth/logout`      | revoke current session, clear cookie        |
| GET    | `/api/auth/me`          | current user or `null` (never 401)          |
| POST   | `/api/auth/forgot`      | request reset link; always 200              |
| GET    | `/api/auth/token/:t`    | validate invite/reset token, return email   |
| POST   | `/api/auth/set-password`| redeem invite or reset token, set password  |
| POST   | `/api/auth/bootstrap`   | first-run owner creation; self-disabling    |

`/api/auth/me` is the one endpoint answering 200 with `null` instead of 401,
so the shell can decide whether to render login without a console error on
every cold load.

### 4.2 Owner — `/api/access/*`

| Method | Path                             | Purpose                             |
|--------|----------------------------------|-------------------------------------|
| GET    | `/api/access/clients`            | companies + portal state + contacts |
| PATCH  | `/api/access/clients/:id`        | toggle `portal_enabled` / `portal_shows_rates` |
| POST   | `/api/access/invite`             | invite a contact (client_id, email, name) |
| POST   | `/api/access/invite/:id/resend`  | new token, old one invalidated      |
| POST   | `/api/access/users/:id/revoke`   | deactivate user, kill all sessions  |
| POST   | `/api/access/users/:id/restore`  | reactivate (soft, never deleted)    |
| GET    | `/api/access/audit`              | recent `portal_audit` rows          |
| POST   | `/api/access/publish`            | bulk publish sessions by client + date range |
| PATCH  | `/api/access/sessions/:id`       | publish/unpublish one session       |
| GET    | `/api/access/requests`           | pending + declined client requests  |
| POST   | `/api/access/requests/:id/accept`| `portal_request` → NULL; enters your board |
| POST   | `/api/access/requests/:id/decline`| `portal_request` → `'declined'`, with a reason |
| GET    | `/api/access/threads`            | recent comments across companies, unread first |
| POST   | `/api/access/projects/:id/comments` | you post into a thread           |
| POST   | `/api/access/projects/:id/read`  | mark a thread read (badge clearing) |

`POST /api/access/publish` takes `{ client_id, from, to, publish }` and returns
the affected count. It is the only place `is_published` moves in bulk.

Accepting a request writes a `status_events` row with `source='accepted'`, so
the project's history shows where it came from. Declining is soft — the row
stays, the client sees "Declined" with your reason, nothing is deleted.

### 4.3 Client reads — `/api/portal/*`

| Method | Path                        | Returns                                  |
|--------|-----------------------------|------------------------------------------|
| GET    | `/api/portal/summary`       | hours this week + this month vs `weekly_hours_target`, recent activity, unread count |
| GET    | `/api/portal/sessions`      | paginated published sessions + entry summaries |
| GET    | `/api/portal/projects`      | all of their company's projects, incl. completed and their own requests |
| GET    | `/api/portal/projects/:id`  | one project + subtasks + links + thread  |
| GET    | `/api/portal/breakdown`     | per-project prorated minutes (labelled an estimate) |
| POST   | `/api/portal/export`        | audit-logs the export, returns the full filtered set |

`/api/portal/sessions` accepts `from`, `to`, `project_id`, `page`, `per_page`.
`project_id` is resolved through `ownedProject()`; a foreign id yields 404. It
returns date, `duration_minutes`, and entry summaries — never `question_text`,
`status_at_entry`, `status_events`, clock-in/clock-out wall times (open
question 7), or anything from `expenses`.

`/api/portal/export` is a POST rather than a GET because it writes an audit
row. It returns the same rows as `/api/portal/sessions` with paging disabled,
built by the same query helper, which is what makes the row-count test
meaningful rather than coincidental.

**Status mapping.** Portal project responses run every status through:

```js
const PORTAL_STATUS = { questions: 'in_progress' }   // decision 4
const portalStatus = (s) => PORTAL_STATUS[s] ?? s
```

A project sitting in Questions reads as In Progress to the client, and
`question_text` is never in the SELECT list to begin with. Requests render as
their own "Requested" / "Declined" state, derived from `portal_request`.

### 4.4 Client writes — `/api/portal/*`

| Method | Path                                 | Effect |
|--------|--------------------------------------|--------|
| POST   | `/api/portal/projects`               | create with `portal_request='pending'`, `requested_by=<them>` |
| PATCH  | `/api/portal/projects/:id`           | `name` and `description` only |
| POST   | `/api/portal/projects/:id/links`     | add an asset link |
| POST   | `/api/portal/projects/:id/comments`  | post a comment |
| POST   | `/api/portal/projects/:id/read`      | mark thread read |

### 4.5 What a client may and may not write

The writable field set is an **allowlist, not a blocklist**. `PATCH
/api/portal/projects/:id` reads exactly two keys off `req.body` and ignores
every other key in it entirely — it never spreads `{...project, ...req.body}`
the way the owner routes do. A body containing `status`, `question_text`,
`client_id`, `portal_request`, or `completed_at` is not rejected with an
error; those keys are simply never read, so they cannot be smuggled in via a
casing trick, a duplicate key, or a nested object. A test posts all of them at
once and asserts the row is unchanged apart from name and description.

| Surface | Client can | Why |
|---------|-----------|-----|
| Project name | edit | They often know the real name better than you do |
| Project description | edit | The brief. This is the field the feature actually needed |
| Project status | **no** | Decision 1 — your workflow, your board, your archive |
| `question_text` | **no** | Decision 4 — never read, never written, never selected |
| Comments | add | The point of the feature |
| Comments | edit or delete | **no** — immutable; ask you to remove one |
| Asset links | add | They drop briefs and reference material |
| Asset links | delete | **no** — you asked for edit/add/comment, not delete |
| Subtasks | **read only** | Your execution breakdown, not theirs to check off |
| Sessions / hours | **read only** | Client-side time entry stays out of scope |
| Projects | create as a request | Decision 2 |
| Projects | delete | **no** — deletes stay soft and stay yours |

Two of those are judgment calls I made rather than asked about, both
reversible in a line of code: **subtasks are read-only** to clients (they are
your task breakdown, and a client ticking off your work items would put the
board's `subtask_done` count under their control), and **clients cannot
delete anything** (you asked for edit, add, and comment; delete was not in
the ask and every delete path would need its own soft-delete column).

Validation and limits, all reusing the existing `httpError` style:

- project name ≤ 200 chars, non-empty after trim
- description ≤ 5000 chars
- comment body ≤ 5000 chars, non-empty after trim
- link URL validated with `new URL(url)`, matching the existing owner route
- 60 portal writes per user per 10 minutes, via `portal_rate_events`
- comment bodies render through React as text; no `dangerouslySetInnerHTML`
  anywhere in `src/portal/`

Every client write appends a `portal_audit` row, and every project field
change appends a `project_revisions` row **inside the same `withTx`** as the
UPDATE, so an edit and its history land together or not at all.

### 4.6 Existing endpoints — required role

Nothing here changes behavior for you. Every one becomes owner-only, and an
authenticated owner sees exactly what it sees today (subject only to §1.3,
which is a no-op on every existing row).

| Endpoint                                | Role  | Reachable by client? |
|-----------------------------------------|-------|----------------------|
| `GET /api/clients`                      | owner | never |
| `POST /api/clients`                     | owner | never |
| `PATCH /api/clients/:id`                | owner | never |
| `GET /api/projects`                     | owner | never |
| `POST /api/projects`                    | owner | never |
| `PATCH /api/projects/:id`               | owner | never |
| `GET /api/projects/:id/detail`          | owner | never |
| `POST /api/projects/:id/subtasks`       | owner | never |
| `PATCH /api/subtasks/:id`               | owner | never |
| `POST /api/projects/:id/subtasks/reorder`| owner | never |
| `DELETE /api/subtasks/:id`              | owner | never |
| `POST /api/projects/:id/links`          | owner | never |
| `DELETE /api/links/:id`                 | owner | never |
| `GET /api/active-session`               | owner | never |
| `POST /api/clock-in`                    | owner | never |
| `GET /api/prefill`                      | owner | never |
| `PATCH /api/sessions/:id`               | owner | never |
| `POST /api/sessions/:id/clock-out`      | owner | never |
| `GET /api/sessions`                     | owner | never |
| `GET /api/board`                        | owner | never |
| `GET /api/archive`                      | owner | never |
| `GET /api/expenses`                     | owner | never |
| `POST /api/expenses`                    | owner | never |
| `PATCH /api/expenses/:id`               | owner | never |
| `DELETE /api/expenses/:id`              | owner | never |

Client-visible equivalents are new, separate, scoped endpoints under
`/api/portal` — not shared handlers with a role branch inside. A shared
handler with `if (role === 'client')` in the middle is exactly the shape that
leaks when someone edits it a year from now. This matters more in v2: the
owner's `PATCH /api/projects/:id` and the client's
`PATCH /api/portal/projects/:id` do superficially similar things, and merging
them would be the single most tempting and most dangerous refactor available.
They stay separate.

---

## 5. Flows

### 5.1 Invite

1. Owner opens the Portal screen, picks a company, enters a contact email and
   name, clicks Invite.
2. Server creates a `portal_users` row: `role='client'`, that `client_id`,
   `password_hash = NULL`, `is_active = 1`. Also sets `clients.portal_enabled`
   if still 0.
3. Server issues an invite token, storing `sha256(token)` in `portal_tokens`
   with `kind='invite'` and **`expires_at = now + 7 days`**, single use.
4. The one-time link `/portal/set-password?t=<token>` is returned to the owner
   UI and shown once with a copy button. **No email is sent** (open question
   2) — you paste it into whatever channel you already use with that contact.
5. The contact opens the link and sets a password. Server verifies the token
   is unused and unexpired, writes `password_hash`, stamps `used_at`, logs
   `invite_redeemed`. Redemption does not auto-log-in; they land on login.

Resend issues a fresh token and stamps `used_at` on the outstanding one, so
exactly one invite link is ever live per user.

### 5.2 Reset

`POST /api/auth/forgot` with an email. If the account exists, is active, and
has a password, a `kind='reset'` token is created with **`expires_at = now +
1 hour`**, single use. The response is always 200 with the same body. The link
is not shown to the requester — it goes into `portal_audit`, and the Portal
screen surfaces pending resets so you can relay one after confirming who is
asking. Redeeming a reset revokes every existing `portal_sessions` row for
that user.

### 5.3 Login and rate limiting

On `POST /api/auth/login`, before any password work:

- `portal_rate_events` for `login:email:<addr>` in the last 15 min → **5 max**
- for `login:ip:<addr>` in the last 15 min → **20 max**

Over either limit → 429 with `Retry-After`, and no scrypt runs. A failed
attempt appends one row per bucket plus a `login_failed` audit row. A
successful login deletes that email's rows. Rows older than 24 hours are
pruned opportunistically on roughly 1-in-50 requests, avoiding a cron on a
platform with no daemon. `req.ip` comes from `trust proxy` +
`x-forwarded-for`.

Portal writes use the same table with a `write:user:<id>` bucket, 60 per 10
minutes. Over the limit → 429, no row written.

On success: create `portal_sessions`, set the cookie, stamp `last_login_at`,
log `login`.

### 5.4 Request lifecycle

```
client creates  →  portal_request = 'pending'   (invisible to your board)
                        │
        ┌───────────────┴────────────────┐
   you accept                       you decline
        │                                │
portal_request = NULL            portal_request = 'declined'
status_events(source='accepted')  reason stored in portal_audit.detail
appears on Board / Archive /      stays visible to the client as Declined,
Projects / prefill                never deleted
```

A pending request is a real `projects` row from the first moment, so its
comment thread and revision history work before you have accepted it. It is
simply filtered out of your four owner queries (§1.3) until it is yours.

### 5.5 Unread badges

`project_comment_reads` holds one `last_read_at` per (project, user). Unread
for a viewer = comments on that project with `created_at > last_read_at` and
`portal_user_id != <viewer>`. This gives a per-project badge in both
directions from one small table. Opening a thread POSTs to `…/read`.

This is the only concession to notifications. A comment feature where you
never learn a comment arrived is a dead feature, but nothing here sends email,
push, or webhooks — the badge lives in the app you already have open.

### 5.6 Bootstrap

`POST /api/auth/bootstrap` succeeds only when **both** hold:

1. `SELECT COUNT(*) FROM portal_users WHERE role='owner'` is `0`, and
2. `process.env.PORTAL_BOOTSTRAP_TOKEN` is set and equals the submitted token
   (compared with `timingSafeEqual`).

Two conditions, so an unset env var cannot be brute-forced into an owner
account and a forgotten one cannot silently re-open the door. Once an owner
exists the route answers 404 forever regardless of the env var.

### 5.7 Token lifetimes at a glance

| Token   | Lifetime             | Single use | Revoked by                        |
|---------|----------------------|------------|-----------------------------------|
| session | 14d rolling, 90d max | no         | logout, user revoke, password set  |
| invite  | 7 days               | yes        | resend, redemption                 |
| reset   | 1 hour               | yes        | redemption, new reset request      |
| bootstrap | until first owner  | yes        | first owner existing               |

---

## 6. Dependencies

**Request: none.** Every piece has a standard-library answer, and each
addition would be supply-chain surface on an app holding your billing data.
For the record, what is declined and what fills the gap:

| Would-be dep       | Using instead                              | What breaks without it |
|--------------------|--------------------------------------------|------------------------|
| `bcrypt`           | `node:crypto` scrypt                        | Nothing. scrypt is memory-hard, in-tree, no native build — `bcrypt` would add a compiled dependency to a Vercel build that has none. |
| `jsonwebtoken`     | opaque random token + DB lookup             | Nothing wanted. JWTs cannot do immediate revocation without a denylist table, which is the table we already have. |
| `cookie-parser`    | six-line `req.headers.cookie` split         | Nothing. `res.cookie()` is Express core already. |
| `express-rate-limit` / `redis` | `portal_rate_events` table      | The library's in-memory store is useless on serverless — each invocation starts with an empty counter, so it would silently enforce nothing. |
| `express-session`  | `portal_sessions` table                     | Same reason: MemoryStore does not survive between invocations. |
| `supertest`        | `app.listen(0)` + global `fetch`            | Nothing. Node 26 has `fetch` built in. |
| a markdown renderer | plain text comments                        | Formatting in comments. Also removes an XSS surface, which is why I would push back even if asked. |
| `nodemailer` / `resend` | manual link relay                      | Automated delivery. Open question 2 — the one dependency I would ask for. |

---

## 7. File layout

`server/app.js` is 438 lines and stays roughly that size. New code lands in
new modules mounted from `app.js`.

```
server/
  auth.js              hashing, token mint/verify, cookie read/write,
                       resolveSession, issueSession, revoke, audit(), rate limit
  gate.js              the deny-by-default middleware (§3.1)
  routes/auth.js       /api/auth/*
  routes/access.js     /api/access/*   (owner)
  routes/portal.js     /api/portal/*   (client, read + write)
  portal-query.js      the scoped+published session query and the scoped
                       project query, shared by every portal read
  auth.test.js         node --test
  portal.test.js       node --test
  portal-write.test.js node --test
src/
  portal/
    PortalApp.jsx      own shell, own nav — does NOT import App.jsx
    api.js             fetch helper w/ credentials + 401 → /portal/login
    csv.js             pure row builder, shared by the table and the export
    screens/           Login  Forgot  SetPassword  Dashboard  Sessions
                       Projects  ProjectDetail
  screens/Portal.jsx   new owner screen: Access | Requests | Threads tabs
  components/Thread.jsx  comment thread, used by both shells
```

`src/portal/*` imports `styles/tokens.css` and `components/ui.jsx`. No new
colors, no new type scale, no second component library. `App.jsx` is untouched
apart from one nav entry and its unread badge — the portal shell is a sibling
top-level route in `main.jsx`, so Expenses and Board are not merely hidden
from clients, they are never rendered in the portal bundle at all.

`components/Thread.jsx` is the one component both shells share. It takes
comments and a post callback and knows nothing about roles or scoping; all
authorization lives server-side. Sharing a presentational component is safe in
a way that sharing a route handler is not.

---

## 8. Tests — `node --test`, no new dependencies

Run with `npm test` → `node --test server/`. Each file boots the app on an
ephemeral port against a throwaway SQLite file and drives it with `fetch`.

This needs one small additive change to `db.js`: a `TEMPO_DATA_DIR` env
override on the hardcoded `DATA_DIR`, so tests cannot touch `data/tempo.db`.
Open question 5.

**Boundary (from your original list):**

1. Unauthenticated request to each `/api/*` route → 401. Enumerated from the
   Express router stack, so a route added later without a test is still
   covered by construction.
2. Client session → `/api/expenses` returns 404 with no body content.
3. Client session's `/api/portal/sessions` contains zero unpublished rows.
4. Client session's list contains zero rows from another company.
5. Same request with `?client_id=<other>` / `{client_id: <other>}` / an
   `X-Client-Id` header produces a byte-identical response.
6. CSV row count equals the on-screen filtered count. Made testable by
   `src/portal/csv.js` being a pure function over the session array — the
   table and the export consume the same builder, so the test compares two
   derivations of one input rather than mocking a DOM.
7. Expired invite token cannot be redeemed (clock moved by writing
   `expires_at` in the past, not by sleeping).
8. Revoked user's existing cookie fails on the very next request.
9. Owner sees everything, unchanged — snapshot of each owner endpoint before
   and after the gate is introduced, including the four §1.3 queries.

**Write boundary (new in v2):**

10. `PATCH /api/portal/projects/:id` with `status`, `question_text`,
    `client_id`, `portal_request`, and `completed_at` all in one body changes
    none of them.
11. No portal response body anywhere contains a known `question_text`
    sentinel value — asserted by scanning the serialized JSON of every portal
    GET, so a future `SELECT *` regression fails the suite.
12. A project in `questions` status reports `in_progress` to the client.
13. Client write to another company's project id → 404, and the target row is
    byte-identical afterwards.
14. A client-created project does not appear in `/api/board`, `/api/projects`,
    `/api/archive`, or `/api/prefill` until accepted, and does appear in all
    four immediately after.
15. A revoked user cannot post a comment.
16. Every client write leaves a `portal_audit` row; every project field edit
    leaves a `project_revisions` row with the correct old value.
17. Comments have no edit or delete path reachable by a client.

---

## 9. README changes

- Replace the "enable Deployment Protection" paragraph with the reverse
  instruction, the reason, and an explicit warning that turning it off is what
  makes application auth load-bearing.
- First-run bootstrap: set `PORTAL_BOOTSTRAP_TOKEN`, POST to
  `/api/auth/bootstrap`, sign in, delete the variable, redeploy.
- Document `TEMPO_DATA_DIR`, `npm test`, invite/publish, and the request
  accept/decline workflow.
- Note that preview deployments have no `DATABASE_URL` and still answer 503,
  so they are not a second exposed surface.
- Add `public/robots.txt` with `Disallow: /` so the portal login page is not
  indexed once protection comes off.

---

## 10. Open questions

1. **`portal_shows_rates` gates nothing that exists.** There is no rate,
   amount, or dollar column on `clients` anywhere — the only money in the
   database is `expenses.amount`, which clients must never see. As specified
   it ships as a no-op toggle. Add `clients.hourly_rate` and show hours ×
   rate, keep the column as a forward hook with the toggle hidden, or drop it?
2. **No email delivery.** Invite and reset links are copy-paste, and now
   comments have no notification either. Confirm that is acceptable for v1, or
   tell me to plan a provider — the one dependency I would ask for.
3. **Owner is blocked from `/api/portal/*` and gets 404.** Your no-client_id
   rule makes an owner preview impossible without violating it. Confirm you
   are fine with no "view as Mercenary Marketing" preview, or accept a
   separate owner-only read-only `/api/access/preview/:client_id` reusing the
   same query helper.
4. **`PATCH /api/clients/:id`** does a fixed-column `UPDATE`. The new toggles
   route through `PATCH /api/access/clients/:id` instead, leaving the existing
   owner endpoint byte-identical. Confirm.
5. **`TEMPO_DATA_DIR` override in `db.js`** — additive, defaults to today's
   path, exists purely so tests do not write to your billing database.
6. **New sessions after this ships**: default unpublished and you publish
   deliberately, or auto-publish on clock-out for companies with
   `portal_enabled = 1`? Schema default is 0 either way; this is only about
   whether clock-out sets it to 1.
7. **Wall-clock times.** Plan shows date + duration only. Showing
   `clock_in`/`clock_out` would tell a client which hours of the day you work
   for them. Confirm.
8. **Untagged sessions** (clock-outs with zero `session_entries`) have
   duration but no project. Hiding them makes the portal total disagree with
   your invoice. Plan shows them as "(untagged)" with their duration, matching
   what `Timesheets.jsx` already does in its CSV export. Confirm.
9. **Local development login.** Same bootstrap locally, no dev bypass — an
   `if (!ON_VERCEL) skipAuth` is exactly the branch that eventually ships.
10. **Uncommitted work.** `server/app.js`, `server/db.js`, `README.md`, and
    `.gitignore` have uncommitted changes (the retry-init / 503 work). I'd
    like those committed before Phase 2 so the portal diff reviews on its own.
11. **NEW — §1.3 sign-off.** Four existing owner queries gain
    `AND portal_request IS NULL`. No existing row is affected, but it is a
    change to existing owner-facing SQL and your constraints say tell you
    first. This is me telling you first.
12. **NEW — one contact per company, or several?** The schema supports many
    `portal_users` per `client_id` and the plan assumes that works. If
    Mercenary Marketing has three people, they each get their own login,
    their own audit trail, and comments attributed by name. Confirm that is
    what you want rather than one shared company login.

---

## 11. Order of work (Phase 2)

1. **Auth boundary** — schema, `auth.js`, `gate.js`, `/api/auth/*`, bootstrap,
   rate limiting; tests 1–2, 7–9 green. Pause.
2. **Owner management** — `/api/access/*`, `Portal.jsx`, the six new columns,
   the §1.3 filter, publish + bulk publish, requests tray; test 14 green.
   Pause.
3. **Client portal, read** — shell, login/forgot/set-password, dashboard,
   sessions table, breakdown, CSV; tests 3–6, 11–12 green. Pause.
4. **Client portal, write** — project edit, requests, links, comment threads,
   unread badges; tests 10, 13, 15–17 green. Pause.

Nothing in step 2 is written until step 1's tests pass. The write surface in
step 4 is deliberately last: it is the only part that can corrupt data rather
than merely expose it, and by then the boundary it depends on has been under
test for three steps.
