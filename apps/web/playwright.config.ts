import { randomBytes } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';

// The directory test's passwords (M1-082), made per run and handed to the API server and the
// tests through the environment, so none is written in the repository. Workers load this file
// again and keep the values they inherited.
process.env.TASKMOOR_E2E_LDAP_BIND_PASSWORD ??= `bind-${randomBytes(18).toString('base64url')}`;
process.env.TASKMOOR_E2E_LDAP_USER_PASSWORD ??= `user-${randomBytes(18).toString('base64url')}`;
// The import wizard's administrator (M1-097, web-server.ts on 4185), made the same way.
process.env.TASKMOOR_E2E_IMPORT_PASSWORD ??= `wizard-${randomBytes(18).toString('base64url')}`;
// The attachments administrator's password (M1-016), made the same way.
process.env.TASKMOOR_E2E_ATTACH_PASSWORD ??= `files-${randomBytes(18).toString('base64url')}`;
// The AI key the fake provider of api-server.ts accepts (M1-076), made per run the same way and
// shaped so that no secret scanner mistakes it for a real key.
process.env.TASKMOOR_E2E_AI_KEY ??= `fake-ai-key-${randomBytes(18).toString('hex')}`;
// The AI features backend's administrator (M1-079, api-server.ts on 8797), made the same way.
process.env.TASKMOOR_E2E_AI_PASSWORD ??= `ai-${randomBytes(18).toString('base64url')}`;

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
  // On Windows the preview's proxy to the API sometimes loses a connection (ECONNRESET) under a
  // full gate's load. A test that passes on its retry is still listed as flaky in the summary.
  retries: process.env.CI || process.platform === 'win32' ? 1 : 0,
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
    // The AI features backends (M1-079): with the fake provider (4186) and with none (4187).
    ...[
      [4174, 8791],
      [4175, 8792],
      [4186, 8797],
      [4187, 8798],
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
    // The Builder page (M1-112): one file built from this run's web build and served alone, as
    // any host or a USB stick would hand it out (4184). builder-page.spec.ts blocks the rest.
    {
      command: `${vite} build --config vite.builder.config.ts --logLevel warn && ${vite} preview --config vite.builder.config.ts`,
      url: 'http://localhost:4184/',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
