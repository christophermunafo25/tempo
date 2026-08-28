/* The one row builder behind the table, the CSV, and the spreadsheet.

   Rows are typed: hours, rate and amount come out as numbers and the date as a
   plain YYYY-MM-DD string, so a spreadsheet can write them as real values that
   filter and sort as numbers and dates. The CSV stringifies the same rows.
   Three renderings of one array is what makes "the export matches what I'm
   looking at" a property rather than a hope.

   Pure: no DOM, no fetch, so it can be tested under node --test directly. */

export const projectNames = (session) =>
  session.projects.length ? session.projects.map(p => p.name).join('; ') : '(untagged)'

// Untagged sessions are shown rather than hidden. Dropping them would make the
// total disagree with the invoice, which is worse than a blank cell.
export const sessionNotes = (session) =>
  session.projects.map(p => p.summary).filter(Boolean).join(' · ')

export const sessionHours = (session) => (session.duration_minutes / 60).toFixed(2)

export const hoursRow = (session) => ({
  date: session.date,
  hours: session.duration_minutes / 60,
  // null, never 0. A session published before rates existed has no amount;
  // zero would be a claim about what it was worth.
  rate: session.rate ?? null,
  amount: session.amount_cents == null ? null : session.amount_cents / 100,
  projects: projectNames(session),
  notes: sessionNotes(session),
})

/* Which columns this particular set of rows carries. Both are server
   decisions: money is omitted entirely when a company has rates switched off,
   and notes are omitted by a share link created without them. Reading the
   shape off the data means no caller has to be told twice. */
export function hoursShape(sessions) {
  return {
    money: sessions.some(s => 'amount_cents' in s),
    notes: sessions.some(s => s.projects.some(p => 'summary' in p)),
  }
}

export function hoursColumns(shape) {
  return [
    { key: 'date', label: 'Date', type: 'date' },
    { key: 'hours', label: 'Hours', type: 'number' },
    ...(shape.money ? [
      { key: 'rate', label: 'Rate', type: 'money' },
      { key: 'amount', label: 'Amount', type: 'money' },
    ] : []),
    { key: 'projects', label: 'Projects', type: 'text' },
    ...(shape.notes ? [{ key: 'notes', label: 'Notes', type: 'text' }] : []),
  ]
}

const asText = (value, type) => {
  if (value == null) return ''
  if (type === 'number' || type === 'money') return value.toFixed(2)
  return String(value)
}

export function csvRows(sessions) {
  const columns = hoursColumns(hoursShape(sessions))
  return [
    columns.map(c => c.label),
    ...sessions.map(s => {
      const row = hoursRow(s)
      return columns.map(c => asText(row[c.key], c.type))
    }),
  ]
}

export const totalHours = (sessions) =>
  (sessions.reduce((a, s) => a + s.duration_minutes, 0) / 60).toFixed(2)

// Summed from the cents the server already rounded per row, so the figure
// under a table is the sum of the rows in it and not a re-derivation.
export const totalAmount = (sessions) =>
  sessions.reduce((a, s) => a + (s.amount_cents || 0), 0) / 100

export const hasMoney = (sessions) => hoursShape(sessions).money
