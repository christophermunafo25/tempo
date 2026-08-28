// Database adapter: one query interface, two backends.
//   DATABASE_URL set  → Postgres (Supabase) — used on Vercel
//   otherwise         → local SQLite file via libsql — used on Chris's Mac
// Both speak raw SQL with `?` placeholders and INSERT … RETURNING *.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ON_VERCEL = !!process.env.VERCEL

export let dbError = null

const SCHEMA_COMMON = (idCol, nowDefault) => `
CREATE TABLE IF NOT EXISTS clients (
  id ${idCol},
  name TEXT NOT NULL,
  color_accent TEXT NOT NULL,
  weekly_hours_target REAL NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT ${nowDefault}
);
CREATE TABLE IF NOT EXISTS projects (
  id ${idCol},
  client_id INTEGER NOT NULL REFERENCES clients(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_queue'
    CHECK (status IN ('in_queue','on_deck','in_progress','questions','sent_for_review','complete')),
  question_text TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT ${nowDefault}
);
CREATE TABLE IF NOT EXISTS subtasks (
  id ${idCol},
  project_id INTEGER NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  is_done INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ${nowDefault}
);
CREATE TABLE IF NOT EXISTS asset_links (
  id ${idCol},
  project_id INTEGER NOT NULL REFERENCES projects(id),
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT ${nowDefault}
);
CREATE TABLE IF NOT EXISTS sessions (
  id ${idCol},
  client_id INTEGER NOT NULL REFERENCES clients(id),
  clock_in TEXT NOT NULL,
  clock_out TEXT,
  duration_minutes REAL,
  created_at TEXT NOT NULL DEFAULT ${nowDefault}
);
CREATE TABLE IF NOT EXISTS session_entries (
  id ${idCol},
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  project_id INTEGER NOT NULL REFERENCES projects(id),
  summary TEXT NOT NULL DEFAULT '',
  status_at_entry TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT ${nowDefault}
);
CREATE TABLE IF NOT EXISTS status_events (
  id ${idCol},
  project_id INTEGER NOT NULL REFERENCES projects(id),
  status TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'session',
  created_at TEXT NOT NULL DEFAULT ${nowDefault}
);
CREATE TABLE IF NOT EXISTS expenses (
  id ${idCol},
  name TEXT NOT NULL,
  cadence TEXT NOT NULL DEFAULT 'monthly'
    CHECK (cadence IN ('monthly','quarterly','annually','fixed')),
  amount REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ${nowDefault}
);

/* ── Client portal ────────────────────────────────────────────────────────
   'clients' means the companies being billed and 'sessions' means work
   blocks, so portal people and portal auth sessions get their own names. */

CREATE TABLE IF NOT EXISTS portal_users (
  id ${idCol},
  client_id INTEGER REFERENCES clients(id),
  email TEXT NOT NULL,
  password_hash TEXT,
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
  token_hash TEXT NOT NULL,
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
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT ${nowDefault}
);
CREATE INDEX IF NOT EXISTS portal_audit_created ON portal_audit (created_at);

CREATE TABLE IF NOT EXISTS portal_rate_events (
  id ${idCol},
  bucket TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT ${nowDefault}
);
CREATE INDEX IF NOT EXISTS portal_rate_events_bucket
  ON portal_rate_events (bucket, created_at);

CREATE TABLE IF NOT EXISTS portal_share_links (
  id ${idCol},
  client_id INTEGER NOT NULL REFERENCES clients(id),
  token_hash TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  shows_notes INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT,
  revoked_at TEXT,
  last_viewed_at TEXT,
  view_count INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES portal_users(id),
  created_at TEXT NOT NULL DEFAULT ${nowDefault}
);
CREATE UNIQUE INDEX IF NOT EXISTS portal_share_links_token
  ON portal_share_links (token_hash);
CREATE INDEX IF NOT EXISTS portal_share_links_client
  ON portal_share_links (client_id);

CREATE TABLE IF NOT EXISTS project_comments (
  id ${idCol},
  project_id INTEGER NOT NULL REFERENCES projects(id),
  portal_user_id INTEGER NOT NULL REFERENCES portal_users(id),
  body TEXT NOT NULL,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT ${nowDefault}
);
CREATE INDEX IF NOT EXISTS project_comments_project ON project_comments (project_id, id);

CREATE TABLE IF NOT EXISTS project_comment_reads (
  id ${idCol},
  project_id INTEGER NOT NULL REFERENCES projects(id),
  portal_user_id INTEGER NOT NULL REFERENCES portal_users(id),
  last_read_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT ${nowDefault}
);
CREATE UNIQUE INDEX IF NOT EXISTS project_comment_reads_pair
  ON project_comment_reads (project_id, portal_user_id);

CREATE TABLE IF NOT EXISTS project_revisions (
  id ${idCol},
  project_id INTEGER NOT NULL REFERENCES projects(id),
  portal_user_id INTEGER REFERENCES portal_users(id),
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  created_at TEXT NOT NULL DEFAULT ${nowDefault}
);
CREATE INDEX IF NOT EXISTS project_revisions_project ON project_revisions (project_id, id);
`

const SCHEMA_SQLITE = SCHEMA_COMMON(
  'INTEGER PRIMARY KEY AUTOINCREMENT',
  "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
)
const SCHEMA_PG = SCHEMA_COMMON(
  'INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY',
  "(to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'))",
)

// Columns added to tables that already shipped. SQLite has no
// ADD COLUMN IF NOT EXISTS, so both backends introspect first and then issue a
// plain ADD COLUMN — no swallowed errors hiding a real failure.
//
// Two dialect rules constrain what can appear here:
//   • SQLite rejects a non-constant DEFAULT in ADD COLUMN, so literals only —
//     never the nowDefault expression. A created_at column needs a new table.
//   • SQLite rejects UNIQUE and PRIMARY KEY in ADD COLUMN, and its CHECK
//     support there is version-dependent. Uniqueness arrives as a separate
//     CREATE UNIQUE INDEX IF NOT EXISTS; value constraints are enforced in code.
const ADD_COLUMNS = [
  ['clients',  'portal_enabled',     'INTEGER NOT NULL DEFAULT 0'],
  ['clients',  'portal_shows_rates', 'INTEGER NOT NULL DEFAULT 0'],
  ['sessions', 'is_published',       'INTEGER NOT NULL DEFAULT 0'],
  ['projects', 'description',        'TEXT'],
  ['projects', 'portal_request',     'TEXT'],
  ['projects', 'requested_by',       'INTEGER'],
]

// Arbitrary fixed key. Parallel Vercel cold starts all run init(); racing
// CREATE TABLE IF NOT EXISTS can still raise 42P07 or a pg_type 23505 on
// Postgres. Transaction-scoped rather than session-scoped, because Supabase's
// transaction pooler doesn't keep a session pinned across statements.
const SCHEMA_LOCK_KEY = 4021977

// Vercel stores exactly what was pasted. A value wrapped in quotes, prefixed
// with `DATABASE_URL=`, or carrying a leading space does not fail loudly: the
// driver parses it as host "base" and reports a baffling DNS error. Strip the
// artifacts that are unambiguous, then insist on a real URI.
const DB_URL = (process.env.DATABASE_URL || '').trim().replace(/^(['"])([\s\S]*)\1$/, '$2').trim()
const IS_URI = /^postgres(ql)?:\/\//.test(DB_URL)

const unconfigured = (message) => {
  dbError = message
  return {
    query() { throw new Error(dbError) },
    withTx() { throw new Error(dbError) },
    async init() {},
    close() {},
  }
}

let backend

if (DB_URL && !IS_URI) {
  backend = unconfigured(
    'DATABASE_URL is set but is not a Postgres connection URI \u2014 it must start with ' +
    'postgresql:// . Re-add it with the bare string from Supabase \u2192 Connect \u2192 ' +
    'Transaction pooler, with no surrounding quotes, no "DATABASE_URL=" prefix and no ' +
    'leading space.')
} else if (DB_URL) {
  /* ── Postgres (Supabase) ─────────────────────────────────────────────── */
  const { default: pg } = await import('pg')
  // COUNT()/SUM() come back as int8/numeric strings — parse them.
  pg.types.setTypeParser(20, Number)     // int8
  pg.types.setTypeParser(1700, Number)   // numeric
  const pool = new pg.Pool({
    connectionString: DB_URL,
    ssl: DB_URL.includes('localhost') ? false : { rejectUnauthorized: false },
    max: ON_VERCEL ? 1 : 5,
  })
  const toPg = (sql) => {
    let i = 0
    return sql.replace(/\?/g, () => `$${++i}`)
  }
  backend = {
    async query(conn, sql, args) {
      const res = await (conn || pool).query(toPg(sql), args)
      return res.rows
    },
    async withTx(fn) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await fn(client)
        await client.query('COMMIT')
        return result
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {})
        throw e
      } finally {
        client.release()
      }
    },
    // All DDL runs on one connection inside one transaction. On Vercel the
    // pool is capped at 1, so reaching for a second connection here would
    // deadlock against the one already holding the lock.
    async init() {
      const conn = await pool.connect()
      try {
        await conn.query('BEGIN')
        await conn.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK_KEY])
        await conn.query(SCHEMA_PG)
        for (const [table, col, ddl] of ADD_COLUMNS) {
          const found = await conn.query(
            `SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
            [table, col])
          if (found.rowCount === 0) {
            await conn.query(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`)
          }
        }
        await conn.query('COMMIT')
      } catch (e) {
        await conn.query('ROLLBACK').catch(() => {})
        throw e
      } finally {
        conn.release()
      }
    },
    close: () => pool.end(),
  }
} else if (!ON_VERCEL) {
  /* ── Local SQLite file ───────────────────────────────────────────────── */
  const { createClient } = await import('@libsql/client')
  // TEMPO_DATA_DIR exists so `node --test` can point at a throwaway directory
  // instead of the database that drives real invoices. Unset in normal use.
  const DATA_DIR = process.env.TEMPO_DATA_DIR || path.join(__dirname, '..', 'data')
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const client = createClient({ url: `file:${path.join(DATA_DIR, 'tempo.db')}` })
  const toObjs = (res) =>
    res.rows.map(row => Object.fromEntries(res.columns.map((c, i) => [c, row[i]])))
  backend = {
    async query(conn, sql, args) {
      return toObjs(await (conn || client).execute({ sql, args }))
    },
    async withTx(fn) {
      const tx = await client.transaction('write')
      try {
        const result = await fn(tx)
        await tx.commit()
        return result
      } finally {
        tx.close()
      }
    },
    async init() {
      await client.executeMultiple(SCHEMA_SQLITE)
      for (const [table, col, ddl] of ADD_COLUMNS) {
        const info = toObjs(await client.execute(`PRAGMA table_info(${table})`))
        if (info.some(c => c.name === col)) continue
        await client.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`)
      }
    },
    close: () => client.close(),
  }
} else {
  backend = unconfigured('No database configured. Set DATABASE_URL (Supabase → Connect → Connection string, transaction pooler) in the Vercel project settings — see README.')
}

/* conn is an open transaction handle, or null/undefined for the pool. */
export const q = (conn, sql, args = []) => backend.query(conn, sql, args)
export const q1 = async (conn, sql, args = []) => (await backend.query(conn, sql, args))[0]
export const withTx = (fn) => backend.withTx(fn)

// Releases the driver's handles so a short-lived process — the test runner —
// can exit instead of idling on an open connection. Not used by the server,
// which is meant to hold its pool open.
export const closeDb = async () => { await backend.close?.() }

// Supabase pauses free-tier projects after a stretch of inactivity, and a
// paused project fails at connect time with a network-level error.
const PAUSED_HINTS = ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'Tenant or user not found']

function unreachableMessage(err) {
  const detail = err.message || String(err)
  if (!PAUSED_HINTS.some(hint => detail.includes(hint))) {
    return `Database setup failed: ${detail}`
  }
  return `Can\u2019t reach the database (${detail}). Supabase pauses free-tier projects ` +
    'after a stretch of inactivity \u2014 open the project in the Supabase dashboard, click ' +
    'Restore, wait for it to report healthy, then reload.'
}

// Schema creation runs once per process. When it fails, every /api request
// answers 503 with the reason rather than the process dying on an opaque
// invocation failure. Clearing the promise lets a later request retry, so a
// restored database recovers without waiting for the instance to recycle.
let initPromise = null

export function ensureReady() {
  if (!initPromise) {
    initPromise = backend.init().catch((err) => {
      initPromise = null
      throw new Error(unreachableMessage(err))
    })
  }
  return initPromise
}

// Entry points await this at boot to warm the connection. It never rejects: a
// database that is down should make requests explain themselves, not stop the
// server from starting at all.
export const ready = ensureReady().catch(() => {})
