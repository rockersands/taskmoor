import { defineProject } from 'vitest/config';

// The sweep's pure parts (T-257): arguments, the route list, the phone windows, the measurements'
// summary and the redaction of links, passwords and tokens. The browser run itself is checked by
// running `pnpm sweep` against a private demo.
export default defineProject({
  test: {
    name: 'sweep',
    environment: 'node',
    include: ['*.test.mjs'],
    testTimeout: 20_000,
  },
});
