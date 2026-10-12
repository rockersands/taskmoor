import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // Relative asset URLs, so the built frontend works from any folder on any web host.
  base: './',
  server: { port: 5173 },
  preview: { port: 4173, strictPort: true },
});
