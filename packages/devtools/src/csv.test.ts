import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import { parseCsv, parseCsvRecords, toCsv } from './csv';

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, commas and newlines inside fields', () => {
    const text = 'a,"b, c","say ""hi""","line\nbreak"\r\nx,,z\n';
    expect(parseCsv(text)).toEqual([
      ['a', 'b, c', 'say "hi"', 'line\nbreak'],
      ['x', '', 'z'],
    ]);
  });

  it('accepts a missing final newline and a byte-order mark', () => {
    expect(parseCsv('﻿a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('rejects an unterminated quoted field', () => {
    expect(() => parseCsv('a,"open\n')).toThrow(/inside a quoted field/);
  });

  it('round-trips anything toCsv writes', () => {
    const field = fc.string({ unit: fc.constantFrom('a', 'Z', ' ', ',', '"', '\n', '\r', 'é') });
    const rows = fc.array(fc.array(field, { minLength: 1, maxLength: 5 }), { maxLength: 6 });
    fc.assert(
      fc.property(rows, (input) => {
        expect(parseCsv(toCsv(input))).toEqual(input);
      }),
    );
  });
});

describe('parseCsvRecords', () => {
  it('keys rows by header and skips blank lines', () => {
    expect(parseCsvRecords('id,name\n1,One\n\n2,Two\n')).toEqual([
      { id: '1', name: 'One' },
      { id: '2', name: 'Two' },
    ]);
  });

  it('names the row whose field count is wrong', () => {
    expect(() => parseCsvRecords('id,name\n1,One\n2\n')).toThrow(/row 3 has 1 fields/);
  });
});
