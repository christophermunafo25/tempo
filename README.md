# TEMPO

Contract time tracking + project intelligence for a solo creative contractor.
Clock in/out per client, capture structured project updates at clock-out, and
review everything through a dashboard, a Kanban board, and weekly timesheets
measured against contracted hours.

Local-first: all data lives in a SQLite file on disk. This data drives client
invoicing — nothing is stubbed, deletes are soft, history is never overwritten.

## Deploy on Vercel (with Supabase)

The front end deploys as a static Vite build; the API runs as a serverless
function (`api/index.js`) wrapping the same Express app used locally. Vercel
has no persistent disk, so the deployed API stores data in a Supabase
Postgres database (free tier). The schema creates itself on first request.

One-time setup — dashboard clicks only, no terminal:

1. [supabase.com](https://supabase.com) → sign in with GitHub → **New
   project** → name it `tempo`, choose a database password (save it), pick a
   region near you.
2. When the project is ready, click **Connect** (top bar) → **Connection
   string** → choose **Transaction pooler** (important: the direct
   connection doesn't work from Vercel) → copy the URI and replace
   `[YOUR-PASSWORD]` with your database password.
3. Vercel → tempo project → **Settings → Environment Variables** → add
   `DATABASE_URL` = that URI → Save.
4. **Deployments → ⋯ → Redeploy.**

Until `DATABASE_URL` is set, `/api/*` returns a clear 503 explaining this.

The project currently in use is `lzqnnvxgrnuogvwishaa`
(https://lzqnnvxgrnuogvwishaa.supabase.co). `DATABASE_URL` is set on Vercel for
the Production environment only, so preview deployments answer 503 rather than
writing to the billing database.

Note this project lives under a different Supabase account than the one the
local `supabase` CLI is logged into, so CLI commands won't see it. Nothing
depends on that — the app builds its own schema on first request — but
`supabase login` against the owning account is needed before any CLI work.

### If the deployed app stops loading

Supabase pauses free-tier projects after a stretch of inactivity, and a paused
project refuses connections. `/api/*` then answers 503 with the reason. The
fix is a dashboard click, not a redeploy:

1. [supabase.com/dashboard](https://supabase.com/dashboard) → the `tempo`
   project → **Restore project**.
2. Wait for the project to report healthy (a minute or two).
3. Reload the app. No redeploy needed — the next request retries the
   connection on its own.

Restoring keeps the same connection string, so `DATABASE_URL` stays valid.

## Deployment Protection and the client portal

Deployment Protection gates the *whole* deployment, which is why it can't stay
on once clients need to sign in: it would block them at the door before the
app ever loads. Turning it off makes every URL on the deployment publicly
reachable, so **application-level authorization becomes the only barrier that
exists** — `/api/expenses` is personal overhead and `/api/clients` lists every
company, and after that switch nothing but the auth gate keeps them private.

Do not turn it off until the auth boundary is deployed and `npm test` passes
against the deployment's own code. In order:

1. Deploy the code that includes `server/gate.js`.
2. Create the owner account (below) and confirm sign-in works.
3. Only then: **Settings → Deployment Protection → Vercel Authentication →
   Disabled**.

Preview deployments have no `DATABASE_URL` and still answer 503, so they are
not a second exposed surface.

### The auth boundary in one paragraph

`server/gate.js` mounts once at `/api`, above every route, and sorts each
request by its first path segment: `/api/auth/*` is public, `/api/portal/*` is
for signed-in client contacts scoped to their own company, and **everything
else requires the owner**. The owner arm is the default, so a route added
anywhere under `/api` later is owner-only automatically — opting one into
client access means physically moving it under `/api/portal`. A client session
asking for an owner route gets 404, not 403, so it learns nothing about what
else is hosted here.

### First-run owner account

There is no sign-up. Accounts come from first-run setup, once, or from an
invite. Until an owner exists, `/login` shows a setup screen instead of a
login form — a fresh deployment would otherwise be a form nobody can satisfy.

1. Vercel → **Settings → Environment Variables** → add
   `PORTAL_BOOTSTRAP_TOKEN` = a long random string, and `TEMPO_TZ` =
   `America/Chicago`. **Redeploy** — env vars don't apply to an already-built
   deployment.
2. Open the app. The setup screen asks for that token, your email and a
   password, then signs you straight in.
3. **Delete `PORTAL_BOOTSTRAP_TOKEN`** and redeploy.

Setup is self-disabling: it needs both the env var *and* an empty owner table,
so a forgotten variable can't reopen it later, and the screen disappears the
moment an owner exists. The token is what stops whoever loads the URL first
from claiming the deployment.

If the screen says setup is locked, the env var isn't set or the deployment
wasn't rebuilt after adding it. The same flow works locally:
`PORTAL_BOOTSTRAP_TOKEN=setup-once npm run dev`.

Passwords are hashed with `node:crypto` scrypt. Session tokens are 256-bit
random values; only their SHA-256 hash is stored, so the database never holds
anything that could be replayed as a cookie. Sessions are validated by lookup
rather than signature, which is what makes revoking a contact take effect on
their very next request.

Run the same bootstrap against `http://localhost:3001` for local development —
there is deliberately no dev-mode auth bypass, since that branch is exactly
the kind that eventually ships.

## Giving a client access

Everything below lives on the **Portal** screen.

**Access** — one card per company. Invite a contact by email and TEMPO creates
a passwordless account, switches that company's portal on, and hands you a
one-time link. **There is no email transport**, so you send that link yourself,
however you already talk to them. It works once and expires in 7 days.
*Resend* replaces it, which kills the previous link. Once they have a password
the button becomes *Reset link*, for when they're locked out.

Each person gets their own login, so comments and audit entries are attributed
by name. *Revoke* is soft: the row and its history stay, live cookies die on
the contact's next request, and outstanding links are burned. *Restore* undoes
it.

The *Show rates* toggle is deliberately labelled "not wired up" — there is no
rate column on clients yet, so the flag currently gates nothing.

**Publishing** — nothing is visible to a client until it is published, and
every session logged before the portal existed defaults to hidden. Pick a
company and a week, then publish the whole week or tick individual sessions.
Unpublishing takes something back out of view.

**Requests** — projects a client submitted. They are real `projects` rows from
the moment they're created, but they stay out of the Board, Archive, project
list and clock-out prefill until you *Accept* them. Accepting records a
`status_events` row with `source='accepted'` so the project's history shows
where it came from. *Decline* is soft, takes a reason the client will see, and
never deletes the row.

## Renaming a client, changing their colour

**Portal → Access → Edit** on a company. Name and accent colour only; weekly
hours target stays inline-editable on Timesheets where it always was.

Both changes apply everywhere at once, including past timesheets, the Board,
the Dashboard charts and the client's own portal — they're read from the one
`clients` row, so there is no stale copy anywhere. Hours are untouched. The
colour comes from the fixed eight-colour palette, since it's what identifies a
company at a glance in the charts and every client dot.

An empty name is refused: it would render as a blank row in every list. Both
changes are recorded in the audit log with the old value.

## Archiving a client

There is no hard delete. **Portal → Access → Archive this company** sets
`clients.is_active = 0` and nothing else: the client row, its projects, its
sessions and every summary you wrote all stay exactly where they are.
Restoring puts every hour back to the minute.

Archiving hides the company **everywhere** — the Clock picker, the Board, the
Dashboard, Timesheets, the Archive, clock-out prefill, and its own client
portal. That is deliberate: rows and totals have to move together, or a
timesheet shows a total that its visible rows don't add up to. The cost, taken
knowingly: **a week you already invoiced will render differently afterwards,
and its CSV will change.** Restore the company to reproduce the original.

Its portal contacts lose access on their very next request, cannot sign in,
and cannot redeem an outstanding invite or reset link. All of that reverses on
restore, with no per-person bookkeeping to get out of step — a contact's access
simply follows their company.

You can't archive a company you're currently clocked into; clock out first, or
the running timer would vanish with no way to close it.

Archived companies stay listed under **Portal → Access → Archived**, which is
the only place they appear and where you restore them from.

## What a client sees

Their own shell at `/portal`, with three screens and none of the owner nav —
it is a sibling of the main app, not a child, so Clock, Board, Timesheets and
Expenses are never in a client's route tree at all.

- **Overview** — hours this week against `weekly_hours_target`, hours this
  month, and recent activity.
- **Hours** — every published session, filterable by date range and project,
  paginated, with a CSV export. The export re-runs the same filter through the
  same query helper the table uses, so the file and the screen cannot disagree.
- **Projects** — everything for their company, completed included, read-only
  for now.

What is deliberately withheld, and enforced by tests rather than by care:

- **Unpublished sessions**, everywhere — the list, the totals, the by-project
  estimate and the CSV.
- **Anything belonging to another company.** Scope comes from the session, so
  no portal endpoint takes a `client_id`; passing one changes nothing.
  Requesting another company's project by id answers 404, never 403.
- **`question_text` and `status_events`.** A project parked in Questions
  reports as In Progress. No portal query uses `SELECT *`, and a test scans
  every portal response for a sentinel question value so a future `SELECT *`
  fails the suite.
- **Clock times.** Sessions are reported as a calendar date and a duration.
  A client learns how long you worked, not which hours of the day.

The by-project figures are an estimate and say so on screen: hours are clocked
per company, so each session is split evenly across the projects worked on in
it. Time logged with no project attached appears as `(untagged)` rather than
being dropped, so the breakdown always reconciles to the total above it.

### What a client can change

Editing, requesting and commenting are allowed; the workflow is not. The
writable set is an allowlist — the handlers read the fields they accept by
name and never spread the request body, so `status`, `question_text`,
`client_id`, `portal_request` and `completed_at` are not rejected with an
error, they are simply never read.

| Surface | Client can | Why |
|---|---|---|
| Project name, brief | edit | The brief is what the feature actually needed |
| Comments | add | Threads are shared with the owner |
| Comments | edit or delete | **no** — immutable; history is the record |
| Asset links | add | They drop briefs and reference material |
| Asset links | delete | **no** — removal was not part of the ask |
| Projects | request | Lands as `portal_request='pending'` for you to accept |
| Project status | **no** | Your board, your archive |
| Subtasks | read-only | Your execution breakdown; ticking them off would put the board's own counts in a client's hands |
| Sessions, hours | read-only | Client-side time entry stays out of scope |

Every edit appends to `project_revisions` inside the same transaction as the
UPDATE, so a change and its history land together or not at all. Every write
appends to `portal_audit`. Writes are capped at 60 per user per 10 minutes.

Unread counts are the only notification in the system. Nothing sends email,
push or webhooks — a badge appears on the Portal screen's Messages tab, and on
the client's side against the project. That is deliberate: a comment feature
where you never learn a comment arrived is a dead feature, but this is not a
notification system.

The owner's Portal screen lives at `/access`, not `/portal` — the client shell
owns `/portal`, and two routes matching one path silently hid the owner screen
once the client shell existed.

### TEMPO_TZ

"The day a session belongs to" has to mean one thing. The owner's screens use
the browser's zone; the portal names one explicitly, because Vercel runs in
UTC, where the date rolls over in the evening Central time — so an evening
session would be reported to the client as the following day.

Set `TEMPO_TZ` to an IANA zone (e.g. `America/Chicago`) in the Vercel
environment variables. It defaults to the server's own zone, which is right
locally and wrong on Vercel.

## Tests

```bash
npm test           # node --test, no test dependencies
```

Covers the security boundary only: that unauthenticated callers get 401 on
every `/api` route, that a client session gets 404 and never data on owner
routes, that revoked cookies die immediately, that expired invite tokens can't
be redeemed, and that the owner's own endpoints are unchanged. The suite
writes to a throwaway directory via `TEMPO_DATA_DIR` and never touches
`data/tempo.db`.

## Run locally

The same code runs fully local (SQLite file, no cloud) when no
`TURSO_DATABASE_URL` is set.

```bash
npm install
npm start          # daily driver: builds the app, serves everything at localhost:3001
```

For working on the code, use dev mode instead (hot reload, two ports):

```bash
npm run dev        # API on localhost:3001 + client on localhost:5173
```

## Back up

```bash
npm run backup     # SQLite online backup → data/backups/tempo-YYYY-MM-DD.db
```

Safe to run while the server is up (uses SQLite's online backup API, so
WAL-pending writes are included).

## Screens

- **Clock** — the home screen. Pick a client, one big CLOCK IN. Clocking out
  opens the review panel: entries prefill from the client's last session
  (project, summary, status, subtasks, asset links) so today's edits describe
  today's progress. Sessions with no entries still save, flagged as untagged
  time. Sessions running past 12 hours get a banner with an editable end time.
- **Dashboard** — week view (headline stats, hours-by-day stacked by client
  color, chronological work log) and all-time view (cumulative hours by
  client, completed-projects archive with prorated hours + summary trail,
  monthly trend).
- **Board** — six status columns fed by clock-out statuses; drag between
  columns to override (Questions requires the question, Complete asks to
  confirm). Complete column shows the last 14 days only. Click a card for the
  full drawer: summary history, subtasks, links, status timeline.
- **Timesheets** — contracted vs. actual per client per week, inline-editable
  targets, pace indicator, totals, and an invoice-ready CSV per week (one row
  per session entry, durations prorated across a session's entries).

## Stack

Vite + React 18 · React Router · Recharts · Express · better-sqlite3 ·
vanilla CSS design tokens. Database at `data/tempo.db` (WAL mode, UTC
timestamps; everything renders in local time — sessions belong to the day
they started).

## Design system

CJPortfolio/SocialPaint tokens (`~/CJPortfolioDesignSystem`): linen/paper
surfaces, Midnight Ink text, hairline borders, Fragment Mono for all numerals
and labels (tabular figures), Stack Sans body, Menseal Black display. Light
theme is the default; the sidebar toggle switches to an Obsidian dark theme
(persisted in localStorage). Solar orange is reserved for interactive moments
only — the clock button, focus rings, active nav rule, timer colons, drag
targets. Client accent colors (a muted 8-color palette) carry all data
differentiation in charts and cards; status pills use muted semantic tints.
