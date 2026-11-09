import { defineProject } from 'vitest/config';

/**
 * The build as an artefact (M1-105): real Vite builds checked from Node, no browser globals. The
 * story tests' own configs are resolved here too (T-208).
 */
export default defineProject({
  test: {
    name: 'web-build',
    environment: 'node',
    include: ['build/**/*.test.ts', 'vitest.*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
