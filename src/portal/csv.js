/* The export and the on-screen table are two renderings of one array.
   Both go through here, so their row counts cannot disagree — which is what
   makes "the CSV matches what I'm looking at" a property rather than a hope.
   Pure: no DOM, no fetch, so it can be tested under node --test directly. */

export const CSV_HEADER = ['Date', 'Hours', 'Projects', 'Notes']

export const sessionHours = (session) => (session.duration_minutes / 60).toFixed(2)

export const projectNames = (session) =>
  session.projects.length ? session.projects.map(p => p.name).join('; ') : '(untagged)'

// Untagged sessions are shown rather than hidden. Dropping them would make the
// portal's total disagree with the invoice, which is worse than a blank row.
export const sessionNotes = (session) =>
  session.projects.map(p => p.summary).filter(Boolean).join(' · ')

export const csvRow = (session) =>
  [session.date, sessionHours(session), projectNames(session), sessionNotes(session)]

export const csvRows = (sessions) => [CSV_HEADER, ...sessions.map(csvRow)]

export const totalHours = (sessions) =>
  (sessions.reduce((a, s) => a + s.duration_minutes, 0) / 60).toFixed(2)
