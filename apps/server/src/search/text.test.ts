import { parseTextSearch } from '@taskmoor/query';
import { describe, expect, it } from 'vitest';
import { fuzzyWords, likePattern, operand, textQuery, wildcardWords } from './text';

/** A search as `to_tsquery` input and `ILIKE` patterns (M1-040; QRY-007). */
describe('text search in SQL terms (M1-040)', () => {
  it('[QRY-007] quotes words and phrases so the database splits and stems them', () => {
    expect(textQuery(parseTextSearch('Login "failed twice" log*'))).toEqual({
      tsquery: "'Login' & 'failed twice' & 'log':*",
      patterns: [],
      excludedPatterns: [],
    });
    expect(operand("it's a\\b")).toBe("'it''s a\\\\b'");
    expect(textQuery(parseTextSearch('a -b -"c d"')).tsquery).toBe("'a' & !'b' & !'c d'");
  });

  it('[QRY-007] expands ? into every letter and digit, accents too', () => {
    const one = wildcardWords(['lo', 'in']);
    expect(one).toContain('login');
    expect(one).toContain('lo9in');
    expect(one).toContain('loéin');
    expect(new Set(one).size).toBe(one.length);
    // Two at once leave the accents out rather than pass 2,000 words.
    const two = wildcardWords(['', 'og', 'n']);
    expect(two).toContain('login');
    expect(two.length).toBeLessThanOrEqual(2_000);
    expect(two.every((w) => /^[a-z0-9]og[a-z0-9]n$/.test(w))).toBe(true);
    expect(textQuery(parseTextSearch('lo?in*')).tsquery).toMatch(/^\('loain':\* \| /);
  });

  it('[QRY-007] expands a fuzzy word into every word one edit away', () => {
    const words = fuzzyWords('Login');
    for (const w of ['login', 'logn', 'lgoin', 'logon', 'logins', 'xlogin', 'lógin']) {
      expect(words, w).toContain(w);
    }
    expect(words).not.toContain('lgon');
    expect(new Set(words).size).toBe(words.length);
    // Too short or too long to expand.
    expect(fuzzyWords('ab')).toEqual(['ab']);
    expect(fuzzyWords('x'.repeat(25))).toEqual(['x'.repeat(25)]);
  });

  it('[QRY-007] turns patterns into ILIKE patterns with literal text escaped', () => {
    const pattern = (text: string) => {
      const t = parseTextSearch(text).terms[0];
      if (t?.kind !== 'pattern') throw new Error(`not a pattern: ${text}`);
      return likePattern(t);
    };
    expect(pattern('*Exception')).toBe('%Exception%');
    expect(pattern('*draft*')).toBe('%draft%');
    expect(pattern('*abc?de*fgh')).toBe('%abc_de%fgh%');
    expect(pattern('*100\\%_done')).toBe('%100\\%\\_done%');
    expect(textQuery(parseTextSearch('*abc -*xyz'))).toEqual({
      tsquery: null,
      patterns: ['%abc%'],
      excludedPatterns: ['%xyz%'],
    });
  });
});
