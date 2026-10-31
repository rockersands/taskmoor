import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { builderPage } from './build/builder-page';

// The Builder page (M1-112, ADR-088): a second entry of the web app, built on its own into one
// self-contained file, apps/web/dist-builder/index.html, that carries the web build of
// apps/web/dist (or TASKMOOR_BUILDER_WEB). `pnpm build` makes it after the app.
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: here('./src/builder'),
  base: './',
  publicDir: false,
  plugins: [react(), builderPage({ webDir: process.env.TASKMOOR_BUILDER_WEB ?? here('./dist') })],
  build: {
    outDir: here('./dist-builder'),
    emptyOutDir: true,
    // One file: every asset inline, one script, one stylesheet.
    assetsInlineLimit: () => true,
    cssCodeSplit: false,
    modulePreload: false,
    chunkSizeWarningLimit: 4096,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  server: { port: 5174 },
  preview: { port: 4183, strictPort: true },
});
