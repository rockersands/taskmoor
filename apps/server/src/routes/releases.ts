import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, type RawBuilder, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { requireUser } from '../auth';
import type { Authorizer } from '../authz/authorizer';
import { diff, emit } from '../events/bus';
import { enforceLimit } from '../guardrails/model';
import { findTeam } from '../teams';
import { rewriteTickets, writeOrder } from '../tickets/fields';
import { isCalendarDay } from '../tickets/model';

/**
 * Releases and areas of a track (M1-014; CORE-015, CORE-016; spec 01a section 1.3).
 *
 * - Everyone who may browse a track reads its releases and areas; its administrators (and
 *   site and configuration administrators) change them while the track is not archived.
 * - Releases keep a manual order (`PUT /api/v1/tracks/:id/releases/order` lists every one),
 *   which `latestShippedRelease()` and the release pages follow (CORE-016 (3)).
 * - Shipping a release whose target tickets are still open answers 409 `open_tickets` unless
 *   the call says where they go: `moveOpenTo` another upcoming release, or null to leave them
 *   (CORE-016 (1)). With approvals required, shipping waits until every approver approves;
 *   declines are recorded (CORE-016 (2)).
 * - Merging points every ticket of a release at another and removes it; deleting a release in
 *   use needs `removeFromTickets=true`. Deleting an area in use needs a replacement or that
 *   flag. Tickets record these changes in their history.
 * - Archived releases and areas stay on the tickets that have them; no ticket takes one anew.
 * - An area's owner and rule name the assignee of a new ticket with no assignee (CORE-015
 *   (1)).
 *
 * Every successful mutation emits exactly one domain event in its transaction (ADR-015).
 */
const MAX_INT = 2_147_483_647;
const id = z.coerce.number().int().positive().max(MAX_INT);
const name = z.string().trim().min(1).max(255);
const description = z.string().max(10_000);
const day = z.string().refine(isCalendarDay, 'a calendar day as YYYY-MM-DD');
const unique = <T>(list: readonly T[]) => new Set(list).size === list.length;
export const archivedQuery = z
  .object({ archived: z.enum(['exclude', 'include', 'only']).default('exclude') })
  .strict();

const releaseFields = {
  name,
  description,
  startDate: day.nullable(),
  releaseDate: day.nullable(),
  requireApprovals: z.boolean(),
};
export const createReleaseBody = z
  .object({
    name,
    description: description.optional(),
    startDate: releaseFields.startDate.optional(),
    releaseDate: releaseFields.releaseDate.optional(),
    requireApprovals: releaseFields.requireApprovals.optional(),
  })
  .strict();
const updateReleaseBody = z.object(releaseFields).partial().strict();
const shipBody = z
  .object({ releaseDate: day.optional(), moveOpenTo: id.nullable().optional() })
  .strict();
const approversBody = z
  .object({ userIds: z.array(id).max(50).refine(unique, 'each person once') })
  .strict();
const decisionBody = z
  .object({ decision: z.enum(['approved', 'declined']), comment: z.string().max(2000).optional() })
  .strict();
const releaseDeleteQuery = z
  .object({ removeFromTickets: z.enum(['true', 'false']).optional() })
  .strict();

const AREA_RULES = ['area_owner', 'track_owner', 'unassigned'] as const;
const areaFields = {
  name,
  description,
  ownerId: id.nullable(),
  /** The team that owns the area (M1-123, CORE-027). */
  ownerTeamId: id.nullable(),
  defaultAssignee: z.enum(AREA_RULES),
};
const createAreaBody = z
  .object({
    name,
    description: description.optional(),
    ownerId: areaFields.ownerId.optional(),
    ownerTeamId: areaFields.ownerTeamId.optional(),
    defaultAssignee: areaFields.defaultAssignee.optional(),
  })
  .strict();
const updateAreaBody = z.object(areaFields).partial().strict();
const areaDeleteQuery = z
  .object({
    replacementId: id.optional(),
    removeFromTickets: z.enum(['true', 'false']).optional(),
  })
  .strict();

type Db = Kysely<Database> | Transaction<Database>;

function uniqueViolation(error: unknown): string | null {
  const e = error as { code?: string; constraint?: string };
  return e.code === '23505' ? (e.constraint ?? '') : null;
}

const invalid = (reply: FastifyReply, detail?: string) =>
  reply.code(400).send({ error: 'invalid_request', ...(detail ? { detail } : {}) });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });

/** Today in UTC, as the day a release ships when none is given. */
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Releases with their target tickets counted; `visible` limits the counts to the tickets a
 * viewer may see (QRY-008 (1), M1-020), as the ticket filter's predicate on `k`.
 */
export function releaseQuery(
  db: Db,
  workspaceId: number,
  visible: RawBuilder<boolean> = sql`true`,
) {
  return db
    .selectFrom('release as r')
    // The release across tracks it is in, at most one (PLN-007).
    .leftJoin('cross_track_release_member as ctm', 'ctm.release_id', 'r.id')
    .leftJoin('cross_track_release as ctr', 'ctr.id', 'ctm.cross_track_release_id')
    .select([
      'ctr.id as cross_id',
      'ctr.name as cross_name',
      'ctr.end_rule as cross_end_rule',
      'ctr.release_date as cross_date',
      'r.id',
      'r.track_id',
      'r.name',
      'r.description',
      'r.start_date',
      'r.release_date',
      'r.sort_order',
      'r.shipped_at',
      'r.archived_at',
      'r.require_approvals',
      // Target tickets outside the trash, and those of them closed.
      (eb) =>
        eb
          .selectFrom('ticket_release as tr')
          .innerJoin('ticket as k', 'k.id', 'tr.ticket_id')
          .select(sql<string>`count(*)`.as('n'))
          .whereRef('tr.release_id', '=', 'r.id')
          .where('tr.role', '=', 'target')
          .where('k.deleted_at', 'is', null)
          .where(visible)
          .as('ticket_count'),
      (eb) =>
        eb
          .selectFrom('ticket_release as tr')
          .innerJoin('ticket as k', 'k.id', 'tr.ticket_id')
          .select(sql<string>`count(*)`.as('n'))
          .whereRef('tr.release_id', '=', 'r.id')
          .where('tr.role', '=', 'target')
          .where('k.deleted_at', 'is', null)
          .where('k.closed_at', 'is not', null)
          .where(visible)
          .as('closed_count'),
    ])
    .where('r.workspace_id', '=', workspaceId);
}
type ReleaseRow = Awaited<ReturnType<ReturnType<typeof releaseQuery>['executeTakeFirstOrThrow']>>;

export function releaseView(r: ReleaseRow) {
  const tickets = Number(r.ticket_count ?? 0);
  const closed = Number(r.closed_count ?? 0);
  return {
    id: r.id,
    trackId: r.track_id,
    name: r.name,
    description: r.description,
    startDate: r.start_date,
    releaseDate: r.release_date,
    order: r.sort_order,
    shipped: r.shipped_at !== null,
    shippedAt: r.shipped_at?.toISOString() ?? null,
    archived: r.archived_at !== null,
    archivedAt: r.archived_at?.toISOString() ?? null,
    requireApprovals: r.require_approvals,
    progress: { tickets, closed, open: tickets - closed },
    // Upcoming, with its release day gone by.
    overdue: r.shipped_at === null && r.release_date !== null && r.release_date < today(),
    // Anyone who sees the release sees this: they see one of its linked tracks.
    crossTrack:
      r.cross_id === null
        ? null
        : {
            id: r.cross_id,
            name: r.cross_name,
            endRule: r.cross_end_rule,
            date: r.cross_date,
          },
  };
}

function areaQuery(db: Db, workspaceId: number) {
  return db
    .selectFrom('area as a')
    .leftJoin('app_user as u', 'u.id', 'a.owner_id')
    .leftJoin('team as tm', 'tm.id', 'a.owner_team_id')
    .select([
      'a.id',
      'a.track_id',
      'a.name',
      'a.description',
      'a.owner_id',
      'u.name as owner_name',
      'a.owner_team_id',
      'tm.name as owner_team_name',
      'a.default_assignee',
      'a.archived_at',
    ])
    .where('a.workspace_id', '=', workspaceId);
}
type AreaRow = Awaited<ReturnType<ReturnType<typeof areaQuery>['executeTakeFirstOrThrow']>>;

const areaView = (a: AreaRow) => ({
  id: a.id,
  trackId: a.track_id,
  name: a.name,
  description: a.description,
  owner: a.owner_id === null ? null : { id: a.owner_id, name: a.owner_name ?? '' },
  ownerTeam:
    a.owner_team_id === null ? null : { id: a.owner_team_id, name: a.owner_team_name ?? '' },
  defaultAssignee: a.default_assignee,
  archived: a.archived_at !== null,
  archivedAt: a.archived_at?.toISOString() ?? null,
});

/**
 * Locks the release across tracks a release is in, before the release itself is locked: the order a
 * move takes, so a merge or a delete cannot deadlock with one (PLN-007).
 */
async function lockCrossTrackOf(trx: Transaction<Database>, releaseId: number) {
  const member = await trx
    .selectFrom('cross_track_release_member')
    .select('cross_track_release_id')
    .where('release_id', '=', releaseId)
    .executeTakeFirst();
  if (!member) return;
  await trx
    .selectFrom('cross_track_release')
    .select('id')
    .where('id', '=', member.cross_track_release_id)
    .forUpdate()
    .execute();
}

/** Tickets that point at a release (in either role), trash included. */
async function releaseTickets(db: Db, releaseId: number, role?: 'target' | 'found') {
  let query = db
    .selectFrom('ticket_release')
    .select('ticket_id')
    .distinct()
    .where('release_id', '=', releaseId);
  if (role) query = query.where('role', '=', role);
  return (await query.execute()).map((r) => r.ticket_id);
}

export function registerReleaseRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  authorizer: Authorizer,
): void {
  const by = (request: FastifyRequest) => ({
    workspaceId: request.workspaceId,
    actorId: request.user?.id ?? null,
  });

  async function isAdmin(request: FastifyRequest): Promise<boolean> {
    const global = await request.authz.global();
    return global.has('site_admin') || global.has('configuration_admin');
  }

  async function canSeeTrack(request: FastifyRequest, trackId: number): Promise<boolean> {
    const held = await request.authz.track(trackId);
    if (held.has('browse_track') || held.has('administer_track')) return true;
    return isAdmin(request);
  }

  /** A track of the workspace the caller may see; answers 404 otherwise. */
  async function visibleTrack(request: FastifyRequest, reply: FastifyReply, trackId: number) {
    const track = await db
      .selectFrom('track')
      .select(['id', 'archived_at'])
      .where('id', '=', trackId)
      .where('workspace_id', '=', request.workspaceId)
      // A track in the trash and everything in it are invisible (M1-101).
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!track || !(await canSeeTrack(request, trackId))) {
      await notFound(reply);
      return null;
    }
    return track;
  }

  /**
   * Whether the caller may change the track's releases and areas: its administrators and
   * site and configuration administrators, while it is not archived. Answers the refusal.
   */
  async function mayManage(
    request: FastifyRequest,
    reply: FastifyReply,
    trackId: number,
  ): Promise<boolean> {
    if (!requireUser(request, reply)) return false;
    const track = await visibleTrack(request, reply, trackId);
    if (!track) return false;
    if (track.archived_at) {
      await reply.code(409).send({ error: 'track_archived' });
      return false;
    }
    if ((await request.authz.can('administer_track', trackId)) || (await isAdmin(request))) {
      return true;
    }
    await reply.code(403).send({ error: 'forbidden' });
    return false;
  }

  /** The track of a release or an area, for the checks above; null when there is none. */
  async function trackOf(table: 'release' | 'area', workspaceId: number, rowId: number) {
    const row = await db
      .selectFrom(table)
      .select('track_id')
      .where('id', '=', rowId)
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirst();
    return row?.track_id ?? null;
  }

  async function activeUser(workspaceId: number, userId: number) {
    const row = await db
      .selectFrom('app_user')
      .select('id')
      .where('id', '=', userId)
      .where('workspace_id', '=', workspaceId)
      .where('deactivated_at', 'is', null)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** The counts a viewer may see: of the tickets visible to them. */
  const visibleTo = async (request: FastifyRequest) => (await request.authz.ticketFilter()).sql;

  async function approverViews(releaseId: number) {
    const rows = await db
      .selectFrom('release_approver as ra')
      .innerJoin('app_user as u', 'u.id', 'ra.user_id')
      .select(['ra.user_id', 'u.name', 'ra.decision', 'ra.comment', 'ra.decided_at'])
      .where('ra.release_id', '=', releaseId)
      .orderBy('u.name')
      .orderBy('ra.user_id')
      .execute();
    return rows.map((r) => ({
      user: { id: r.user_id, name: r.name },
      decision: r.decision,
      comment: r.comment,
      decidedAt: r.decided_at?.toISOString() ?? null,
    }));
  }

  /** A release with its approvers, as the release page shows it. */
  async function fullRelease(request: FastifyRequest, releaseId: number) {
    const row = await releaseQuery(db, request.workspaceId, await visibleTo(request))
      .where('r.id', '=', releaseId)
      .executeTakeFirst();
    if (!row) return null;
    return { ...releaseView(row), approvers: await approverViews(releaseId) };
  }

  /** The release row, locked; null when it is gone. */
  const lockRelease = (trx: Transaction<Database>, releaseId: number) =>
    trx
      .selectFrom('release')
      .select(['id', 'track_id', 'name', 'shipped_at', 'archived_at', 'require_approvals'])
      .where('id', '=', releaseId)
      .forUpdate()
      .executeTakeFirst();
  /** The track's releases that are not archived: what `releases_per_track` counts (M1-055). */
  const openReleases = async (trx: Transaction<Database>, trackId: number) =>
    (
      await trx
        .selectFrom('release')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('track_id', '=', trackId)
        .where('archived_at', 'is', null)
        .executeTakeFirstOrThrow()
    ).n;

  // Releases (CORE-016)

  app.get('/api/v1/tracks/:id/releases', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const params = z.object({ id }).safeParse(request.params);
    const query = archivedQuery.safeParse(request.query);
    if (!params.success || !query.success) return invalid(reply);
    const track = await visibleTrack(request, reply, params.data.id);
    if (!track) return reply;
    let q = releaseQuery(db, request.workspaceId, await visibleTo(request)).where(
      'r.track_id',
      '=',
      params.data.id,
    );
    if (query.data.archived === 'exclude') q = q.where('r.archived_at', 'is', null);
    if (query.data.archived === 'only') q = q.where('r.archived_at', 'is not', null);
    const rows = await q.orderBy('r.sort_order').execute();
    // Whether the caller may change them, for the releases hub (M1-050).
    const mayManage =
      track.archived_at === null &&
      ((await request.authz.can('administer_track', params.data.id)) || (await isAdmin(request)));
    return { releases: rows.map(releaseView), mayManage };
  });

  app.post('/api/v1/tracks/:id/releases', async (request, reply) => {
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    const trackId = params.data.id;
    if (!(await mayManage(request, reply, trackId))) return reply;
    const parsed = createReleaseBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const body = parsed.data;
    const ws = request.workspaceId;
    if (body.startDate && body.releaseDate && body.startDate > body.releaseDate) {
      return invalid(reply, 'startDate comes after releaseDate');
    }
    try {
      const releaseId = await db.transaction().execute(async (trx) => {
        // One change to the track's order at a time.
        await trx
          .selectFrom('track')
          .select('id')
          .where('id', '=', trackId)
          .forNoKeyUpdate()
          .execute();
        await enforceLimit(trx, ws, 'releases_per_track', (await openReleases(trx, trackId)) + 1);
        const last = await trx
          .selectFrom('release')
          .select(sql<number>`coalesce(max(sort_order), 0)`.as('n'))
          .where('track_id', '=', trackId)
          .executeTakeFirstOrThrow();
        const row = await trx
          .insertInto('release')
          .values({
            workspace_id: ws,
            track_id: trackId,
            name: body.name,
            description: body.description ?? '',
            start_date: body.startDate ?? null,
            release_date: body.releaseDate ?? null,
            require_approvals: body.requireApprovals ?? false,
            sort_order: Number(last.n) + 1,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await emit(trx, by(request), {
          type: 'release.created',
          subjectId: row.id,
          payload: { trackId, name: body.name },
        });
        return row.id;
      });
      return reply.code(201).send({ release: await fullRelease(request, releaseId) });
    } catch (error) {
      if (uniqueViolation(error) === 'release_name_idx') {
        return reply.code(409).send({ error: 'name_taken' });
      }
      throw error;
    }
  });

  app.put('/api/v1/tracks/:id/releases/order', async (request, reply) => {
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    const trackId = params.data.id;
    if (!(await mayManage(request, reply, trackId))) return reply;
    const parsed = z
      .object({ releaseIds: z.array(id).min(1).max(20_000).refine(unique, 'each id once') })
      .strict()
      .safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const ids = parsed.data.releaseIds;
    const ws = request.workspaceId;
    const done = await db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('track')
        .select('id')
        .where('id', '=', trackId)
        .forNoKeyUpdate()
        .execute();
      const rows = await trx
        .selectFrom('release')
        .select('id')
        .where('track_id', '=', trackId)
        .execute();
      const all = new Set(rows.map((r) => r.id));
      if (all.size !== ids.length || ids.some((i) => !all.has(i))) return false;
      await writeOrder(trx, 'release', ids);
      await emit(trx, by(request), {
        type: 'release.reordered',
        subjectId: trackId,
        payload: { releaseIds: ids },
      });
      return true;
    });
    if (!done) return invalid(reply, 'releaseIds must list every release of the track once');
    const rows = await releaseQuery(db, ws, await visibleTo(request))
      .where('r.track_id', '=', trackId)
      .orderBy('r.sort_order')
      .execute();
    return { releases: rows.map(releaseView) };
  });

  app.get('/api/v1/releases/:id', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    const ws = request.workspaceId;
    const trackId = await trackOf('release', ws, params.data.id);
    if (trackId === null) return notFound(reply);
    if (!(await visibleTrack(request, reply, trackId))) return reply;
    return { release: await fullRelease(request, params.data.id) };
  });

  /** The release's track, checked for the caller; answers the refusal and returns null. */
  async function managedRelease(request: FastifyRequest, reply: FastifyReply) {
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) {
      await invalid(reply);
      return null;
    }
    const trackId = await trackOf('release', request.workspaceId, params.data.id);
    if (trackId === null) {
      if (requireUser(request, reply)) await notFound(reply);
      return null;
    }
    if (!(await mayManage(request, reply, trackId))) return null;
    return { releaseId: params.data.id, trackId };
  }

  app.patch('/api/v1/releases/:id', async (request, reply) => {
    const target = await managedRelease(request, reply);
    if (!target) return reply;
    const parsed = updateReleaseBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const body = parsed.data;
    const ws = request.workspaceId;
    try {
      const result = await db.transaction().execute(async (trx) => {
        const current = await trx
          .selectFrom('release')
          .select(['name', 'description', 'start_date', 'release_date', 'require_approvals'])
          .where('id', '=', target.releaseId)
          .forNoKeyUpdate()
          .executeTakeFirst();
        if (!current) return { missing: true as const };
        const start = body.startDate !== undefined ? body.startDate : current.start_date;
        const end = body.releaseDate !== undefined ? body.releaseDate : current.release_date;
        if (start && end && start > end) return { badDates: true as const };
        const changes = diff<Record<string, unknown>>(
          {
            name: current.name,
            description: current.description,
            startDate: current.start_date,
            releaseDate: current.release_date,
            requireApprovals: current.require_approvals,
          },
          body,
        );
        if (Object.keys(changes).length === 0) return { done: true as const };
        await trx
          .updateTable('release')
          .set({
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.description !== undefined ? { description: body.description } : {}),
            ...(body.startDate !== undefined ? { start_date: body.startDate } : {}),
            ...(body.releaseDate !== undefined ? { release_date: body.releaseDate } : {}),
            ...(body.requireApprovals !== undefined
              ? { require_approvals: body.requireApprovals }
              : {}),
            updated_at: new Date(),
          })
          .where('id', '=', target.releaseId)
          .execute();
        await emit(trx, by(request), {
          type: 'release.updated',
          subjectId: target.releaseId,
          payload: { changes },
        });
        return { done: true as const };
      });
      if ('missing' in result) return notFound(reply);
      if ('badDates' in result) return invalid(reply, 'startDate comes after releaseDate');
      return { release: await fullRelease(request, target.releaseId) };
    } catch (error) {
      if (uniqueViolation(error) === 'release_name_idx') {
        return reply.code(409).send({ error: 'name_taken' });
      }
      throw error;
    }
  });

  // Shipping (CORE-016 (1) and (2)).
  app.post('/api/v1/releases/:id/ship', async (request, reply) => {
    const target = await managedRelease(request, reply);
    if (!target) return reply;
    const parsed = shipBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply);
    const body = parsed.data;
    const ws = request.workspaceId;
    const actorId = request.user?.id ?? null;
    const moveTo = body.moveOpenTo;
    if (moveTo === target.releaseId) return invalid(reply, 'moveOpenTo');
    const result = await db.transaction().execute(async (trx) => {
      const release = await lockRelease(trx, target.releaseId);
      if (!release) return { missing: true as const };
      if (release.shipped_at) return { conflict: 'already_shipped' };
      if (release.archived_at) return { conflict: 'release_archived' };
      if (release.require_approvals) {
        const approvers = await trx
          .selectFrom('release_approver')
          .select(['user_id', 'decision'])
          .where('release_id', '=', target.releaseId)
          .orderBy('user_id')
          .execute();
        const pending = approvers.filter((a) => a.decision !== 'approved');
        if (pending.length > 0) {
          return {
            conflict: 'approvals_pending',
            detail: {
              pending: pending.filter((a) => a.decision === null).map((a) => a.user_id),
              declined: pending.filter((a) => a.decision === 'declined').map((a) => a.user_id),
            },
          };
        }
      }
      if (moveTo != null) {
        const next = await trx
          .selectFrom('release')
          .select(['track_id', 'shipped_at', 'archived_at'])
          .where('id', '=', moveTo)
          .where('workspace_id', '=', ws)
          .forKeyShare()
          .executeTakeFirst();
        if (!next || next.track_id !== release.track_id || next.shipped_at || next.archived_at) {
          return { badTarget: true as const };
        }
      }
      // Open: a target ticket outside the trash that is not closed.
      const open = await trx
        .selectFrom('ticket_release as tr')
        .innerJoin('ticket as k', 'k.id', 'tr.ticket_id')
        .select('k.id')
        .where('tr.release_id', '=', target.releaseId)
        .where('tr.role', '=', 'target')
        .where('k.deleted_at', 'is', null)
        .where('k.closed_at', 'is', null)
        .execute();
      if (open.length > 0 && moveTo === undefined) {
        return { conflict: 'open_tickets', detail: { openTickets: open.length } };
      }
      if (moveTo != null) {
        await rewriteTickets(
          trx,
          ws,
          actorId,
          open.map((t) => t.id),
          async (ids) => {
            await sql`
              INSERT INTO ticket_release (workspace_id, ticket_id, release_id, role)
              SELECT workspace_id, ticket_id, ${moveTo}, 'target' FROM ticket_release
               WHERE release_id = ${target.releaseId} AND role = 'target'
                 AND ticket_id = ANY(${ids}::int[])
              ON CONFLICT DO NOTHING`.execute(trx);
            await trx
              .deleteFrom('ticket_release')
              .where('release_id', '=', target.releaseId)
              .where('role', '=', 'target')
              .where('ticket_id', 'in', ids)
              .execute();
          },
        );
      }
      const releaseDate = body.releaseDate ?? today();
      await trx
        .updateTable('release')
        .set({ shipped_at: new Date(), release_date: releaseDate, updated_at: new Date() })
        .where('id', '=', target.releaseId)
        .execute();
      await emit(trx, by(request), {
        type: 'release.shipped',
        subjectId: target.releaseId,
        payload: {
          name: release.name,
          releaseDate,
          openTickets: open.length,
          movedTo: moveTo ?? null,
        },
      });
      return { done: true as const };
    });
    if ('missing' in result) return notFound(reply);
    if ('badTarget' in result) return invalid(reply, 'moveOpenTo');
    if ('conflict' in result) {
      return reply.code(409).send({ error: result.conflict, ...(result.detail ?? {}) });
    }
    return { release: await fullRelease(request, target.releaseId) };
  });

  for (const action of ['unship', 'archive', 'restore'] as const) {
    app.post(`/api/v1/releases/:id/${action}`, async (request, reply) => {
      const target = await managedRelease(request, reply);
      if (!target) return reply;
      const ws = request.workspaceId;
      const result = await db.transaction().execute(async (trx) => {
        const release = await lockRelease(trx, target.releaseId);
        if (!release) return { missing: true as const };
        const now = new Date();
        if (action === 'unship') {
          if (!release.shipped_at) return { conflict: 'not_shipped' };
          await trx
            .updateTable('release')
            .set({ shipped_at: null, updated_at: now })
            .where('id', '=', target.releaseId)
            .execute();
          await emit(trx, by(request), {
            type: 'release.unshipped',
            subjectId: target.releaseId,
            payload: { name: release.name },
          });
        } else {
          const archiving = action === 'archive';
          if ((release.archived_at !== null) === archiving) {
            return { conflict: archiving ? 'already_archived' : 'not_archived' };
          }
          // Archived releases do not count; one coming back does (CORE-026).
          if (!archiving) {
            await enforceLimit(
              trx,
              ws,
              'releases_per_track',
              (await openReleases(trx, release.track_id)) + 1,
            );
          }
          await trx
            .updateTable('release')
            .set({ archived_at: archiving ? now : null, updated_at: now })
            .where('id', '=', target.releaseId)
            .execute();
          await emit(trx, by(request), {
            type: archiving ? 'release.archived' : 'release.restored',
            subjectId: target.releaseId,
            payload: { name: release.name },
          });
        }
        return { done: true as const };
      });
      if ('missing' in result) return notFound(reply);
      if ('conflict' in result) return reply.code(409).send({ error: result.conflict });
      return { release: await fullRelease(request, target.releaseId) };
    });
  }

  // Every ticket of the release points at `into` instead, in the same role.
  app.post('/api/v1/releases/:id/merge', async (request, reply) => {
    const target = await managedRelease(request, reply);
    if (!target) return reply;
    const parsed = z.object({ into: id }).strict().safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const into = parsed.data.into;
    if (into === target.releaseId) return invalid(reply, 'into');
    const ws = request.workspaceId;
    const actorId = request.user?.id ?? null;
    const result = await db.transaction().execute(async (trx) => {
      await lockCrossTrackOf(trx, target.releaseId);
      // Both releases, in id order, so two opposite merges cannot deadlock.
      const held = await trx
        .selectFrom('release')
        .select(['id', 'track_id', 'name'])
        .where('id', 'in', [target.releaseId, into])
        .where('workspace_id', '=', ws)
        .orderBy('id')
        .forUpdate()
        .execute();
      const release = held.find((r) => r.id === target.releaseId);
      const kept = held.find((r) => r.id === into);
      if (!release) return { missing: true as const };
      if (!kept || kept.track_id !== release.track_id) return { badTarget: true as const };
      const tickets = await releaseTickets(trx, target.releaseId);
      const ticketCount = await rewriteTickets(trx, ws, actorId, tickets, async (ids) => {
        await sql`
          INSERT INTO ticket_release (workspace_id, ticket_id, release_id, role)
          SELECT workspace_id, ticket_id, ${into}, role FROM ticket_release
           WHERE release_id = ${target.releaseId} AND ticket_id = ANY(${ids}::int[])
          ON CONFLICT DO NOTHING`.execute(trx);
        await trx
          .deleteFrom('ticket_release')
          .where('release_id', '=', target.releaseId)
          .where('ticket_id', 'in', ids)
          .execute();
      });
      await leaveCrossTrack(request, trx, target.releaseId, release.track_id, 'release_merged');
      await removeRelease(trx, target.releaseId, release.track_id);
      await emit(trx, by(request), {
        type: 'release.merged',
        subjectId: target.releaseId,
        payload: { name: release.name, into, ticketCount },
      });
      return { done: true as const };
    });
    if ('missing' in result) return notFound(reply);
    if ('badTarget' in result) return invalid(reply, 'into');
    return { release: await fullRelease(request, into) };
  });

  /**
   * A linked release that goes takes its row with it: the release across tracks says so in one
   * event of its own, in this transaction, and its version moves, so a confirmed list still matches
   * what a move does (PLN-007).
   */
  async function leaveCrossTrack(
    request: FastifyRequest,
    trx: Transaction<Database>,
    releaseId: number,
    trackId: number,
    reason: 'release_merged' | 'release_deleted',
  ) {
    const member = await trx
      .selectFrom('cross_track_release_member')
      .select('cross_track_release_id')
      .where('release_id', '=', releaseId)
      .executeTakeFirst();
    if (!member) return;
    await trx
      .updateTable('cross_track_release')
      .set((eb) => ({ version: eb('version', '+', 1), updated_at: new Date() }))
      .where('id', '=', member.cross_track_release_id)
      .execute();
    await emit(trx, by(request), {
      type: 'cross_track_release.member_removed',
      subjectId: member.cross_track_release_id,
      payload: { releaseId, trackId, reason },
    });
  }

  /** Deletes a release and closes the gap it leaves in the track's order. */
  async function removeRelease(trx: Transaction<Database>, releaseId: number, trackId: number) {
    await trx.deleteFrom('release').where('id', '=', releaseId).execute();
    const rest = await trx
      .selectFrom('release')
      .select('id')
      .where('track_id', '=', trackId)
      .orderBy('sort_order')
      .execute();
    await writeOrder(
      trx,
      'release',
      rest.map((r) => r.id),
    );
  }

  app.delete('/api/v1/releases/:id', async (request, reply) => {
    const query = releaseDeleteQuery.safeParse(request.query);
    if (!query.success) return invalid(reply);
    const target = await managedRelease(request, reply);
    if (!target) return reply;
    const remove = query.data.removeFromTickets === 'true';
    const ws = request.workspaceId;
    const actorId = request.user?.id ?? null;
    const result = await db.transaction().execute(async (trx) => {
      await lockCrossTrackOf(trx, target.releaseId);
      const release = await lockRelease(trx, target.releaseId);
      if (!release) return { missing: true as const };
      const tickets = await releaseTickets(trx, target.releaseId);
      if (tickets.length > 0 && !remove) return { inUse: tickets.length };
      const ticketCount = await rewriteTickets(trx, ws, actorId, tickets, async (ids) => {
        await trx
          .deleteFrom('ticket_release')
          .where('release_id', '=', target.releaseId)
          .where('ticket_id', 'in', ids)
          .execute();
      });
      await leaveCrossTrack(request, trx, target.releaseId, release.track_id, 'release_deleted');
      await removeRelease(trx, target.releaseId, release.track_id);
      await emit(trx, by(request), {
        type: 'release.deleted',
        subjectId: target.releaseId,
        payload: { name: release.name, ticketCount },
      });
      return { done: true as const };
    });
    if ('missing' in result) return notFound(reply);
    if ('inUse' in result) {
      return reply.code(409).send({ error: 'in_use', ticketCount: result.inUse });
    }
    return reply.code(204).send();
  });

  // Approvers keep their decision while they stay; new ones start undecided.
  app.put('/api/v1/releases/:id/approvers', async (request, reply) => {
    const target = await managedRelease(request, reply);
    if (!target) return reply;
    const parsed = approversBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const userIds = parsed.data.userIds;
    const ws = request.workspaceId;
    for (const userId of userIds) {
      const sees = (await activeUser(ws, userId))
        ? (await authorizer.trackPermissions(ws, { userId }, target.trackId)).has('browse_track')
        : false;
      if (!sees) return invalid(reply, 'userIds');
    }
    const result = await db.transaction().execute(async (trx) => {
      const release = await lockRelease(trx, target.releaseId);
      if (!release) return { missing: true as const };
      const current = await trx
        .selectFrom('release_approver')
        .select('user_id')
        .where('release_id', '=', target.releaseId)
        .execute();
      const was = current.map((c) => c.user_id);
      const added = userIds.filter((u) => !was.includes(u)).sort((a, b) => a - b);
      const removed = was.filter((u) => !userIds.includes(u)).sort((a, b) => a - b);
      if (added.length === 0 && removed.length === 0) return { done: true as const };
      if (removed.length > 0) {
        await trx
          .deleteFrom('release_approver')
          .where('release_id', '=', target.releaseId)
          .where('user_id', 'in', removed)
          .execute();
      }
      if (added.length > 0) {
        await trx
          .insertInto('release_approver')
          .values(
            added.map((user_id) => ({ workspace_id: ws, release_id: target.releaseId, user_id })),
          )
          .execute();
      }
      await emit(trx, by(request), {
        type: 'release.approvers_set',
        subjectId: target.releaseId,
        payload: { added, removed },
      });
      return { done: true as const };
    });
    if ('missing' in result) return notFound(reply);
    return { release: await fullRelease(request, target.releaseId) };
  });

  // An approver's own decision; a later one replaces it until the release ships.
  app.post('/api/v1/releases/:id/approval', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const params = z.object({ id }).safeParse(request.params);
    const parsed = decisionBody.safeParse(request.body);
    if (!params.success || !parsed.success) return invalid(reply);
    const releaseId = params.data.id;
    const ws = request.workspaceId;
    const trackId = await trackOf('release', ws, releaseId);
    if (trackId === null) return notFound(reply);
    if (!(await visibleTrack(request, reply, trackId))) return reply;
    const comment = parsed.data.comment ?? '';
    const result = await db.transaction().execute(async (trx) => {
      const release = await lockRelease(trx, releaseId);
      if (!release) return { missing: true as const };
      if (release.shipped_at) return { conflict: 'already_shipped' };
      const updated = await trx
        .updateTable('release_approver')
        .set({ decision: parsed.data.decision, comment, decided_at: new Date() })
        .where('release_id', '=', releaseId)
        .where('user_id', '=', user.id)
        .returning('user_id')
        .executeTakeFirst();
      if (!updated) return { notApprover: true as const };
      await emit(trx, by(request), {
        type: 'release.approval_decided',
        subjectId: releaseId,
        payload: { decision: parsed.data.decision, comment },
      });
      return { done: true as const };
    });
    if ('missing' in result) return notFound(reply);
    if ('conflict' in result) return reply.code(409).send({ error: result.conflict });
    if ('notApprover' in result) return reply.code(403).send({ error: 'not_an_approver' });
    return { release: await fullRelease(request, releaseId) };
  });

  // Areas (CORE-015)

  app.get('/api/v1/tracks/:id/areas', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const params = z.object({ id }).safeParse(request.params);
    const query = archivedQuery.safeParse(request.query);
    if (!params.success || !query.success) return invalid(reply);
    if (!(await visibleTrack(request, reply, params.data.id))) return reply;
    let q = areaQuery(db, request.workspaceId).where('a.track_id', '=', params.data.id);
    if (query.data.archived === 'exclude') q = q.where('a.archived_at', 'is', null);
    if (query.data.archived === 'only') q = q.where('a.archived_at', 'is not', null);
    const rows = await q.orderBy(sql`lower(a.name)`).orderBy('a.id').execute();
    return { areas: rows.map(areaView) };
  });

  const loadArea = (d: Db, ws: number, areaId: number) =>
    areaQuery(d, ws).where('a.id', '=', areaId).executeTakeFirst();

  app.post('/api/v1/tracks/:id/areas', async (request, reply) => {
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    const trackId = params.data.id;
    if (!(await mayManage(request, reply, trackId))) return reply;
    const parsed = createAreaBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const body = parsed.data;
    const ws = request.workspaceId;
    if (body.ownerId != null && !(await activeUser(ws, body.ownerId))) {
      return invalid(reply, 'ownerId');
    }
    if (body.ownerTeamId != null && !(await findTeam(db, ws, body.ownerTeamId))) {
      return invalid(reply, 'ownerTeamId');
    }
    try {
      const row = await db.transaction().execute(async (trx) => {
        await trx
          .selectFrom('track')
          .select('id')
          .where('id', '=', trackId)
          .forNoKeyUpdate()
          .execute();
        const areas = await trx
          .selectFrom('area')
          .select(sql<number>`count(*)::int`.as('n'))
          .where('track_id', '=', trackId)
          .where('archived_at', 'is', null)
          .executeTakeFirstOrThrow();
        await enforceLimit(trx, ws, 'areas_per_track', areas.n + 1);
        const created = await trx
          .insertInto('area')
          .values({
            workspace_id: ws,
            track_id: trackId,
            name: body.name,
            description: body.description ?? '',
            owner_id: body.ownerId ?? null,
            owner_team_id: body.ownerTeamId ?? null,
            default_assignee: body.defaultAssignee ?? 'unassigned',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await emit(trx, by(request), {
          type: 'area.created',
          subjectId: created.id,
          payload: { trackId, name: body.name },
        });
        return loadArea(trx, ws, created.id);
      });
      return reply.code(201).send({ area: row ? areaView(row) : null });
    } catch (error) {
      if (uniqueViolation(error) === 'area_name_idx') {
        return reply.code(409).send({ error: 'name_taken' });
      }
      throw error;
    }
  });

  /** The area's track, checked for the caller; answers the refusal and returns null. */
  async function managedArea(request: FastifyRequest, reply: FastifyReply) {
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) {
      await invalid(reply);
      return null;
    }
    const trackId = await trackOf('area', request.workspaceId, params.data.id);
    if (trackId === null) {
      if (requireUser(request, reply)) await notFound(reply);
      return null;
    }
    if (!(await mayManage(request, reply, trackId))) return null;
    return { areaId: params.data.id, trackId };
  }

  app.patch('/api/v1/areas/:id', async (request, reply) => {
    const target = await managedArea(request, reply);
    if (!target) return reply;
    const parsed = updateAreaBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const body = parsed.data;
    const ws = request.workspaceId;
    if (body.ownerId != null && !(await activeUser(ws, body.ownerId))) {
      return invalid(reply, 'ownerId');
    }
    if (body.ownerTeamId != null && !(await findTeam(db, ws, body.ownerTeamId))) {
      return invalid(reply, 'ownerTeamId');
    }
    try {
      const row = await db.transaction().execute(async (trx) => {
        const current = await trx
          .selectFrom('area')
          .select(['name', 'description', 'owner_id', 'owner_team_id', 'default_assignee'])
          .where('id', '=', target.areaId)
          .forNoKeyUpdate()
          .executeTakeFirst();
        if (!current) return null;
        const changes = diff<Record<string, unknown>>(
          {
            name: current.name,
            description: current.description,
            ownerId: current.owner_id,
            ownerTeamId: current.owner_team_id,
            defaultAssignee: current.default_assignee,
          },
          body,
        );
        if (Object.keys(changes).length > 0) {
          await trx
            .updateTable('area')
            .set({
              ...(body.name !== undefined ? { name: body.name } : {}),
              ...(body.description !== undefined ? { description: body.description } : {}),
              ...(body.ownerId !== undefined ? { owner_id: body.ownerId } : {}),
              ...(body.ownerTeamId !== undefined ? { owner_team_id: body.ownerTeamId } : {}),
              ...(body.defaultAssignee !== undefined
                ? { default_assignee: body.defaultAssignee }
                : {}),
              updated_at: new Date(),
            })
            .where('id', '=', target.areaId)
            .execute();
          await emit(trx, by(request), {
            type: 'area.updated',
            subjectId: target.areaId,
            payload: { changes },
          });
        }
        return loadArea(trx, ws, target.areaId);
      });
      if (!row) return notFound(reply);
      return { area: areaView(row) };
    } catch (error) {
      if (uniqueViolation(error) === 'area_name_idx') {
        return reply.code(409).send({ error: 'name_taken' });
      }
      throw error;
    }
  });

  for (const action of ['archive', 'restore'] as const) {
    app.post(`/api/v1/areas/:id/${action}`, async (request, reply) => {
      const target = await managedArea(request, reply);
      if (!target) return reply;
      const ws = request.workspaceId;
      const archiving = action === 'archive';
      const result = await db.transaction().execute(async (trx) => {
        const area = await trx
          .selectFrom('area')
          .select(['name', 'archived_at'])
          .where('id', '=', target.areaId)
          .forNoKeyUpdate()
          .executeTakeFirst();
        if (!area) return { missing: true as const };
        if ((area.archived_at !== null) === archiving) {
          return { conflict: archiving ? 'already_archived' : 'not_archived' };
        }
        const now = new Date();
        await trx
          .updateTable('area')
          .set({ archived_at: archiving ? now : null, updated_at: now })
          .where('id', '=', target.areaId)
          .execute();
        await emit(trx, by(request), {
          type: archiving ? 'area.archived' : 'area.restored',
          subjectId: target.areaId,
          payload: { name: area.name },
        });
        return { area: await loadArea(trx, ws, target.areaId) };
      });
      if ('missing' in result || !('area' in result) || !result.area) {
        if ('conflict' in result) return reply.code(409).send({ error: result.conflict });
        return notFound(reply);
      }
      return { area: areaView(result.area) };
    });
  }

  // Tickets with the area take the replacement, or lose it with `removeFromTickets=true`.
  app.delete('/api/v1/areas/:id', async (request, reply) => {
    const query = areaDeleteQuery.safeParse(request.query);
    if (!query.success) return invalid(reply);
    const target = await managedArea(request, reply);
    if (!target) return reply;
    const replacementId = query.data.replacementId ?? null;
    const remove = query.data.removeFromTickets === 'true';
    if (replacementId === target.areaId) return invalid(reply, 'replacementId');
    const ws = request.workspaceId;
    const actorId = request.user?.id ?? null;
    const result = await db.transaction().execute(async (trx) => {
      const held = await trx
        .selectFrom('area')
        .select(['id', 'track_id', 'name', 'archived_at'])
        .where('workspace_id', '=', ws)
        .where(
          'id',
          'in',
          replacementId === null ? [target.areaId] : [target.areaId, replacementId],
        )
        .orderBy('id')
        .forUpdate()
        .execute();
      const area = held.find((a) => a.id === target.areaId);
      if (!area) return { missing: true as const };
      if (replacementId !== null) {
        const replacement = held.find((a) => a.id === replacementId);
        if (!replacement || replacement.track_id !== area.track_id || replacement.archived_at) {
          return { badReplacement: true as const };
        }
      }
      const tickets = (
        await trx
          .selectFrom('ticket_area')
          .select('ticket_id')
          .where('area_id', '=', area.id)
          .execute()
      ).map((t) => t.ticket_id);
      if (tickets.length > 0 && replacementId === null && !remove) {
        return { inUse: tickets.length };
      }
      const ticketCount = await rewriteTickets(trx, ws, actorId, tickets, async (ids) => {
        if (replacementId !== null) {
          await sql`
            INSERT INTO ticket_area (workspace_id, ticket_id, area_id)
            SELECT workspace_id, ticket_id, ${replacementId} FROM ticket_area
             WHERE area_id = ${area.id} AND ticket_id = ANY(${ids}::int[])
            ON CONFLICT DO NOTHING`.execute(trx);
        }
        await trx
          .deleteFrom('ticket_area')
          .where('area_id', '=', area.id)
          .where('ticket_id', 'in', ids)
          .execute();
      });
      await trx.deleteFrom('area').where('id', '=', area.id).execute();
      await emit(trx, by(request), {
        type: 'area.deleted',
        subjectId: area.id,
        payload: { name: area.name, replacementId, ticketCount },
      });
      return { done: true as const };
    });
    if ('missing' in result) return notFound(reply);
    if ('badReplacement' in result) return invalid(reply, 'replacementId');
    if ('inUse' in result) {
      return reply.code(409).send({ error: 'in_use', ticketCount: result.inUse });
    }
    return reply.code(204).send();
  });
}
