// The refresh decision, in isolation. This is where the bug was: the baseline
// used to be taken on the first poll instead of at mount, so a change landing
// between the page's data load and that first poll was silently absorbed.

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { pulseTracker } = await import('../src/portal/pulse-tracker.js')

test('seeding the baseline never reports a change', () => {
  const t = pulseTracker()
  assert.equal(t.observe('1:1:100:0', { compare: false }), false)
  assert.equal(t.baseline, '1:1:100:0')
})

test('a change after the baseline is reported once', () => {
  const t = pulseTracker()
  t.observe('1:1:100:0', { compare: false })
  assert.equal(t.observe('2:2:300:145', { compare: true }), true)
  assert.equal(t.observe('2:2:300:145', { compare: true }), false, 'and not again')
})

test('an unchanged signature is never a refresh', () => {
  const t = pulseTracker()
  t.observe('1:1:100:0', { compare: false })
  for (let i = 0; i < 5; i++) {
    assert.equal(t.observe('1:1:100:0', { compare: true }), false)
  }
})

// The regression, stated as the sequence that produced it: page mounts and
// seeds, work is clocked out while the tab is hidden, the tab comes back.
test('a change that lands while the tab is hidden is caught when it returns', () => {
  const t = pulseTracker()
  t.observe('1:1:120:145', { compare: false })   // mount, tab hidden
  // …polling is stopped throughout, so nothing is observed in between…
  assert.equal(t.observe('2:2:300:290', { compare: true }), true,
    'the comparison is against the state at load, not at first poll')
})

test('a failed poll neither fires nor disturbs the baseline', () => {
  const t = pulseTracker()
  t.observe('1:1:100:0', { compare: false })
  assert.equal(t.observe(null, { compare: true }), false)
  assert.equal(t.observe(undefined, { compare: true }), false)
  assert.equal(t.baseline, '1:1:100:0', 'a dropped poll leaves the baseline alone')
  assert.equal(t.observe('2:2:200:0', { compare: true }), true, 'and the next real one still fires')
})

test('comparing defaults on, so a caller cannot silently seed forever', () => {
  const t = pulseTracker()
  t.observe('a')
  assert.equal(t.observe('b'), true)
})
