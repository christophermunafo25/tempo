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

Bootstrap is self-disabling: it needs both an env var *and* an empty owner
table, so a forgotten variable can't reopen it later.

1. Vercel → **Settings → Environment Variables** → add
   `PORTAL_BOOTSTRAP_TOKEN` = a long random string. Redeploy.
2. Create the account:

   ```bash
   curl -X POST https://<your-deployment>/api/auth/bootstrap \
     -H 'Content-Type: application/json' \
     -H 'Origin: https://<your-deployment>' \
     -d '{"token":"<PORTAL_BOOTSTRAP_TOKEN>","email":"you@example.com","password":"<a long password>","name":"Chris"}'
   ```

3. Sign in, confirm the app loads.
4. **Delete `PORTAL_BOOTSTRAP_TOKEN`** and redeploy. The route answers 404
   from here on regardless, but leaving the secret around serves no purpose.

Passwords are hashed with `node:crypto` scrypt. Session tokens are 256-bit
random values; only their SHA-256 hash is stored, so the database never holds
anything that could be replayed as a cookie. Sessions are validated by lookup
rather than signature, which is what makes revoking a contact take effect on
their very next request.

Run the same bootstrap against `http://localhost:3001` for local development —
there is deliberately no dev-mode auth bypass, since that branch is exactly
the kind that eventually ships.

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
