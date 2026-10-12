import { defineConfig } from 'vitest/config';

// One Vitest run covers every package. Each package keeps its own vitest.config.ts
// (environment, setup files); this root file only lists them and starts the shared
// test Postgres once for the whole run.
export default defineConfig({
  test: {
    projects: [
      'packages/*',
      'apps/server',
      'apps/web/vitest.config.ts',
      // Stories run as browser tests with axe checks (M0-031).
      'apps/web/vitest.stories.config.ts',
    ],
    globalSetup: ['./packages/testkit/src/pg/global-setup.ts'],
    // Lets pnpm verify print file:line for each failing test.
    includeTaskLocation: true,
    // Database creation can take seconds on a loaded machine or a slow CI runner.
    testTimeout: 20_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'apps/*/src/**'],
      exclude: ['**/*.test.*', '**/__golden__/**'],
      reportsDirectory: '.verify/coverage',
    },
  },
});
