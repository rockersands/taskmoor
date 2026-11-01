import { describe, expect, it } from 'vitest';
import { unsafePattern } from './pattern';

describe('workflow validator patterns (M1-118)', () => {
  it('[WF-004] accepts the patterns validators are written with', () => {
    for (const p of [
      '^[A-Z]+-[0-9]+$',
      '^[0-9]+',
      '^x',
      '^(?:v|release-)\\d+\\.\\d+(\\.\\d+)?$',
      '^[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}$',
      '^(foo|bar)$',
      '^(ab){1,3}$',
      '[(+*]',
      '^\\(\\d+\\)$',
    ]) {
      expect(unsafePattern(p), p).toBeNull();
    }
  });

  it('[WF-004] refuses patterns that can backtrack catastrophically', () => {
    for (const [p, why] of [
      ['^(a+)+$', 'nested repetition'],
      ['(\\w*)*x', 'nested repetition'],
      ['((ab)*c)+', 'nested repetition'],
      ['^(a|aa)*$', 'repeated alternation'],
      ['(x|x?)+y', 'repeated alternation'],
      ['^(a{1,100}){2,}$', 'nested repetition'],
      ['(a)\\1', 'a backreference'],
      ['(?<n>a)\\k<n>', 'a backreference'],
      ['(a', 'an unbalanced parenthesis'],
      ['a'.repeat(501), 'too long'],
    ] as const) {
      expect(unsafePattern(p), p).toBe(why);
    }
  });
});
