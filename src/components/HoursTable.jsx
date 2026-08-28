import { hoursColumns, hoursShape, hoursRow } from '../portal/csv.js'
import { fmtDuration, fmtMoney } from '../time.js'

/* Driven by the same hoursColumns() the CSV and the spreadsheet use, so the
   columns on screen and the columns in the file are the same decision made
   once. A client comparing the two should never find a column in one that
   isn't in the other.

   Hours read as "2h 30m" here and 2.50 in a file: a person scanning a screen
   and a spreadsheet doing arithmetic want different things from the same
   number. The row count is what has to match, and does. */

export default function HoursTable({ sessions }) {
  const columns = hoursColumns(hoursShape(sessions))

  const cell = (session, row, col) => {
    if (col.key === 'hours') return fmtDuration(session.duration_minutes)
    // A blank amount means no rate was ever applied to that session. An em
    // dash says "not priced"; 0.00 would say "worth nothing".
    if (col.type === 'money') return row[col.key] == null ? '—' : fmtMoney(row[col.key])
    return row[col.key]
  }

  return (
    <table className="portal-table">
      <thead>
        <tr>{columns.map(c => <th key={c.key}>{c.label}</th>)}</tr>
      </thead>
      <tbody>
        {sessions.map(s => {
          const row = hoursRow(s)
          return (
            <tr key={s.id}>
              {columns.map(c => (
                <td key={c.key}
                  className={c.type === 'text' ? (c.key === 'notes' ? 'portal-dim' : '') : 'mono'}>
                  {cell(s, row, c)}
                </td>
              ))}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
