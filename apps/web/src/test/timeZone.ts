import { afterAll, beforeAll } from 'vitest';

/**
 * Runs the tests of the enclosing `describe` on another zone's clock: Node reads `TZ` again when
 * it changes, so `getDate()` and the rest answer for `zone`. Put back afterwards, so the tests
 * after them run on the machine's own zone.
 */
export function useTimeZone(zone: string) {
  let before: string | undefined;
  beforeAll(() => {
    before = process.env.TZ;
    process.env.TZ = zone;
  });
  afterAll(() => {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  });
}
