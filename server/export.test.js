// Export parity. The table, the CSV and the spreadsheet are three renderings
// of one array, and these read the bytes back out of the generated .xlsx to
// prove it rather than trusting the builder that produced them.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.TEMPO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tempo-export-'))
process.env.PORTAL_BOOTSTRAP_TOKEN = 'bootstrap-secret-for-tests'
process.env.TEMPO_TZ = 'America/Chicago'
delete process.env.DATABASE_URL
delete process.env.VERCEL

const { default: app, ready } = await import('./app.js')
const { q, q1, closeDb } = await import('./db.js')
const { hashPassword, mintToken, hashToken } = await import('./auth.js')
const { csvRows, hoursColumns, hoursShape } = await import('../src/portal/csv.js')
const { hoursWorkbook, workbookFilename } = await import('../src/portal/workbook.js')
const { dateSerial } = await import('../src/portal/xlsx.js')

await ready
const server = app.listen(0)
await new Promise((r) => server.once('listening', r))
const base = `http://127.0.0.1:${server.address().port}`
after(async () => {
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
  await closeDb()
})

async function call(method, url, { body, cookie } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'Content-Type': 'application/json', Origin: base,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, text }
}

/* ── A minimal reader, so the assertions are about the file and not the
      function that wrote it. Entries are STOREd, so no inflate is needed. ── */

function unzip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const files = {}
  let i = 0
  while (i < bytes.length - 4) {
    if (dv.getUint32(i, true) !== 0x04034b50) { i++; continue }
    const size = dv.getUint32(i + 18, true)
    const nameLen = dv.getUint16(i + 26, true)
    const extraLen = dv.getUint16(i + 28, true)
    const name = new TextDecoder().decode(bytes.subarray(i + 30, i + 30 + nameLen))
    const start = i + 30 + nameLen + extraLen
    files[name] = new TextDecoder().decode(bytes.subarray(start, start + size))
    i = start + size
  }
  return files
}

// Rows of raw cell values, in column order, exactly as a reader would see them.
function sheetRows(xml) {
  return [...xml.matchAll(/<row r="(\d+)">(.*?)<\/row>/g)].map(m => ({
    n: Number(m[1]),
    cells: [...m[2].matchAll(/<c r="[A-Z]+\d+"(?: s="\d+")?(?:\s*\/>|[^>]*>(?:<f>(.*?)<\/f>|<v>(.*?)<\/v>|<is><t[^>]*>(.*?)<\/t><\/is>)?<\/c>)/g)]
      .map(c => c[1] ?? c[2] ?? c[3] ?? ''),
  }))
}

let owner, dana, client, project, shareToken

test('setup: enough sessions, with money and a mixture of rates', async () => {
  await call('POST', '/api/auth/bootstrap', {
    body: { token: 'bootstrap-secret-for-tests', email: 'chris@example.com', password: 'owner-password-long' },
  })
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ email: 'chris@example.com', password: 'owner-password-long' }),
  })
  owner = res.headers.getSetCookie().map(l => l.split(';')[0]).find(p => p.startsWith('tempo_portal='))

  client = (await call('POST', '/api/clients', {
    cookie: owner, body: { name: 'Mercenary Marketing', color_accent: '#6B93C4', weekly_hours_target: 20 },
  })).json
  await q(null,
    'UPDATE clients SET portal_enabled = 1, portal_shows_rates = 1, hourly_rate = 137.77 WHERE id = ?',
    [client.id])
  project = await q1(null,
    'INSERT INTO projects (client_id, name) VALUES (?,?) RETURNING *', [client.id, 'Q3 Rebrand'])

  const awkward = [7, 13, 23, 41, 53, 67, 83, 97]
  for (let i = 0; i < 40; i++) {
    const start = new Date(Date.now() - (i + 1) * 86400000)
    const s = await q1(null, `
      INSERT INTO sessions (client_id, clock_in, clock_out, duration_minutes, is_published, rate_applied)
      VALUES (?,?,?,?,1,?) RETURNING *`,
      [client.id, start.toISOString(),
       new Date(start.getTime() + awkward[i % 8] * 60000).toISOString(),
       awkward[i % 8], i % 7 === 0 ? 120 : 137.77])
    await q(null, `INSERT INTO session_entries (session_id, project_id, summary, status_at_entry)
      VALUES (?,?,?,?)`, [s.id, project.id, `work ${i}`, 'in_progress'])
  }

  const u = await q1(null, `
    INSERT INTO portal_users (client_id, email, password_hash, role, name)
    VALUES (?,?,?,?,?) RETURNING *`,
    [client.id, 'dana@merc.example', await hashPassword('dana-portal-password'), 'client', 'Dana'])
  dana = u
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ email: 'dana@merc.example', password: 'dana-portal-password' }),
  })
  dana.cookie = login.headers.getSetCookie().map(l => l.split(';')[0]).find(p => p.startsWith('tempo_portal='))

  shareToken = mintToken()
  await q(null, 'INSERT INTO portal_share_links (client_id, token_hash, label) VALUES (?,?,?)',
    [client.id, hashToken(shareToken), 'Finance'])
})

/* ── 15. Row-count parity ────────────────────────────────────────────── */

test('the spreadsheet row count equals the on-screen filtered count', async () => {
  const onScreen = await call('GET', '/api/portal/sessions?per_page=100', { cookie: dana.cookie })
  const exported = await call('POST', '/api/portal/export', { cookie: dana.cookie, body: {} })
  assert.equal(exported.json.sessions.length, onScreen.json.total)

  const bytes = hoursWorkbook({ sessions: exported.json.sessions, company: 'Mercenary Marketing' })
  const rows = sheetRows(unzip(bytes)['xl/worksheets/sheet1.xml'])

  // header + one row per session + one totals row
  assert.equal(rows.length, onScreen.json.total + 2)
  const dataRows = rows.slice(1, -1)
  assert.equal(dataRows.length, onScreen.json.total,
    'one spreadsheet row per session the client can see')
  assert.equal(rows[rows.length - 1].cells[0], 'Total')
})

test('a filtered spreadsheet matches the filtered view, not the whole set', async () => {
  const from = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10)
  const url = `/api/portal/sessions?per_page=100&from=${from}`
  const onScreen = await call('GET', url, { cookie: dana.cookie })
  const exported = await call('POST', '/api/portal/export', { cookie: dana.cookie, body: { from } })

  assert.ok(onScreen.json.total < 40, 'the filter actually narrowed it')
  const rows = sheetRows(unzip(hoursWorkbook({ sessions: exported.json.sessions }))['xl/worksheets/sheet1.xml'])
  assert.equal(rows.length - 2, onScreen.json.total)
})

/* ── 16. The CSV and the spreadsheet agree ───────────────────────────── */

test('the CSV and the spreadsheet built from one array carry identical rows', async () => {
  const exported = await call('POST', '/api/portal/export', { cookie: dana.cookie, body: {} })
  const sessions = exported.json.sessions

  const csv = csvRows(sessions)
  const columns = hoursColumns(hoursShape(sessions))
  const sheet = sheetRows(unzip(hoursWorkbook({ sessions }))['xl/worksheets/sheet1.xml'])

  assert.deepEqual(sheet[0].cells, csv[0], 'same headers, same order')
  assert.equal(sheet.length - 2, csv.length - 1, 'same number of data rows')

  for (let i = 0; i < sessions.length; i++) {
    const csvRow = csv[i + 1]
    const xlsxRow = sheet[i + 1].cells
    columns.forEach((col, c) => {
      const text = csvRow[c]
      const raw = xlsxRow[c]
      if (col.type === 'date') {
        // The CSV carries a date string, the spreadsheet a real date value.
        // Same day, expressed the two ways each format can filter on.
        assert.equal(Number(raw), dateSerial(text), `row ${i} date`)
      } else if (col.type === 'number' || col.type === 'money') {
        if (text === '') assert.equal(raw, '', `row ${i} ${col.key} blank both ways`)
        else assert.equal(Number(raw).toFixed(2), text, `row ${i} ${col.key}`)
      } else {
        assert.equal(raw, text.replace(/&amp;/g, '&'), `row ${i} ${col.key}`)
      }
    })
  }
})

test('money reaches the spreadsheet as numbers, and the totals subtotal', async () => {
  const exported = await call('POST', '/api/portal/export', { cookie: dana.cookie, body: {} })
  const files = unzip(hoursWorkbook({ sessions: exported.json.sessions }))
  const xml = files['xl/worksheets/sheet1.xml']
  const rows = sheetRows(xml)

  const columns = hoursColumns(hoursShape(exported.json.sessions))
  assert.deepEqual(columns.map(c => c.key), ['date', 'hours', 'rate', 'amount', 'projects', 'notes'])

  // SUBTOTAL rather than SUM is what makes the total follow the reader's own
  // filter instead of silently reporting the unfiltered set.
  const totals = rows[rows.length - 1].cells
  assert.match(totals[1], /^SUBTOTAL\(109,B2:B\d+\)$/, 'hours subtotal')
  assert.match(totals[3], /^SUBTOTAL\(109,D2:D\d+\)$/, 'amount subtotal')
  assert.equal(totals[2], '', 'rates are not summed — a total rate is meaningless')

  // The subtotal range must stop at the last data row, and the AutoFilter must
  // not cover the totals row, or filtering could hide the total itself.
  const lastData = rows.length - 1
  assert.ok(totals[1].includes(`B2:B${lastData}`))
  assert.match(xml, new RegExp(`<autoFilter ref="A1:F${lastData}"/>`))
})

test('the file is a readable zip with both sheets and a frozen header', async () => {
  const exported = await call('POST', '/api/portal/export', { cookie: dana.cookie, body: {} })
  const files = unzip(hoursWorkbook({
    sessions: exported.json.sessions,
    company: 'Mercenary Marketing',
    from: '2026-08-01', to: '2026-08-31',
    timeZone: 'America/Chicago',
    breakdown: [{ project_id: 1, name: 'Q3 Rebrand', minutes: 300, amount_cents: 68885 }],
  }))

  for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels', 'xl/styles.xml',
    'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']) {
    assert.ok(files[part], `missing ${part}`)
  }
  assert.match(files['xl/workbook.xml'], /name="Hours"/)
  assert.match(files['xl/workbook.xml'], /name="Summary"/)
  assert.match(files['xl/worksheets/sheet1.xml'], /state="frozen"/)

  const summary = files['xl/worksheets/sheet2.xml']
  assert.ok(summary.includes('Mercenary Marketing'))
  assert.ok(summary.includes('America/Chicago'))
  assert.ok(summary.includes('2026-08-01 to 2026-08-31'))
  // The caveat has to travel with the file: a spreadsheet outlives the screen
  // it came from, and by then nobody remembers the figures are derived.
  assert.ok(summary.includes('estimates'))
  assert.ok(summary.includes('Only work that has been published is included.'))
})

test('a no-money company gets a spreadsheet with no money columns', async () => {
  await q(null, 'UPDATE clients SET portal_shows_rates = 0 WHERE id = ?', [client.id])
  const exported = await call('POST', '/api/portal/export', { cookie: dana.cookie, body: {} })
  const rows = sheetRows(unzip(hoursWorkbook({ sessions: exported.json.sessions }))['xl/worksheets/sheet1.xml'])

  assert.deepEqual(rows[0].cells, ['Date', 'Hours', 'Projects', 'Notes'])
  assert.ok(!rows[rows.length - 1].cells.some(c => c.includes('D2')), 'no amount subtotal')
  await q(null, 'UPDATE clients SET portal_shows_rates = 1 WHERE id = ?', [client.id])
})

test('the share surface exports the same rows as the portal', async () => {
  const viaPortal = await call('POST', '/api/portal/export', { cookie: dana.cookie, body: {} })
  const viaShare = await call('GET', `/api/share/${shareToken}/export`)

  assert.equal(viaShare.json.total, viaPortal.json.total)
  const a = sheetRows(unzip(hoursWorkbook({ sessions: viaPortal.json.sessions }))['xl/worksheets/sheet1.xml'])
  const b = sheetRows(unzip(hoursWorkbook({ sessions: viaShare.json.sessions }))['xl/worksheets/sheet1.xml'])
  assert.deepEqual(b.map(r => r.cells), a.map(r => r.cells),
    'one query layer, so both front doors produce the same file')
})

test('the filename names the company and the range', () => {
  assert.equal(workbookFilename('Mercenary Marketing', '2026-08-01', '2026-08-31'),
    'tempo-hours-mercenary-marketing-2026-08-01-to-2026-08-31.xlsx')
  assert.equal(workbookFilename('Mercenary Marketing', '', ''),
    'tempo-hours-mercenary-marketing-all-to-all.xlsx')
})
