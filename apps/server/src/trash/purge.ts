import type { Database } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';
import { queueSweep } from '../attachments/cleanup';
import { emit } from '../events/bus';
import { enqueue, type JobRunner } from '../events/queue';
import { shareHierarchy } from '../tickets/configuration';
import { SUBTICKET_RANK } from '../tickets/hierarchy';
import { changesOf, type FieldChange, linkChange, recordChanges } from '../tickets/history';
import { ticketKey } from '../tickets/model';
import { loadTickets } from '../tickets/store';
import { defaultWorkspaceId } from '../workspace';
import { retentionCutoff, trashRetentionDays } from './policy';

/**
 * Emptying the trash for good (M1-101, CORE-025 (3)).
 *
 * - A ticket leaves with what cannot live without it: the subtickets that went to the trash
 *   with it, and any subticket of it still in the trash. Its history, links, web links,
 *   followers, votes, releases, areas and attachments go with it (the foreign keys cascade);
 *   the attachments' files leave the store after commit, through `storage_cleanup` and the
 *   worker's sweep (M1-016). The audit log keeps `ticket.deleted` and `ticket.purged`.
 * - The tickets it leaves behind record the loss in their own history: a link to it, or a
 *   parent link (children lose the parent, as when it went to the trash).
 * - A track leaves in batches: its tickets first, whatever their state, then its releases,
 *   areas, own type set, ticket types and access policy, its key history and the old keys of
 *   tickets that moved away from it. `purge_started_at` marks it at the start, so a track
 *   half emptied can never be restored, and the next purge run finishes it.
 * - The purge job runs every hour in the worker role (one run across all workers, keyed by
 *   the hour) and removes, workspace by workspace, what has been in the trash longer than the
 *   retention, in batches of a few hundred tickets per transaction. Each ticket and track it
 *   removes is one event (`ticket.purged`, `track.purged`, actor none), so the audit log
 *   records every permanent deletion. Site administrators can also purge one at once.
 */

export const PURGE_BATCH = 200;
export type PurgeReason = 'retention' | 'admin';

export interface PurgedRoot {
  id: number;
  key: string;
  /** Tickets that went with it (its subtickets in the trash), by id. */
  subtickets: number[];
  /** Children elsewhere that lost it as their parent. */
  detachedChildren: number[];
}

/**
 * Deletes `rootIds` for good with everything that cannot outlive them (see above). With
 * `trackId`, every child in that track goes too (a track purge). Children elsewhere are
 * detached and links are dropped, each with a history row on the ticket that stays. Callers
 * hold the hierarchy lock shared (lock order of ADR-009) and have checked the roots.
 */
export async function purgeTicketSet(
  trx: Transaction<Database>,
  workspaceId: number,
  rootIds: readonly number[],
  options: { actorId: number | null; trackId?: number },
): Promise<PurgedRoot[]> {
  if (rootIds.length === 0) return [];
  const trackId = options.trackId ?? null;
  // Each doomed ticket with the root it belongs to: subtickets that went along, subtickets
  // still in the trash and, in a track purge, every child in the track.
  const { rows: doomed } = await sql<{ id: number; root: number }>`
    WITH RECURSIVE doomed(id, root) AS (
      SELECT r, r FROM unnest(${[...rootIds]}::int[]) AS r
      UNION
      SELECT k.id, d.root FROM ticket k
        JOIN doomed d ON k.trashed_with = d.id OR k.parent_id = d.id
        JOIN ticket_type ty ON ty.id = k.ticket_type_id
        JOIN hierarchy_level l ON l.id = ty.level_id
       WHERE k.workspace_id = ${workspaceId}
         AND (k.trashed_with = d.id
              OR (k.deleted_at IS NOT NULL AND l.rank = ${SUBTICKET_RANK})
              OR k.track_id = ${trackId}::int)
    )
    SELECT id, min(root) AS root FROM doomed GROUP BY id ORDER BY id`.execute(trx);
  const ids = doomed.map((d) => d.id);
  const rootOf = new Map(doomed.map((d) => [d.id, d.root]));
  await sql`SELECT id FROM ticket WHERE id = ANY(${ids}::int[]) ORDER BY id FOR UPDATE`.execute(
    trx,
  );
  const { rows: keyed } = await sql<{ id: number; key: string; number: number }>`
    SELECT k.id, t.key, k.number FROM ticket k JOIN track t ON t.id = k.track_id
     WHERE k.id = ANY(${ids}::int[])`.execute(trx);
  const keyOf = new Map(keyed.map((k) => [k.id, ticketKey(k.key, k.number)]));
  const changes: FieldChange[] = [];

  // Children elsewhere lose the parent, as when it went to the trash, with a history row.
  const { rows: children } = await sql<{ id: number; parent_id: number }>`
    SELECT id, parent_id FROM ticket
     WHERE parent_id = ANY(${ids}::int[]) AND NOT (id = ANY(${ids}::int[]))
     ORDER BY id FOR UPDATE`.execute(trx);
  const detached = children.map((c) => c.id);
  if (detached.length > 0) {
    const before = await loadTickets(trx, workspaceId, detached);
    await trx
      .updateTable('ticket')
      .set((eb) => ({ parent_id: null, version: eb('version', '+', 1), updated_at: new Date() }))
      .where('id', 'in', detached)
      .execute();
    changes.push(...changesOf(before, await loadTickets(trx, workspaceId, detached)));
  }

  // Links to tickets that stay: the other side records the loss.
  const { rows: links } = await sql<{
    link_type_id: number;
    source_id: number;
    target_id: number;
    outward: string;
    inward: string;
  }>`
    SELECT * FROM (
      SELECT l.id, l.link_type_id, l.source_id, l.target_id, lt.outward, lt.inward
        FROM ticket_link l JOIN link_type lt ON lt.id = l.link_type_id
       WHERE l.source_id = ANY(${ids}::int[]) AND NOT (l.target_id = ANY(${ids}::int[]))
      UNION ALL
      SELECT l.id, l.link_type_id, l.source_id, l.target_id, lt.outward, lt.inward
        FROM ticket_link l JOIN link_type lt ON lt.id = l.link_type_id
       WHERE l.target_id = ANY(${ids}::int[]) AND NOT (l.source_id = ANY(${ids}::int[]))
    ) crossing ORDER BY id`.execute(trx);
  for (const link of links) {
    const sourceGoes = rootOf.has(link.source_id);
    const survivor = sourceGoes ? link.target_id : link.source_id;
    const gone = sourceGoes ? link.source_id : link.target_id;
    const direction = sourceGoes ? 'inward' : 'outward';
    changes.push(
      linkChange(
        survivor,
        { typeId: link.link_type_id, direction, phrase: link[direction], otherId: gone },
        keyOf.get(gone) ?? String(gone),
        false,
      ),
    );
  }
  await recordChanges(trx, workspaceId, options.actorId, changes);

  // Their attachments' files leave the store after commit (M1-016): the rows cascade, a
  // trigger lists their keys in storage_cleanup, and the worker's sweep deletes the objects.
  const { rows: attached } = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM attachment WHERE ticket_id = ANY(${ids}::int[])`.execute(trx);
  if ((attached[0]?.n ?? 0) > 0) await queueSweep(trx, workspaceId);

  // One statement, so references among the doomed tickets (parent, trashed with) never dangle.
  await trx.deleteFrom('ticket').where('id', 'in', ids).execute();

  const parentOf = new Map(children.map((c) => [c.id, c.parent_id]));
  // A root that another root takes along (a subticket whose parent goes too) is reported with
  // that root, not on its own.
  return rootIds
    .filter((id) => keyOf.has(id) && rootOf.get(id) === id)
    .map((id) => ({
      id,
      key: keyOf.get(id) as string,
      subtickets: ids.filter((t) => t !== id && rootOf.get(t) === id),
      detachedChildren: detached.filter((c) => rootOf.get(parentOf.get(c) as number) === id),
    }));
}

export type PurgeOutcome =
  | { purged: PurgedRoot }
  | { refused: 'not_found' | 'not_in_trash' | 'deleted_with_parent' };

/** Purges one ticket from the trash now, as a site administrator asked (one event). */
export async function purgeTicketNow(
  db: Kysely<Database>,
  workspaceId: number,
  ticketId: number,
  actorId: number,
): Promise<PurgeOutcome> {
  return db.transaction().execute(async (trx): Promise<PurgeOutcome> => {
    await shareHierarchy(trx, workspaceId);
    const row = await trx
      .selectFrom('ticket')
      .select(['id', 'deleted_at', 'trashed_with'])
      .where('id', '=', ticketId)
      .where('workspace_id', '=', workspaceId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) return { refused: 'not_found' };
    if (!row.deleted_at) return { refused: 'not_in_trash' };
    if (row.trashed_with !== null) return { refused: 'deleted_with_parent' };
    const [purged] = await purgeTicketSet(trx, workspaceId, [ticketId], { actorId });
    if (!purged) return { refused: 'not_found' };
    await emit(
      trx,
      { workspaceId, actorId },
      {
        type: 'ticket.purged',
        subjectId: purged.id,
        payload: {
          key: purged.key,
          subtickets: purged.subtickets,
          detachedChildren: purged.detachedChildren,
          reason: 'admin',
        },
      },
    );
    return { purged };
  });
}

export interface TrackPurge {
  key: string;
  name: string;
  tickets: number;
}

/**
 * Deletes a track in the trash for good, in batches of tickets, then the track itself with one
 * `track.purged` event. Returns null when the track is not in the trash (or already gone), and
 * 'unfinished' when the deadline came first. Safe to run again after an interruption: the mark
 * set at the start keeps it unrestorable, and the next run carries on.
 */
export async function purgeTrack(
  db: Kysely<Database>,
  workspaceId: number,
  trackId: number,
  options: {
    actorId: number | null;
    reason: PurgeReason;
    batchSize?: number;
    /** Stop between batches after this time (ms since the epoch). */
    deadline?: number;
  },
): Promise<TrackPurge | 'unfinished' | null> {
  const started = await db.transaction().execute(async (trx) => {
    const track = await trx
      .selectFrom('track')
      .select(['id', 'key', 'name', 'deleted_at'])
      .where('id', '=', trackId)
      .where('workspace_id', '=', workspaceId)
      .forUpdate()
      .executeTakeFirst();
    if (!track?.deleted_at) return null;
    await sql`
      UPDATE track SET purge_started_at = coalesce(purge_started_at, now())
       WHERE id = ${trackId}`.execute(trx);
    return track;
  });
  if (!started) return null;

  let tickets = 0;
  const batch = options.batchSize ?? PURGE_BATCH;
  for (;;) {
    if (options.deadline !== undefined && Date.now() >= options.deadline) return 'unfinished';
    const removed = await db.transaction().execute(async (trx) => {
      await shareHierarchy(trx, workspaceId);
      const pick = await trx
        .selectFrom('ticket')
        .select('id')
        .where('track_id', '=', trackId)
        .orderBy('number')
        .limit(batch)
        .execute();
      if (pick.length === 0) return 0;
      const purged = await purgeTicketSet(
        trx,
        workspaceId,
        pick.map((p) => p.id),
        { actorId: options.actorId, trackId },
      );
      return purged.reduce((n, p) => n + 1 + p.subtickets.length, 0);
    });
    if (removed === 0) break;
    tickets += removed;
  }

  return db.transaction().execute(async (trx) => {
    const track = await trx
      .selectFrom('track')
      .select(['key', 'name'])
      .where('id', '=', trackId)
      .where('deleted_at', 'is not', null)
      .forUpdate()
      .executeTakeFirst();
    if (!track) return null;
    // A ticket created there since the last batch cannot be: nobody may create in the trash.
    // Old keys of tickets that moved away stop resolving with the track key.
    await trx.deleteFrom('ticket_key_history').where('track_id', '=', trackId).execute();
    const releases = trx.selectFrom('release').select('id').where('track_id', '=', trackId);
    const areas = trx.selectFrom('area').select('id').where('track_id', '=', trackId);
    await trx.deleteFrom('ticket_release').where('release_id', 'in', releases).execute();
    await trx.deleteFrom('ticket_area').where('area_id', 'in', areas).execute();
    await trx.deleteFrom('release').where('track_id', '=', trackId).execute();
    await trx.deleteFrom('area').where('track_id', '=', trackId).execute();
    // The rest cascades: key history, counter, role actors, its own policy, type set and types.
    await trx.deleteFrom('track').where('id', '=', trackId).execute();
    await emit(
      trx,
      { workspaceId, actorId: options.actorId },
      {
        type: 'track.purged',
        subjectId: trackId,
        payload: { key: track.key, name: track.name, tickets, reason: options.reason },
      },
    );
    return { key: track.key, name: track.name, tickets };
  });
}

export interface PurgeReport {
  tickets: number;
  tracks: number;
  /** The run stopped at its deadline or batch limit with more to purge. */
  more: boolean;
}

/**
 * Removes everything that has outlived the retention, workspace by workspace: tickets in
 * batches (one transaction and one event per ticket each), then tracks. A `deadline` (or
 * `maxBatches` per workspace) bounds a run, so it never holds the worker too long; the report
 * says when more is left, and the job queues the next run at once.
 */
export async function purgeExpired(
  db: Kysely<Database>,
  options: { now?: Date; batchSize?: number; maxBatches?: number; deadline?: number } = {},
): Promise<PurgeReport> {
  const now = options.now ?? new Date();
  const batch = options.batchSize ?? PURGE_BATCH;
  const report: PurgeReport = { tickets: 0, tracks: 0, more: false };
  const late = () => options.deadline !== undefined && Date.now() >= options.deadline;
  const workspaces = await db.selectFrom('workspace').select('id').orderBy('id').execute();
  for (const { id: workspaceId } of workspaces) {
    const cutoff = retentionCutoff(now, await trashRetentionDays(db, workspaceId));
    for (let round = 0; ; round++) {
      if (late() || round >= (options.maxBatches ?? Number.POSITIVE_INFINITY)) {
        report.more = true;
        return report;
      }
      const purged = await db.transaction().execute(async (trx) => {
        await shareHierarchy(trx, workspaceId);
        const { rows } = await sql<{ id: number }>`
          SELECT id FROM ticket
           WHERE workspace_id = ${workspaceId} AND deleted_at IS NOT NULL
             AND deleted_at <= ${cutoff} AND trashed_with IS NULL
           ORDER BY deleted_at, id LIMIT ${batch}
           FOR UPDATE SKIP LOCKED`.execute(trx);
        const roots = await purgeTicketSet(
          trx,
          workspaceId,
          rows.map((r) => r.id),
          { actorId: null },
        );
        for (const root of roots) {
          await emit(
            trx,
            { workspaceId, actorId: null, ip: null },
            {
              type: 'ticket.purged',
              subjectId: root.id,
              payload: {
                key: root.key,
                subtickets: root.subtickets,
                detachedChildren: root.detachedChildren,
                reason: 'retention',
              },
            },
          );
        }
        return roots.reduce((n, r) => n + 1 + r.subtickets.length, 0);
      });
      if (purged === 0) break;
      report.tickets += purged;
    }
    const tracks = await db
      .selectFrom('track')
      .select('id')
      .where('workspace_id', '=', workspaceId)
      .where('deleted_at', 'is not', null)
      .where((eb) =>
        eb.or([eb('deleted_at', '<=', cutoff), eb('purge_started_at', 'is not', null)]),
      )
      .orderBy('deleted_at')
      .execute();
    for (const track of tracks) {
      const done = await purgeTrack(db, workspaceId, track.id, {
        actorId: null,
        reason: 'retention',
        batchSize: batch,
        ...(options.deadline !== undefined ? { deadline: options.deadline } : {}),
      });
      if (done === 'unfinished') {
        report.more = true;
        return report;
      }
      if (done) report.tracks += 1;
    }
  }
  return report;
}

/** How long one purge run may take before it hands over to the next (the worker has more to do). */
export const PURGE_RUN_MS = 3 * 60_000;

/** The queued purge; its key makes it run once an hour across all workers. */
export const PURGE_TASK = 'trash.purge';

export async function schedulePurge(db: Kysely<Database>, now = new Date()): Promise<boolean> {
  const added = await enqueue(db, [
    {
      workspaceId: await defaultWorkspaceId(db),
      task: PURGE_TASK,
      key: `${PURGE_TASK}:${now.toISOString().slice(0, 13)}`,
      maxAttempts: 3,
    },
  ]);
  return added > 0;
}

export function registerTrashJobs(
  runner: JobRunner,
  db: Kysely<Database>,
  onPurged: (report: PurgeReport) => void = () => {},
): void {
  runner.handle(PURGE_TASK, async (job) => {
    const report = await purgeExpired(db, { deadline: Date.now() + PURGE_RUN_MS });
    if (report.tickets > 0 || report.tracks > 0) onPurged(report);
    // A large backlog (a bulk delete, a big track) goes on in the next run, at once.
    if (report.more) {
      await enqueue(db, [
        {
          workspaceId: job.workspaceId,
          task: PURGE_TASK,
          key: `${PURGE_TASK}:after:${job.id}`,
          maxAttempts: 3,
        },
      ]);
    }
  });
}
