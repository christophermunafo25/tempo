import { hoursColumns, hoursShape, hoursRow, totalAmount } from './csv.js'
import { buildWorkbook } from './xlsx.js'

/* Assembles the spreadsheet from the same row builder the table and the CSV
   use. Nothing here decides what a column is or whether money appears — that
   is read off the data, which is what keeps three renderings in step. */

const slug = (s) => String(s || 'hours').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()

export const workbookFilename = (company, from, to) =>
  `tempo-hours-${slug(company)}-${from || 'all'}-to-${to || 'all'}.xlsx`

export function hoursWorkbook({ sessions, company, from, to, timeZone, breakdown, generatedAt }) {
  const shape = hoursShape(sessions)
  const columns = hoursColumns(shape)
  const rows = sessions.map(hoursRow)

  const totalHours = sessions.reduce((a, s) => a + s.duration_minutes, 0) / 60
  const stamp = (generatedAt || new Date()).toISOString().replace('T', ' ').slice(0, 16)

  const summary = [
    [{ v: 'TEMPO — hours export', bold: true }],
    [],
    [{ v: 'Company' }, { v: company || '' }],
    [{ v: 'Range' }, { v: from || to ? `${from || 'start'} to ${to || 'today'}` : 'All time' }],
    [{ v: 'Generated' }, { v: `${stamp} UTC` }],
    [{ v: 'Dates shown in' }, { v: timeZone || 'UTC' }],
    [],
    [{ v: 'Total hours' }, { v: totalHours, type: 'number', bold: true }],
    ...(shape.money ? [[{ v: 'Total amount' }, { v: totalAmount(sessions), type: 'money', bold: true }]] : []),
    [{ v: 'Sessions' }, { v: sessions.length, type: 'number' }],
    [],
  ]

  if (breakdown?.length) {
    summary.push(
      [{ v: 'By project — estimate', bold: true }],
      // The caveat travels with the file. A spreadsheet outlives the screen it
      // came from, and by then nobody remembers that these figures are derived.
      [{ v: 'Hours are clocked per company, not per project. Each session is split' }],
      [{ v: 'evenly across the projects worked on in it, so these are estimates.' }],
      [],
      [{ v: 'Project', bold: true }, { v: 'Hours', bold: true },
        ...(shape.money ? [{ v: 'Amount', bold: true }] : [])],
      ...breakdown.map(p => [
        { v: p.name },
        { v: p.minutes / 60, type: 'number' },
        ...(shape.money ? [{ v: (p.amount_cents || 0) / 100, type: 'money' }] : []),
      ]),
    )
  }

  summary.push(
    [],
    [{ v: 'Only work that has been published is included.' }],
  )

  return buildWorkbook({ columns, rows, summary })
}
