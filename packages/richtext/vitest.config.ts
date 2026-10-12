import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'richtext',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
