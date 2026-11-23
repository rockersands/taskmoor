import { describe, expect, it } from 'vitest';
import { liveTestKey } from './testing';

// Made up for this file: not a key, and not shaped like one.
const KEY = 'not-a-key-for-tests';

describe('the live tests run only under pnpm ai:live (T-333)', () => {
  it('[IAM-020] [OPS-020] a key left in the environment alone does not make a test run spend', () => {
    // As `pnpm verify` would see a key kept in a user variable: no live test runs.
    expect(liveTestKey({ TASKMOOR_AI_TEST_KEY: KEY })).toBeUndefined();
    expect(liveTestKey({ TASKMOOR_AI_LIVE_RESULTS: 'results.jsonl' })).toBeUndefined();
    expect(liveTestKey({})).toBeUndefined();
    // As `pnpm ai:live` starts its children: the key and the file for the results.
    expect(
      liveTestKey({ TASKMOOR_AI_TEST_KEY: KEY, TASKMOOR_AI_LIVE_RESULTS: 'results.jsonl' }),
    ).toBe(KEY);
  });
});
