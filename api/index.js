// Vercel serverless entry — all /api/* requests are rewritten here
// (see vercel.json) and handled by the same Express app used locally.
import app, { ready } from '../server/app.js'

export default async function handler(req, res) {
  await ready
  return app(req, res)
}
