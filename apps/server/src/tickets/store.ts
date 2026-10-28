import type { Database } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { looksLikeKey, normalizeKey } from '../tracks/model';
import { parseTicketKey, TRASH_RETENTION_DAYS, ticketKey } from './model';
import { sequenceKey } from './rank';

/**
 * Reading and numbering tickets (M1-008). The routes in `routes/tickets.ts` decide who may do
 * what; this module finds tickets by id or key, gives out numbers and rank keys, and shapes the
 * API view.
 */
type Db = Kysely<Database> | Transaction<Database>;
const MAX_INT = 2_147_483_647;

/** A track by id or by any key it has had. */
export async function resolveTrack(
  db: Db,
  workspaceId: number,
  ref: string | number,
): Promise<number | null> {
  if (typeof ref === 'number' || /^\d+$/.test(ref)) {
    const n = Number(ref);
    if (!(n > 0 && n <= MAX_INT)) return null;
    const row = await db
      .selectFrom('track')
      .select('id')
      .where('id', '=', n)
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirst();
    return row?.id ?? null;
  }
  if (!looksLikeKey(ref)) return null;
  const row = await db
    .selectFrom('track_key_history')
    .select('track_id')
    .where('workspace_id', '=', workspaceId)
    .where(sql<string>`upper(key)`, '=', normalizeKey(ref))
    .executeTakeFirst();
  return row?.track_id ?? null;
}

/**
 * A ticket by id or by any key it has had: an old number in its track, or any old key of that
 * track (CORE-001 (2), CORE-023 (3)). `asked` is the key as asked for, so the caller can tell a
 * retired key from the current one.
 */
export async function resolveTicket(
  db: Db,
  workspaceId: number,
  ref: string | number,
): Promise<{ id: number; asked: string | null } | null> {
  if (typeof ref === 'number' || /^\d+$/.test(ref)) {
    const n = Number(ref);
    if (!(n > 0 && n <= MAX_INT)) return null;
    return { id: n, asked: null };
  }
  const parsed = parseTicketKey(ref);
  if (!parsed) return null;
  const row = await db
    .selectFrom('track_key_history as tk')
    .innerJoin('ticket_key_history as h', 'h.track_id', 'tk.track_id')
    .select('h.ticket_id')
    .where('tk.workspace_id', '=', workspaceId)
    .where(sql<string>`upper(tk.key)`, '=', parsed.trackKey)
    .where('h.number', '=', parsed.number)
    .executeTakeFirst();
  return row ? { id: row.ticket_id, asked: ticketKey(parsed.trackKey, parsed.number) } : null;
}

/**
 * The next number in a track. The counter row stays locked until the transaction ends, so
 * concurrent creates in one track take consecutive numbers, and a rolled-back create gives its
 * number to the next one. Writers that set numbers themselves (the importer) move the counter.
 */
export async function nextNumber(
  trx: Transaction<Database>,
  workspaceId: number,
  trackId: number,
): Promise<number> {
  const { rows } = await sql<{ last_number: number }>`
    INSERT INTO ticket_counter (workspace_id, track_id, last_number)
    VALUES (${workspaceId}, ${trackId}, 1)
    ON CONFLICT (track_id) DO UPDATE SET last_number = ticket_counter.last_number + 1
    RETURNING last_number`.execute(trx);
  return rows[0]?.last_number as number;
}

/** A rank key after every key in use: the bottom of the order (AGL-009, ADR-037). */
export async function bottomRank(db: Db): Promise<string> {
  const { rows } = await sql<{ n: string }>`SELECT nextval('ticket_rank_seq') AS n`.execute(db);
  return sequenceKey(rows[0]?.n as string);
}

/** The releases of one role of the ticket `k` in the outer query, in the track's order. */
const releasesOf = (db: Db, role: 'target' | 'found') =>
  jsonArrayFrom(
    db
      .selectFrom('ticket_release as tr')
      .innerJoin('release as rl', 'rl.id', 'tr.release_id')
      .select(['rl.id', 'rl.name', sql<boolean>`rl.shipped_at IS NOT NULL`.as('shipped')])
      .where(sql<boolean>`tr.ticket_id = k.id`)
      .where('tr.role', '=', role)
      .orderBy('rl.sort_order')
      .orderBy('rl.id'),
  );

/** The columns a ticket view needs, joined with the names it shows. */
export function ticketQuery(db: Db, workspaceId: number) {
  return db
    .selectFrom('ticket as k')
    .innerJoin('track as t', 't.id', 'k.track_id')
    .innerJoin('ticket_type as ty', 'ty.id', 'k.ticket_type_id')
    .innerJoin('hierarchy_level as l', 'l.id', 'ty.level_id')
    .leftJoin('ticket as p', 'p.id', 'k.parent_id')
    .leftJoin('track as pt', 'pt.id', 'p.track_id')
    .leftJoin('app_user as a', 'a.id', 'k.assignee_id')
    .leftJoin('app_user as r', 'r.id', 'k.requester_id')
    .leftJoin('app_user as c', 'c.id', 'k.creator_id')
    .leftJoin('app_user as d', 'd.id', 'k.deleted_by')
    .leftJoin('ticket as w', 'w.id', 'k.trashed_with')
    .leftJoin('track as wt', 'wt.id', 'w.track_id')
    .leftJoin('priority as pr', 'pr.id', 'k.priority_id')
    .leftJoin('close_reason as cr', 'cr.id', 'k.close_reason_id')
    .select([
      'k.id',
      'k.number',
      'k.track_id',
      't.key as track_key',
      't.name as track_name',
      't.archived_at as track_archived_at',
      'k.ticket_type_id',
      'ty.name as type_name',
      'ty.icon as type_icon',
      'ty.color as type_color',
      'ty.level_id',
      'l.rank as level_rank',
      'l.name as level_name',
      'k.parent_id',
      'p.number as parent_number',
      'p.summary as parent_summary',
      'p.track_id as parent_track_id',
      'pt.key as parent_track_key',
      'k.summary',
      'k.description',
      'k.environment',
      'k.assignee_id',
      'a.name as assignee_name',
      'k.requester_id',
      'r.name as requester_name',
      'k.creator_id',
      'c.name as creator_name',
      'k.start_date',
      'k.due_date',
      'k.rank',
      'k.version',
      'k.created_at',
      'k.updated_at',
      'k.deleted_at',
      'k.deleted_by',
      'd.name as deleted_by_name',
      'k.trashed_with',
      'w.number as trashed_with_number',
      'wt.key as trashed_with_track_key',
      'k.priority_id',
      'pr.name as priority_name',
      'pr.icon as priority_icon',
      'pr.color as priority_color',
      'k.close_reason_id',
      'cr.name as close_reason_name',
      'k.closed_at',
      'k.labels',
    ])
    .select([
      releasesOf(db, 'target').as('target_releases'),
      releasesOf(db, 'found').as('found_releases'),
      jsonArrayFrom(
        db
          .selectFrom('ticket_area as ta')
          .innerJoin('area as ar', 'ar.id', 'ta.area_id')
          .select(['ar.id', 'ar.name'])
          .where(sql<boolean>`ta.ticket_id = k.id`)
          .orderBy('ar.name')
          .orderBy('ar.id'),
      ).as('areas'),
      db
        .selectFrom('ticket_follower')
        .select(sql<number>`count(*)::int`.as('n'))
        .where(sql<boolean>`ticket_id = k.id`)
        .as('follower_count'),
      db
        .selectFrom('ticket_vote')
        .select(sql<number>`count(*)::int`.as('n'))
        .where(sql<boolean>`ticket_id = k.id`)
        .as('vote_count'),
    ])
    .where('k.workspace_id', '=', workspaceId);
}
export type TicketRow = Awaited<
  ReturnType<ReturnType<typeof ticketQuery>['executeTakeFirstOrThrow']>
>;

export function loadTicket(db: Db, workspaceId: number, ticketId: number) {
  return ticketQuery(db, workspaceId).where('k.id', '=', ticketId).executeTakeFirst();
}

/** Several tickets by id, trash included, keyed by id. */
export async function loadTickets(
  db: Db,
  workspaceId: number,
  ticketIds: readonly number[],
): Promise<Map<number, TicketRow>> {
  if (ticketIds.length === 0) return new Map();
  const rows = await ticketQuery(db, workspaceId)
    .where('k.id', 'in', [...ticketIds])
    .execute();
  return new Map(rows.map((r) => [r.id, r]));
}

const person = (id: number | null, name: string | null) =>
  id === null ? null : { id, name: name ?? '' };

/**
 * A ticket as the API shows it. `canSeeParent` says whether the viewer may browse the parent's
 * track (spec 01a section 1.2 rule 5): a parent elsewhere shows only its id otherwise.
 */
export function ticketView(row: TicketRow, canSeeParent: boolean) {
  const parentVisible = canSeeParent && row.parent_track_key !== null;
  return {
    id: row.id,
    key: ticketKey(row.track_key, row.number),
    number: row.number,
    track: { id: row.track_id, key: row.track_key, name: row.track_name },
    ticketType: {
      id: row.ticket_type_id,
      name: row.type_name,
      icon: row.type_icon,
      color: row.type_color,
      level: { id: row.level_id, rank: row.level_rank, name: row.level_name },
    },
    parent:
      row.parent_id === null
        ? null
        : {
            id: row.parent_id,
            key: parentVisible
              ? ticketKey(row.parent_track_key as string, row.parent_number as number)
              : null,
            summary: parentVisible ? row.parent_summary : null,
          },
    summary: row.summary,
    description: row.description,
    environment: row.environment,
    assignee: person(row.assignee_id, row.assignee_name),
    requester: person(row.requester_id, row.requester_name),
    creator: person(row.creator_id, row.creator_name),
    startDate: row.start_date,
    dueDate: row.due_date,
    priority:
      row.priority_id === null
        ? null
        : {
            id: row.priority_id,
            name: row.priority_name ?? '',
            icon: row.priority_icon,
            color: row.priority_color,
          },
    closeReason:
      row.close_reason_id === null
        ? null
        : { id: row.close_reason_id, name: row.close_reason_name ?? '' },
    closedAt: row.closed_at?.toISOString() ?? null,
    labels: row.labels,
    targetReleases: row.target_releases,
    foundInReleases: row.found_releases,
    areas: row.areas,
    followerCount: row.follower_count ?? 0,
    voteCount: row.vote_count ?? 0,
    rank: row.rank,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    trash:
      row.deleted_at === null
        ? null
        : {
            deletedAt: row.deleted_at.toISOString(),
            deletedBy: person(row.deleted_by, row.deleted_by_name),
            purgeAfter: new Date(
              row.deleted_at.getTime() + TRASH_RETENTION_DAYS * 86_400_000,
            ).toISOString(),
            deletedWith:
              row.trashed_with === null
                ? null
                : {
                    id: row.trashed_with,
                    key: ticketKey(
                      row.trashed_with_track_key as string,
                      row.trashed_with_number as number,
                    ),
                  },
          },
  };
}
export type TicketView = ReturnType<typeof ticketView>;

/** Whether a track id is among those a caller may browse. */
export function inTracks(tracks: readonly number[] | 'all', trackId: number | null): boolean {
  return trackId !== null && (tracks === 'all' || tracks.includes(trackId));
}
