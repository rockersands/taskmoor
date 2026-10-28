import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Where /api goes during development and in the e2e preview; the built app calls its own
// origin, which the backend's web role or a reverse proxy serves (ADR-021, ADR-032).
const apiProxy = process.env.VITE_API_PROXY ?? 'http://127.0.0.1:8080';
// WebSockets too: the sync engine's socket (M1-032) and co-editing over /api/v1/collab (M1-017).
const proxy = { '/api': { target: apiProxy, changeOrigin: false, ws: true } };

export default defineConfig({
  plugins: [react()],
  // Relative asset URLs, so the built frontend works from any folder on any web host.
  base: './',
  server: { port: 5173, proxy },
  preview: { port: 4173, strictPort: true, proxy },
});
