import type { Database } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';
import { syncPropertyValues } from '../properties/model';
import type { Catalog, FieldDef } from './catalog';
import { type FieldConfig, type FieldType, fold, plainText, type Stored, storageOf } from './types';

/**
 * The side tables of custom field values (M1-011; ADR-008): what each stored value becomes as
 * typed rows, writing them with the ticket in the same transaction, and checking or rebuilding
 * them from `ticket.fields`. Tickets in the trash have no rows; their values come back with
 * them.
 */
type Db = Kysely<Database> | Transaction<Database>;

export const SIDE_TABLES = [
  'v_text',
  'v_number',
  'v_date',
  'v_time',
  'v_user',
  'v_option',
] as const;
export type SideTable = (typeof SIDE_TABLES)[number];
const TABLE_OF = {
  text: 'v_text',
  number: 'v_number',
  date: 'v_date',
  time: 'v_time',
  user: 'v_user',
  option: 'v_option',
} as const satisfies Record<string, SideTable>;

/** Indexed text is short: a paragraph contributes the start of its text (full text: ADR-011). */
export const INDEXED_TEXT_MAX = 255;

export interface SideValue {
  table: SideTable;
  /** Text, a number, an ISO date or instant, or an id. */
  value: string | number;
  /** For text: the case-folded order key. */
  sortKey?: string;
}

/** The side rows one stored value makes: one per label, person, option or other id. */
export function sideValues(
  field: { type: FieldType; config?: FieldConfig },
  value: Stored,
): SideValue[] {
  const table = TABLE_OF[storageOf(field)];
  const text = (s: string): SideValue => ({ table, value: s, sortKey: fold(s) });
  switch (field.type) {
    case 'formula':
      // A formula is indexed as its output: text, a date, or a number (durations in seconds).
      return table === 'v_text'
        ? [text(value as string)]
        : [{ table, value: value as string | number }];
    case 'paragraph': {
      const start = [...plainText(value)].slice(0, INDEXED_TEXT_MAX).join('');
      return start === '' ? [] : [text(start)];
    }
    case 'labels':
      return (value as string[]).map(text);
    case 'text':
    case 'read-only-text':
    case 'url':
      return [text(value as string)];
    case 'number':
    case 'date':
    case 'datetime':
      return [{ table, value: value as string | number }];
    default: {
      const ids = Array.isArray(value) ? (value as number[]) : [value as number];
      return [...new Set(ids)].map((id) => ({ table, value: id }));
    }
  }
}

interface TicketValues {
  id: number;
  workspace_id: number;
  track_id: number;
  /** As Postgres prints it, so the copy keeps its microseconds (side rows order like tickets). */
  created_at: string;
  fields: Record<string, unknown>;
}

const ticketValues = (db: Db) =>
  db
    .selectFrom('ticket')
    .select(['id', 'workspace_id', 'track_id', 'fields', 'deleted_at'])
    .select(sql<string>`created_at::text`.as('created_at'));

/** The rows a ticket's values make, by table, in insertable form. */
function rowsOf(catalog: Catalog, tickets: readonly TicketValues[], only?: ReadonlySet<number>) {
  const out = new Map<SideTable, Record<string, unknown>[]>();
  for (const t of tickets) {
    for (const [key, value] of Object.entries(t.fields)) {
      const fieldId = Number(key);
      if (only && !only.has(fieldId)) continue;
      const field = catalog.fields.get(fieldId);
      if (!field) continue;
      for (const v of sideValues(field, value as Stored)) {
        const list = out.get(v.table) ?? [];
        out.set(v.table, list);
        list.push({
          workspace_id: t.workspace_id,
          ticket_id: t.id,
          track_id: t.track_id,
          field_id: fieldId,
          value: v.value,
          ...(v.sortKey !== undefined ? { sort_key: v.sortKey } : {}),
          created_at: t.created_at,
        });
      }
    }
  }
  return out;
}

const CHUNK = 2000;

/**
 * Rewrites the side rows of tickets from their `fields`, in the caller's transaction: all of a
 * ticket's rows, or those of `fieldIds` only (an edit that changed a few values). Tickets in the
 * trash end with none.
 */
export async function syncFieldValues(
  trx: Transaction<Database>,
  catalog: Catalog,
  ticketIds: readonly number[],
  fieldIds?: readonly number[],
): Promise<void> {
  if (ticketIds.length === 0 || (fieldIds !== undefined && fieldIds.length === 0)) return;
  const ids = [...new Set(ticketIds)];
  // Only the tables the changed fields keep values in (all of them for a field that is gone).
  const tables =
    fieldIds === undefined || fieldIds.some((id) => !catalog.fields.has(id))
      ? SIDE_TABLES
      : [...new Set(fieldIds.map((id) => TABLE_OF[storageOf(catalog.fields.get(id) as FieldDef)]))];
  for (const table of tables) {
    let query = trx.deleteFrom(table).where('ticket_id', 'in', ids);
    if (fieldIds !== undefined) query = query.where('field_id', 'in', [...fieldIds]);
    await query.execute();
  }
  const tickets = await ticketValues(trx)
    .where('id', 'in', ids)
    .where('deleted_at', 'is', null)
    .execute();
  const rows = rowsOf(catalog, tickets, fieldIds ? new Set(fieldIds) : undefined);
  for (const [table, list] of rows) {
    for (let i = 0; i < list.length; i += CHUNK) {
      await trx
        .insertInto(table)
        .values(list.slice(i, i + CHUNK) as never)
        .execute();
    }
  }
  // A full rewrite (create, move, trash, restore, import) also rewrites the indexed property
  // values (M1-129), which copy the same track and creation time and leave with the trash.
  if (fieldIds === undefined) await syncPropertyValues(trx, ids);
}

/** The field ids whose values differ between two `fields` documents. */
export function changedFieldIds(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): number[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null))
    .map(Number);
}

export interface FieldValuesReport {
  /** Tickets read. */
  tickets: number;
  /** Tickets whose side rows did not match their values. */
  mismatched: number[];
  /** Whether the mismatched ones were rewritten. */
  repaired: boolean;
  /** The last ticket id read, to go on from; null at the end. */
  next: number | null;
}

/** A row as text, so expected and stored rows compare whatever types the driver returns. */
function rowKey(table: SideTable, row: Record<string, unknown>): string {
  const raw = row.value instanceof Date ? row.value.toISOString() : String(row.value);
  const value = table === 'v_number' ? String(Number(raw)) : raw;
  return [
    table,
    row.ticket_id,
    row.track_id,
    row.field_id,
    JSON.stringify(value),
    JSON.stringify(row.sort_key ?? null),
    row.created_at,
  ].join('|');
}

/** Stored side rows of tickets, values in the forms `sideValues` gives. */
async function storedRows(db: Db, table: SideTable, ticketIds: readonly number[]) {
  const value = table === 'v_date' || table === 'v_number' ? sql`value::text AS value` : sql`value`;
  const sortKey = table === 'v_text' ? sql`, sort_key` : sql``;
  const { rows } = await sql<Record<string, unknown>>`
    SELECT ticket_id, track_id, field_id, ${value}${sortKey}, created_at::text AS created_at
      FROM ${sql.table(table)} WHERE ticket_id = ANY(${[...ticketIds]}::int[])`.execute(db);
  return rows;
}

/**
 * Checks a batch of tickets' side rows against their values, in ticket id order after `after`,
 * and rewrites the ones that differ when `repair` is set (the repair job of ADR-008).
 */
export async function verifyFieldValues(
  db: Kysely<Database>,
  catalog: Catalog,
  workspaceId: number,
  options: { after?: number; limit?: number; repair?: boolean } = {},
): Promise<FieldValuesReport> {
  const limit = options.limit ?? 1000;
  const tickets = await ticketValues(db)
    .where('workspace_id', '=', workspaceId)
    .where('id', '>', options.after ?? 0)
    .orderBy('id')
    .limit(limit)
    .execute();
  if (tickets.length === 0) return { tickets: 0, mismatched: [], repaired: false, next: null };
  const ids = tickets.map((t) => t.id);
  const expected = new Map<number, string[]>();
  for (const t of tickets) expected.set(t.id, []);
  const live = tickets.filter((t) => t.deleted_at === null);
  for (const [table, rows] of rowsOf(catalog, live)) {
    for (const row of rows) expected.get(row.ticket_id as number)?.push(rowKey(table, row));
  }
  const actual = new Map<number, string[]>();
  for (const t of tickets) actual.set(t.id, []);
  for (const table of SIDE_TABLES) {
    for (const row of await storedRows(db, table, ids)) {
      actual.get(row.ticket_id as number)?.push(rowKey(table, row));
    }
  }
  const same = (a: string[], b: string[]) =>
    a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
  const mismatched = ids.filter(
    (id) => !same(expected.get(id) as string[], actual.get(id) as string[]),
  );
  if (options.repair && mismatched.length > 0) {
    await db.transaction().execute(async (trx) => {
      // Rows are rewritten under the tickets' locks, so a concurrent edit is not undone.
      await trx
        .selectFrom('ticket')
        .select('id')
        .where('id', 'in', mismatched)
        .forUpdate()
        .execute();
      await syncFieldValues(trx, catalog, mismatched);
    });
  }
  return {
    tickets: tickets.length,
    mismatched,
    repaired: options.repair === true && mismatched.length > 0,
    next: tickets.length === limit ? (ids[ids.length - 1] ?? null) : null,
  };
}

/** Refreshes the planner's statistics of the side tables, after a bulk load or a rebuild. */
export async function analyzeFieldValues(db: Db): Promise<void> {
  await sql`ANALYZE v_text, v_number, v_date, v_time, v_user, v_option`.execute(db);
}
