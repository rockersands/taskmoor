import type { Database } from '@taskmoor/db';
import { type Kysely, sql } from 'kysely';
import type { Authorizer, Principal } from '../authz/authorizer';
import type { TicketAccessRow } from '../authz/visibility';

/**
 * Reading the change log of ADR-013 (M1-031) for one person: bootstrap, then follow.
 *
 * - **Sync groups** are the tracks the person may browse (or browse some tickets of, through a
 *   ticket-level grant) and the workspace's own group (authorization changes).
 * - **Bootstrap** pages through one track's tickets the person may see, in id order, with the
 *   position to follow from, read before the first page; changes after it arrive by following.
 * - **Follow** returns the rows after a position in the person's groups. Each ticket row is
 *   judged with the person's current permissions against its own snapshot: one they may see
 *   comes with its data, any other as a bare removal of its id. A client that applies them in
 *   order holds exactly the tickets it may see; an `authz` row says groups or visibility may have
 *   changed, so the client bootstraps again. A position older than the trimmed part of the log
 *   answers `resync`.
 */
export interface SyncChange {
  seq: string;
  entity: 'ticket' | 'track' | 'authz';
  id: number;
  trackId: number | null;
  op: 'upsert' | 'delete';
  data?: Record<string, unknown>;
}

type Db = Kysely<Database>;

/** The last numbered row: where a client that has read everything stands. */
export async function logPosition(db: Db, workspaceId: number): Promise<string> {
  const row = await db
    .selectFrom('change_log')
    .select(sql<string>`coalesce(max(seq), 0)::text`.as('seq'))
    .where('workspace_id', '=', workspaceId)
    .where('seq', 'is not', null)
    .executeTakeFirst();
  return row?.seq ?? '0';
}

/** The tracks a person syncs: those with tickets they may see. */
export async function syncTracks(
  db: Db,
  authorizer: Authorizer,
  workspaceId: number,
  principal: Principal,
): Promise<{ id: number; key: string; name: string }[]> {
  const filter = await authorizer.ticketFilter(workspaceId, principal);
  let query = db
    .selectFrom('track')
    .select(['id', 'key', 'name'])
    .where('workspace_id', '=', workspaceId)
    .where('deleted_at', 'is', null);
  if (filter.tracks !== 'all') {
    if (filter.tracks.length === 0) return [];
    query = query.where('id', 'in', [...filter.tracks]);
  } else {
    query = query.where('archived_at', 'is', null);
  }
  return query.orderBy('key').execute();
}

const accessRow = (data: Record<string, unknown>): TicketAccessRow => ({
  id: Number(data.id),
  track_id: Number(data.track_id),
  requester_id: (data.requester_id as number | null) ?? null,
  assignee_id: (data.assignee_id as number | null) ?? null,
  visibility_level_id: (data.visibility_level_id as number | null) ?? null,
  fields: (data.fields as Record<string, unknown> | null) ?? {},
});

/** One track's tickets the person may see, a page at a time, with the position to follow from. */
export async function bootstrapTrack(
  db: Db,
  authorizer: Authorizer,
  workspaceId: number,
  principal: Principal,
  trackId: number,
  options: { after: number; limit: number },
): Promise<{ position: string; tickets: Record<string, unknown>[]; next: number | null } | null> {
  const filter = await authorizer.ticketFilter(workspaceId, principal);
  if (filter.tracks !== 'all' && !filter.tracks.includes(trackId)) return null;
  // Read first: whatever changes after it reaches the client by following.
  const position = await logPosition(db, workspaceId);
  const rows = await db
    .selectFrom('ticket as k')
    .select([
      'k.id',
      sql<Record<string, unknown>>`to_jsonb(k) - 'description' - 'environment'`.as('data'),
    ])
    .where('k.workspace_id', '=', workspaceId)
    .where('k.track_id', '=', trackId)
    .where('k.deleted_at', 'is', null)
    .where('k.id', '>', options.after)
    .where(filter.sql)
    .orderBy('k.id')
    .limit(options.limit + 1)
    .execute();
  const page = rows.slice(0, options.limit);
  return {
    position,
    tickets: page.map((r) => r.data),
    next: rows.length > options.limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

/** The rows after `after` in the person's groups, judged for them. */
export async function changesSince(
  db: Db,
  authorizer: Authorizer,
  workspaceId: number,
  principal: Principal,
  options: { after: string; limit: number },
): Promise<{ changes: SyncChange[]; position: string; resync: boolean }> {
  const floor = await db
    .selectFrom('change_log_floor')
    .select('floor_seq')
    .where('workspace_id', '=', workspaceId)
    .executeTakeFirst();
  if (floor && BigInt(options.after) < BigInt(floor.floor_seq)) {
    return { changes: [], position: options.after, resync: true };
  }
  // The top is read before the rows, so nothing numbered meanwhile is skipped.
  const top = await logPosition(db, workspaceId);
  const filter = await authorizer.ticketFilter(workspaceId, principal);
  let query = db
    .selectFrom('change_log')
    .select(['seq', 'entity', 'entity_id', 'track_id', 'op', 'data'])
    .where('workspace_id', '=', workspaceId)
    .where('seq', '>', options.after)
    .where('seq', '<=', top);
  if (filter.tracks !== 'all') {
    const tracks = [...filter.tracks];
    query = query.where((eb) =>
      eb.or([
        eb('track_id', 'is', null),
        ...(tracks.length > 0 ? [eb('track_id', 'in', tracks)] : []),
      ]),
    );
  }
  const rows = await query
    .orderBy('seq')
    .limit(options.limit + 1)
    .execute();
  const page = rows.slice(0, options.limit);
  const changes: SyncChange[] = [];
  for (const row of page) {
    const base = {
      seq: row.seq as string,
      entity: row.entity,
      id: row.entity_id,
      trackId: row.track_id,
    };
    if (row.entity === 'ticket' && row.op === 'upsert' && row.data) {
      const held = await authorizer.ticketPermissions(workspaceId, principal, accessRow(row.data));
      changes.push(
        held.has('browse_track')
          ? { ...base, op: 'upsert', data: row.data }
          : { ...base, op: 'delete' },
      );
    } else if (row.entity === 'track' && row.op === 'upsert' && row.data) {
      changes.push({ ...base, op: 'upsert', data: row.data });
    } else {
      changes.push({ ...base, op: row.op });
    }
  }
  const more = rows.length > options.limit;
  return {
    changes,
    position: more ? (page[page.length - 1]?.seq as string) : top,
    resync: false,
  };
}

/**
 * Trims rows older than the workspace's retention and raises the floor to the highest
 * sequence removed. Returns how many rows went.
 */
export async function trimChangeLog(
  db: Db,
  workspaceId: number,
  now = new Date(),
): Promise<number> {
  const setting = await db
    .selectFrom('change_log_floor')
    .select('retention_days')
    .where('workspace_id', '=', workspaceId)
    .executeTakeFirst();
  const before = new Date(now.getTime() - (setting?.retention_days ?? 30) * 24 * 3600 * 1000);
  let removed = 0;
  for (;;) {
    const { rows } = await sql<{ n: number; top: string | null }>`
      WITH gone AS (
        DELETE FROM change_log WHERE id IN (
          SELECT id FROM change_log
           WHERE workspace_id = ${workspaceId} AND created_at < ${before} AND seq IS NOT NULL
           ORDER BY id LIMIT 10000)
        RETURNING seq)
      SELECT count(*)::int AS n, max(seq)::text AS top FROM gone`.execute(db);
    const n = rows[0]?.n ?? 0;
    const top = rows[0]?.top;
    if (top) {
      await sql`
        UPDATE change_log_floor SET floor_seq = greatest(floor_seq, ${top}::bigint)
         WHERE workspace_id = ${workspaceId}`.execute(db);
    }
    removed += n;
    if (n < 10000) return removed;
  }
}
