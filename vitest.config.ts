import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Stories run in Playwright's Chromium. Where it is not installed (a CI job that only runs the
 * database suites, a fresh machine) the stories project is left out, with a notice; the main CI
 * job installs the browser and runs them.
 */
function chromiumInstalled(): boolean {
  const root =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    (process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA ?? homedir(), 'ms-playwright')
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Caches', 'ms-playwright')
        : join(homedir(), '.cache', 'ms-playwright'));
  try {
    return existsSync(root) && readdirSync(root).some((d) => d.startsWith('chromium'));
  } catch {
    return false;
  }
}

// Stories run once per skin (ADR-036): light, then dark.
const storiesProject = chromiumInstalled()
  ? ['apps/web/vitest.stories.config.ts', 'apps/web/vitest.stories-dark.config.ts']
  : [];
if (storiesProject.length === 0) {
  console.warn(
    'Stories skipped: Playwright Chromium is not installed (pnpm --filter @taskmoor/web exec playwright install chromium).',
  );
}

// One Vitest run covers every package. Each package keeps its own vitest.config.ts
// (environment, setup files); this root file only lists them and starts the shared
// test Postgres once for the whole run.
export default defineConfig({
  test: {
    projects: [
      'packages/*',
      'apps/server',
      'apps/web/vitest.config.ts',
      // The frontend build as an artefact (M1-105): real builds, so a project of its own.
      'apps/web/vitest.build.config.ts',
      // Stories run as browser tests with axe checks (M0-031).
      ...storiesProject,
    ],
    globalSetup: ['./packages/testkit/src/pg/global-setup.ts'],
    // Lets pnpm verify print file:line for each failing test.
    includeTaskLocation: true,
    // Timeouts are set in each project config: projects do not inherit them from here.
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'apps/*/src/**'],
      exclude: ['**/*.test.*', '**/__golden__/**'],
      reportsDirectory: '.verify/coverage',
    },
  },
});
