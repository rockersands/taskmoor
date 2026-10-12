import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import { lineIndex, locate, QueryError } from './lexer';
import { MAX_DEPTH, parseQuery, parseWithDiagnostics } from './parser';
import { printQuery } from './print';

/** Errors as `start: message start`, and the partial tree as canonical text. */
const RECOVERY: [text: string, errors: [number, string][], partial: string][] = [
  [
    'status = AND priority = ',
    [
      [9, 'Expected a value'],
      [24, 'Expected a value'],
    ],
    '',
  ],
  [
    'status = Done AND priority = AND assignee = currentUser()',
    [[29, 'Expected a value']],
    'status = Done AND assignee = currentUser()',
  ],
  ['status IN (Open AND Done)', [[16, 'Expected "," or ")"']], 'status IN (Open)'],
  ['(status = Done', [[14, 'Expected ")"']], 'status = Done'],
  ['status = Done)', [[13, 'Unexpected ")"']], 'status = Done'],
  [
    'status = Done ) AND priority = High',
    [[14, 'Unexpected ")"']],
    'status = Done AND priority = High',
  ],
  [
    'status Done AND priority = High',
    [[7, 'Expected an operator after "status"']],
    'priority = High',
  ],
  ['status = Done ANDD priority = High', [[14, 'Unexpected "ANDD"']], 'status = Done'],
  [
    'status = Done AND ORDER BY created',
    [[18, '"ORDER" cannot be used as a field name']],
    'status = Done ORDER BY created ASC',
  ],
  ['ORDER BY created,', [[17, 'Expected a field name']], 'ORDER BY created ASC'],
  ['ORDER BY , created', [[9, 'Expected a field name']], 'ORDER BY created ASC'],
  [
    'status = Done ORDER created DESC',
    [[20, 'Expected BY after ORDER']],
    'status = Done ORDER BY created DESC',
  ],
  ['a = "unterminated', [[4, 'Unterminated string']], 'a = "unterminated"'],
  ['a = 1 # AND b = 2', [[6, 'Unexpected character "#"']], 'a = 1 AND b = 2'],
  ['a = 1 AND b = 2 #', [[16, 'Unexpected character "#"']], 'a = 1 AND b = 2'],
  [
    'a = 1 ### b',
    [
      [6, 'Unexpected character "#"'],
      [10, 'Unexpected "b"'],
    ],
    'a = 1',
  ],
  ['status IN ()', [[11, 'Expected at least one value']], ''],
  ['status IN () AND a = 1', [[11, 'Expected at least one value']], 'a = 1'],
  ['status IN (Open, ) AND a = 1', [[17, 'Expected a value']], 'status IN (Open) AND a = 1'],
  ['status IN (Open', [[15, 'Expected "," or ")"']], 'status IN (Open)'],
  ['status IN (Open AND a = 1', [[16, 'Expected "," or ")"']], 'status IN (Open) AND a = 1'],
  ['NOT', [[3, 'Expected a field name']], ''],
  ['NOT (a = 1', [[10, 'Expected ")"']], 'NOT a = 1'],
  ['((a = 1)', [[8, 'Expected ")"']], 'a = 1'],
  ['a = 1 OR', [[8, 'Expected a field name']], 'a = 1'],
  ['a = 1 OR OR b = 2', [[9, '"OR" cannot be used as a field name']], 'a = 1 OR b = 2'],
  ['cf[x] = 1 AND a = 1', [[3, 'Expected a custom field number']], 'a = 1'],
  ['a IS Done AND b IS EMPTY', [[5, 'Expected EMPTY or NULL after IS']], 'b IS EMPTY'],
  ['a NOT Done', [[6, 'Expected IN after NOT']], ''],
  ['a = currentUser( AND b = 1', [[17, 'Expected a value']], 'b = 1'],
  ['a WAS IN () AND b = 1', [[10, 'Expected at least one value']], 'b = 1'],
  ['a CHANGED DURING () AND b = 1', [[18, 'Expected at least one value']], 'b = 1'],
  ['a = 1 AND (b = AND c = 2)', [[15, 'Expected a value']], 'a = 1 AND c = 2'],
  [
    '(a = ) OR (b = 2',
    [
      [5, 'Expected a value'],
      [16, 'Expected ")"'],
    ],
    'b = 2',
  ],
  [') a = 1', [[0, 'Expected a field name']], 'a = 1'],
  ['a = 1 ORDER BY b ASC c', [[21, 'Unexpected "c"']], 'a = 1 ORDER BY b ASC'],
];

describe('error recovery', () => {
  for (const [text, errors, partial] of RECOVERY) {
    it(`[QRY-001] ${JSON.stringify(text)} reports ${errors.length} error(s) and keeps ${JSON.stringify(partial)}`, () => {
      const result = parseWithDiagnostics(text);
      expect(result.errors.map((e) => e.start)).toEqual(errors.map(([start]) => start));
      for (const [i, [, message]] of errors.entries()) {
        expect(result.errors[i]?.message.startsWith(message), result.errors[i]?.message).toBe(true);
      }
      const printed = printQuery(result.query);
      expect(printed).toBe(partial);
      // The partial tree is always a valid query.
      expect(parseWithDiagnostics(printed).errors).toEqual([]);
      // The throwing parser reports the first error.
      expect(() => parseQuery(text)).toThrow(QueryError);
      try {
        parseQuery(text);
      } catch (error) {
        expect((error as QueryError).position).toBe(errors[0]?.[0]);
      }
    });
  }

  it('[QRY-001] finds no errors and the full tree in a valid query', () => {
    const result = parseWithDiagnostics('status = Done AND (priority = High OR labels IN (a, b))');
    expect(result.errors).toEqual([]);
    expect(printQuery(result.query)).toBe(
      'status = Done AND (priority = High OR labels IN (a, b))',
    );
  });
});

describe('positions and hints', () => {
  it('[QRY-001] reports line and column, and names them in the message of a multi-line query', () => {
    const text = 'status = Done\nAND priority =\nORDER BY created';
    const [error] = parseWithDiagnostics(text).errors;
    expect(error).toMatchObject({
      start: 29,
      line: 3,
      column: 1,
      message: 'Expected a value, found "ORDER"',
    });
    expect(() => parseQuery(text)).toThrow('Expected a value, found "ORDER" at line 3, column 1');
  });

  it('[QRY-001] counts CRLF as one line break', () => {
    const text = 'a = 1\r\nAND b =';
    const [error] = parseWithDiagnostics(text).errors;
    expect(error).toMatchObject({ line: 2, column: 8 });
  });

  it('[QRY-001] keeps the position form for one-line queries', () => {
    expect(() => parseQuery('status = ')).toThrow(
      'Expected a value, found the end of the query at position 10',
    );
    try {
      parseQuery('status = ');
    } catch (error) {
      expect(error).toMatchObject({ line: 1, column: 10, position: 9, expected: ['value'] });
    }
  });

  it('[QRY-001] locates offsets on every line', () => {
    const text = 'ab\ncd\r\nef';
    const at = lineIndex(text);
    expect([0, 1, 2, 3, 4, 7, 8, 9].map((o) => at(o))).toEqual([
      { line: 1, column: 1 },
      { line: 1, column: 2 },
      { line: 1, column: 3 },
      { line: 2, column: 1 },
      { line: 2, column: 2 },
      { line: 3, column: 1 },
      { line: 3, column: 2 },
      { line: 3, column: 3 },
    ]);
    expect(locate(text, 7)).toEqual({ line: 3, column: 1 });
  });

  it.each([
    ['status', ['=', 'IN', 'IS', 'WAS', 'CHANGED']],
    ['status = ', ['value']],
    ['status = Done Done', ['AND', 'OR', 'ORDER BY']],
    ['status IN (Open', [',', ')']],
    ['status IS NOT', ['EMPTY', 'NULL']],
    ['a = 1 ORDER created', ['BY']],
    ['(a = 1', [')']],
    ['', []],
  ] as const)('[QRY-001] suggests what can follow %j', (text, expected) => {
    const [error] = parseWithDiagnostics(text).errors;
    if (expected.length === 0) {
      expect(error).toBeUndefined();
      return;
    }
    expect(error?.expected).toEqual(expect.arrayContaining([...expected]));
  });
});

describe('numbers', () => {
  it('[QRY-001] keeps numerals a JavaScript number cannot hold exactly as written (found by the fuzzer)', () => {
    for (const [text, kind] of [
      ['filter > 10001100001100010000110001', 'word'],
      ['id = 9007199254740993', 'word'],
      ['x = 0.0000001', 'word'],
      ['id = 9007199254740991', 'number'],
      ['x = 3.50', 'number'],
      ['x = -12', 'number'],
    ] as const) {
      const query = parseQuery(text);
      expect((query.where as { value: { kind: string } }).value.kind, text).toBe(kind);
      const printed = printQuery(query);
      expect(parseWithDiagnostics(printed).errors, printed).toEqual([]);
    }
    expect(printQuery(parseQuery('filter > 10001100001100010000110001'))).toBe(
      'filter > 10001100001100010000110001',
    );
  });
});

describe('limits', () => {
  it(`[QRY-001] refuses nesting deeper than ${MAX_DEPTH} levels instead of overflowing the stack`, () => {
    for (const text of [
      `${'('.repeat(20_000)}a = 1${')'.repeat(20_000)}`,
      `${'NOT '.repeat(20_000)}a = 1`,
      `a IN ${'f('.repeat(20_000)}1${')'.repeat(20_000)}`,
    ]) {
      const { errors } = parseWithDiagnostics(text);
      expect(errors[0]?.message).toBe(`The query nests deeper than ${MAX_DEPTH} levels`);
      expect(() => parseQuery(text)).toThrow(QueryError);
    }
    const ok = `${'('.repeat(MAX_DEPTH)}a = 1${')'.repeat(MAX_DEPTH)}`;
    expect(parseWithDiagnostics(ok).errors).toEqual([]);
  });

  it('[QRY-001] stays linear on long runs of mistakes', () => {
    const text = 'a IN (b c AND '.repeat(5_000);
    const started = performance.now();
    const { errors } = parseWithDiagnostics(text);
    expect(errors.length).toBeGreaterThan(1_000);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

const TOKENS = [
  'status',
  '"Story Points"',
  'cf[10016]',
  '=',
  '!=',
  '~',
  '<=',
  'IN',
  'NOT',
  'IS',
  'EMPTY',
  'WAS',
  'CHANGED',
  'FROM',
  'BY',
  'DURING',
  'AND',
  'OR',
  'ORDER',
  'ASC',
  '(',
  ')',
  ',',
  '[',
  ']',
  'Done',
  '-1w',
  '2026-01-31',
  'currentUser()',
  'f(',
  '"',
  "'",
  '\\',
  '#',
  '\n',
  '@current',
];

describe('invariants on any input', () => {
  const check = (text: string) => {
    const result = parseWithDiagnostics(text);
    const starts = result.errors.map((e) => e.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(new Set(starts).size).toBe(starts.length);
    for (const e of result.errors) {
      expect(e.start).toBeGreaterThanOrEqual(0);
      expect(e.end).toBeGreaterThanOrEqual(e.start);
      expect(e.end).toBeLessThanOrEqual(text.length + 1);
      expect(locate(text, e.start)).toEqual({ line: e.line, column: e.column });
    }
    // The partial tree prints as a valid query that reads back to the same text.
    const printed = printQuery(result.query);
    const again = parseWithDiagnostics(printed);
    expect(again.errors).toEqual([]);
    expect(printQuery(again.query)).toBe(printed);
    // The throwing parser agrees.
    let thrown: unknown;
    try {
      parseQuery(text);
    } catch (error) {
      thrown = error;
    }
    if (result.errors.length === 0) expect(thrown).toBeUndefined();
    else {
      expect(thrown).toBeInstanceOf(QueryError);
      expect((thrown as QueryError).position).toBe(result.errors[0]?.start);
    }
  };

  it('[QRY-001] hold for arbitrary strings', () => {
    fc.assert(fc.property(fc.string({ maxLength: 120 }), check), { numRuns: 500 });
    fc.assert(fc.property(fc.string({ unit: 'binary', maxLength: 60 }), check), { numRuns: 300 });
  });

  it('[QRY-001] hold for token soup', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...TOKENS), { maxLength: 40 }),
        fc.constantFrom(' ', '', '  '),
        (tokens, glue) => check(tokens.join(glue)),
      ),
      { numRuns: 1_000 },
    );
  });
});
