import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const vite = 'node node_modules/vite/bin/vite.js';

/**
 * End-to-end tests run against the production build, served the way a static host would.
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
  webServer: {
    command: `${vite} build --logLevel warn && ${vite} preview`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
