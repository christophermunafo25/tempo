import app, { ready } from './app.js'

await ready
const PORT = 3001
app.listen(PORT, () => console.log(`tempo api on :${PORT}`))
