import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 4173,
    strictPort: true,
    // DEV-ONLY: bind to all interfaces so a phone on the same LAN can reach the
    // dev server at http://<laptop-LAN-IP>:4173. Does not affect production builds.
    host: true,
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
      },
    },
  },
})