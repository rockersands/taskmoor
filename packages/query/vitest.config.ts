import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'query',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Project configs do not inherit the root timeouts; database setup is slow under load.
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
