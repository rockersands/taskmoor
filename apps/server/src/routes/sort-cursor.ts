import { z } from 'zod';

const MAX_INT = 2_147_483_647;
/** Characters of the text half at most: four times a 255-character name, for what lower() widens. */
const MOST_TEXT = 1020;

/**
 * Where the next page of a list sorted by a text and then the id starts (T-310): the last row's
 * text, as the database sorted it, and its id. The id breaks ties, so rows with the same text
 * are never skipped or repeated from one page to the next. Opaque to clients: base64url JSON.
 */
export function encodeSortCursor(text: string, id: number): string {
  return Buffer.from(JSON.stringify([text, id]), 'utf8').toString('base64url');
}

/** The text and id a cursor of `encodeSortCursor` holds; null for anything else. */
export function decodeSortCursor(cursor: string): [string, number] | null {
  if (!/^[A-Za-z0-9_-]{1,2000}$/.test(cursor)) return null;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [text, id] = value as [unknown, unknown];
  if (typeof text !== 'string' || text.length > MOST_TEXT || text.includes('\0')) return null;
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 1 || id > MAX_INT) return null;
  return [text, id];
}

/** The `after` query parameter of a list paged by `encodeSortCursor`. */
export const sortCursorParam = z
  .string()
  .min(1)
  .max(2000)
  .regex(/^[A-Za-z0-9_-]+$/)
  .refine((v) => decodeSortCursor(v) !== null)
  .meta({ description: 'The `next` of the page before; the list starts after it.' });
