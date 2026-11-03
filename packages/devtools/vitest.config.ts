import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'devtools',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Project configs do not inherit the root timeouts; database setup is slow under load, and
    // starting shell scripts is slow on Windows.
    testTimeout: process.platform === 'win32' ? 60_000 : 20_000,
    hookTimeout: process.platform === 'win32' ? 180_000 : 60_000,
  },
});
