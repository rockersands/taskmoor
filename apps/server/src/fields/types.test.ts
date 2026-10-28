import { OUTPUT_TYPES, outputValueType } from '@taskmoor/formula';
import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import {
  compareValues,
  deserialise,
  FIELD_TYPES,
  type FieldShape,
  type FieldType,
  MULTIPLE_TYPES,
  parseValue,
  plainText,
  type Reference,
  type Resolver,
  restValue,
  type Stored,
  serialise,
} from './types';

/**
 * Type conformance (M1-010; CORE-010): for every type in the catalogue, what it accepts and
 * refuses, that every stored value reads back from its text (history, CSV) and its REST form,
 * that empty is never stored and sorts last, and that ordering is a total order.
 */
const shape = (type: FieldType, multiple = false, config = {}): FieldShape => ({
  type,
  multiple,
  config,
});

/** Options rank in reverse id order, so sorting by rank differs from sorting by id. */
const resolver: Resolver = {
  rank: (ref: Reference, id: number) => (ref === 'option' ? 1000 - id : `name-${id % 7}`),
  name: (ref: Reference, id: number) => `${ref} ${id}`,
};

const accepted = (field: FieldShape, input: unknown) => {
  const parsed = parseValue(field, input);
  if (!parsed.ok) throw new Error(`refused ${JSON.stringify(input)}: ${parsed.problem}`);
  return parsed.value;
};
const problem = (field: FieldShape, input: unknown) => {
  const parsed = parseValue(field, input);
  return parsed.ok ? 'accepted' : parsed.problem;
};

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const id = fc.integer({ min: 1, max: 2_147_483_647 });
const word = fc
  .string({ unit: 'grapheme', minLength: 1, maxLength: 20 })
  .map((s) => s.replace(/[\s\p{Cc}]/gu, ''))
  .filter((s) => s !== '');

/** Stored values a field of each type can hold, for the round-trip properties. */
function storedValues(field: FieldShape): fc.Arbitrary<Stored> {
  if (field.type === 'formula') {
    // What each output stores (M1-013): as its kind of field, durations in whole seconds.
    const kind = outputValueType(field.config.output ?? 'number');
    if (kind === 'duration') return fc.integer({ min: -1e12, max: 1e12 });
    return storedValues(shape(kind === 'number' ? 'number' : kind));
  }
  switch (field.type) {
    case 'text':
    case 'read-only-text':
      return fc
        .string({ unit: 'grapheme', minLength: 1, maxLength: 255 })
        .map((s) => s.replace(/\p{Cc}/gu, '').trim())
        .filter((s) => s !== '' && [...s].length <= 255);
    case 'paragraph':
      return word.map(doc).map((d) => accepted(field, d) as Stored);
    case 'number':
      return fc
        .integer({ min: -1_000_000_000_000_000, max: 1_000_000_000_000_000 })
        .map((n) => n / 1000);
    case 'date':
      return fc
        .date({ min: new Date('1000-01-01'), max: new Date('9999-12-31'), noInvalidDate: true })
        .map((d) => d.toISOString().slice(0, 10));
    case 'datetime':
      return fc
        .date({ min: new Date('1000-01-01'), max: new Date('9999-12-31'), noInvalidDate: true })
        .map((d) => d.toISOString());
    case 'cascading-select':
      return fc.oneof(
        id.map((p) => [p]),
        fc.tuple(id, id).filter(([p, c]) => p !== c),
      );
    case 'labels':
      return fc.uniqueArray(word, { minLength: 1, maxLength: 20 });
    case 'url':
      return fc.webUrl({ validSchemes: ['http', 'https'] }).filter((u) => !/\s/.test(u));
    default:
      return field.multiple
        ? fc
            .uniqueArray(id, { minLength: 1, maxLength: 20 })
            .map((ids) => ids.sort((a, b) => a - b))
        : id;
  }
}

/** Every type, the multiple variant of those that have one, and a formula of every output. */
const SHAPES: FieldShape[] = FIELD_TYPES.flatMap((type) =>
  type === 'formula'
    ? OUTPUT_TYPES.map((output) => shape(type, false, { expression: '1', output }))
    : MULTIPLE_TYPES.has(type)
      ? [shape(type), shape(type, true)]
      : [shape(type)],
);

describe('custom field types (M1-010)', () => {
  it('[CORE-010] covers every type of the catalogue the backlog row names', () => {
    for (const type of [
      'text',
      'number',
      'date',
      'select',
      'cascading-select',
      'user',
      'group',
      'labels',
      'url',
      'release',
      'area',
      'formula',
    ]) {
      expect(FIELD_TYPES).toContain(type);
    }
  });

  it('[CORE-010] number: rejects 2e12, stores 1.23456 as 1.235, accepts "5e3" as 5000', () => {
    const number = shape('number');
    expect(problem(number, 2e12)).toBe('out_of_range');
    expect(problem(number, '2e12')).toBe('out_of_range');
    expect(accepted(number, 1.23456)).toBe(1.235);
    expect(accepted(number, '1.23456')).toBe(1.235);
    expect(accepted(number, '5e3')).toBe(5000);
    // Half away from zero on the decimal digits, not on the binary double.
    expect(accepted(number, 1.2345)).toBe(1.235);
    expect(accepted(number, -1.2345)).toBe(-1.235);
    expect(accepted(number, 0.0004)).toBe(0);
    expect(accepted(number, '-0.0004')).toBe(0);
    expect(accepted(number, 1e12)).toBe(1e12);
    expect(accepted(number, -1e12)).toBe(-1e12);
    expect(problem(number, 1e12 + 0.001)).toBe('out_of_range');
    expect(accepted(number, ' 42 ')).toBe(42);
    expect(accepted(number, '.5')).toBe(0.5);
    for (const input of ['abc', '1,5', '0x10', 'Infinity', 'NaN', '1e', '.', '--1', true, {}, []]) {
      expect(problem(number, input)).toBe('invalid');
    }
    expect(problem(number, Number.POSITIVE_INFINITY)).toBe('invalid');
  });

  it('[CORE-010] short text: one line of at most 255 characters, trimmed', () => {
    for (const type of ['text', 'read-only-text'] as const) {
      const text = shape(type);
      expect(accepted(text, '  hello  ')).toBe('hello');
      expect(accepted(text, 'x'.repeat(255))).toBe('x'.repeat(255));
      expect(problem(text, 'x'.repeat(256))).toBe('too_long');
      // Characters, not UTF-16 units: 255 emoji fit.
      expect(accepted(text, '😀'.repeat(255))).toBe('😀'.repeat(255));
      expect(problem(text, 'two\nlines')).toBe('invalid');
      expect(problem(text, 42)).toBe('invalid');
    }
  });

  it('[CORE-010] paragraph: rich text within the field limit (32,767 by default)', () => {
    const paragraph = shape('paragraph');
    expect(plainText(accepted(paragraph, doc('hello')))).toBe('hello');
    expect(problem(paragraph, doc('x'.repeat(32_768)))).toBe('too_long');
    expect(
      accepted(shape('paragraph', false, { maxChars: 100_000 }), doc('x'.repeat(32_768))),
    ).toBeDefined();
    expect(problem(shape('paragraph', false, { maxChars: 10 }), doc('eleven char'))).toBe(
      'too_long',
    );
    expect(problem(paragraph, 'plain text')).toBe('invalid');
    expect(problem(paragraph, { type: 'doc', content: [{ type: 'nonsense' }] })).toBe('invalid');
  });

  it('[CORE-010] dates and date-times: real days; instants with an offset, kept in UTC', () => {
    expect(accepted(shape('date'), '2026-02-28')).toBe('2026-02-28');
    expect(problem(shape('date'), '2026-02-30')).toBe('invalid');
    expect(problem(shape('date'), '28.02.2026')).toBe('invalid');
    const at = shape('datetime');
    expect(accepted(at, '2026-10-28T14:30:00+02:00')).toBe('2026-10-28T12:30:00.000Z');
    expect(accepted(at, '2026-10-28T14:30Z')).toBe('2026-10-28T14:30:00.000Z');
    expect(problem(at, '2026-10-28T14:30:00')).toBe('invalid');
    expect(problem(at, '2026-10-28T24:00:00Z')).toBe('invalid');
    expect(problem(at, '0999-12-31T00:00:00Z')).toBe('out_of_range');
  });

  it('[CORE-010] references: ids as numbers, digit strings or {id}; multiple fields keep each once in id order', () => {
    for (const type of ['select', 'user', 'group', 'release', 'area'] as const) {
      expect(accepted(shape(type), 7)).toBe(7);
      expect(accepted(shape(type), '7')).toBe(7);
      expect(accepted(shape(type), { id: 7, name: 'ignored' })).toBe(7);
      expect(problem(shape(type), [7])).toBe('invalid');
      expect(problem(shape(type), 0)).toBe('invalid');
      expect(problem(shape(type), 2_147_483_648)).toBe('invalid');
      expect(accepted(shape(type, true), [9, '3', { id: 9 }])).toEqual([3, 9]);
      expect(problem(shape(type, true), 3)).toBe('invalid');
      expect(
        problem(
          shape(type, true),
          Array.from({ length: 1001 }, (_, i) => i + 1),
        ),
      ).toBe('too_many');
    }
    const cascade = shape('cascading-select');
    expect(accepted(cascade, { parent: 3, child: 8 })).toEqual([3, 8]);
    expect(accepted(cascade, [3])).toEqual([3]);
    expect(accepted(cascade, { id: 3, child: { id: 8 } })).toEqual([3, 8]);
    expect(accepted(cascade, { id: 3, child: null })).toEqual([3]);
    expect(problem(cascade, [3, 3])).toBe('invalid');
    expect(problem(cascade, [1, 2, 3])).toBe('invalid');
  });

  it('[CORE-010] labels and URLs', () => {
    expect(accepted(shape('labels'), ['b', ' a ', 'b'])).toEqual(['b', 'a']);
    expect(problem(shape('labels'), ['two words'])).toBe('invalid');
    expect(problem(shape('labels'), 'a')).toBe('invalid');
    expect(accepted(shape('url'), ' https://example.com/a?b=1 ')).toBe('https://example.com/a?b=1');
    for (const input of ['javascript:alert(1)', 'ftp://example.com', 'example.com', 'http://a b']) {
      expect(problem(shape('url'), input)).toBe('invalid');
    }
  });

  it('[CORE-010] empty input of every type clears the field and is never stored', () => {
    for (const field of SHAPES) {
      const empties: unknown[] = [null, undefined];
      if (field.type !== 'paragraph') empties.push('');
      if (field.multiple || field.type === 'labels' || field.type === 'cascading-select') {
        empties.push([]);
      }
      if (field.type === 'paragraph') {
        empties.push({ type: 'doc', content: [{ type: 'paragraph' }] });
      }
      if (field.type === 'text' || field.type === 'read-only-text') empties.push('   ');
      for (const input of empties) {
        expect(parseValue(field, input), `${field.type} ${JSON.stringify(input)}`).toEqual({
          ok: true,
          value: undefined,
        });
      }
      expect(deserialise(field, '')).toEqual({ ok: true, value: undefined });
    }
  });

  it('[CORE-010] every stored value of every type reads back from its text and from its REST form', () => {
    for (const field of SHAPES) {
      fc.assert(
        fc.property(storedValues(field), (value) => {
          // A stored value is what parsing gives: reading it again changes nothing.
          expect(accepted(field, value)).toEqual(value);
          const text = serialise(field, value);
          expect(text).not.toBe('');
          expect(deserialise(field, text)).toEqual({ ok: true, value });
          expect(accepted(field, restValue(field, value, resolver))).toEqual(value);
          // REST shows references with their names.
          const rest = JSON.stringify(restValue(field, value, resolver));
          if (['select', 'user', 'group', 'release', 'area'].includes(field.type)) {
            expect(rest).toContain(field.type === 'select' ? '"value":"option ' : '"name":"');
          }
        }),
        { numRuns: 50 },
      );
    }
  });

  it('[CORE-010] sorting is a total order with empty last', () => {
    for (const field of SHAPES) {
      const value = fc.option(storedValues(field), { nil: undefined });
      const cmp = (a: Stored | undefined, b: Stored | undefined) =>
        compareValues(field, a, b, resolver);
      fc.assert(
        fc.property(value, value, value, (a, b, c) => {
          expect(Math.sign(cmp(a, b))).toBe(-Math.sign(cmp(b, a)) || 0);
          expect(cmp(a, a)).toBe(0);
          if (cmp(a, b) <= 0 && cmp(b, c) <= 0) expect(cmp(a, c)).toBeLessThanOrEqual(0);
          if (a !== undefined) expect(cmp(a, undefined)).toBe(-1);
        }),
        { numRuns: 50 },
      );
    }
  });

  it("[CORE-010] sorts numbers by value, text without case, references in their objects' order", () => {
    const sorted = (field: FieldShape, values: Stored[]) =>
      [...values, undefined].sort((a, b) => compareValues(field, a, b, resolver));
    expect(sorted(shape('number'), [10, -2.5, 9.999, 0])).toEqual([-2.5, 0, 9.999, 10, undefined]);
    expect(sorted(shape('text'), ['b', 'B', 'a', 'Ä', 'z'])).toEqual([
      'a',
      'B',
      'b',
      'z',
      'Ä',
      undefined,
    ]);
    expect(sorted(shape('date'), ['2026-01-02', '2025-12-31'])).toEqual([
      '2025-12-31',
      '2026-01-02',
      undefined,
    ]);
    expect(
      sorted(shape('datetime'), ['2026-01-02T00:00:00.000Z', '2026-01-01T23:59:59.999Z']),
    ).toEqual(['2026-01-01T23:59:59.999Z', '2026-01-02T00:00:00.000Z', undefined]);
    // Options rank in reverse id order in this resolver.
    expect(sorted(shape('select'), [1, 3, 2])).toEqual([3, 2, 1, undefined]);
    expect(sorted(shape('select', true), [[1], [2, 3], [3]])).toEqual([
      [3],
      [2, 3],
      [1],
      undefined,
    ]);
    // A parent alone sorts before the same parent with a child.
    expect(sorted(shape('cascading-select'), [[5, 9], [5], [6]])).toEqual([
      [6],
      [5],
      [5, 9],
      undefined,
    ]);
    expect(sorted(shape('labels'), [['b'], ['A', 'z'], ['a']])).toEqual([
      ['a'],
      ['A', 'z'],
      ['b'],
      undefined,
    ]);
  });
});
