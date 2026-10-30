import { randomBytes } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';

// The directory test's passwords (M1-082), made per run and handed to the API server and the
// tests through the environment, so none is written in the repository. Workers load this file
// again and keep the values they inherited.
process.env.TASKMOOR_E2E_LDAP_BIND_PASSWORD ??= `bind-${randomBytes(18).toString('base64url')}`;
process.env.TASKMOOR_E2E_LDAP_USER_PASSWORD ??= `user-${randomBytes(18).toString('base64url')}`;
// The attachments administrator's password (M1-016), made the same way.
process.env.TASKMOOR_E2E_ATTACH_PASSWORD ??= `files-${randomBytes(18).toString('base64url')}`;

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
    // Every supported browser (M1-132; NFR-007), with TASKMOOR_E2E_BROWSERS=all or
    // `pnpm verify --e2e --browsers`: Firefox and Safari (WebKit) on a desktop, then Safari on an
    // iPhone and Chrome on an Android phone, both at the narrowest supported width (360 px).
    // Edge is Chromium, the desktop project.
    ...(process.env.TASKMOOR_E2E_BROWSERS === 'all'
      ? [
          {
            name: 'firefox',
            use: { ...devices['Desktop Firefox'], viewport: { width: 1440, height: 900 } },
          },
          {
            name: 'webkit',
            use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 900 } },
          },
          {
            name: 'iphone',
            use: { ...devices['iPhone 13'], viewport: { width: 360, height: 740 } },
          },
          {
            name: 'narrow',
            use: { ...devices['Pixel 7'], viewport: { width: 360, height: 740 } },
          },
        ]
      : []),
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
    // The backend serving that build itself (M1-105), once with hash routing (4176) and once
    // with clean URLs (4177), for routing.spec.ts.
    {
      command: `${tsx} e2e/web-server.ts`,
      url: 'http://127.0.0.1:4177/health',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    // Attachments (M1-016) on local disk and on S3: the same build, proxied to the two APIs
    // the API server starts on 8791 and 8792. Servers start in order, so the build is there.
    ...[
      [4174, 8791],
      [4175, 8792],
    ].map(([port, api]) => ({
      command: `${vite} preview --port ${port} --strictPort`,
      url: `http://localhost:${port}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { VITE_API_PROXY: `http://127.0.0.1:${api}` },
    })),
    // Frontend kits (M1-111) made from that build and served as a static host would, with /api
    // passed to the attachments backend: the zip kit (4178), the single file (4179) and a kit
    // pinned to another instance (4180).
    {
      command: `${tsx} e2e/kit-server.ts`,
      url: 'http://127.0.0.1:4178/',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
