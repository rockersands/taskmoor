import { defineConfig, devices } from '@playwright/test';

/**
 * The fresh-install journey (M1-113), run by tools/image/fresh-vm.sh against kits installed on a
 * fresh machine: no web servers of its own, desktop Chromium, and the backend's own certificate
 * (Caddy's local authority for localhost) accepted.
 */
export default defineConfig({
  testDir: './e2e-fresh',
  timeout: 120_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: { ...devices['Desktop Chrome'], ignoreHTTPSErrors: true, trace: 'retain-on-failure' },
});
