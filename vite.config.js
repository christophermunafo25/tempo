import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // changeOrigin must stay false: the API's CSRF guard compares the Origin
    // header against Host, and rewriting Host to the target port makes every
    // same-origin POST from the dev server look cross-site.
    proxy: { '/api': { target: 'http://localhost:3001', changeOrigin: false } },
  },
})
