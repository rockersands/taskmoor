import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CSV_COLUMNS, csvField, csvLine } from './query';

describe('audit export format (M1-003)', () => {
  it('[PLN-014] guards a cell by the table the web app is held to as well', () => {
    const table = JSON.parse(
      readFileSync(new URL('../../../web/src/plans/csvGuardTable.json', import.meta.url), 'utf8'),
    ) as [string | number | null, string][];
    expect(table.length).toBeGreaterThan(10);
    for (const [value, written] of table) expect(csvField(value)).toBe(written);
  });

  it('[IAM-013] quotes CSV fields that need it and defuses spreadsheet formulas', () => {
    expect(csvField(null)).toBe('');
    expect(csvField(42)).toBe('42');
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('two\nlines')).toBe('"two\nlines"');
    expect(csvField('=HYPERLINK("http://example.com")')).toBe(
      '"\'=HYPERLINK(""http://example.com"")"',
    );
    expect(csvField('+1')).toBe("'+1");
    expect(csvField('@sum')).toBe("'@sum");
  });

  it('writes one line per record in the column order of the header', () => {
    const line = csvLine({
      seq: 7,
      occurredAt: '2026-10-12T08:00:00.000Z',
      recordedAt: '2026-10-12T08:00:01.000Z',
      actor: { id: 3, name: 'Ada', email: 'ada@example.com' },
      action: 'group.created',
      subject: { type: 'group', id: '9' },
      details: { name: 'Ops, west' },
      ip: '203.0.113.5',
      sourceEventId: '55',
      prevHash: 'a'.repeat(64),
      hash: 'b'.repeat(64),
    });
    expect(CSV_COLUMNS).toHaveLength(14);
    expect(line).toBe(
      `7,2026-10-12T08:00:00.000Z,2026-10-12T08:00:01.000Z,3,ada@example.com,Ada,group.created,group,9,203.0.113.5,55,"{""name"":""Ops, west""}",${'a'.repeat(64)},${'b'.repeat(64)}\r\n`,
    );
  });
});
