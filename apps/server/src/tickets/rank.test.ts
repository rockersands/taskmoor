import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import { isRankKey, keyBetween, RANK_DIGITS, sequenceKey, sequenceValueOf } from './rank';

/** A deterministic stand-in for Math.random. */
function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 2 ** 32;
  };
}

/** Code-unit order, as the "C" collation compares. */
const ordered = (keys: readonly string[]) =>
  keys.every((key, i) => i === 0 || (keys[i - 1] as string) < key);

type Step = { kind: 'append' } | { kind: 'top' } | { kind: 'between'; at: number };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.constant<Step>({ kind: 'append' }),
  fc.constant<Step>({ kind: 'top' }),
  fc.nat({ max: 1_000 }).map((at): Step => ({ kind: 'between', at })),
);

describe('rank keys (AGL-009)', () => {
  it('[AGL-009] keeps one strict order under random appends, moves to the top and inserts', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 300 }), fc.integer(), (steps, seed) => {
        const random = seeded(seed);
        let sequence = 0;
        const keys: string[] = [];
        for (const step of steps) {
          let key: string;
          let index: number;
          const at = step.kind === 'between' ? (step.at % Math.max(1, keys.length)) + 1 : 0;
          if (step.kind === 'append' || keys.length === 0 || at === keys.length) {
            // The bottom is reached only through the sequence, as tickets do.
            key = sequenceKey(++sequence);
            index = keys.length;
          } else if (step.kind === 'top') {
            key = keyBetween(null, keys[0] as string, random);
            index = 0;
          } else {
            index = at;
            key = keyBetween(keys[index - 1] as string, keys[index] as string, random);
          }
          expect(isRankKey(key)).toBe(true);
          keys.splice(index, 0, key);
        }
        expect(ordered(keys)).toBe(true);
      }),
    );
  });

  it('[AGL-009] puts every later sequence key after every key in use', () => {
    fc.assert(
      fc.property(fc.array(fc.nat({ max: 50 }), { maxLength: 100 }), (inserts) => {
        const random = seeded(inserts.length + 1);
        const keys = [sequenceKey(1), sequenceKey(2)];
        for (const at of inserts) {
          const index = (at % (keys.length - 1)) + 1;
          keys.splice(
            index,
            0,
            keyBetween(keys[index - 1] as string, keys[index] as string, random),
          );
        }
        expect(keys.every((key) => key < sequenceKey(3))).toBe(true);
      }),
    );
  });

  it('[AGL-009] steps through the integers in the order keyBetween(key, null) does', () => {
    const boundaries = [0, 1, 61, 62, 63, 62 + 62 ** 2 - 1, 62 + 62 ** 2, 1_000_000, 123_456_789];
    for (const n of boundaries) {
      const key = sequenceKey(n);
      expect(isRankKey(key)).toBe(true);
      expect(keyBetween(key, null)).toBe(sequenceKey(n + 1));
      expect(key < sequenceKey(n + 1)).toBe(true);
    }
    expect(sequenceKey(0)).toBe('a0');
    expect(sequenceKey(61)).toBe('az');
    expect(sequenceKey(62)).toBe('b00');
    expect(sequenceKey('9007199254740993')).toMatch(/^[a-z]/);
    fc.assert(
      fc.property(fc.nat({ max: 10_000_000 }), (n) => {
        expect(keyBetween(sequenceKey(n), null)).toBe(sequenceKey(n + 1));
      }),
    );
  });

  it('[AGL-009] reads the sequence value back from a key, so imported ranks stay above it', () => {
    fc.assert(
      fc.property(fc.nat({ max: 100_000_000 }), fc.string({ maxLength: 3 }), (n, tail) => {
        const key = sequenceKey(n);
        expect(sequenceValueOf(key)).toBe(BigInt(n));
        // A key between two others keeps its integer part.
        expect(sequenceValueOf(`${key}${tail.replace(/[^0-9A-Za-z]/g, '')}`)).toBe(BigInt(n));
        expect(sequenceKey(n + 1) > key).toBe(true);
      }),
    );
    expect(sequenceValueOf('')).toBe(0n);
    expect(sequenceValueOf('c1')).toBe(0n);
  });

  it('[AGL-009] keeps keys short for ten million appends', () => {
    expect(sequenceKey(10_000_000).length).toBeLessThanOrEqual(5);
  });

  it('[AGL-009] needs no rebalance for 1,000 consecutive moves into the same gap', () => {
    const random = seeded(7);
    // Always just below the top ticket: the worst case for fractional keys.
    const top = sequenceKey(1);
    let below = sequenceKey(2);
    for (let i = 0; i < 1_000; i++) {
      const key = keyBetween(top, below, random);
      expect(top < key && key < below).toBe(true);
      below = key;
    }
    expect(below.length).toBeLessThan(300);
    // And always to the top of the order.
    let first = sequenceKey(1);
    for (let i = 0; i < 1_000; i++) first = keyBetween(null, first, random);
    expect(first.length).toBeLessThan(10);
  });

  it('[AGL-009] reaches into the negative integers and below them', () => {
    let key = 'a0';
    for (let i = 0; i < 200; i++) {
      const next = keyBetween(null, key);
      expect(next < key).toBe(true);
      key = next;
    }
    expect(key.startsWith('Z') || key.startsWith('Y')).toBe(true);
    const smallest = `A${'0'.repeat(25)}1`;
    expect(isRankKey(smallest)).toBe(true);
    const below = keyBetween(null, smallest);
    expect(below < smallest && isRankKey(below)).toBe(true);
  });

  it('[AGL-009] rejects malformed keys and reversed neighbours', () => {
    for (const bad of ['', 'a', 'b0', 'a00', 'a1-', 'é0', `A${'0'.repeat(26)}`]) {
      expect(isRankKey(bad)).toBe(false);
    }
    expect(() => keyBetween('a2', 'a1')).toThrow(RangeError);
    expect(() => keyBetween('a1', 'a1')).toThrow(RangeError);
    expect(() => keyBetween('nonsense', null)).toThrow(RangeError);
    expect(() => sequenceKey(-1)).toThrow(RangeError);
    expect(RANK_DIGITS).toHaveLength(62);
    expect([...RANK_DIGITS].sort().join('')).toBe(RANK_DIGITS);
  });
});
