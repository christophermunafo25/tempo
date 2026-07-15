export const DAY_MS = 86400000

export const STATUSES = [
  { key: 'in_queue', label: 'In Queue', tone: 'neutral' },
  { key: 'on_deck', label: 'On Deck', tone: 'neutral' },
  { key: 'in_progress', label: 'In Progress', tone: 'blue' },
  { key: 'questions', label: 'Questions or Concerns', short: 'Questions', tone: 'amber' },
  { key: 'sent_for_review', label: 'Sent for Review', tone: 'violet' },
  { key: 'complete', label: 'Complete', tone: 'green' },
]
export const statusMeta = (key) => STATUSES.find(s => s.key === key) || STATUSES[0]

export const CLIENT_COLORS = [
  '#9C8AD6', '#6B93C4', '#D9A13B', '#8FAE7E',
  '#D98873', '#5FA8A0', '#C77D9E', '#A5A06B',
]

/* All timestamps are stored UTC; everything below renders/derives local. */

export function weekStart(d = new Date()) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  const day = (x.getDay() + 6) % 7 // Monday = 0
  x.setDate(x.getDate() - day)
  return x
}

export function addDays(d, n) {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

export function weekRange(offset = 0) {
  const from = addDays(weekStart(), offset * 7)
  return { from, to: addDays(from, 7) }
}

export const localDayKey = (iso) => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export const fmtTime = (iso) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

export const fmtDate = (d) =>
  new Date(d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })

export const fmtDateShort = (d) =>
  new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric' })

export const fmtRange = ({ from, to }) =>
  `${fmtDateShort(from)} – ${fmtDateShort(addDays(to, -1))}`

export const fmtHours = (mins, digits = 1) => (mins / 60).toFixed(digits)

export function fmtDuration(mins) {
  const total = Math.round(mins)
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h === 0) return `${m}m`
  return `${h}h ${String(m).padStart(2, '0')}m`
}

export function clockParts(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return [String(h).padStart(2, '0'), String(m).padStart(2, '0'), String(s).padStart(2, '0')]
}

/* Tolerant time-of-day parser for typed input.
   Accepts "2:30 PM", "2:30pm", "14:30", "230pm", "1430", "9", "9 am"… */
export function parseTimeText(text) {
  const t = String(text).trim().toLowerCase().replace(/\./g, '')
  const m = t.match(/^(\d{1,2})(?::?([0-5]\d))?\s*(am|pm|a|p)?$/)
  if (!m) return null
  let h = parseInt(m[1], 10)
  const min = m[2] ? parseInt(m[2], 10) : 0
  const ap = m[3]
  if (ap) {
    if (h < 1 || h > 12) return null
    if (ap.startsWith('p') && h !== 12) h += 12
    if (ap.startsWith('a') && h === 12) h = 0
  } else if (h > 23) return null
  return { h, m: min }
}

/* Same calendar day as `date`, with the given time of day. */
export function withTimeOf(date, h, m) {
  const d = new Date(date)
  d.setHours(h, m, 0, 0)
  return d
}

/* datetime-local <-> Date */
export function toLocalInput(date) {
  const d = new Date(date)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
export const fromLocalInput = (val) => new Date(val)

export const fmtMoney = (n) =>
  '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export const EXPENSE_CADENCES = [
  { key: 'monthly', label: 'Monthly', suffix: '/mo' },
  { key: 'quarterly', label: 'Quarterly', suffix: '/qtr' },
  { key: 'annually', label: 'Annually', suffix: '/yr' },
  { key: 'fixed', label: 'One-time', suffix: 'once' },
]
export const cadenceMeta = (key) => EXPENSE_CADENCES.find(c => c.key === key) || EXPENSE_CADENCES[0]

/* Normalized views of an expense. One-time costs stay out of the recurring
   monthly number; they join the annual overview as a single hit. */
export const monthlyOf = (e) =>
  e.cadence === 'monthly' ? e.amount
    : e.cadence === 'quarterly' ? e.amount / 3
    : e.cadence === 'annually' ? e.amount / 12
    : 0
export const annualOf = (e) => e.cadence === 'fixed' ? e.amount : monthlyOf(e) * 12

export function downloadCSV(filename, rows) {
  const esc = (v) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const text = rows.map(r => r.map(esc).join(',')).join('\n')
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}
