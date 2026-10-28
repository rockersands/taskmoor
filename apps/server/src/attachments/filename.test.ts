import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import { contentDisposition, MAX_NAME_BYTES, safeFilename, uniqueNames } from './filename';

describe('safe file names (CORE-021)', () => {
  it('[CORE-021] keeps only the last path segment, whatever the separator', () => {
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename('/etc/shadow')).toBe('shadow');
    expect(safeFilename('C:\\Windows\\System32\\evil.dll')).toBe('evil.dll');
    expect(safeFilename('..\\..\\boot.ini')).toBe('boot.ini');
    expect(safeFilename('dir/sub/')).toBe('attachment');
    expect(safeFilename('..')).toBe('attachment');
    expect(safeFilename('.')).toBe('attachment');
    expect(safeFilename('')).toBe('attachment');
  });

  it('[CORE-021] strips NUL, control and bidirectional characters', () => {
    expect(safeFilename('report\u0000.pdf')).toBe('report.pdf');
    expect(safeFilename('line\r\nbreak.txt')).toBe('line break.txt');
    // "invoice‮fdp.exe" displays as "invoiceexe.pdf"; without the override it shows what it is.
    expect(safeFilename('invoice\u202efdp.exe')).toBe('invoicefdp.exe');
    expect(safeFilename('zero\u200bwidth.txt')).toBe('zerowidth.txt');
  });

  it('[CORE-021] gives names Windows can save', () => {
    expect(safeFilename('what?<now>.txt')).toBe('what__now_.txt');
    expect(safeFilename('CON.txt')).toBe('_CON.txt');
    expect(safeFilename('lpt1')).toBe('_lpt1');
    expect(safeFilename('trailing dots...')).toBe('trailing dots');
    expect(safeFilename('  spaced   out  .md')).toBe('spaced out .md');
  });

  it('[CORE-021] keeps the extension when a long name is cut to 255 bytes', () => {
    const long = `${'é'.repeat(300)}.tar.gz`;
    const safe = safeFilename(long);
    expect(Buffer.byteLength(safe)).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(safe.endsWith('.gz')).toBe(true);
    expect(safe.normalize('NFC')).toBe(safe);
  });

  it('[CORE-021] never yields a separator, control character or over-long name', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 400 }), (input) => {
        const safe = safeFilename(input);
        expect(safe.length).toBeGreaterThan(0);
        expect(Buffer.byteLength(safe)).toBeLessThanOrEqual(MAX_NAME_BYTES);
        // biome-ignore lint/suspicious/noControlCharactersInRegex: what must never remain
        expect(safe).not.toMatch(/[/\\\u0000-\u001f\u007f<>:"|?*\u202a-\u202e\u2066-\u2069]/);
        expect(safe === '.' || safe === '..').toBe(false);
        // Idempotent: a safe name stays as it is.
        expect(safeFilename(safe)).toBe(safe);
      }),
    );
  });

  it('[CORE-021] writes Content-Disposition per RFC 6266 that cannot be broken out of', () => {
    expect(contentDisposition('attachment', 'plan.pdf')).toBe(
      `attachment; filename="plan.pdf"; filename*=UTF-8''plan.pdf`,
    );
    expect(contentDisposition('inline', 'résumé (final).pdf')).toBe(
      `inline; filename="r_sum_ (final).pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%28final%29.pdf`,
    );
    const hostile = contentDisposition('attachment', 'a"; filename="evil.exe\r\nSet-Cookie: x=1');
    expect(hostile).not.toMatch(/[\r\n]/);
    expect(hostile.match(/"/g)?.length).toBe(2);
  });

  it('[CORE-021] makes names unique within an archive', () => {
    expect(uniqueNames(['a.png', 'A.png', 'a.png', 'b', 'b'])).toEqual([
      'a.png',
      'A (2).png',
      'a (3).png',
      'b',
      'b (2)',
    ]);
  });
});
