import type { Database } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';
import { fold } from '../fields/types';

/**
 * Entity properties (M1-129; API-013; ADR-083): JSON documents that integrations keep on a
 * ticket, track, person, board or sprint under a key of their own, and the declared property
 * indexes that make one value inside a ticket's property searchable.
 *
 * - A key is 1 to 255 characters with no control characters; a value is any JSON document of
 *   at most 32,768 bytes as JSON text.
 * - A property index names a ticket property's key, a dot path inside its document ('' for the
 *   whole value) and a type. The values it finds there become rows of a typed side table
 *   (`p_text`, `p_number`, `p_time`, `p_user`), shaped like the custom field ones so the search
 *   compiler reads them the same way. An array anywhere along the path gives one value per
 *   element; a value of the wrong type is skipped, as the index never fails a write.
 * - `syncPropertyValues` rewrites a ticket's rows in the caller's transaction: after a property
 *   is set or deleted, when an index is declared, and with every full rewrite of a ticket's
 *   custom field rows (create, move, trash, restore, import), so tickets in the trash have none.
 */
type Db = Kysely<Database> | Transaction<Database>;

export const PROPERTY_KINDS = ['ticket', 'track', 'user', 'board', 'sprint'] as const;
export type PropertyKind = (typeof PROPERTY_KINDS)[number];

export const PROPERTY_TABLE = {
  ticket: 'ticket_property',
  track: 'track_property',
  user: 'user_property',
  board: 'board_property',
  sprint: 'sprint_property',
} as const satisfies Record<PropertyKind, keyof Database>;

export const OWNER_COLUMN = {
  ticket: 'ticket_id',
  track: 'track_id',
  user: 'user_id',
  board: 'board_id',
  sprint: 'sprint_id',
} as const satisfies Record<PropertyKind, string>;

export const MAX_KEY_LENGTH = 255;
export const MAX_VALUE_BYTES = 32_768;
export const MAX_PATH_LENGTH = 255;
/** Indexed text is short, as custom text is (ADR-008): the start of a longer string. */
export const INDEXED_PROPERTY_TEXT = 255;

/** Why a key is refused, or null. */
export function keyProblem(key: string): string | null {
  if (key.length === 0) return 'empty';
  if (key.length > MAX_KEY_LENGTH) return 'too_long';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  if (/[\u0000-\u001f\u007f]/.test(key)) return 'control_character';
  return null;
}

/** The size of a value as JSON text, the measure of the 32,768-byte limit. */
export const valueBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), 'utf8');

export const INDEX_TYPES = ['number', 'string', 'text', 'date', 'user'] as const;
export type IndexType = (typeof INDEX_TYPES)[number];

export interface PropertyIndex {
  id: number;
  key: string;
  /** Dot-separated names inside the document; '' for the whole value. */
  path: string;
  type: IndexType;
  alias: string | null;
}

/** Why a path is refused, or null: names separated by single dots, nothing empty. */
export function pathProblem(path: string): string | null {
  if (path === '') return null;
  if (path.length > MAX_PATH_LENGTH) return 'too_long';
  if (path.split('.').some((s) => s === '')) return 'empty_segment';
  return null;
}

/** The values a path finds in a document; arrays along the way give one value per element. */
export function valuesAt(document: unknown, path: string): unknown[] {
  let current: unknown[] = [document];
  const segments = path === '' ? [] : path.split('.');
  for (const segment of segments) {
    const next: unknown[] = [];
    for (const value of current.flatMap(spread)) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const inner = (value as Record<string, unknown>)[segment];
        if (inner !== undefined) next.push(inner);
      }
    }
    current = next;
  }
  return current.flatMap(spread).filter((v) => v !== null && v !== undefined);
}

const spread = (value: unknown): unknown[] =>
  Array.isArray(value) ? value.flatMap(spread) : [value];

/** The side table an index type keeps its values in. */
export const VALUE_TABLE = {
  number: 'p_number',
  string: 'p_text',
  text: 'p_text',
  date: 'p_time',
  user: 'p_user',
} as const satisfies Record<IndexType, keyof Database>;
export type PropertyValueTable = (typeof VALUE_TABLE)[IndexType];
const VALUE_TABLES = ['p_text', 'p_number', 'p_time', 'p_user'] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/** A JSON value as an indexed value of the type, or null when it is not one. */
export function indexedValue(
  type: Exclude<IndexType, 'user'>,
  value: unknown,
): { value: string | number; sortKey?: string } | null {
  switch (type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? { value } : null;
    case 'string':
    case 'text': {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        return null;
      }
      const text = String(value).slice(0, INDEXED_PROPERTY_TEXT);
      return text === '' ? null : { value: text, sortKey: fold(text) };
    }
    case 'date': {
      if (typeof value !== 'string') return null;
      const iso = ISO_DATE.test(value) ? `${value}T00:00:00Z` : value;
      if (!ISO_DATE.test(value) && !ISO_INSTANT.test(value)) return null;
      const time = Date.parse(iso);
      return Number.isNaN(time) ? null : { value: new Date(time).toISOString() };
    }
  }
}

export async function propertyIndexes(
  db: Db,
  workspaceId: number,
  key?: string,
): Promise<PropertyIndex[]> {
  let query = db
    .selectFrom('property_index')
    .select(['id', 'key', 'path', 'type', 'alias'])
    .where('workspace_id', '=', workspaceId)
    .orderBy('id');
  if (key !== undefined) query = query.where('key', '=', key);
  const rows = await query.execute();
  return rows.map((r) => ({ ...r, type: r.type as IndexType }));
}

const CHUNK = 2000;

/**
 * Rewrites the indexed property values of tickets, in the caller's transaction: every index,
 * or those of one key (a property set or deleted), or some indexes (one just declared).
 */
export async function syncPropertyValues(
  trx: Transaction<Database>,
  ticketIds: readonly number[],
  only: { key?: string; indexIds?: readonly number[] } = {},
): Promise<void> {
  if (ticketIds.length === 0) return;
  const ids = [...new Set(ticketIds)];
  const tickets = await trx
    .selectFrom('ticket')
    .select(['id', 'workspace_id', 'track_id', 'deleted_at'])
    .select(sql<string>`created_at::text`.as('created_at'))
    .where('id', 'in', ids)
    .execute();
  const workspaces = [...new Set(tickets.map((t) => t.workspace_id))];
  for (const ws of workspaces) {
    let indexes = await propertyIndexes(trx, ws, only.key);
    if (only.indexIds) indexes = indexes.filter((i) => only.indexIds?.includes(i.id));
    if (indexes.length === 0) continue;
    const inWorkspace = tickets.filter((t) => t.workspace_id === ws);
    const wsIds = inWorkspace.map((t) => t.id);
    const indexIds = indexes.map((i) => i.id);
    for (const table of VALUE_TABLES) {
      await trx
        .deleteFrom(table)
        .where('ticket_id', 'in', wsIds)
        .where('field_id', 'in', indexIds)
        .execute();
    }
    const live = inWorkspace.filter((t) => t.deleted_at === null);
    if (live.length === 0) continue;
    const keys = [...new Set(indexes.map((i) => i.key))];
    const properties = await trx
      .selectFrom('ticket_property')
      .select(['ticket_id', 'key', 'value'])
      .where(
        'ticket_id',
        'in',
        live.map((t) => t.id),
      )
      .where('key', 'in', keys)
      .execute();
    const ticketOf = new Map(live.map((t) => [t.id, t]));
    const rows = new Map<PropertyValueTable, Map<string, Record<string, unknown>>>();
    const people: { row: Record<string, unknown>; ref: unknown }[] = [];
    for (const property of properties) {
      const ticket = ticketOf.get(property.ticket_id);
      if (!ticket) continue;
      for (const index of indexes) {
        if (index.key !== property.key) continue;
        const table = VALUE_TABLE[index.type];
        for (const found of valuesAt(property.value, index.path)) {
          const base = {
            workspace_id: ws,
            ticket_id: ticket.id,
            track_id: ticket.track_id,
            field_id: index.id,
            created_at: ticket.created_at,
          };
          if (index.type === 'user') {
            people.push({ row: base, ref: found });
            continue;
          }
          const value = indexedValue(index.type, found);
          if (!value) continue;
          const row: Record<string, unknown> = { ...base, value: value.value };
          if (table === 'p_text') row.sort_key = value.sortKey;
          const byKey = rows.get(table) ?? new Map();
          byKey.set(`${ticket.id}:${index.id}:${value.value}`, row);
          rows.set(table, byKey);
        }
      }
    }
    if (people.length > 0) {
      const resolved = await peopleByRef(
        trx,
        ws,
        people.map((p) => p.ref),
      );
      const byKey = new Map<string, Record<string, unknown>>();
      for (const { row, ref } of people) {
        const userId = resolved.get(refKey(ref));
        if (userId === undefined) continue;
        byKey.set(`${row.ticket_id}:${row.field_id}:${userId}`, { ...row, value: userId });
      }
      rows.set('p_user', byKey);
    }
    for (const [table, byKey] of rows) {
      const list = [...byKey.values()];
      for (let i = 0; i < list.length; i += CHUNK) {
        await trx
          .insertInto(table)
          .values(list.slice(i, i + CHUNK) as never)
          .execute();
      }
    }
  }
}

const refKey = (ref: unknown): string =>
  typeof ref === 'number' ? `id:${ref}` : `email:${String(ref).toLowerCase()}`;

/** People a user index names: a person's id, or an email address (any case). */
async function peopleByRef(
  db: Db,
  workspaceId: number,
  refs: readonly unknown[],
): Promise<Map<string, number>> {
  const ids = [
    ...new Set(refs.filter((r): r is number => typeof r === 'number' && Number.isSafeInteger(r))),
  ];
  const emails = [
    ...new Set(
      refs
        .filter((r): r is string => typeof r === 'string' && r.includes('@'))
        .map((r) => r.toLowerCase()),
    ),
  ];
  const out = new Map<string, number>();
  if (ids.length === 0 && emails.length === 0) return out;
  const rows = await db
    .selectFrom('app_user')
    .select(['id', 'email'])
    .where('workspace_id', '=', workspaceId)
    .where((eb) => {
      const parts = [];
      if (ids.length > 0) parts.push(eb('id', 'in', ids));
      if (emails.length > 0) parts.push(eb(sql`lower(email)`, 'in', emails));
      return eb.or(parts);
    })
    .execute();
  for (const r of rows) {
    out.set(`id:${r.id}`, r.id);
    if (r.email) out.set(`email:${r.email.toLowerCase()}`, r.id);
  }
  return out;
}
