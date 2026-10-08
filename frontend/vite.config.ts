import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { resolveDevServerConfig } from './config/devServer.ts'

// Read the .env files next to this config file rather than the current working
// directory, so `vite` behaves the same however it is invoked.
const envDir = fileURLToPath(new URL('.', import.meta.url))

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const { host, port, strictPort, apiProxyTarget, https } = resolveDevServerConfig(
    loadEnv(mode, envDir, 'VITE_'),
  )

  return {
    plugins: [react()],
    server: {
      // Defaults to loopback (127.0.0.1) so a local dev run is not reachable from
      // the network. Set VITE_DEV_HOST=0.0.0.0 in frontend/.env for LAN mode.
      host,
      port,
      strictPort,
      ...(https ? { https } : {}),
      proxy: {
        // The browser only ever requests the relative path `/api/...`, so requests
        // stay same-origin and the API needs no CORS policy. That holds when the page
        // is loaded from the server PC's LAN address, where `localhost` would mean
        // the phone rather than the server.
        '/api': {
          target: apiProxyTarget,
          changeOrigin: true,
          rewrite: (path) => path,
          // No cookieDomainRewrite: the API sets host-only cookies (no Domain
          // attribute), which is what lets the browser scope them to whichever host
          // it loaded the app from. Rewriting them here would bind the session to the
          // wrong host and log every LAN device out.
        },
      },
    },
  }
})
