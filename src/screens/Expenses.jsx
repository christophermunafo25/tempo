import { useEffect, useMemo, useState } from 'react'
import { BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { get, post, patch, del } from '../api.js'
import {
  CLIENT_COLORS, EXPENSE_CADENCES, cadenceMeta, fmtMoney, monthlyOf, annualOf,
} from '../time.js'
import { Modal, EmptyState } from '../components/ui.jsx'

const MONO = 'Fragment Mono, monospace'

function useThemeColors() {
  const [theme, setTheme] = useState(document.documentElement.dataset.theme || 'light')
  useEffect(() => {
    const obs = new MutationObserver(() =>
      setTheme(document.documentElement.dataset.theme || 'light'))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])
  const dark = theme === 'dark'
  return {
    grid: dark ? 'rgba(247,246,245,0.08)' : 'rgba(35,31,35,0.08)',
    tick: dark ? 'rgba(247,246,245,0.48)' : 'rgba(35,31,35,0.48)',
  }
}

function MoneyTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div className="tooltip">
      <div className="t-title">{label}</div>
      <div className="t-row">
        <span>{payload[0].name}</span>
        <span className="t-val">{fmtMoney(payload[0].value)}</span>
      </div>
    </div>
  )
}

export default function Expenses() {
  const [expenses, setExpenses] = useState([])
  const [view, setView] = useState('monthly')
  const [modal, setModal] = useState(null)          // 'new' | expense object
  const [confirmingId, setConfirmingId] = useState(null)
  const colors = useThemeColors()

  const refresh = () => get('/expenses').then(setExpenses)
  useEffect(() => { refresh() }, [])

  const recurring = expenses.filter(e => e.cadence !== 'fixed')
  const oneTime = expenses.filter(e => e.cadence === 'fixed')
  const monthlyTotal = recurring.reduce((a, e) => a + monthlyOf(e), 0)
  const annualRecurring = monthlyTotal * 12
  const oneTimeTotal = oneTime.reduce((a, e) => a + e.amount, 0)

  const chartData = useMemo(() => {
    const rows = (view === 'monthly' ? recurring : expenses)
      .map(e => ({ name: e.name, value: view === 'monthly' ? monthlyOf(e) : annualOf(e) }))
      .filter(r => r.value > 0)
      .sort((a, b) => b.value - a.value)
    return rows
  }, [expenses, view])                              // eslint-disable-line react-hooks/exhaustive-deps

  const remove = async (e) => {
    await del(`/expenses/${e.id}`)
    setConfirmingId(null)
    refresh()
  }

  const axisTick = { fill: colors.tick, fontSize: 11, fontFamily: MONO }

  return (
    <div className="screen">
      <h1 className="screen-title rise">Expenses</h1>

      <div className="filterbar rise" style={{ '--i': 1 }}>
        <div className="seg">
          {['monthly', 'annual'].map(v => (
            <button key={v} className={`seg-btn${view === v ? ' active' : ''}`}
              onClick={() => setView(v)}>{v === 'monthly' ? 'Monthly' : 'Annual'}</button>
          ))}
        </div>
        <span className="spacer" />
        <button className="btn" onClick={() => setModal('new')}>+ Add expense</button>
      </div>

      <div className="stats-row rise" style={{ '--i': 2 }}>
        <div className="card stat">
          <span className="label">{view === 'monthly' ? 'Monthly spend' : 'Annual spend'}</span>
          <span className="val">{fmtMoney(view === 'monthly' ? monthlyTotal : annualRecurring)}</span>
        </div>
        <div className="card stat">
          <span className="label">Recurring expenses</span>
          <span className="val">{recurring.length}</span>
        </div>
        <div className="card stat">
          <span className="label">One-time costs</span>
          <span className="val">{fmtMoney(oneTimeTotal)}</span>
        </div>
        <div className="card stat">
          <span className="label">{view === 'monthly' ? 'Annualized' : 'Total incl. one-time'}</span>
          <span className="val">{fmtMoney(view === 'monthly' ? annualRecurring : annualRecurring + oneTimeTotal)}</span>
        </div>
      </div>

      {chartData.length > 0 && (
        <div className="card chart-card rise" style={{ '--i': 3 }}>
          <span className="label">{view === 'monthly' ? 'Where the month goes' : 'Where the year goes'}</span>
          <ResponsiveContainer width="100%" height={Math.max(120, chartData.length * 44)}>
            <BarChart data={chartData} layout="vertical" barSize={16}
              margin={{ top: 0, right: 56, left: 8, bottom: 0 }}>
              <CartesianGrid horizontal={false} stroke={colors.grid} />
              <XAxis type="number" tickLine={false} axisLine={false} tick={axisTick}
                tickFormatter={v => `$${v >= 1000 ? `${Math.round(v / 100) / 10}k` : v}`} />
              <YAxis type="category" dataKey="name" tickLine={false} axisLine={false}
                tick={{ ...axisTick, fontSize: 12 }} width={140} />
              <Tooltip content={<MoneyTooltip />} cursor={{ fill: colors.grid }} />
              <Bar dataKey="value" name={view === 'monthly' ? 'Per month' : 'Per year'} radius={[0, 4, 4, 0]}>
                {chartData.map((r, i) => (
                  <Cell key={r.name} fill={CLIENT_COLORS[i % CLIENT_COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="card rise" style={{ '--i': 4 }}>
        {expenses.length === 0 ? (
          <EmptyState action={<button className="btn" onClick={() => setModal('new')}>Add your first expense</button>}>
            No expenses tracked yet. Add subscriptions and one-time costs to see where the money goes.
          </EmptyState>
        ) : (
          <div className="ts-table">
            <div className="exp-row head">
              <span>Expense</span><span>Cadence</span><span>Amount</span>
              <span>{view === 'monthly' ? 'Per month' : 'Per year'}</span><span />
            </div>
            {expenses.map(e => {
              const normalized = view === 'monthly' ? monthlyOf(e) : annualOf(e)
              return (
                <div className="exp-row" key={e.id}>
                  <span className="who">{e.name}</span>
                  <span><span className="pill neutral">{cadenceMeta(e.cadence).label}</span></span>
                  <span className="num">{fmtMoney(e.amount)} <span style={{ color: 'var(--text-4)' }}>{cadenceMeta(e.cadence).suffix}</span></span>
                  <span className="num">
                    {e.cadence === 'fixed' && view === 'monthly'
                      ? <span style={{ color: 'var(--text-4)' }}>—</span>
                      : fmtMoney(normalized)}
                  </span>
                  <span style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', alignItems: 'center' }}>
                    {confirmingId === e.id ? (
                      <>
                        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>Delete?</span>
                        <button className="btn btn-danger btn-sm" onClick={() => remove(e)}>Yes</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => setConfirmingId(null)}>No</button>
                      </>
                    ) : (
                      <>
                        <button className="st-ctl" style={{ textTransform: 'none', letterSpacing: 0 }}
                          onClick={() => setModal(e)}>edit</button>
                        <button className="st-ctl del" aria-label={`Delete ${e.name}`}
                          onClick={() => setConfirmingId(e.id)}>✕</button>
                      </>
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {modal && (
        <ExpenseModal
          expense={modal === 'new' ? null : modal}
          onSaved={() => { setModal(null); refresh() }}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  )
}

function ExpenseModal({ expense, onSaved, onClose }) {
  const [name, setName] = useState(expense?.name || '')
  const [cadence, setCadence] = useState(expense?.cadence || 'monthly')
  const [amount, setAmount] = useState(expense != null ? String(expense.amount) : '')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const valid = name.trim() && Number(amount) >= 0 && amount !== ''

  const save = async () => {
    if (!valid || saving) return
    setSaving(true)
    setError('')
    try {
      const body = { name, cadence, amount: Number(amount) }
      if (expense) await patch(`/expenses/${expense.id}`, body)
      else await post('/expenses', body)
      onSaved()
    } catch (e) {
      setError(e.message)
      setSaving(false)
    }
  }

  return (
    <Modal title={expense ? 'Edit expense' : 'Add expense'} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div className="field">
          <span className="label">Name</span>
          <input className="input" autoFocus value={name} placeholder="e.g. Figma, Adobe CC, hosting"
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') save() }} />
        </div>
        <div className="field">
          <span className="label">Billing cadence</span>
          <div className="seg" role="radiogroup" aria-label="Billing cadence">
            {EXPENSE_CADENCES.map(c => (
              <button key={c.key} role="radio" aria-checked={cadence === c.key}
                className={`seg-btn${cadence === c.key ? ' active' : ''}`}
                onClick={() => setCadence(c.key)}>
                {c.label}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="label">Amount (USD)</span>
          <input className="input" type="number" min="0" step="0.01" value={amount}
            placeholder="0.00"
            onChange={e => setAmount(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') save() }} />
        </div>
      </div>
      {error && <div className="field-error" style={{ marginTop: 16, fontSize: 13 }}>{error}</div>}
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={!valid || saving}>
          {saving ? 'Saving…' : expense ? 'Save changes' : 'Add expense'}
        </button>
      </div>
    </Modal>
  )
}
