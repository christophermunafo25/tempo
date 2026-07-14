# TEMPO

Contract time tracking + project intelligence for a solo creative contractor.
Clock in/out per client, capture structured project updates at clock-out, and
review everything through a dashboard, a Kanban board, and weekly timesheets
measured against contracted hours.

Local-first: all data lives in a SQLite file on disk. This data drives client
invoicing — nothing is stubbed, deletes are soft, history is never overwritten.

## Run

TEMPO is local-first by design — it runs on your machine and nowhere else.

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
