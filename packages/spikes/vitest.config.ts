import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'spikes',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Project configs do not inherit the root timeouts; benchmarks and loads are slow.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
