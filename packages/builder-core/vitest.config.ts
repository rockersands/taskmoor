import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'builder-core',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Project configs do not inherit the root timeouts.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
