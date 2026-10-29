import type { Database } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { enqueue, extendLock, type JobRunner } from '../events/queue';
import type { Catalog, FieldCatalogs } from '../fields/catalog';
import { refreshFormulas } from '../fields/formulas';
import { recordChanges } from '../tickets/history';
import { loadTicket, type TicketRow } from '../tickets/store';
import { publishedStatuses } from './maps';

/**
 * Status migrations after a change of workflow map (M1-028; ADR-045). When a track switches
 * map, or a map gives a ticket type another workflow, tickets whose status the new workflow
 * lacks move to the status the administrator mapped it to:
 *
 * - The change itself commits at once (the next ticket created or moved uses the new
 *   workflow); the tickets move behind it, in batches of set-based SQL, each with a new version,
 *   a status history row (one change set for the whole migration, the person who asked as the
 *   actor), the change log rows the ticket triggers write, and formulas recomputed.
 * - Small migrations finish in the request's own transaction through the same batch code; the
 *   rest run as a job that hands over to the next part after `PART_MS`, so no worker is held
 *   for long, and that keeps its progress in `workflow_migration`.
 * - A ticket not yet moved keeps working: a transition on it first moves it as the migration
 *   would (`settleStatus`), in the transition's transaction, then runs against the new
 *   workflow; the transitions it offers are those of its mapped status.
 * - While a migration runs, the tracks it covers refuse another change of map, and the
 *   workflows they use refuse a publish (409 `status_migration_running`): a mapping's target
 *   stays in its workflow until every ticket has moved.
 */
type Db = Kysely<Database> | Transaction<Database>;

export const MIGRATION_TASK = 'workflow.migrate';
/** Migrations of this many tickets or fewer finish in the request. */
export const IN_REQUEST_TICKETS = 500;
/** Tickets per transaction in the background. */
export const MIGRATION_BATCH = 2000;
/** How long one part of a job runs before it hands over to the next. */
const PART_MS = 50_000;

const MAX_INT = 2_147_483_647;
const id = z.number().int().positive().max(MAX_INT);
const idKey = z.string().regex(/^\d{1,10}$/);
/** For each status tickets are in that their new workflow lacks: where they go. */
export const statusMappingSchema = z.record(idKey, id);
/** The same for one ticket type, where its tickets need another target than the rest. */
export const typeStatusMappingSchema = z.record(idKey, statusMappingSchema);

export interface StatusMapping {
  all: ReadonlyMap<number, number>;
  byType: ReadonlyMap<number, ReadonlyMap<number, number>>;
}

export function statusMappingOf(
  all: Record<string, number> | undefined,
  byType: Record<string, Record<string, number>> | undefined,
): StatusMapping {
  const pairs = (record: Record<string, number>) =>
    new Map(Object.entries(record).map(([from, to]) => [Number(from), to]));
  return {
    all: pairs(all ?? {}),
    byType: new Map(Object.entries(byType ?? {}).map(([type, m]) => [Number(type), pairs(m)])),
  };
}

const targetOf = (mapping: StatusMapping, ticketTypeId: number, statusId: number) =>
  mapping.byType.get(ticketTypeId)?.get(statusId) ?? mapping.all.get(statusId);

/** Tickets of one type in one track, in a status their new workflow lacks. */
export interface LostStatus {
  trackId: number;
  ticketTypeId: number;
  statusId: number;
  ticketCount: number;
  /** The ticket type's new workflow. */
  workflowId: number;
}

/** What a change of workflows does to tickets, per track and ticket type. */
export interface Impact {
  /** Ticket types whose workflow changes, with how many tickets they have. */
  types: { trackId: number; ticketTypeId: number; ticketCount: number; from: number; to: number }[];
  lost: LostStatus[];
  /** Name, statuses and initial status of every workflow named. */
  workflows: Awaited<ReturnType<typeof publishedStatuses>>;
}

/**
 * The impact of giving the tickets of `trackIds` (the trash included) the workflows `next`
 * names instead of those `now` names.
 */
export async function impactOf(
  db: Db,
  workspaceId: number,
  trackIds: readonly number[],
  now: (trackId: number, ticketTypeId: number) => number,
  next: (trackId: number, ticketTypeId: number) => number,
): Promise<Impact> {
  const present =
    trackIds.length === 0
      ? []
      : await db
          .selectFrom('ticket')
          .select([
            'track_id',
            'ticket_type_id',
            'status_id',
            (eb) => eb.fn.countAll<string>().as('n'),
          ])
          .where('workspace_id', '=', workspaceId)
          .where('track_id', 'in', [...trackIds])
          .groupBy(['track_id', 'ticket_type_id', 'status_id'])
          .orderBy('track_id')
          .orderBy('ticket_type_id')
          .orderBy('status_id')
          .execute();
  const workflows = await publishedStatuses(db, [
    ...new Set(
      present.flatMap((p) => [
        now(p.track_id, p.ticket_type_id),
        next(p.track_id, p.ticket_type_id),
      ]),
    ),
  ]);
  const types = new Map<string, Impact['types'][number]>();
  const lost: LostStatus[] = [];
  for (const p of present) {
    const n = Number(p.n);
    const from = now(p.track_id, p.ticket_type_id);
    const to = next(p.track_id, p.ticket_type_id);
    if (from !== to) {
      const key = `${p.track_id}:${p.ticket_type_id}`;
      const entry = types.get(key) ?? {
        trackId: p.track_id,
        ticketTypeId: p.ticket_type_id,
        ticketCount: 0,
        from,
        to,
      };
      entry.ticketCount += n;
      types.set(key, entry);
    }
    if (!workflows.get(to)?.statuses.has(p.status_id)) {
      lost.push({
        trackId: p.track_id,
        ticketTypeId: p.ticket_type_id,
        statusId: p.status_id,
        ticketCount: n,
        workflowId: to,
      });
    }
  }
  return { types: [...types.values()], lost, workflows };
}

/** Lost statuses summed over tracks, by ticket type and status (a map gives every track the same). */
export function lostByType(lost: readonly LostStatus[]) {
  const out = new Map<
    string,
    { ticketTypeId: number; statusId: number; ticketCount: number; workflowId: number }
  >();
  for (const l of lost) {
    const key = `${l.ticketTypeId}:${l.statusId}`;
    const entry = out.get(key) ?? {
      ticketTypeId: l.ticketTypeId,
      statusId: l.statusId,
      ticketCount: 0,
      workflowId: l.workflowId,
    };
    entry.ticketCount += l.ticketCount;
    out.set(key, entry);
  }
  return [...out.values()].sort(
    (a, b) => a.ticketTypeId - b.ticketTypeId || a.statusId - b.statusId,
  );
}

export interface MigrationStep {
  trackId: number;
  ticketTypeId: number;
  fromStatusId: number;
  toStatusId: number;
  ticketCount: number;
}

export type MigrationPlan =
  | { ok: true; steps: MigrationStep[]; ticketCount: number }
  | { ok: false; required: ReturnType<typeof lostByType> }
  | { ok: false; badTarget: { ticketTypeId: number; statusId: number; toStatusId: number } };

/**
 * The steps that take every lost status where the mapping says, or what is missing: a status
 * with tickets and no target (409 `status_mapping_required`), or a target outside the type's
 * new workflow (400).
 */
export function planMigration(impact: Impact, mapping: StatusMapping): MigrationPlan {
  const needed = lostByType(impact.lost);
  const unmapped = needed.filter(
    (l) => targetOf(mapping, l.ticketTypeId, l.statusId) === undefined,
  );
  if (unmapped.length > 0) return { ok: false, required: needed };
  for (const l of needed) {
    const to = targetOf(mapping, l.ticketTypeId, l.statusId) as number;
    if (!impact.workflows.get(l.workflowId)?.statuses.has(to)) {
      return {
        ok: false,
        badTarget: { ticketTypeId: l.ticketTypeId, statusId: l.statusId, toStatusId: to },
      };
    }
  }
  const steps = impact.lost.map((l) => ({
    trackId: l.trackId,
    ticketTypeId: l.ticketTypeId,
    fromStatusId: l.statusId,
    toStatusId: targetOf(mapping, l.ticketTypeId, l.statusId) as number,
    ticketCount: l.ticketCount,
  }));
  return { ok: true, steps, ticketCount: steps.reduce((n, s) => n + s.ticketCount, 0) };
}

export interface MigrationRow {
  id: string;
  workspace_id: number;
  user_id: number | null;
  status: 'queued' | 'running' | 'done';
  total: number;
  migrated: number;
  change_set: string;
}

/**
 * Moves up to `limit` tickets of a migration that nobody else holds, in one statement: status,
 * version and update time, and a history row each. Then their formulas (the update time moved,
 * M1-013). Returns the tickets moved.
 */
export async function migrateBatch(
  trx: Transaction<Database>,
  catalog: Catalog,
  migration: MigrationRow,
  limit: number,
): Promise<number[]> {
  const { rows } = await sql<{ id: number }>`
    WITH picked AS (
      SELECT k.id, k.status_id AS from_status, s.to_status_id AS to_status
        FROM workflow_migration_step s
        JOIN ticket k ON k.track_id = s.track_id AND k.ticket_type_id = s.ticket_type_id
                     AND k.status_id = s.from_status_id
       WHERE s.migration_id = ${Number(migration.id)}
       LIMIT ${limit}
         FOR UPDATE OF k SKIP LOCKED
    ), moved AS (
      UPDATE ticket k SET status_id = p.to_status, version = k.version + 1, updated_at = now()
        FROM picked p
       WHERE k.id = p.id
      RETURNING k.id, p.from_status, p.to_status
    ), logged AS (
      INSERT INTO ticket_change (workspace_id, ticket_id, change_set, actor_id, field,
                                 from_value, to_value, from_display, to_display)
      SELECT ${migration.workspace_id}::int, m.id, ${migration.change_set}::bigint,
             ${migration.user_id}::int, 'status', m.from_status::text, m.to_status::text,
             f.name, t.name
        FROM moved m
        JOIN status f ON f.id = m.from_status
        JOIN status t ON t.id = m.to_status
      RETURNING ticket_id
    )
    SELECT ticket_id AS id FROM logged ORDER BY ticket_id`.execute(trx);
  const ids = rows.map((r) => r.id);
  if (ids.length > 0) {
    const computed = await refreshFormulas(trx, catalog, migration.workspace_id, ids);
    await recordChanges(
      trx,
      migration.workspace_id,
      migration.user_id,
      computed,
      migration.change_set,
    );
  }
  return ids;
}

/** Tickets a migration has still to move, those others hold included. */
export async function remainingOf(db: Db, migrationId: string): Promise<number> {
  const { rows } = await sql<{ n: number }>`
    SELECT count(*)::int AS n
      FROM workflow_migration_step s
      JOIN ticket k ON k.track_id = s.track_id AND k.ticket_type_id = s.ticket_type_id
                   AND k.status_id = s.from_status_id
     WHERE s.migration_id = ${Number(migrationId)}`.execute(db);
  return rows[0]?.n ?? 0;
}

const migrationJob = (workspaceId: number, migrationId: string, part = 0) => ({
  workspaceId,
  task: MIGRATION_TASK,
  payload: { migrationId, part },
  key: `workflow-migration:${migrationId}:${part}`,
});

/** Progress as the API shows it. */
export function migrationView(row: {
  id: string;
  status: string;
  total: number;
  migrated: number;
  reason: string;
  map_id: number | null;
  track_id: number | null;
  user_id: number | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}) {
  return {
    id: Number(row.id),
    status: row.status,
    reason: row.reason,
    workflowMapId: row.map_id,
    trackId: row.track_id,
    userId: row.user_id,
    total: row.total,
    migrated: row.migrated,
    pending: Math.max(0, row.total - row.migrated),
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

/**
 * Records a migration and its steps in the change's transaction and starts it: a small one
 * runs here through the batch code and finishes unless someone holds one of its tickets; the
 * rest goes to a job that runs after the commit. Returns its progress.
 */
export async function startMigration(
  trx: Transaction<Database>,
  catalog: Catalog,
  request: {
    workspaceId: number;
    userId: number | null;
    reason: 'track_map' | 'map_change';
    mapId: number | null;
    trackId: number | null;
  },
  steps: readonly MigrationStep[],
) {
  const total = steps.reduce((n, s) => n + s.ticketCount, 0);
  const { rows } = await sql<{ n: string }>`SELECT nextval('ticket_change_set_seq') AS n`.execute(
    trx,
  );
  const row = await trx
    .insertInto('workflow_migration')
    .values({
      workspace_id: request.workspaceId,
      user_id: request.userId,
      reason: request.reason,
      map_id: request.mapId,
      track_id: request.trackId,
      total,
      change_set: rows[0]?.n as string,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('workflow_migration_step')
    .values(
      steps.map((s) => ({
        migration_id: row.id,
        workspace_id: request.workspaceId,
        track_id: s.trackId,
        ticket_type_id: s.ticketTypeId,
        from_status_id: s.fromStatusId,
        to_status_id: s.toStatusId,
        ticket_count: s.ticketCount,
      })),
    )
    .execute();
  if (total <= IN_REQUEST_TICKETS) {
    await migrateBatch(trx, catalog, row, IN_REQUEST_TICKETS);
    const remaining = await remainingOf(trx, row.id);
    const now = new Date();
    const done = await trx
      .updateTable('workflow_migration')
      .set({
        migrated: Math.max(0, total - remaining),
        started_at: now,
        ...(remaining === 0 ? { status: 'done' as const, finished_at: now } : {}),
      })
      .where('id', '=', row.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    if (remaining > 0) await enqueue(trx, [migrationJob(request.workspaceId, row.id)]);
    return migrationView(done);
  }
  await enqueue(trx, [migrationJob(request.workspaceId, row.id)]);
  return migrationView(row);
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs a migration's batches until it is done or `until` passes; each batch is its own
 * transaction that holds the migration row. Tickets someone else holds are taken in a later
 * batch.
 */
export async function runMigration(
  db: Kysely<Database>,
  catalogs: FieldCatalogs,
  migrationId: string,
  options: { until: number; batch?: number },
): Promise<'finished' | 'more'> {
  for (;;) {
    const head = await db
      .selectFrom('workflow_migration')
      .select(['workspace_id', 'status'])
      .where('id', '=', migrationId)
      .executeTakeFirst();
    if (!head || head.status === 'done') return 'finished';
    // Read through the pool before the transaction, which never waits for a second connection.
    const catalog = await catalogs.get(head.workspace_id);
    const outcome = await db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('workflow_migration')
        .selectAll()
        .where('id', '=', migrationId)
        .forUpdate()
        .executeTakeFirst();
      if (!row || row.status === 'done') return 'finished' as const;
      const moved = await migrateBatch(trx, catalog, row, options.batch ?? MIGRATION_BATCH);
      const remaining = await remainingOf(trx, row.id);
      const now = new Date();
      await trx
        .updateTable('workflow_migration')
        .set({
          migrated: Math.max(0, row.total - remaining),
          ...(row.started_at === null ? { started_at: now } : {}),
          ...(remaining === 0
            ? { status: 'done' as const, finished_at: now }
            : { status: 'running' as const }),
        })
        .where('id', '=', row.id)
        .execute();
      if (remaining === 0) return 'finished' as const;
      return moved.length > 0 ? ('moved' as const) : ('held' as const);
    });
    if (outcome === 'finished') return 'finished';
    if (Date.now() >= options.until) return 'more';
    // Every ticket left is held by a write in progress: give it a moment.
    if (outcome === 'held') await pause(200);
  }
}

export function registerWorkflowMigrationJobs(
  runner: JobRunner,
  db: Kysely<Database>,
  catalogs: FieldCatalogs,
  options: { partMs?: number; batch?: number } = {},
): void {
  runner.handle(MIGRATION_TASK, async (job) => {
    const { migrationId, part } = job.payload as { migrationId: string; part: number };
    // A part runs for most of a minute: keep its lock, so no second worker takes it meanwhile.
    const keep = setInterval(() => void extendLock(db, job.id).catch(() => {}), 15_000);
    try {
      const state = await runMigration(db, catalogs, migrationId, {
        until: Date.now() + (options.partMs ?? PART_MS),
        ...(options.batch ? { batch: options.batch } : {}),
      });
      if (state === 'more') {
        await enqueue(db, [migrationJob(job.workspaceId, migrationId, part + 1)]);
      }
    } finally {
      clearInterval(keep);
    }
  });
}

/** The status a running migration takes a ticket to, when it has one for it. */
export async function pendingTarget(
  db: Db,
  ticket: Pick<TicketRow, 'track_id' | 'ticket_type_id' | 'status_id'>,
) {
  const row = await db
    .selectFrom('workflow_migration_step as s')
    .innerJoin('workflow_migration as o', 'o.id', 's.migration_id')
    .select(['s.to_status_id', 'o.id', 'o.workspace_id', 'o.user_id', 'o.change_set'])
    .where('s.track_id', '=', ticket.track_id)
    .where('s.ticket_type_id', '=', ticket.ticket_type_id)
    .where('s.from_status_id', '=', ticket.status_id)
    .where('o.status', '<>', 'done')
    .orderBy('o.id', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row ?? null;
}

/**
 * A ticket a running migration has not moved yet, moved now as the migration would move it
 * (same history change set and actor), for a write that needs its status in its workflow
 * first: a transition. The caller holds the ticket. Returns the ticket as it is now.
 */
export async function settleStatus(
  trx: Transaction<Database>,
  catalog: Catalog,
  workspaceId: number,
  ticket: TicketRow,
  statuses: ReadonlySet<number>,
): Promise<TicketRow> {
  if (statuses.has(ticket.status_id)) return ticket;
  const target = await pendingTarget(trx, ticket);
  if (!target || !statuses.has(target.to_status_id)) return ticket;
  await trx
    .updateTable('ticket')
    .set((eb) => ({
      status_id: target.to_status_id,
      version: eb('version', '+', 1),
      updated_at: new Date(),
    }))
    .where('id', '=', ticket.id)
    .execute();
  const moved = (await loadTicket(trx, workspaceId, ticket.id)) as TicketRow;
  const computed = await refreshFormulas(trx, catalog, workspaceId, [ticket.id]);
  await recordChanges(
    trx,
    workspaceId,
    target.user_id,
    [
      {
        ticketId: ticket.id,
        field: 'status',
        from: String(ticket.status_id),
        to: String(moved.status_id),
        fromDisplay: ticket.status_name,
        toDisplay: moved.status_name,
      },
      ...computed,
    ],
    target.change_set,
  );
  return (await loadTicket(trx, workspaceId, ticket.id)) as TicketRow;
}

/** A migration still running over any of these tracks, which a new change must wait for. */
export async function runningMigration(
  db: Db,
  workspaceId: number,
  trackIds: readonly number[],
): Promise<number | null> {
  if (trackIds.length === 0) return null;
  const row = await db
    .selectFrom('workflow_migration as o')
    .select('o.id')
    .where('o.workspace_id', '=', workspaceId)
    .where('o.status', '<>', 'done')
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('workflow_migration_step as s')
          .select('s.migration_id')
          .whereRef('s.migration_id', '=', 'o.id')
          .where('s.track_id', 'in', [...trackIds]),
      ),
    )
    .orderBy('o.id')
    .limit(1)
    .executeTakeFirst();
  return row ? Number(row.id) : null;
}
