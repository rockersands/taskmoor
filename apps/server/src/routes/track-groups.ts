import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { requireGlobal, requireUser } from '../auth';
import { emit } from '../events/bus';
import {
  type AccessChange,
  givableTracks,
  giveOutright,
  giveThroughShare,
  LastTrackAdministrator,
  releaseShares,
} from '../trackgroups/access';

/**
 * Personal track groups (CORE-034, IAM-034; ADR-121). Each person arranges the Tracks page in
 * groups of their own: made, renamed, put in order, minimized and opened, with tracks moved in,
 * out and between them. A track sits in at most one of a person's groups. The arrangement is
 * remembered here, per person.
 *
 * A group is its owner's alone until they share it. Sharing shows it to another person, kept as
 * the owner changes it, and may give them a role on its tracks (`trackgroups/access.ts`): only
 * where the owner may give that role, and taking the share back removes only what shares gave.
 * Setting a group on someone instead gives them a copy of their own, and the role as an ordinary
 * one. A person never sees a track in a group that they may not see in the track list.
 *
 * Every change answers the caller's whole arrangement, so a page stays in step with one call.
 */
const MAX_INT = 2_147_483_647;
const id = z.coerce.number().int().positive().max(MAX_INT);
const name = z.string().trim().min(1).max(100);
const MAX_TRACKS = 500;

const createBody = z.object({ name, trackIds: z.array(id).max(MAX_TRACKS).default([]) }).strict();
const patchBody = z
  .object({ name: name.optional(), minimized: z.boolean().optional() })
  .strict()
  .refine((b) => b.name !== undefined || b.minimized !== undefined);
const orderBody = z.object({ groupIds: z.array(id).max(1000) }).strict();
const placeBody = z
  .object({ position: z.number().int().min(0).max(MAX_TRACKS).optional() })
  .strict();
const shareBody = z.object({ userId: id, roleId: id.nullable() }).strict();
const peopleQuery = z.object({ q: z.string().max(100).default('') }).strict();

type Trx = Transaction<Database>;

interface TrackView {
  id: number;
  key: string;
  name: string;
}

export interface GroupView {
  id: number;
  name: string;
  minimized: boolean;
  /** The caller's own group; otherwise one shared with them. */
  mine: boolean;
  owner: { id: number; name: string };
  /** A group shared with the caller: the role it gave them, if any. */
  role?: { id: number; name: string } | null;
  /** The caller's own group: how many people it is shared with. */
  sharedWith?: number;
  /** A copy someone set on the caller. */
  givenBy?: { id: number; name: string } | null;
  /** The tracks the caller may see, in the group's order. */
  tracks: TrackView[];
}

const invalid = (reply: FastifyReply, detail?: string) =>
  reply.code(400).send({ error: 'invalid_request', ...(detail ? { detail } : {}) });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });

/** What a change was about went while it waited for its lock. */
class Gone extends Error {}

const accessList = (changes: readonly AccessChange[]) =>
  changes.map((c) => ({ trackId: c.trackId, userId: c.userId, roleId: c.roleId }));

export function registerTrackGroupRoutes(app: FastifyInstance, db: Kysely<Database>): void {
  const by = (request: FastifyRequest) => ({
    workspaceId: request.workspaceId,
    actorId: request.user?.id ?? null,
  });

  /** Of these tracks, those the caller sees in the track list: active, and browsed or run. */
  async function visibleOf(request: FastifyRequest, trackIds: readonly number[]) {
    if (trackIds.length === 0) return new Set<number>();
    const [browse, administer] = await Promise.all([
      request.authz.allowedTracks('browse_track'),
      request.authz.allowedTracks('administer_track'),
    ]);
    const allowed =
      browse === 'all' || administer === 'all' ? null : new Set([...browse, ...administer]);
    const rows = await db
      .selectFrom('track')
      .select('id')
      .where('workspace_id', '=', request.workspaceId)
      .where('id', 'in', [...trackIds])
      .where('archived_at', 'is', null)
      .where('deleted_at', 'is', null)
      .execute();
    return new Set(rows.map((r) => r.id).filter((t) => allowed === null || allowed.has(t)));
  }

  /** The caller's arrangement: their groups and those shared with them, in their order. */
  async function layoutOf(request: FastifyRequest): Promise<{ groups: GroupView[] }> {
    const me = request.user?.id as number;
    const ws = request.workspaceId;
    const { rows } = await sql<{
      id: number;
      name: string;
      owner_id: number;
      owner_name: string;
      mine: boolean;
      position: number;
      minimized: boolean;
      role_id: number | null;
      role_name: string | null;
      shared_with: number;
      given_by: number | null;
      given_by_name: string | null;
    }>`
      SELECT g.id, g.name, g.owner_id, o.name AS owner_name, true AS mine, g.position,
             g.minimized, NULL::int AS role_id, NULL::text AS role_name,
             (SELECT count(*)::int FROM track_group_share s WHERE s.group_id = g.id) AS shared_with,
             g.given_by, gb.name AS given_by_name
        FROM track_group g
        JOIN app_user o ON o.id = g.owner_id
        LEFT JOIN app_user gb ON gb.id = g.given_by
       WHERE g.workspace_id = ${ws} AND g.owner_id = ${me}
      UNION ALL
      SELECT g.id, g.name, g.owner_id, o.name, false, s.position, s.minimized, s.role_id, r.name,
             0, NULL, NULL
        FROM track_group_share s
        JOIN track_group g ON g.id = s.group_id
        JOIN app_user o ON o.id = g.owner_id
        LEFT JOIN role r ON r.id = s.role_id
       WHERE s.workspace_id = ${ws} AND s.user_id = ${me}
       ORDER BY position, mine DESC, id`.execute(db);
    const ids = rows.map((r) => r.id);
    const members =
      ids.length === 0
        ? []
        : await db
            .selectFrom('track_group_track as m')
            .innerJoin('track as t', 't.id', 'm.track_id')
            .select(['m.group_id', 't.id', 't.key', 't.name'])
            .where('m.group_id', 'in', ids)
            .orderBy('m.group_id')
            .orderBy('m.position')
            .execute();
    const visible = await visibleOf(request, [...new Set(members.map((m) => m.id))]);
    const tracks = new Map<number, TrackView[]>();
    for (const m of members) {
      if (!visible.has(m.id)) continue;
      const list = tracks.get(m.group_id) ?? [];
      list.push({ id: m.id, key: m.key, name: m.name });
      tracks.set(m.group_id, list);
    }
    return {
      groups: rows.map((r) => ({
        id: r.id,
        name: r.name,
        minimized: r.minimized,
        mine: r.mine,
        owner: { id: r.owner_id, name: r.owner_name },
        ...(r.mine
          ? {
              sharedWith: r.shared_with,
              givenBy: r.given_by === null ? null : { id: r.given_by, name: r.given_by_name ?? '' },
            }
          : { role: r.role_id === null ? null : { id: r.role_id, name: r.role_name ?? '' } }),
        tracks: tracks.get(r.id) ?? [],
      })),
    };
  }

  /** Where the next group goes in a person's arrangement: after everything they have. */
  async function nextPosition(trx: Trx | Kysely<Database>, userId: number): Promise<number> {
    const { rows } = await sql<{ next: number }>`
      SELECT coalesce(max(p), -1)::int + 1 AS next FROM (
        SELECT position AS p FROM track_group WHERE owner_id = ${userId}
        UNION ALL SELECT position FROM track_group_share WHERE user_id = ${userId}) x`.execute(trx);
    return rows[0]?.next ?? 0;
  }

  /**
   * The group as the caller reaches it: their own, or one shared with them (then `share`). A
   * group the caller does not reach answers 404, as if there were none.
   */
  async function reach(request: FastifyRequest, groupId: number) {
    const me = request.user?.id as number;
    const group = await db
      .selectFrom('track_group')
      .select(['id', 'name', 'owner_id', 'minimized'])
      .where('id', '=', groupId)
      .where('workspace_id', '=', request.workspaceId)
      .executeTakeFirst();
    if (!group) return null;
    if (group.owner_id === me) return { group, share: null };
    const share = await db
      .selectFrom('track_group_share')
      .select(['id', 'minimized'])
      .where('group_id', '=', groupId)
      .where('user_id', '=', me)
      .executeTakeFirst();
    return share ? { group, share } : null;
  }

  /** The caller's own group, or the reply already sent: 404 unseen, 403 shared with them. */
  async function owned(request: FastifyRequest, reply: FastifyReply, groupId: number) {
    if (!requireUser(request, reply)) return null;
    const found = await reach(request, groupId);
    if (!found) {
      await notFound(reply);
      return null;
    }
    if (found.share) {
      await reply.code(403).send({ error: 'forbidden' });
      return null;
    }
    return found.group;
  }

  const trackIdsOf = async (trx: Trx | Kysely<Database>, groupId: number) =>
    (
      await trx
        .selectFrom('track_group_track')
        .select('track_id')
        .where('group_id', '=', groupId)
        .orderBy('position')
        .execute()
    ).map((r) => r.track_id);

  /** A group's tracks the caller sees, in the group's order. */
  async function visibleInOrder(
    request: FastifyRequest,
    groupId: number,
    executor: Trx | Kysely<Database> = db,
  ) {
    const all = await trackIdsOf(executor, groupId);
    const visible = await visibleOf(request, all);
    return all.filter((t) => visible.has(t));
  }

  /** Writes a group's tracks in this order. */
  async function writeOrder(trx: Trx, groupId: number, trackIds: readonly number[]) {
    for (const [position, trackId] of trackIds.entries()) {
      await trx
        .updateTable('track_group_track')
        .set({ position })
        .where('group_id', '=', groupId)
        .where('track_id', '=', trackId)
        .execute();
    }
  }

  const sharesWithRoles = (trx: Trx, groupId: number) =>
    trx
      .selectFrom('track_group_share')
      .select(['id', 'user_id', 'role_id'])
      .where('group_id', '=', groupId)
      .where('role_id', 'is not', null)
      .orderBy('id')
      .execute();

  const shareIdsOf = async (trx: Trx, groupId: number) =>
    (
      await trx
        .selectFrom('track_group_share')
        .select('id')
        .where('group_id', '=', groupId)
        .execute()
    ).map((r) => r.id);

  /**
   * Takes a track out of whichever of the owner's groups holds it, and returns that group. The
   * shares of that group still hold their role on it until `releaseFrom`.
   */
  async function detach(trx: Trx, ownerId: number, trackId: number) {
    const row = await trx
      .deleteFrom('track_group_track')
      .where('owner_id', '=', ownerId)
      .where('track_id', '=', trackId)
      .returning('group_id')
      .executeTakeFirst();
    if (!row) return null;
    await writeOrder(trx, row.group_id, await trackIdsOf(trx, row.group_id));
    return row.group_id;
  }

  /** The shares of the group a track left stop giving their role on it: the roles that went. */
  const releaseFrom = async (
    trx: Trx,
    request: FastifyRequest,
    groupId: number | null,
    trackId: number,
  ) =>
    groupId === null
      ? []
      : releaseShares(trx, request.workspaceId, await shareIdsOf(trx, groupId), [trackId]);

  /** A track out of its group, and what the group's shares gave on it with it. */
  async function takeOut(trx: Trx, request: FastifyRequest, ownerId: number, trackId: number) {
    const from = await detach(trx, ownerId, trackId);
    return { from, removed: await releaseFrom(trx, request, from, trackId) };
  }

  /** Gives each share of a group its role on tracks that just came in, where the owner may. */
  async function giveNewcomers(
    trx: Trx,
    request: FastifyRequest,
    groupId: number,
    trackIds: readonly number[],
  ): Promise<AccessChange[]> {
    const given: AccessChange[] = [];
    for (const share of await sharesWithRoles(trx, groupId)) {
      const roleId = share.role_id as number;
      const givable = await givableTracks(trx, request.authz, roleId, trackIds);
      const result = await giveThroughShare(
        trx,
        { id: share.id, workspaceId: request.workspaceId, userId: share.user_id, roleId },
        givable,
      );
      given.push(...result.given);
    }
    return given;
  }

  /** A person a group may go to: an active person of the workspace, not the caller. */
  async function recipient(request: FastifyRequest, reply: FastifyReply, userId: number) {
    if (userId === request.user?.id) {
      await invalid(reply, 'a group is shared with someone else');
      return false;
    }
    const person = await db
      .selectFrom('app_user')
      .select(['id', 'deactivated_at', 'kind'])
      .where('id', '=', userId)
      .where('workspace_id', '=', request.workspaceId)
      .executeTakeFirst();
    if (person?.kind !== 'person') {
      await notFound(reply);
      return false;
    }
    if (person.deactivated_at !== null) {
      await reply.code(400).send({ error: 'person_inactive' });
      return false;
    }
    return true;
  }

  async function roleExists(request: FastifyRequest, roleId: number | null) {
    if (roleId === null) return true;
    const row = await db
      .selectFrom('role')
      .select('id')
      .where('id', '=', roleId)
      .where('workspace_id', '=', request.workspaceId)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Locks what a change touches before it reads anything: the arrangement of each person whose
   * groups it changes (an advisory lock per person, in id order), then the group itself. Changes
   * to one person's groups, or to one group and its shares, run one after another, so a role a
   * share gave never loses its record and a track never lands in two of a person's groups.
   * Throws `Gone` when the group went in the meantime.
   */
  async function lockFor(trx: Trx, ownerIds: readonly number[], groupId?: number) {
    for (const ownerId of [...new Set(ownerIds)].sort((a, b) => a - b)) {
      await sql`SELECT pg_advisory_xact_lock(hashtext('track-groups'), ${ownerId}::int)`.execute(
        trx,
      );
    }
    if (groupId === undefined) return;
    const row = await trx
      .selectFrom('track_group')
      .select('id')
      .where('id', '=', groupId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new Gone();
  }

  /**
   * Runs a change that may take roles back: a track left with nobody to run it answers 409, and
   * a group or share that went while it waited answers 404.
   */
  async function guarded<T>(reply: FastifyReply, change: () => Promise<T>): Promise<T | null> {
    try {
      return await change();
    } catch (error) {
      if (error instanceof Gone) {
        await notFound(reply);
        return null;
      }
      if (!(error instanceof LastTrackAdministrator)) throw error;
      await reply.code(409).send({ error: 'last_track_admin', trackIds: error.trackIds });
      return null;
    }
  }

  app.get('/api/v1/track-groups', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    return layoutOf(request);
  });

  app.post('/api/v1/track-groups', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const parsed = createBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const trackIds = [...new Set(parsed.data.trackIds)];
    const visible = await visibleOf(request, trackIds);
    if (trackIds.some((t) => !visible.has(t))) return invalid(reply, 'trackIds');
    const made = await guarded(reply, () =>
      db.transaction().execute(async (trx) => {
        await lockFor(trx, [user.id]);
        const group = await trx
          .insertInto('track_group')
          .values({
            workspace_id: request.workspaceId,
            owner_id: user.id,
            name: parsed.data.name,
            position: await nextPosition(trx, user.id),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        const removed: AccessChange[] = [];
        for (const [position, trackId] of trackIds.entries()) {
          removed.push(...(await takeOut(trx, request, user.id, trackId)).removed);
          await trx
            .insertInto('track_group_track')
            .values({
              workspace_id: request.workspaceId,
              group_id: group.id,
              owner_id: user.id,
              track_id: trackId,
              position,
            })
            .execute();
        }
        await emit(trx, by(request), {
          type: 'track_group.created',
          subjectId: group.id,
          payload: { name: parsed.data.name, trackIds, removed: accessList(removed) },
        });
        return group.id;
      }),
    );
    if (made === null) return reply;
    return reply.code(201).send({ groupId: made, ...(await layoutOf(request)) });
  });

  // The caller's order of their groups and those shared with them: every one, once.
  app.put('/api/v1/track-groups/order', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const parsed = orderBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const { groupIds } = parsed.data;
    const current = (await layoutOf(request)).groups;
    const known = new Set(current.map((g) => g.id));
    if (
      new Set(groupIds).size !== groupIds.length ||
      groupIds.length !== known.size ||
      groupIds.some((g) => !known.has(g))
    ) {
      return invalid(reply, 'groupIds');
    }
    const mine = new Set(current.filter((g) => g.mine).map((g) => g.id));
    await db.transaction().execute(async (trx) => {
      await lockFor(trx, [user.id]);
      for (const [position, groupId] of groupIds.entries()) {
        if (mine.has(groupId)) {
          await trx
            .updateTable('track_group')
            .set({ position })
            .where('id', '=', groupId)
            .execute();
        } else {
          await trx
            .updateTable('track_group_share')
            .set({ position })
            .where('group_id', '=', groupId)
            .where('user_id', '=', user.id)
            .execute();
        }
      }
      await emit(trx, by(request), {
        type: 'track_group.reordered',
        subjectId: user.id,
        payload: { groupIds },
      });
    });
    return layoutOf(request);
  });

  // People a group can be shared with or set on: active people, found by name or address.
  app.get('/api/v1/track-groups/people', async (request, reply) => {
    const user = await requireGlobal(request, reply, 'browse_users');
    if (!user) return reply;
    const parsed = peopleQuery.safeParse(request.query);
    if (!parsed.success) return invalid(reply);
    const text = parsed.data.q
      .trim()
      .toLowerCase()
      .replace(/[\\%_]/g, (c) => `\\${c}`);
    let query = db
      .selectFrom('app_user')
      .select(['id', 'name'])
      .where('workspace_id', '=', request.workspaceId)
      .where('deactivated_at', 'is', null)
      .where('kind', '=', 'person')
      .where('id', '<>', user.id);
    if (text !== '') {
      query = query.where((eb) =>
        eb.or([
          sql<boolean>`lower(name) LIKE ${`%${text}%`}`,
          sql<boolean>`lower(email) LIKE ${`${text}%`}`,
        ]),
      );
    }
    const people = await query.orderBy(sql`lower(name)`).orderBy('id').limit(8).execute();
    return { people };
  });

  app.patch('/api/v1/track-groups/:id', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const params = z.object({ id }).safeParse(request.params);
    const parsed = patchBody.safeParse(request.body);
    if (!params.success || !parsed.success) return invalid(reply);
    const found = await reach(request, params.data.id);
    if (!found) return notFound(reply);
    const { name: newName, minimized } = parsed.data;
    // A group shared with the caller is theirs to minimize, its name the owner's.
    if (found.share && newName !== undefined) return reply.code(403).send({ error: 'forbidden' });
    const before = found.share
      ? { minimized: found.share.minimized }
      : { name: found.group.name, minimized: found.group.minimized };
    const after = { ...before, ...(newName !== undefined ? { name: newName } : {}) };
    if (minimized !== undefined) after.minimized = minimized;
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [key, value] of Object.entries(after)) {
      const was = (before as Record<string, unknown>)[key];
      if (was !== value) changes[key] = { from: was, to: value };
    }
    if (Object.keys(changes).length > 0) {
      await db.transaction().execute(async (trx) => {
        if (found.share) {
          await trx
            .updateTable('track_group_share')
            .set({ minimized: after.minimized })
            .where('id', '=', found.share.id)
            .execute();
        } else {
          await trx
            .updateTable('track_group')
            .set({ ...after, updated_at: new Date() })
            .where('id', '=', found.group.id)
            .execute();
        }
        await emit(trx, by(request), {
          type: 'track_group.updated',
          subjectId: found.group.id,
          payload: { changes },
        });
      });
    }
    return layoutOf(request);
  });

  app.delete('/api/v1/track-groups/:id', async (request, reply) => {
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    const group = await owned(request, reply, params.data.id);
    if (!group) return reply;
    const done = await guarded(reply, () =>
      db.transaction().execute(async (trx) => {
        await lockFor(trx, [group.owner_id], group.id);
        const trackIds = await trackIdsOf(trx, group.id);
        const removed = await releaseShares(
          trx,
          request.workspaceId,
          await shareIdsOf(trx, group.id),
        );
        await trx.deleteFrom('track_group').where('id', '=', group.id).execute();
        await emit(trx, by(request), {
          type: 'track_group.deleted',
          subjectId: group.id,
          payload: { name: group.name, trackIds, removed: accessList(removed) },
        });
        return true;
      }),
    );
    if (done === null) return reply;
    return layoutOf(request);
  });

  // A track into the group, at a place among its tracks; from another group of the owner's, or
  // from none. Within the same group it only moves. `position` counts the tracks the caller sees,
  // as the page shows them: the track goes just before the one at that place among them, or
  // last, so tracks the caller no longer sees stay where they were.
  app.put('/api/v1/track-groups/:id/tracks/:trackId', async (request, reply) => {
    const params = z.object({ id, trackId: id }).safeParse(request.params);
    const parsed = placeBody.safeParse(request.body ?? {});
    if (!params.success || !parsed.success) return invalid(reply);
    const group = await owned(request, reply, params.data.id);
    if (!group) return reply;
    const { trackId } = params.data;
    if (!(await visibleOf(request, [trackId])).has(trackId)) return notFound(reply);
    const done = await guarded(reply, () =>
      db.transaction().execute(async (trx) => {
        await lockFor(trx, [group.owner_id], group.id);
        const held = await trx
          .selectFrom('track_group_track')
          .select('group_id')
          .where('owner_id', '=', group.owner_id)
          .where('track_id', '=', trackId)
          .executeTakeFirst();
        const order = (await trackIdsOf(trx, group.id)).filter((t) => t !== trackId);
        const seen = await visibleOf(request, order);
        const shown = order.filter((t) => seen.has(t));
        const before = parsed.data.position === undefined ? undefined : shown[parsed.data.position];
        const position = before === undefined ? order.length : order.indexOf(before);
        let from: number | null = held?.group_id ?? null;
        let removed: AccessChange[] = [];
        let given: AccessChange[] = [];
        if (held?.group_id !== group.id) {
          from = await detach(trx, group.owner_id, trackId);
          await trx
            .insertInto('track_group_track')
            .values({
              workspace_id: request.workspaceId,
              group_id: group.id,
              owner_id: group.owner_id,
              track_id: trackId,
              position,
            })
            .execute();
          // The new group's shares give first, so a role both groups' shares give stays put.
          given = await giveNewcomers(trx, request, group.id, [trackId]);
          removed = await releaseFrom(trx, request, from, trackId);
        }
        order.splice(position, 0, trackId);
        await writeOrder(trx, group.id, order);
        await emit(trx, by(request), {
          type: 'track_group.track_moved',
          subjectId: group.id,
          payload: {
            trackId,
            fromGroupId: from,
            toGroupId: group.id,
            position,
            given: accessList(given),
            removed: accessList(removed),
          },
        });
        return true;
      }),
    );
    if (done === null) return reply;
    return layoutOf(request);
  });

  // A track out of the group, back among the tracks in no group.
  app.delete('/api/v1/track-groups/:id/tracks/:trackId', async (request, reply) => {
    const params = z.object({ id, trackId: id }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    const group = await owned(request, reply, params.data.id);
    if (!group) return reply;
    const { trackId } = params.data;
    const done = await guarded(reply, () =>
      db.transaction().execute(async (trx) => {
        await lockFor(trx, [group.owner_id], group.id);
        const held = await trx
          .selectFrom('track_group_track')
          .select('group_id')
          .where('group_id', '=', group.id)
          .where('track_id', '=', trackId)
          .executeTakeFirst();
        if (!held) throw new Gone();
        const { removed } = await takeOut(trx, request, group.owner_id, trackId);
        await emit(trx, by(request), {
          type: 'track_group.track_moved',
          subjectId: group.id,
          payload: {
            trackId,
            fromGroupId: group.id,
            toGroupId: null,
            position: null,
            given: [],
            removed: accessList(removed),
          },
        });
        return true;
      }),
    );
    if (done === null) return reply;
    return layoutOf(request);
  });

  /** Who a group is shared with, and the roles its owner may give on how many of its tracks. */
  app.get('/api/v1/track-groups/:id/shares', async (request, reply) => {
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    const group = await owned(request, reply, params.data.id);
    if (!group) return reply;
    const trackIds = await visibleInOrder(request, group.id);
    const roles = await db
      .selectFrom('role')
      .select(['id', 'name'])
      .where('workspace_id', '=', request.workspaceId)
      .orderBy(sql`lower(name)`)
      .execute();
    const offered: { id: number; name: string; givableOn: number }[] = [];
    for (const role of roles) {
      const givable = await givableTracks(db, request.authz, role.id, trackIds);
      if (givable.length > 0) offered.push({ ...role, givableOn: givable.length });
    }
    const { rows: shares } = await sql<{
      user_id: number;
      user_name: string;
      active: boolean;
      role_id: number | null;
      role_name: string | null;
      holds: number;
    }>`
      SELECT s.user_id, u.name AS user_name, u.deactivated_at IS NULL AS active, s.role_id,
             r.name AS role_name,
             (SELECT count(*)::int FROM track_group_access a WHERE a.share_id = s.id) AS holds
        FROM track_group_share s
        JOIN app_user u ON u.id = s.user_id
        LEFT JOIN role r ON r.id = s.role_id
       WHERE s.group_id = ${group.id}
       ORDER BY lower(u.name), s.id`.execute(db);
    return {
      trackCount: trackIds.length,
      roles: offered,
      shares: shares.map((s) => ({
        userId: s.user_id,
        name: s.user_name,
        active: s.active,
        role: s.role_id === null ? null : { id: s.role_id, name: s.role_name ?? '' },
        holds: s.holds,
      })),
    };
  });

  /**
   * What a role reaches on a group's tracks, read inside the change's transaction once it holds
   * its locks, so a track moved out meanwhile is never given.
   */
  async function reachOf(
    trx: Trx,
    request: FastifyRequest,
    groupId: number,
    roleId: number | null,
  ) {
    const trackIds = await visibleInOrder(request, groupId, trx);
    const givable =
      roleId === null ? [] : await givableTracks(trx, request.authz, roleId, trackIds);
    return { trackIds, givable };
  }

  app.post('/api/v1/track-groups/:id/shares', async (request, reply) => {
    const params = z.object({ id }).safeParse(request.params);
    const parsed = shareBody.safeParse(request.body);
    if (!params.success || !parsed.success) return invalid(reply);
    const group = await owned(request, reply, params.data.id);
    if (!group) return reply;
    const { userId, roleId } = parsed.data;
    if (!(await recipient(request, reply, userId))) return reply;
    if (!(await roleExists(request, roleId))) return notFound(reply);
    const result = await guarded(reply, () =>
      db.transaction().execute(async (trx) => {
        await lockFor(trx, [group.owner_id], group.id);
        const { trackIds, givable } = await reachOf(trx, request, group.id, roleId);
        const share = await trx
          .insertInto('track_group_share')
          .values({
            workspace_id: request.workspaceId,
            group_id: group.id,
            user_id: userId,
            role_id: roleId,
            shared_by: request.user?.id ?? null,
            position: await nextPosition(trx, userId),
          })
          .onConflict((oc) => oc.doNothing())
          .returning('id')
          .executeTakeFirst();
        if (!share) return 'already_shared' as const;
        const outcome =
          roleId === null
            ? { given: [] as AccessChange[], alreadyHeld: 0 }
            : await giveThroughShare(
                trx,
                { id: share.id, workspaceId: request.workspaceId, userId, roleId },
                givable,
              );
        await emit(trx, by(request), {
          type: 'track_group.shared',
          subjectId: group.id,
          payload: { shareId: share.id, userId, roleId, given: accessList(outcome.given) },
        });
        return { ...outcome, tracks: trackIds.length, givable: givable.length };
      }),
    );
    if (result === null) return reply;
    if (result === 'already_shared') return reply.code(409).send({ error: 'already_shared' });
    return reply.code(201).send({
      tracks: result.tracks,
      given: result.given.length,
      alreadyHeld: result.alreadyHeld,
      notGivable: roleId === null ? 0 : result.tracks - result.givable,
    });
  });

  // Taking a share back: the group leaves the person's page, and what shares gave goes with it.
  app.delete('/api/v1/track-groups/:id/shares/:userId', async (request, reply) => {
    const params = z.object({ id, userId: id }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    const group = await owned(request, reply, params.data.id);
    if (!group) return reply;
    const done = await guarded(reply, () =>
      db.transaction().execute(async (trx) => {
        await lockFor(trx, [group.owner_id], group.id);
        const share = await trx
          .selectFrom('track_group_share')
          .select(['id', 'role_id'])
          .where('group_id', '=', group.id)
          .where('user_id', '=', params.data.userId)
          .executeTakeFirst();
        if (!share) throw new Gone();
        const removed = await releaseShares(trx, request.workspaceId, [share.id]);
        await trx.deleteFrom('track_group_share').where('id', '=', share.id).execute();
        await emit(trx, by(request), {
          type: 'track_group.unshared',
          subjectId: group.id,
          payload: {
            shareId: share.id,
            userId: params.data.userId,
            roleId: share.role_id,
            removed: accessList(removed),
          },
        });
        return true;
      }),
    );
    if (done === null) return reply;
    return reply.code(204).send();
  });

  // Setting a group on someone: a copy of their own, and the role as an ordinary one.
  app.post('/api/v1/track-groups/:id/copies', async (request, reply) => {
    const params = z.object({ id }).safeParse(request.params);
    const parsed = shareBody.safeParse(request.body);
    if (!params.success || !parsed.success) return invalid(reply);
    const group = await owned(request, reply, params.data.id);
    if (!group) return reply;
    const { userId, roleId } = parsed.data;
    if (!(await recipient(request, reply, userId))) return reply;
    if (!(await roleExists(request, roleId))) return notFound(reply);
    const result = await guarded(reply, () =>
      db.transaction().execute(async (trx) => {
        await lockFor(trx, [group.owner_id, userId], group.id);
        const { trackIds, givable } = await reachOf(trx, request, group.id, roleId);
        const copy = await trx
          .insertInto('track_group')
          .values({
            workspace_id: request.workspaceId,
            owner_id: userId,
            name: group.name,
            position: await nextPosition(trx, userId),
            copied_from: group.id,
            given_by: request.user?.id ?? null,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        // Tracks the person already keeps in a group of theirs stay where they put them.
        const theirs = new Set(
          (
            await trx
              .selectFrom('track_group_track')
              .select('track_id')
              .where('owner_id', '=', userId)
              .execute()
          ).map((r) => r.track_id),
        );
        const placed = trackIds.filter((t) => !theirs.has(t));
        for (const [position, trackId] of placed.entries()) {
          await trx
            .insertInto('track_group_track')
            .values({
              workspace_id: request.workspaceId,
              group_id: copy.id,
              owner_id: userId,
              track_id: trackId,
              position,
            })
            .execute();
        }
        const outcome =
          roleId === null
            ? { given: [] as AccessChange[], kept: [] as AccessChange[], alreadyHeld: 0 }
            : await giveOutright(trx, request.workspaceId, userId, roleId, givable);
        await emit(trx, by(request), {
          type: 'track_group.copied',
          subjectId: copy.id,
          payload: {
            fromGroupId: group.id,
            userId,
            roleId,
            trackIds: placed,
            given: accessList(outcome.given),
            // Roles only shares held, now the person's own.
            kept: accessList(outcome.kept),
          },
        });
        return { groupId: copy.id, ...outcome, tracks: trackIds.length, givable: givable.length };
      }),
    );
    if (result === null) return reply;
    return reply.code(201).send({
      groupId: result.groupId,
      tracks: result.tracks,
      given: result.given.length,
      alreadyHeld: result.alreadyHeld,
      notGivable: roleId === null ? 0 : result.tracks - result.givable,
    });
  });
}
