// Shared HTTP helpers. These lived in app.js; they moved here so auth.js,
// gate.js, and the route modules can use them without importing app.js and
// creating a cycle. Behaviour is unchanged.

export function httpError(code, message) {
  const e = new Error(message)
  e.status = code
  return e
}

// Express 4 doesn't catch async errors — every handler goes through this.
export const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
