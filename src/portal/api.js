// Thin wrapper over the shared fetch helper. Everything a client session can
// reach lives under /api/portal, so the prefix is baked in here rather than
// written out at each call site — there is no way to accidentally address an
// owner route from a portal screen.

import { api } from '../api.js'

export const pget = (path) => api(`/portal${path}`)
export const ppost = (path, body) => api(`/portal${path}`, { method: 'POST', body })
