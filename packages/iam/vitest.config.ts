import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'iam',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Project configs do not inherit the root timeouts; password hashing is deliberately slow.
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
