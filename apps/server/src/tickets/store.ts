import type { Database, JsonValue } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { looksLikeKey, normalizeKey } from '../tracks/model';
import { DEFAULT_TRASH_RETENTION_DAYS, parseTicketKey, purgeAfter, ticketKey } from './model';
import { priorityLevel } from './priority-level';
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

/**
 * The columns a ticket view needs, with the names it shows. Lookups of one row (people,
 * priority, close reason, parent, the trash) are scalar subqueries rather than joins: with
 * sixteen joined tables the planner spent 4 to 7 ms ordering joins for a query that runs in
 * under 1 ms (M1-011), and every ticket write reads this view twice.
 */
export function ticketQuery(db: Db, workspaceId: number) {
  const one = <T>(query: string) => sql<T>`(${sql.raw(query)})`;
  const userName = (column: string) =>
    one<string | null>(`SELECT name FROM app_user WHERE id = k.${column}`);
  return db
    .selectFrom('ticket as k')
    .innerJoin('track as t', 't.id', 'k.track_id')
    .innerJoin('ticket_type as ty', 'ty.id', 'k.ticket_type_id')
    .innerJoin('hierarchy_level as l', 'l.id', 'ty.level_id')
    .innerJoin('status as st', 'st.id', 'k.status_id')
    .select([
      'k.id',
      'k.number',
      'k.track_id',
      't.key as track_key',
      't.name as track_name',
      't.archived_at as track_archived_at',
      't.field_rule_set_id as rule_set_id',
      't.layout_set_id',
      'k.ticket_type_id',
      'ty.name as type_name',
      'ty.icon as type_icon',
      'ty.color as type_color',
      'ty.level_id',
      'l.rank as level_rank',
      'l.name as level_name',
      'k.parent_id',
      one<number | null>('SELECT number FROM ticket WHERE id = k.parent_id').as('parent_number'),
      one<string | null>('SELECT summary FROM ticket WHERE id = k.parent_id').as('parent_summary'),
      one<number | null>('SELECT track_id FROM ticket WHERE id = k.parent_id').as(
        'parent_track_id',
      ),
      one<string | null>(
        'SELECT pt.key FROM ticket p JOIN track pt ON pt.id = p.track_id WHERE p.id = k.parent_id',
      ).as('parent_track_key'),
      'k.status_id',
      'st.name as status_name',
      'st.stage as status_stage',
      'k.summary',
      'k.description',
      'k.environment',
      'k.assignee_id',
      userName('assignee_id').as('assignee_name'),
      'k.requester_id',
      userName('requester_id').as('requester_name'),
      'k.creator_id',
      userName('creator_id').as('creator_name'),
      'k.start_date',
      'k.due_date',
      'k.rank',
      'k.version',
      'k.created_at',
      'k.updated_at',
      'k.deleted_at',
      'k.deleted_by',
      userName('deleted_by').as('deleted_by_name'),
      'k.trashed_with',
      one<number | null>('SELECT number FROM ticket WHERE id = k.trashed_with').as(
        'trashed_with_number',
      ),
      one<string | null>(
        'SELECT wt.key FROM ticket w JOIN track wt ON wt.id = w.track_id WHERE w.id = k.trashed_with',
      ).as('trashed_with_track_key'),
      'k.priority_id',
      one<string | null>('SELECT name FROM priority WHERE id = k.priority_id').as('priority_name'),
      one<string | null>('SELECT icon FROM priority WHERE id = k.priority_id').as('priority_icon'),
      one<string | null>('SELECT color FROM priority WHERE id = k.priority_id').as(
        'priority_color',
      ),
      one<number | null>('SELECT sort_order FROM priority WHERE id = k.priority_id').as(
        'priority_order',
      ),
      // Not correlated with the row: the planner runs it once per statement.
      sql<number>`(SELECT count(*)::int FROM priority WHERE workspace_id = ${workspaceId})`.as(
        'priority_total',
      ),
      'k.close_reason_id',
      one<string | null>('SELECT name FROM close_reason WHERE id = k.close_reason_id').as(
        'close_reason_name',
      ),
      'k.closed_at',
      'k.labels',
      'k.original_estimate',
      'k.remaining_estimate',
      'k.time_spent',
      one<number | null>(
        'SELECT retention_days FROM trash_policy WHERE workspace_id = k.workspace_id',
      ).as('trash_retention_days'),
      'k.fields',
      'k.visibility_level_id',
      one<string | null>('SELECT name FROM visibility_level WHERE id = k.visibility_level_id').as(
        'visibility_level_name',
      ),
      't.visibility_policy_id',
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
 * `fields` holds its custom values in REST form (`fields/values.ts`), keyed by field id.
 */
export function ticketView(
  row: TicketRow,
  canSeeParent: boolean,
  fields: Record<string, JsonValue> = {},
) {
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
    status: { id: row.status_id, name: row.status_name, stage: row.status_stage },
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
            level: priorityLevel(row.priority_order ?? 1, row.priority_total),
          },
    closeReason:
      row.close_reason_id === null
        ? null
        : { id: row.close_reason_id, name: row.close_reason_name ?? '' },
    closedAt: row.closed_at?.toISOString() ?? null,
    visibilityLevel:
      row.visibility_level_id === null
        ? null
        : { id: row.visibility_level_id, name: row.visibility_level_name ?? '' },
    labels: row.labels,
    targetReleases: row.target_releases,
    foundInReleases: row.found_releases,
    areas: row.areas,
    followerCount: row.follower_count ?? 0,
    voteCount: row.vote_count ?? 0,
    // Seconds; the client formats them with the time tracking settings (M1-019).
    timeTracking: {
      originalEstimate: row.original_estimate,
      remainingEstimate: row.remaining_estimate,
      timeSpent: row.time_spent,
      // Time spent against the original estimate, in percent (spec 01a section 1.3).
      effortRatio:
        row.original_estimate === null || row.original_estimate === 0
          ? null
          : Math.round((row.time_spent / row.original_estimate) * 1000) / 10,
    },
    fields,
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
            purgeAfter: purgeAfter(
              row.deleted_at,
              row.trash_retention_days ?? DEFAULT_TRASH_RETENTION_DAYS,
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
