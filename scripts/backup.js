import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = path.join(root, 'data', 'tempo.db')
const destDir = path.join(root, 'data', 'backups')

if (!fs.existsSync(src)) {
  console.error('No database found at data/tempo.db — nothing to back up.')
  process.exit(1)
}
fs.mkdirSync(destDir, { recursive: true })
const stamp = new Date().toISOString().slice(0, 10)
const dest = path.join(destDir, `tempo-${stamp}.db`)

// SQLite online backup — safe while the server is running (WAL included).
const db = new Database(src, { readonly: true })
await db.backup(dest)
db.close()
console.log(`Backed up to ${path.relative(root, dest)}`)
