import { describe, expect, it } from 'vitest';
import { QUERY_CASES } from './conformance/cases';
import { nativeEngine, runCase } from './conformance/run';

/**
 * Every parse and parse-error case of the conformance suite (M1-033) as its own parser test
 * (M1-034): the text parses and prints back in canonical form, or is refused at the stated
 * position. Resolution cases are measured by the suite's pass-rate golden instead.
 */
const PARSE_CASES = QUERY_CASES.filter((c) => c.kind === 'parse' || c.kind === 'parse-error');

describe('parser conformance', () => {
  it('[QRY-001] covers at least 500 cases', () => {
    expect(PARSE_CASES.length).toBeGreaterThanOrEqual(500);
  });

  it.each(PARSE_CASES.map((c) => [`[${c.requirement}] ${c.id}: ${c.title}`, c] as const))(
    '%s',
    (_, c) => {
      const result = runCase(nativeEngine, c);
      expect(result.detail ?? '').toBe('');
      expect(result.status).toBe('pass');
    },
  );
});
