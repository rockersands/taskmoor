import { CSV_BOM, csvFile } from '@taskmoor/webconfig';
import { describe, expect, it } from 'vitest';
import { parsePeopleCsv } from './people';

describe('the people file of an import (M1-095)', () => {
  it('[IMP-007] reads a file with a byte-order mark as a spreadsheet saves it, the mark left out', () => {
    const rows = [
      { source: '2', target: 'bea@example.org' },
      { source: 'cyd@example.com', target: 'nobody@example.org' },
    ];
    // Saved by Excel as "CSV UTF-8": the mark, then the rows, no header.
    const bare = `${CSV_BOM}2,bea@example.org\r\nCyd@Example.com,nobody@example.org\r\n`;
    expect(parsePeopleCsv(bare)).toEqual(rows);
    // As Taskmoor's own exports write it (T-252): the mark once, a header, then the rows.
    const exported = csvFile([
      ['source', 'taskmoor'],
      ['2', 'bea@example.org'],
      ['cyd@example.com', 'nobody@example.org'],
    ]);
    expect(parsePeopleCsv(exported)).toEqual(rows);
  });
});

describe('the people file in the separator a spreadsheet chose (T-263)', () => {
  it('[IMP-007] [IMP-012] finds semicolons, tabs and pipes from the first row, as the CSV import does', () => {
    const rows = [
      { source: '2', target: 'bea@example.org' },
      { source: 'cyd@example.com', target: 'nobody@example.org' },
    ];
    // Saved by a Spanish Excel: semicolons, with a header or without.
    expect(parsePeopleCsv('2;bea@example.org\r\ncyd@example.com;nobody@example.org\r\n')).toEqual(
      rows,
    );
    expect(
      parsePeopleCsv(
        csvFile(
          [
            ['origen', 'taskmoor'],
            ['2', 'bea@example.org'],
            ['cyd@example.com', 'nobody@example.org'],
          ],
          'semicolon',
        ),
      ),
    ).toEqual(rows);
    expect(parsePeopleCsv('2\tbea@example.org\ncyd@example.com\tnobody@example.org')).toEqual(rows);
    expect(parsePeopleCsv('2|bea@example.org\ncyd@example.com|nobody@example.org')).toEqual(rows);
  });
});
