import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { taskmoorArtefact } from './build/artefact';
import { contentSecurityPolicy } from './build/csp';

// Where /api goes during development and in the e2e preview; the built app calls its own
// origin, which the backend's web role or a reverse proxy serves (ADR-021, ADR-032).
const apiProxy = process.env.VITE_API_PROXY ?? 'http://127.0.0.1:8080';
// WebSockets too: the sync engine's socket (M1-032) and co-editing over /api/v1/collab (M1-017).
const proxy = { '/api': { target: apiProxy, changeOrigin: false, ws: true } };

/**
 * The fonts' licence ships beside them in the build (T-262): SIL OFL 1.1 asks that every copy of
 * the font carries its copyright and licence, and every install carries a copy of the build.
 */
const fontLicence: Plugin = {
  name: 'taskmoor-font-licence',
  apply: 'build',
  generateBundle() {
    this.emitFile({
      type: 'asset',
      fileName: 'assets/OFL.txt',
      source: readFileSync(new URL('./src/fonts/OFL.txt', import.meta.url)),
    });
  },
};

export default defineConfig({
  // The build is the versioned artefact the backend image ships (M1-105, ADR-066).
  plugins: [
    react(),
    fontLicence,
    taskmoorArtefact({ root: fileURLToPath(new URL('../../', import.meta.url)) }),
  ],
  // Relative asset URLs, so the built frontend works from any folder on any web host.
  base: './',
  // The canvas and the illustration (under 10 KB each) go inside the stylesheet, so the
  // single-file kit, which inlines only the script and the stylesheet, keeps them; so does Google's
  // G, inside the script. Fonts stay files (T-262): a browser fetches a face only for text that
  // uses it, so only pages with Google's button load Google Sans. The single-file kit puts them
  // into its page itself (builder-core).
  build: {
    assetsInlineLimit: (file, content) => !file.endsWith('.woff2') && content.length < 32 * 1024,
  },
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
