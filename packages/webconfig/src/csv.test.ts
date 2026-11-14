import { readFileSync } from 'node:fs';
import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import { bomLength, CSV_BOM, csvField, csvFile, csvLine, withBom } from './csv';

const bytes = (text: string) => [...new TextEncoder().encode(text)];

describe('CSV files, the one rule of every export (T-252)', () => {
  it('[QRY-015] [PLN-014] [IAM-013] guards every cell by one table: quoting, and text that would run as a formula', () => {
    const table = JSON.parse(
      readFileSync(new URL('./csvGuardTable.json', import.meta.url), 'utf8'),
    ) as [string | number | null, string][];
    expect(table.length).toBeGreaterThan(10);
    for (const [value, written] of table) expect(csvField(value)).toBe(written);
    expect(csvField(undefined)).toBe('');
    expect(csvLine(['a', 'b,c', null, 1])).toBe('a,"b,c",,1\r\n');
  });

  it('[QRY-015] [PLN-014] starts a file with a UTF-8 byte-order mark, its bytes EF BB BF, and keeps the commas', () => {
    const text = csvFile([
      ['Versión', 'Título'],
      ['a;b', 1],
    ]);
    expect(bytes(text).slice(0, 3)).toEqual([0xef, 0xbb, 0xbf]);
    expect(text).toBe(`${CSV_BOM}Versión,Título\r\n"a;b",1\r\n`);
    // An empty file is the mark alone: what a spreadsheet opens as an empty sheet.
    expect(csvFile([])).toBe(CSV_BOM);
  });

  it('[QRY-015] [PLN-014] puts the mark in front exactly once', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const once = withBom(text);
        expect(withBom(once)).toBe(once);
        expect(once.startsWith(CSV_BOM)).toBe(true);
        expect(once.slice(1)).toBe(text.startsWith(CSV_BOM) ? text.slice(1) : text);
      }),
    );
    expect(bytes(csvFile([['x']])).filter((b) => b === 0xef)).toHaveLength(1);
  });

  it('[IMP-012] tells an importer how many bytes the mark takes, and nothing else', () => {
    expect(bomLength(new TextEncoder().encode(csvFile([['Key']])))).toBe(3);
    expect(bomLength(new TextEncoder().encode('Key\r\n'))).toBe(0);
    expect(bomLength([0xef, 0xbb])).toBe(0);
    expect(bomLength([0xef, 0xbb, 0xbe])).toBe(0);
    expect(bomLength([])).toBe(0);
  });
});
