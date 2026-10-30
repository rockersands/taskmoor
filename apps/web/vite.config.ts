import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { taskmoorArtefact } from './build/artefact';
import { contentSecurityPolicy } from './build/csp';

// Where /api goes during development and in the e2e preview; the built app calls its own
// origin, which the backend's web role or a reverse proxy serves (ADR-021, ADR-032).
const apiProxy = process.env.VITE_API_PROXY ?? 'http://127.0.0.1:8080';
// WebSockets too: the sync engine's socket (M1-032) and co-editing over /api/v1/collab (M1-017).
const proxy = { '/api': { target: apiProxy, changeOrigin: false, ws: true } };

export default defineConfig({
  // The build is the versioned artefact the backend image ships (M1-105, ADR-066).
  plugins: [react(), taskmoorArtefact({ root: fileURLToPath(new URL('../../', import.meta.url)) })],
  // Relative asset URLs, so the built frontend works from any folder on any web host.
  base: './',
  server: { port: 5173, proxy },
  // The preview sends the app's content security policy (M1-107), so the end-to-end suite
  // runs under it; the attachments previews also load files from the fake S3 bucket (8793).
  preview: {
    port: 4173,
    strictPort: true,
    proxy,
    headers: {
      'Content-Security-Policy': contentSecurityPolicy({
        mediaOrigins: ['http://127.0.0.1:8793'],
        header: true,
      }),
    },
  },
});
