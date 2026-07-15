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

Since this holds billing data, enable **Settings → Deployment Protection →
Vercel Authentication** so only you can open the deployed app.

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
