import type { JsonValue } from '@taskmoor/db';
import { schema } from '@taskmoor/richtext';
import { looksLikeKey, normalizeKey } from '../tracks/model';

/**
 * The ticket as a domain object (M1-008; CORE-001, CORE-008, CORE-025, spec 01a section 1.3):
 * ticket keys, the summary and rich text rules, and how long the trash keeps a ticket.
 */

/** Spec 01a section 1.3: a summary is required and at most 255 characters. */
export const SUMMARY_MAX = 255;

/** The longest rich text field, in characters of text (spec 01a section 1.4, Paragraph). */
export const RICH_TEXT_MAX_CHARS = 100_000;
/** A guard on the stored document, whose markup outweighs its text. */
export const RICH_TEXT_MAX_BYTES = 2_000_000;

/**
 * Days the trash keeps a deleted ticket or track before the purge removes it for good
 * (CORE-025 (3)): the default and the bounds of the workspace setting (`trash_policy`, M1-101).
 */
export const DEFAULT_TRASH_RETENTION_DAYS = 30;
export const MIN_TRASH_RETENTION_DAYS = 1;
export const MAX_TRASH_RETENTION_DAYS = 365;

/** When something deleted at `deletedAt` leaves the trash for good. */
export function purgeAfter(deletedAt: Date, retentionDays: number): Date {
  return new Date(deletedAt.getTime() + retentionDays * 86_400_000);
}

/** Ticket numbers are positive and fit the integer column. */
const MAX_NUMBER = 2_147_483_647;

/** KEY-n: a track key under the import rule (so old and imported keys resolve), then a number. */
export function parseTicketKey(ref: string): { trackKey: string; number: number } | null {
  const at = ref.lastIndexOf('-');
  if (at <= 0) return null;
  const trackKey = ref.slice(0, at);
  const digits = ref.slice(at + 1).trim();
  if (!/^[1-9][0-9]{0,9}$/.test(digits)) return null;
  const number = Number(digits);
  if (number > MAX_NUMBER || !looksLikeKey(trackKey)) return null;
  return { trackKey: normalizeKey(trackKey), number };
}

export function ticketKey(trackKey: string, number: number): string {
  return `${trackKey}-${number}`;
}

export type RichTextProblem = 'invalid' | 'too_long';

/**
 * A rich text value as stored: the document normalised through the shared schema (ADR-014),
 * or null for an empty one. Anything the schema does not accept is refused, so the editor and
 * the importer always read back a document they know.
 */
export function checkRichText(
  value: unknown,
): { ok: true; doc: JsonValue | null } | { ok: false; problem: RichTextProblem } {
  if (value === null) return { ok: true, doc: null };
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, problem: 'invalid' };
  if (JSON.stringify(value).length > RICH_TEXT_MAX_BYTES) return { ok: false, problem: 'too_long' };
  try {
    const node = schema.nodeFromJSON(value);
    if (node.type.name !== 'doc') return { ok: false, problem: 'invalid' };
    node.check();
    if (node.textContent.length > RICH_TEXT_MAX_CHARS) return { ok: false, problem: 'too_long' };
    // A document with nothing in it is no description at all.
    const empty =
      node.childCount === 0 ||
      (node.childCount === 1 &&
        node.firstChild?.type.name === 'paragraph' &&
        node.firstChild.childCount === 0);
    return { ok: true, doc: empty ? null : (node.toJSON() as JsonValue) };
  } catch {
    return { ok: false, problem: 'invalid' };
  }
}

/**
 * JSON text with object keys sorted, so two documents compare equal whatever order their keys
 * came in (Postgres stores JSONB keys in its own order).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/** A calendar day as YYYY-MM-DD that exists (no 31 April). */
export function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
