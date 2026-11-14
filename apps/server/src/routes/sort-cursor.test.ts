import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import { decodeSortCursor, encodeSortCursor, sortCursorParam } from './sort-cursor';

describe('the cursor of a list sorted by a text, then id (T-310)', () => {
  it('[QRY-011] [IAM-030] gives back the text and id it was made from, whatever the text', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 1020, unit: 'grapheme' }).filter((t) => !t.includes('\0')),
        fc.integer({ min: 1, max: 2_147_483_647 }),
        (text, id) => {
          const cursor = encodeSortCursor(text, id);
          if (cursor.length > 2000) return;
          expect(sortCursorParam.safeParse(cursor).success).toBe(true);
          expect(decodeSortCursor(cursor)).toEqual([text, id]);
        },
      ),
    );
  });

  it('[QRY-011] [IAM-030] refuses anything it did not make', () => {
    const made = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    for (const cursor of [
      '',
      'not a cursor',
      'bm90IGpzb24',
      made(['a', 0]),
      made(['a', 1.5]),
      made(['a', 2_147_483_648]),
      made(['a\0b', 1]),
      made(['x'.repeat(1021), 1]),
      made([1, 1]),
      made(['a', 1, 2]),
      made({ text: 'a', id: 1 }),
    ]) {
      expect(decodeSortCursor(cursor), cursor).toBeNull();
      expect(sortCursorParam.safeParse(cursor).success, cursor).toBe(false);
    }
  });
});
