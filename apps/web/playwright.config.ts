import { randomBytes } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';

// The directory test's passwords (M1-082), made per run and handed to the API server and the
// tests through the environment, so none is written in the repository. Workers load this file
// again and keep the values they inherited.
process.env.TASKMOOR_E2E_LDAP_BIND_PASSWORD ??= `bind-${randomBytes(18).toString('base64url')}`;
process.env.TASKMOOR_E2E_LDAP_USER_PASSWORD ??= `user-${randomBytes(18).toString('base64url')}`;

const PORT = 4173;
const API_PORT = 8787;
const vite = 'node node_modules/vite/bin/vite.js';
const tsx = 'node ../../node_modules/tsx/dist/cli.mjs';

/**
 * End-to-end tests run against the production build, served the way a static host would, with
 * the real backend (embedded Postgres, fixed setup token) behind the preview's /api proxy.
 * Desktop is the primary target; the mobile project keeps phones working.
 */
export default defineConfig({
  testDir: './e2e',
  outputDir: '../../.verify/e2e-results',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: 'line',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    {
      command: `${tsx} e2e/api-server.ts`,
      url: `http://127.0.0.1:${API_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: `${vite} build --logLevel warn && ${vite} preview`,
      url: `http://localhost:${PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { VITE_API_PROXY: `http://127.0.0.1:${API_PORT}` },
    },
  ],
});
