/* Decides whether a new signature means the page should refresh.

   Split out of usePulse because this is where the interesting mistake lives
   and a React hook needing a DOM cannot be tested under node --test. The
   mistake, for the record: taking the baseline on the first poll rather than
   at mount meant anything that changed between the page's data load and that
   first poll was absorbed into the baseline and never reported — which is
   every change that lands while a tab sits in the background. */

export function pulseTracker() {
  let signature = null
  let primed = false

  return {
    // compare:false seeds the baseline — used once, at mount, alongside the
    // page's own first load. compare:true is every poll after that.
    observe(next, { compare } = { compare: true }) {
      if (next == null) return false
      const changed = compare && primed && next !== signature
      signature = next
      primed = true
      return changed
    },
    get baseline() { return signature },
  }
}
