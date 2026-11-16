import { readFileSync } from 'node:fs';
import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import {
  automaticCsvSeparator,
  bomLength,
  CSV_BOM,
  CSV_DELIMITERS,
  type CsvSeparator,
  csvField,
  csvFile,
  csvLine,
  detectDelimiter,
  withBom,
} from './csv';

const bytes = (text: string) => [...new TextEncoder().encode(text)];

describe('CSV files, the one rule of every export (T-252)', () => {
  it('[QRY-015] [PLN-014] [IAM-013] guards every cell by one table, in both styles: quoting, numbers, and text that would run as a formula', () => {
    const table = JSON.parse(
      readFileSync(new URL('./csvGuardTable.json', import.meta.url), 'utf8'),
    ) as [string | number | null, string, string][];
    expect(table.length).toBeGreaterThan(10);
    for (const [value, comma, semicolon] of table) {
      expect(csvField(value)).toBe(comma);
      expect(csvField(value, 'comma')).toBe(comma);
      expect(csvField(value, 'semicolon')).toBe(semicolon);
    }
    expect(csvField(undefined)).toBe('');
    expect(csvLine(['a', 'b,c', null, 1])).toBe('a,"b,c",,1\r\n');
    expect(csvLine(['a', 'b,c', null, 1.5], 'semicolon')).toBe('a;"b,c";;1,5\r\n');
  });

  it('[QRY-015] [PLN-014] starts a file with a UTF-8 byte-order mark, its bytes EF BB BF, in both styles', () => {
    const rows = [
      ['Versión', 'Título'],
      ['a;b', 1.5],
    ];
    const text = csvFile(rows);
    expect(bytes(text).slice(0, 3)).toEqual([0xef, 0xbb, 0xbf]);
    expect(text).toBe(`${CSV_BOM}Versión,Título\r\n"a;b",1.5\r\n`);
    const semicolons = csvFile(rows, 'semicolon');
    expect(bytes(semicolons).slice(0, 3)).toEqual([0xef, 0xbb, 0xbf]);
    expect(semicolons).toBe(`${CSV_BOM}Versión;Título\r\n"a;b";1,5\r\n`);
    // An empty file is the mark alone: what a spreadsheet opens as an empty sheet.
    expect(csvFile([])).toBe(CSV_BOM);
    expect(csvFile([], 'semicolon')).toBe(CSV_BOM);
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
    for (const style of ['comma', 'semicolon'] as const) {
      expect(bytes(csvFile([['x']], style)).filter((b) => b === 0xef)).toHaveLength(1);
    }
  });

  it('[IMP-012] tells an importer how many bytes the mark takes, and nothing else', () => {
    expect(bomLength(new TextEncoder().encode(csvFile([['Key']])))).toBe(3);
    expect(bomLength(new TextEncoder().encode('Key\r\n'))).toBe(0);
    expect(bomLength([0xef, 0xbb])).toBe(0);
    expect(bomLength([0xef, 0xbb, 0xbe])).toBe(0);
    expect(bomLength([])).toBe(0);
  });
});

describe('the CSV style for a person (T-263)', () => {
  it('[NFR-006] [IAM-008] writes semicolons where the region writes a decimal comma, commas where it writes a point', () => {
    const cases: [string | null | undefined, CsvSeparator][] = [
      ['es', 'semicolon'],
      ['es-ES', 'semicolon'],
      ['es-AR', 'semicolon'],
      ['de-DE', 'semicolon'],
      ['fr-FR', 'semicolon'],
      ['pt-BR', 'semicolon'],
      ['es-MX', 'comma'],
      ['en-US', 'comma'],
      ['en-GB', 'comma'],
      ['ja-JP', 'comma'],
      // The known gap: Swiss German writes a decimal point, while Excel there wants ';'.
      ['de-CH', 'comma'],
      // A tag no browser knows reads as a decimal point.
      ['not a tag', 'comma'],
    ];
    for (const [tag, style] of cases) expect(automaticCsvSeparator(tag), String(tag)).toBe(style);
  });
});

describe('finding the separator of a file (T-263)', () => {
  it('[IMP-012] takes the most frequent of , ; tab and | outside quotes in the header record', () => {
    const of = (text: string) => detectDelimiter(new TextEncoder().encode(text));
    expect(of('Key,Summary,Status\r\nA-1;x;y')).toBe(',');
    expect(of('Clave;Resumen;Estado\r\nA-1,x,y')).toBe(';');
    expect(of('Key\tSummary\tStatus\n')).toBe('\t');
    expect(of('Key|Summary|Status')).toBe('|');
    // Quoted separators do not count; a line break inside quotes does not end the header.
    expect(of('"a,b,c";"d,e";f\n1,2,3,4')).toBe(';');
    expect(of('"line\none";x;y\n1,2,3,4,5')).toBe(';');
    // A byte-order mark is skipped.
    expect(of(`${CSV_BOM}Clave;Resumen`)).toBe(';');
  });

  it('[IMP-012] breaks a tie, or a single column, toward the comma, then in the listed order', () => {
    const of = (text: string) => detectDelimiter(new TextEncoder().encode(text));
    expect(of('a,b;c')).toBe(',');
    expect(of('Summary\nx')).toBe(',');
    expect(of('')).toBe(',');
    expect(of('a;b\tc')).toBe(';');
    expect(of('a\tb|c')).toBe('\t');
  });

  it('[IMP-012] finds the separator a file was written with, for any header of plain names', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CSV_DELIMITERS),
        fc.array(fc.stringMatching(/^[A-Za-zÁ-ú0-9 ]{1,12}$/), { minLength: 2, maxLength: 8 }),
        fc.boolean(),
        (delimiter, header, bom) => {
          const text = `${bom ? CSV_BOM : ''}${header.join(delimiter)}\r\nrest`;
          expect(detectDelimiter(new TextEncoder().encode(text))).toBe(delimiter);
        },
      ),
    );
  });

  it('[IMP-012] reads back the header any export writes, in either style', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ unit: 'binary' }), { minLength: 2, maxLength: 6 }),
        fc.constantFrom<CsvSeparator>('comma', 'semicolon'),
        (header, style) => {
          const file = new TextEncoder().encode(csvFile([header], style));
          expect(detectDelimiter(file)).toBe(style === 'comma' ? ',' : ';');
        },
      ),
    );
  });
});
