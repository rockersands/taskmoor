import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import {
  checkKey,
  FEATURE_DEFAULTS,
  KEY_RULES,
  normalizeKey,
  TRACK_FEATURES,
  TRACK_TYPES,
} from './model';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const NATIVE = /^[A-Z][A-Z0-9]{1,9}$/;
const IMPORTED = /^[A-Z][A-Z0-9_]{0,254}$/;

const charFrom = (chars: string) => fc.constantFrom(...chars.split(''));
/** Strings over the key alphabet plus the characters people get wrong. */
const keyish = fc
  .array(charFrom(`${LETTERS}${LETTERS.toLowerCase()}${DIGITS}_- .ßÄé`), {
    minLength: 0,
    maxLength: 14,
  })
  .map((chars) => chars.join(''));
const nativeKey = fc
  .tuple(charFrom(LETTERS), fc.array(charFrom(LETTERS + DIGITS), { minLength: 1, maxLength: 9 }))
  .map(([first, rest]) => first + rest.join(''));

describe('track keys (CORE-001)', () => {
  it('[CORE-001] accepts exactly the native keys: a letter, then letters or digits, 2 to 10 characters', () => {
    fc.assert(
      fc.property(keyish, (raw) => {
        const result = checkKey(raw);
        expect(result.ok).toBe(NATIVE.test(normalizeKey(raw)));
        if (result.ok) expect(result.key).toMatch(NATIVE);
      }),
    );
  });

  it('[CORE-001] accepts every native key in upper or lower case and stores it upper case', () => {
    fc.assert(
      fc.property(nativeKey, fc.boolean(), (key, lower) => {
        const result = checkKey(lower ? key.toLowerCase() : key);
        expect(result).toEqual({ ok: true, key });
      }),
    );
  });

  it('[CORE-001] (3) accepts under the import rule every key the native rule accepts', () => {
    fc.assert(
      fc.property(keyish, (raw) => {
        if (checkKey(raw).ok) expect(checkKey(raw, 'import').ok).toBe(true);
        const imported = checkKey(raw, 'import');
        expect(imported.ok).toBe(IMPORTED.test(normalizeKey(raw)));
      }),
    );
  });

  it('[CORE-001] (3) accepts the key formats a widened Jira key pattern allows', () => {
    // Synthetic examples of what a Jira site can hold after its administrator widens the key
    // pattern: single letters, underscores, digits, keys longer than ten characters.
    const imported = [
      'A',
      'AB',
      'X1',
      'ABC_DEF',
      'A_1',
      'PROJ2024',
      'LONGERKEYTHANTEN',
      'K'.repeat(255),
    ];
    for (const key of imported) expect(checkKey(key, 'import'), key).toEqual({ ok: true, key });
    for (const key of ['', '1ABC', '_AB', 'AB-C', 'A B', 'ÄBC', 'K'.repeat(256)]) {
      expect(checkKey(key, 'import').ok, key).toBe(false);
    }
    expect(checkKey('ABC_DEF').ok).toBe(false);
    expect(checkKey('A').ok).toBe(false);
  });

  it('[CORE-001] names the problem with a rejected key', () => {
    expect(checkKey('')).toEqual({ ok: false, problem: 'empty' });
    expect(checkKey('   ')).toEqual({ ok: false, problem: 'empty' });
    expect(checkKey('1AB')).toEqual({ ok: false, problem: 'must_start_with_letter' });
    expect(checkKey('A')).toEqual({ ok: false, problem: 'too_short' });
    expect(checkKey('ABCDEFGHIJK')).toEqual({ ok: false, problem: 'too_long' });
    expect(checkKey('AB-1')).toEqual({ ok: false, problem: 'invalid_character' });
    expect(checkKey('PAY_1')).toEqual({ ok: false, problem: 'invalid_character' });
  });

  it('[CORE-001] upper-cases ASCII letters only, so no other script changes shape', () => {
    expect(normalizeKey(' pay ')).toBe('PAY');
    // toUpperCase would turn the sharp s into SS and make a valid-looking key.
    expect(normalizeKey('straße')).toBe('STRAßE');
    expect(checkKey('straße')).toEqual({ ok: false, problem: 'invalid_character' });
    fc.assert(
      fc.property(fc.string(), (raw) => {
        expect(normalizeKey(raw).length).toBe(raw.trim().length);
      }),
    );
  });

  it('keeps the documented bounds', () => {
    expect(KEY_RULES.native).toMatchObject({ min: 2, max: 10 });
    expect(KEY_RULES.import).toMatchObject({ min: 1, max: 255 });
  });
});

describe('track types and feature toggles (CORE-002)', () => {
  it('[CORE-002] gives each type a preset of every toggle', () => {
    for (const type of TRACK_TYPES) {
      expect(Object.keys(FEATURE_DEFAULTS[type]).sort()).toEqual([...TRACK_FEATURES].sort());
      expect(FEATURE_DEFAULTS[type].board, type).toBe(true);
    }
    expect(Object.values(FEATURE_DEFAULTS.software).every(Boolean)).toBe(true);
    expect(FEATURE_DEFAULTS.business).toMatchObject({
      sprints: false,
      backlog: false,
      releases: false,
      development: false,
      calendar: true,
      forms: true,
    });
  });
});
