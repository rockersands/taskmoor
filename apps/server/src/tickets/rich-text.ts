import { createHash } from 'node:crypto';
import type { Database, JsonValue, RichTextField } from '@taskmoor/db';
import {
  type AdfNode,
  fromAdfJson,
  fromMarkdown,
  fromWiki,
  type PmJson,
  toAdfFromJson,
  toMarkdown,
  toPlainText,
  toWiki,
} from '@taskmoor/richtext';
import type { Kysely, Transaction } from 'kysely';
import { canonicalJson, checkRichText, RICH_TEXT_MAX_BYTES, type RichTextProblem } from './model';

/**
 * Rich text on the API (M1-017; API-011, NTF-007, IMP-008; ADR-014 "Implementation (M1-017)").
 *
 * - `?format=` picks how a request writes and reads rich text: `doc` (the stored ProseMirror
 *   document, the default), `adf` (the Jira-compatible document format), `markdown`, `wiki`
 *   (wiki markup, M1-071) or `text` (plain text without formatting, for exports; reads only:
 *   a write that carries rich text in it is refused as invalid).
 * - A field written as `adf` keeps that document as its original (`ticket_text_original`),
 *   with the hash of the document converted from it; reading it back as `adf` converts the
 *   stored document, so later edits show.
 */
export const RICH_TEXT_FIELDS = [
  'description',
  'environment',
] as const satisfies readonly RichTextField[];
export const RICH_TEXT_FORMATS = ['doc', 'adf', 'markdown', 'wiki', 'text'] as const;
export type RichTextFormat = (typeof RICH_TEXT_FORMATS)[number];

/** The format a request asks for (`?format=`); `doc` when it names none, null when unknown. */
export function requestedFormat(query: unknown): RichTextFormat | null {
  const value = (query as { format?: unknown } | null | undefined)?.format;
  if (value === undefined) return 'doc';
  return RICH_TEXT_FORMATS.find((f) => f === value) ?? null;
}

export interface ReadText {
  /** The document to store; null for none. */
  doc: JsonValue | null;
  /** The value as written, when it came in the other format (null when it cleared the field). */
  original?: AdfNode | null;
}

/**
 * A rich text value as a request wrote it in `format`, checked against the shared schema
 * (`checkRichText`): the document to store, and the original when there is one to keep.
 */
export function readRichText(
  value: unknown,
  format: RichTextFormat,
): { ok: true; text: ReadText } | { ok: false; problem: RichTextProblem } {
  if (value === null) {
    return { ok: true, text: format === 'adf' ? { doc: null, original: null } : { doc: null } };
  }
  let doc: unknown = value;
  if (format === 'adf') {
    if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, problem: 'invalid' };
    if (JSON.stringify(value).length > RICH_TEXT_MAX_BYTES) {
      return { ok: false, problem: 'too_long' };
    }
    try {
      doc = fromAdfJson(value as AdfNode);
    } catch {
      return { ok: false, problem: 'invalid' };
    }
  } else if (format === 'markdown' || format === 'wiki') {
    if (typeof value !== 'string') return { ok: false, problem: 'invalid' };
    if (value.length > RICH_TEXT_MAX_BYTES) return { ok: false, problem: 'too_long' };
    doc = format === 'markdown' ? fromMarkdown(value) : fromWiki(value);
  } else if (format === 'text') {
    // Plain text is a read format: it has no way to say what the formatting was.
    return { ok: false, problem: 'invalid' };
  }
  const checked = checkRichText(doc);
  if (!checked.ok) return checked;
  return {
    ok: true,
    text:
      format === 'adf'
        ? { doc: checked.doc, original: checked.doc === null ? null : (value as AdfNode) }
        : { doc: checked.doc },
  };
}

/** A stored document as a response gives it in `format`. */
export function writeRichText(doc: JsonValue | null, format: RichTextFormat): unknown {
  if (doc === null || format === 'doc') return doc;
  const json = doc as unknown as PmJson;
  switch (format) {
    case 'adf':
      return toAdfFromJson(json);
    case 'markdown':
      return toMarkdown(json);
    case 'wiki':
      return toWiki(json);
    default:
      return toPlainText(json);
  }
}

/** A ticket view with its rich text in `format`. */
export function inFormat<
  T extends { description: JsonValue | null; environment: JsonValue | null },
>(view: T, format: RichTextFormat): T {
  if (format === 'doc') return view;
  return {
    ...view,
    description: writeRichText(view.description, format),
    environment: writeRichText(view.environment, format),
  } as T;
}

/** SHA-256 of a document's canonical JSON: what originals and collaboration states hold. */
export function docHash(doc: JsonValue | null | undefined): string {
  return createHash('sha256')
    .update(canonicalJson(doc ?? null))
    .digest('hex');
}

/**
 * Keeps the originals of the fields a write took in the other format (IMP-008 (3)), in the
 * write's transaction: a value replaces the one kept, a cleared field drops it.
 */
export async function keepOriginals(
  trx: Transaction<Database>,
  workspaceId: number,
  ticketId: number,
  texts: Partial<Record<RichTextField, ReadText>>,
  actorId: number | null,
): Promise<void> {
  for (const field of RICH_TEXT_FIELDS) {
    const text = texts[field];
    if (text?.original === undefined) continue;
    if (text.original === null || text.doc === null) {
      await trx
        .deleteFrom('ticket_text_original')
        .where('ticket_id', '=', ticketId)
        .where('field', '=', field)
        .execute();
      continue;
    }
    const row = {
      ticket_id: ticketId,
      workspace_id: workspaceId,
      field,
      format: 'adf' as const,
      source: JSON.stringify(text.original),
      doc_sha256: docHash(text.doc),
      written_by: actorId,
      written_at: new Date(),
    };
    await trx
      .insertInto('ticket_text_original')
      .values(row)
      .onConflict((oc) =>
        oc.columns(['ticket_id', 'field']).doUpdateSet({
          format: row.format,
          source: row.source,
          doc_sha256: row.doc_sha256,
          written_by: row.written_by,
          written_at: row.written_at,
        }),
      )
      .execute();
  }
}

/** The original kept for a field, if any. */
export function loadOriginal(
  db: Kysely<Database> | Transaction<Database>,
  ticketId: number,
  field: RichTextField,
) {
  return db
    .selectFrom('ticket_text_original as o')
    .leftJoin('app_user as u', 'u.id', 'o.written_by')
    .select([
      'o.format',
      'o.source',
      'o.doc_sha256',
      'o.written_at',
      'o.written_by',
      'u.name as written_by_name',
    ])
    .where('o.ticket_id', '=', ticketId)
    .where('o.field', '=', field)
    .executeTakeFirst();
}
