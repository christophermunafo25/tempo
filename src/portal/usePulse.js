import { useEffect, useRef } from 'react'
import { pulseTracker } from './pulse-tracker.js'

/* Polls a tiny signature endpoint and calls back when it moves.

   Polling rather than SSE or websockets because of where this runs: Vercel's
   serverless functions don't support websockets at all, and an SSE connection
   holds a function open for its whole life, billed and capped. Polling a single
   aggregate row is the cheap, boring option that actually works here.

   Two things keep an idle tab from costing anything: it stops entirely while
   the tab is hidden, and it fetches a signature rather than the payload, so a
   day with no new work is one small query every interval and nothing else. */

const DEFAULT_INTERVAL = 20000

export function usePulse(fetchSignature, onChange, { interval = DEFAULT_INTERVAL } = {}) {
  // Held in refs so a caller passing inline functions — which is every caller —
  // doesn't restart the timer on every render.
  const fetchRef = useRef(fetchSignature)
  const changeRef = useRef(onChange)
  fetchRef.current = fetchSignature
  changeRef.current = onChange

  useEffect(() => {
    const tracker = pulseTracker()
    let timer = null
    let stopped = false

    const poll = async ({ compare }) => {
      if (stopped) return
      try {
        const next = await fetchRef.current()
        if (stopped) return
        if (tracker.observe(next, { compare })) changeRef.current()
      } catch {
        // A failed poll is not worth surfacing. The next one either succeeds or
        // the page's own fetches report the real problem.
      }
    }

    // The baseline is taken at mount, alongside the page's own first load, and
    // regardless of visibility. Waiting for the first tick to establish it
    // meant anything that changed in between was absorbed into the baseline
    // and never reported — including everything that happened while a tab sat
    // in the background.
    poll({ compare: false })

    const start = () => {
      if (!timer) timer = setInterval(() => poll({ compare: true }), interval)
    }
    const stop = () => {
      clearInterval(timer)
      timer = null
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        // Compare against the baseline from before the tab was hidden, so work
        // that landed in the meantime is caught the moment it comes back
        // rather than after another whole interval.
        poll({ compare: true })
        start()
      } else {
        stop()
      }
    }

    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      stopped = true
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [interval])
}
