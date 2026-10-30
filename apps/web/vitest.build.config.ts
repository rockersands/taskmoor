import { defineProject } from 'vitest/config';

/** The build as an artefact (M1-105): real Vite builds checked from Node, no browser globals. */
export default defineProject({
  test: {
    name: 'web-build',
    environment: 'node',
    include: ['build/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
