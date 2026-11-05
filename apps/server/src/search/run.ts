import { createHash } from 'node:crypto';
import type { Database } from '@taskmoor/db';
import {
  type Catalogue,
  clauses,
  parseQuery,
  type Query,
  resolveQuery,
  type Value,
} from '@taskmoor/query';
import { type Kysely, type RawBuilder, sql, type Transaction } from 'kysely';
import type { TrackPermission } from '../authz/permissions';
import type { Catalog } from '../fields/catalog';
import { commentReadableSql } from '../tickets/comments';
import { bindPlan } from './bind';
import { type CompiledSearch, type Cursor, compileSearch, type PageRow } from './compile';
import { COUNT_CAP, countMatches, type Total } from './count';
import type { CrossTrackSight } from './cross-track';
import type { Bound, Scalar } from './model';
import { type ExpandOptions, expandSavedSearches } from './saved';

/**
 * Running a query (M1-037; QRY-008 to QRY-010): text to a compiled statement, a page of ids
 * cut by keyset, an optional capped count, and the admin's explain. Every statement runs in a
 * read-only transaction under the search timeout, so no query holds the database for longer
 * than the operator allows (QRY-010 (3)).
 */
type Db = Kysely<Database> | Transaction<Database>;

/** The default search timeout (QRY-010: 30 s unless the operator sets another). */
export const DEFAULT_QUERY_TIMEOUT_MS = 30_000;

export { COUNT_CAP } from './count';

export interface PrepareInput {
  db: Db;
  workspaceId: number;
  catalog: Catalog;
  catalogue: Catalogue;
  /** The viewer's predicate on ticket `k` and the tracks it opens (TicketFilter). */
  filter: { sql: RawBuilder<boolean>; tracks: readonly number[] | 'all' };
  q: string;
  currentUserId: number | null;
  now?: Date;
  /** The person's time zone: dates and date functions are read on its clock (QRY-006). */
  timeZone?: string | null;
  /** The session the person searches from, for `currentLogin()` and `lastLogin()`. */
  sessionId?: number | null;
  /** The tracks where the person holds a permission (`tracksWhereUserHasPermission()`). */
  allowedTracks?: (permission: TrackPermission) => Promise<readonly number[] | 'all'>;
  /** Which releases across tracks the person sees (`crossTrackRelease`; PLN-007). */
  crossTrackSight?: CrossTrackSight;
  /** False keeps the plain ticket-table form (tests compare both). */
  anchor?: boolean;
  /** False keeps one statement instead of value branches (tests compare both). */
  branches?: boolean;
  /** How many matches relevance ranks (tests make it small; `RANKED_CAP`). */
  rankedCap?: number;
  /** Saving a saved search: a reference back to it is a cycle (M1-063). */
  savedSearch?: ExpandOptions['self'];
}

export interface Prepared {
  bound: Bound;
  compiled: CompiledSearch;
}

/** Parses, resolves, binds and compiles; throws QueryError or SearchError for a bad query. */
export async function prepareSearch(input: PrepareInput): Promise<Prepared> {
  // Saved-search references read as the person sees saved searches (M1-063).
  const query = await expandSavedSearches(
    input.db,
    input.workspaceId,
    input.currentUserId,
    parseQuery(input.q),
    input.savedSearch ? { self: input.savedSearch } : {},
  );
  const names = functionNames(query);
  const logins =
    names.has('currentlogin') || names.has('lastlogin')
      ? await loginTimes(input.db, input.workspaceId, input.currentUserId, input.sessionId ?? null)
      : undefined;
  const plan = resolveQuery(query, input.catalogue, {
    currentUserId: input.currentUserId,
    now: input.now ?? new Date(),
    timeZone: input.timeZone ?? null,
    ...(logins ? { logins } : {}),
  });
  const bound = await bindPlan(plan, {
    db: input.db,
    workspaceId: input.workspaceId,
    catalog: input.catalog,
    catalogue: input.catalogue,
    currentUserId: input.currentUserId,
    filter: input.filter.sql,
    ...(input.allowedTracks ? { allowedTracks: input.allowedTracks } : {}),
    ...(input.crossTrackSight ? { crossTrackSight: input.crossTrackSight } : {}),
  });
  const compiled = compileSearch(bound, {
    workspaceId: input.workspaceId,
    filter: input.filter.sql,
    tracks: input.filter.tracks,
    comments: commentReadableSql(input.workspaceId, input.currentUserId),
    commentsOf: (track) => commentReadableSql(input.workspaceId, input.currentUserId, track),
    ...(input.anchor === undefined ? {} : { anchor: input.anchor }),
    ...(input.branches === undefined ? {} : { branches: input.branches }),
    ...(input.rankedCap === undefined ? {} : { rankedCap: input.rankedCap }),
  });
  return { bound, compiled };
}

/** The functions a query calls, by lower-case name, arguments and history predicates included. */
export function functionNames(query: Query): Set<string> {
  const names = new Set<string>();
  const visit = (v: Value) => {
    if (v.kind !== 'function') return;
    names.add(v.name.toLowerCase());
    for (const a of v.args) visit(a);
  };
  for (const c of clauses(query.where)) {
    if (c.kind === 'compare') visit(c.value);
    if (c.kind === 'in' || c.kind === 'was') for (const v of c.values) visit(v);
    if (c.kind === 'was' || c.kind === 'changed') {
      for (const p of c.predicates) for (const v of p.values) visit(v);
    }
  }
  return names;
}

/**
 * When the person signed in this time and the time before (`currentLogin()`, `lastLogin()`;
 * M1-038): this time is the session's start (with an API token, the latest sign-in), the time
 * before the latest session started earlier. Sessions removed at sign-out take their start
 * with them; without an earlier one, `lastLogin()` reads as this sign-in.
 */
export async function loginTimes(
  db: Db,
  workspaceId: number,
  userId: number | null,
  sessionId: number | null,
): Promise<{ current: Date | null; last: Date | null } | undefined> {
  if (userId === null) return undefined;
  const sessions = db
    .selectFrom('user_session')
    .select('created_at')
    .where('workspace_id', '=', workspaceId)
    .where('user_id', '=', userId);
  const own =
    sessionId === null ? undefined : await sessions.where('id', '=', sessionId).executeTakeFirst();
  let current = own?.created_at ?? null;
  if (!current) {
    const latest = await sessions.orderBy('created_at', 'desc').limit(1).executeTakeFirst();
    const user = await db
      .selectFrom('app_user')
      .select('last_sign_in_at')
      .where('id', '=', userId)
      .executeTakeFirst();
    current = latest?.created_at ?? user?.last_sign_in_at ?? null;
  }
  if (!current) return { current: null, last: null };
  const before = await sessions
    .where('created_at', '<', current)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  return { current, last: before?.created_at ?? null };
}

/** A cursor that does not belong to this query. */
export class CursorError extends Error {}

const signatureOf = (compiled: CompiledSearch) =>
  createHash('sha256').update(compiled.signature).digest('base64url').slice(0, 12);

/** The cursor after a row: its order values and id, tied to the query's order. */
export function encodeCursor(compiled: CompiledSearch, row: PageRow): string {
  const values = compiled.keys.map((_, i) => row[`c${i}`] ?? null);
  const body = JSON.stringify({ s: signatureOf(compiled), v: values, i: row.id });
  return Buffer.from(body).toString('base64url');
}

export function decodeCursor(compiled: CompiledSearch, text: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch {
    throw new CursorError('unreadable cursor');
  }
  const c = parsed as { s?: unknown; v?: unknown; i?: unknown };
  if (c.s !== signatureOf(compiled)) throw new CursorError('the cursor belongs to another order');
  if (!Array.isArray(c.v) || c.v.length !== compiled.keys.length) {
    throw new CursorError('unreadable cursor');
  }
  if (!Number.isSafeInteger(c.i)) throw new CursorError('unreadable cursor');
  const values = c.v.map((v: unknown) => {
    if (v === null || typeof v === 'number' || typeof v === 'string') return v as Scalar | null;
    throw new CursorError('unreadable cursor');
  });
  return { values, id: c.i as number };
}

/** Whether an error is the statement timeout stopping a query (SQLSTATE 57014). */
export function isQueryTimeout(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === '57014';
}

/** Runs `work` in a read-only transaction whose statements stop after `timeoutMs`. */
export async function readOnly<T>(
  db: Kysely<Database>,
  timeoutMs: number,
  work: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  return db
    .transaction()
    .setAccessMode('read only')
    .execute(async (trx) => {
      await sql`SELECT set_config('statement_timeout', ${String(Math.max(1, Math.round(timeoutMs)))}, true)`.execute(
        trx,
      );
      return work(trx);
    });
}

export interface PageResult {
  ids: number[];
  next: string | null;
  total?: Total;
}

/**
 * One page of ids after `after`, and the total when asked: exact up to the cap, beyond it an
 * estimate within 10% (`count.ts`).
 */
export async function runPage(
  db: Kysely<Database>,
  compiled: CompiledSearch,
  options: {
    limit: number;
    after?: Cursor;
    count?: boolean;
    countCap?: number;
    timeoutMs: number;
  },
): Promise<PageResult> {
  return readOnly(db, options.timeoutMs, async (trx) => {
    const { rows } = await compiled.page(options.limit + 1, options.after).execute(trx);
    const page = rows.slice(0, options.limit);
    const last = page[page.length - 1];
    const result: PageResult = {
      ids: page.map((r) => r.id),
      next: rows.length > options.limit && last ? encodeCursor(compiled, last) : null,
    };
    if (options.count) {
      result.total = await countMatches(trx, compiled, options.countCap ?? COUNT_CAP);
    }
    return result;
  });
}

/**
 * Every matching id in the query's order, a keyset page at a time, up to `max` (bulk changes
 * by query, M1-037): `more` says that there were more than `max`.
 */
export async function collectIds(
  db: Kysely<Database>,
  compiled: CompiledSearch,
  options: { max: number; timeoutMs: number; pageSize?: number },
): Promise<{ ids: number[]; more: boolean }> {
  const size = options.pageSize ?? 1000;
  const ids: number[] = [];
  let after: Cursor | undefined;
  for (;;) {
    const rows = await readOnly(db, options.timeoutMs, async (trx) => {
      return (await compiled.page(size, after).execute(trx)).rows;
    });
    for (const row of rows) {
      if (ids.length === options.max) return { ids, more: true };
      ids.push(row.id);
    }
    const last = rows[rows.length - 1];
    if (rows.length < size || !last) return { ids, more: false };
    after = { values: compiled.keys.map((_, i) => last[`c${i}`] ?? null), id: last.id };
  }
}

export interface Explanation {
  sql: string;
  parameters: readonly unknown[];
  anchored: boolean;
  branched: boolean;
  plan: unknown;
}

/** The statement of a page and the planner's plan for it, run when `analyze` (QRY-010 (2)). */
export async function explainSearch(
  db: Kysely<Database>,
  compiled: CompiledSearch,
  options: { limit: number; analyze: boolean; timeoutMs: number },
): Promise<Explanation> {
  const statement = compiled.page(options.limit + 1);
  const text = statement.compile(db);
  const mode = options.analyze ? sql`FORMAT JSON, ANALYZE, BUFFERS` : sql`FORMAT JSON`;
  const plan = await readOnly(db, options.timeoutMs, async (trx) => {
    const { rows } = await sql<{ 'QUERY PLAN': unknown }>`EXPLAIN (${mode}) ${statement}`.execute(
      trx,
    );
    return rows[0]?.['QUERY PLAN'];
  });
  return {
    sql: text.sql,
    parameters: text.parameters,
    anchored: compiled.anchored,
    branched: compiled.branched,
    plan,
  };
}
