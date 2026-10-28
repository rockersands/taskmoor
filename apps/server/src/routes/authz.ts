import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { requireGlobal, requireSiteAdmin, requireUser } from '../auth';
import type { Authorizer } from '../authz/authorizer';
import {
  GLOBAL_PERMISSIONS,
  isGlobalPermission,
  isTrackPermission,
  TICKET_LEVEL_GRANTEES,
  TRACK_LEVEL_GRANTEES,
  TRACK_PERMISSION_GROUPS,
} from '../authz/permissions';
import { diff, emit } from '../events/bus';
import { trackInTrash } from '../trash/policy';

const id = z.coerce.number().int().positive();
const nameBody = z
  .object({
    name: z.string().trim().min(1).max(255),
    description: z.string().trim().max(2000).optional(),
  })
  .strict();
const grantBody = z
  .object({
    permission: z.string(),
    grantee: z.enum([...TRACK_LEVEL_GRANTEES, ...TICKET_LEVEL_GRANTEES]),
    roleId: id.optional(),
    groupId: id.optional(),
    userId: id.optional(),
    fieldKey: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
const globalBody = z
  .object({
    permission: z.string(),
    grantee: z.enum(['group', 'user', 'any_user']),
    groupId: id.optional(),
    userId: id.optional(),
  })
  .strict();

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === '23505';
}

const invalid = (reply: FastifyReply, detail?: string) =>
  reply.code(400).send({ error: 'invalid_request', ...(detail ? { detail } : {}) });

/**
 * Roles, access policies, global grants, track role actors, and the questions people ask the
 * authorization service (M1-002, IAM-009 to IAM-012). Configuration belongs to site and
 * configuration administrators; global grants to site administrators; a track's role actors
 * to whoever may administer that track. A policy owned by a local-mode track (M1-006, spec 01a
 * section 1.1) is also read and granted by that track's administrators.
 */
export function registerAuthzRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  authorizer: Authorizer,
): void {
  const configAdmin = (request: FastifyRequest, reply: FastifyReply) =>
    requireGlobal(request, reply, 'site_admin', 'configuration_admin');
  /** Who the event names: the signed-in person of the request. */
  const by = (request: FastifyRequest) => ({
    workspaceId: request.workspaceId,
    actorId: request.user?.id ?? null,
  });

  /** Configuration administrators, or for a local-mode track's own policy its administrators. */
  async function policyEditor(request: FastifyRequest, reply: FastifyReply, policyId: number) {
    if (!requireUser(request, reply)) return false;
    const global = await request.authz.global();
    if (global.has('site_admin') || global.has('configuration_admin')) return true;
    const policy = await db
      .selectFrom('access_policy')
      .select('owner_track_id')
      .where('id', '=', policyId)
      .where('workspace_id', '=', request.workspaceId)
      .executeTakeFirst();
    const owner = policy?.owner_track_id ?? null;
    if (owner !== null && (await request.authz.can('administer_track', owner))) return true;
    await reply.code(403).send({ error: 'forbidden' });
    return false;
  }

  async function inWorkspace(
    table: 'role' | 'user_group' | 'app_user' | 'access_policy' | 'track',
    workspaceId: number,
    rowId: number | undefined,
  ): Promise<boolean> {
    if (rowId === undefined) return true;
    const row = await db
      .selectFrom(table)
      .select('id')
      .where('id', '=', rowId)
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirst();
    return row !== undefined;
  }

  app.get('/api/v1/permissions/catalogue', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    return {
      global: GLOBAL_PERMISSIONS,
      track: TRACK_PERMISSION_GROUPS,
      grantees: { track: TRACK_LEVEL_GRANTEES, ticket: TICKET_LEVEL_GRANTEES },
    };
  });

  // What the signed-in person (or an anonymous visitor) may do, globally and in a track.
  app.get('/api/v1/me/permissions', async (request, reply) => {
    const parsed = z.object({ trackId: id.optional() }).safeParse(request.query);
    if (!parsed.success) return invalid(reply);
    const global = [...(await request.authz.global())].sort();
    if (parsed.data.trackId === undefined) return { global };
    const track = [...(await request.authz.track(parsed.data.trackId))].sort();
    return { global, track };
  });

  // IAM-012: why a person can or cannot do something in a track.
  app.get('/api/v1/permissions/explain', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const parsed = z
      .object({ userId: id.optional(), trackId: id, permission: z.string() })
      .safeParse(request.query);
    if (!parsed.success || !isTrackPermission(parsed.data.permission)) return invalid(reply);
    const ws = request.workspaceId;
    if (!(await inWorkspace('track', ws, parsed.data.trackId))) {
      return reply.code(404).send({ error: 'not_found' });
    }
    if (!(await inWorkspace('app_user', ws, parsed.data.userId))) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return authorizer.explain(
      ws,
      { userId: parsed.data.userId ?? null },
      parsed.data.trackId,
      parsed.data.permission,
    );
  });

  // Roles.
  app.get('/api/v1/roles', async (request, reply) => {
    if (!(await configAdmin(request, reply))) return reply;
    const roles = await db
      .selectFrom('role')
      .select(['id', 'name', 'description'])
      .where('workspace_id', '=', request.workspaceId)
      .orderBy(sql`lower(name)`)
      .execute();
    return { roles };
  });

  app.post('/api/v1/roles', async (request, reply) => {
    if (!(await configAdmin(request, reply))) return reply;
    const parsed = nameBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    try {
      const role = await db.transaction().execute(async (trx) => {
        const row = await trx
          .insertInto('role')
          .values({
            workspace_id: request.workspaceId,
            name: parsed.data.name,
            description: parsed.data.description ?? '',
          })
          .returning(['id', 'name', 'description'])
          .executeTakeFirstOrThrow();
        await emit(trx, by(request), {
          type: 'role.created',
          subjectId: row.id,
          payload: { name: row.name },
        });
        return row;
      });
      return reply.code(201).send({ role });
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ error: 'name_taken' });
      throw error;
    }
  });

  app.patch('/api/v1/roles/:id', async (request, reply) => {
    if (!(await configAdmin(request, reply))) return reply;
    const params = z.object({ id }).safeParse(request.params);
    const parsed = nameBody.partial().strict().safeParse(request.body);
    if (!params.success || !parsed.success) return invalid(reply);
    try {
      const role = await db.transaction().execute(async (trx) => {
        const before = await trx
          .selectFrom('role')
          .select(['name', 'description'])
          .where('id', '=', params.data.id)
          .where('workspace_id', '=', request.workspaceId)
          .forUpdate()
          .executeTakeFirst();
        if (!before) return undefined;
        const next = {
          ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
          ...(parsed.data.description !== undefined
            ? { description: parsed.data.description }
            : {}),
        };
        const row = await trx
          .updateTable('role')
          .set(next)
          .where('id', '=', params.data.id)
          .returning(['id', 'name', 'description'])
          .executeTakeFirstOrThrow();
        const changes = diff(before, next);
        if (Object.keys(changes).length > 0) {
          await emit(trx, by(request), {
            type: 'role.updated',
            subjectId: row.id,
            payload: { changes },
          });
        }
        return row;
      });
      if (!role) return reply.code(404).send({ error: 'not_found' });
      return { role };
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ error: 'name_taken' });
      throw error;
    }
  });

  app.delete('/api/v1/roles/:id', async (request, reply) => {
    if (!(await configAdmin(request, reply))) return reply;
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    // A role still granted by a policy would silently take its permissions along.
    const used = await db
      .selectFrom('access_grant')
      .select('id')
      .where('role_id', '=', params.data.id)
      .executeTakeFirst();
    if (used) return reply.code(409).send({ error: 'role_in_use' });
    const deleted = await db.transaction().execute(async (trx) => {
      const row = await trx
        .deleteFrom('role')
        .where('id', '=', params.data.id)
        .where('workspace_id', '=', request.workspaceId)
        .returning(['id', 'name'])
        .executeTakeFirst();
      if (row) {
        await emit(trx, by(request), {
          type: 'role.deleted',
          subjectId: row.id,
          payload: { name: row.name },
        });
      }
      return row;
    });
    if (!deleted) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });

  // Access policies and their grants.
  app.get('/api/v1/access-policies', async (request, reply) => {
    if (!(await configAdmin(request, reply))) return reply;
    const rows = await db
      .selectFrom('access_policy as p')
      .select((eb) => [
        'p.id',
        'p.name',
        'p.description',
        'p.is_default',
        'p.owner_track_id',
        eb
          .selectFrom('track as t')
          .select((t) => t.fn.countAll<string>().as('n'))
          .whereRef('t.access_policy_id', '=', 'p.id')
          .as('tracks'),
        eb
          .selectFrom('access_grant as g')
          .select((g) => g.fn.countAll<string>().as('n'))
          .whereRef('g.policy_id', '=', 'p.id')
          .as('grants'),
      ])
      .where('p.workspace_id', '=', request.workspaceId)
      .orderBy(sql`lower(p.name)`)
      .execute();
    return {
      policies: rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        isDefault: r.is_default,
        ownerTrackId: r.owner_track_id,
        trackCount: Number(r.tracks ?? 0),
        grantCount: Number(r.grants ?? 0),
      })),
    };
  });

  app.post('/api/v1/access-policies', async (request, reply) => {
    if (!(await configAdmin(request, reply))) return reply;
    const parsed = nameBody.extend({ copyFrom: id.optional() }).strict().safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const ws = request.workspaceId;
    if (!(await inWorkspace('access_policy', ws, parsed.data.copyFrom))) {
      return reply.code(404).send({ error: 'not_found' });
    }
    try {
      const policy = await db.transaction().execute(async (trx) => {
        const row = await trx
          .insertInto('access_policy')
          .values({
            workspace_id: ws,
            name: parsed.data.name,
            description: parsed.data.description ?? '',
          })
          .returning(['id', 'name', 'description'])
          .executeTakeFirstOrThrow();
        if (parsed.data.copyFrom !== undefined) {
          await sql`
            INSERT INTO access_grant (workspace_id, policy_id, permission, grantee, role_id,
                                      group_id, user_id, field_key)
            SELECT workspace_id, ${row.id}, permission, grantee, role_id, group_id, user_id, field_key
              FROM access_grant WHERE policy_id = ${parsed.data.copyFrom}`.execute(trx);
        }
        await emit(trx, by(request), {
          type: 'access_policy.created',
          subjectId: row.id,
          payload: { name: row.name, copiedFrom: parsed.data.copyFrom ?? null },
        });
        return row;
      });
      return reply.code(201).send({ policy });
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ error: 'name_taken' });
      throw error;
    }
  });

  app.get('/api/v1/access-policies/:id', async (request, reply) => {
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    if (!(await policyEditor(request, reply, params.data.id))) return reply;
    const ws = request.workspaceId;
    const policy = await db
      .selectFrom('access_policy')
      .select([
        'id',
        'name',
        'description',
        'is_default as isDefault',
        'owner_track_id as ownerTrackId',
      ])
      .where('id', '=', params.data.id)
      .where('workspace_id', '=', ws)
      .executeTakeFirst();
    if (!policy) return reply.code(404).send({ error: 'not_found' });
    const [grants, tracks] = await Promise.all([
      db
        .selectFrom('access_grant as g')
        .leftJoin('role as r', 'r.id', 'g.role_id')
        .leftJoin('user_group as ug', 'ug.id', 'g.group_id')
        .leftJoin('app_user as u', 'u.id', 'g.user_id')
        .select([
          'g.id',
          'g.permission',
          'g.grantee',
          'g.role_id as roleId',
          'r.name as roleName',
          'g.group_id as groupId',
          'ug.name as groupName',
          'g.user_id as userId',
          'u.name as userName',
          'g.field_key as fieldKey',
        ])
        .where('g.policy_id', '=', policy.id)
        .orderBy('g.permission')
        .orderBy('g.id')
        .execute(),
      db
        .selectFrom('track')
        .select(['id', 'key', 'name'])
        .where('access_policy_id', '=', policy.id)
        .orderBy('key')
        .execute(),
    ]);
    return { policy, grants, tracks };
  });

  app.patch('/api/v1/access-policies/:id', async (request, reply) => {
    if (!(await configAdmin(request, reply))) return reply;
    const params = z.object({ id }).safeParse(request.params);
    const parsed = nameBody.partial().strict().safeParse(request.body);
    if (!params.success || !parsed.success) return invalid(reply);
    try {
      const policy = await db.transaction().execute(async (trx) => {
        const before = await trx
          .selectFrom('access_policy')
          .select(['name', 'description'])
          .where('id', '=', params.data.id)
          .where('workspace_id', '=', request.workspaceId)
          .forUpdate()
          .executeTakeFirst();
        if (!before) return undefined;
        const next = {
          ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
          ...(parsed.data.description !== undefined
            ? { description: parsed.data.description }
            : {}),
        };
        const row = await trx
          .updateTable('access_policy')
          .set(next)
          .where('id', '=', params.data.id)
          .returning(['id', 'name', 'description'])
          .executeTakeFirstOrThrow();
        const changes = diff(before, next);
        if (Object.keys(changes).length > 0) {
          await emit(trx, by(request), {
            type: 'access_policy.updated',
            subjectId: row.id,
            payload: { changes },
          });
        }
        return row;
      });
      if (!policy) return reply.code(404).send({ error: 'not_found' });
      return { policy };
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ error: 'name_taken' });
      throw error;
    }
  });

  app.delete('/api/v1/access-policies/:id', async (request, reply) => {
    if (!(await configAdmin(request, reply))) return reply;
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    const used = await db
      .selectFrom('track')
      .select('id')
      .where('access_policy_id', '=', params.data.id)
      .executeTakeFirst();
    if (used) return reply.code(409).send({ error: 'policy_in_use' });
    const deleted = await db.transaction().execute(async (trx) => {
      const row = await trx
        .deleteFrom('access_policy')
        .where('id', '=', params.data.id)
        .where('workspace_id', '=', request.workspaceId)
        .returning(['id', 'name'])
        .executeTakeFirst();
      if (row) {
        await emit(trx, by(request), {
          type: 'access_policy.deleted',
          subjectId: row.id,
          payload: { name: row.name },
        });
      }
      return row;
    });
    if (!deleted) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });

  app.post('/api/v1/access-policies/:id/grants', async (request, reply) => {
    const params = z.object({ id }).safeParse(request.params);
    const parsed = grantBody.safeParse(request.body);
    if (!params.success || !parsed.success) return invalid(reply);
    if (!(await policyEditor(request, reply, params.data.id))) return reply;
    const g = parsed.data;
    if (!isTrackPermission(g.permission)) return invalid(reply, 'unknown permission');
    // Exactly the reference the grantee kind needs, and no other.
    const needs = {
      roleId: g.grantee === 'role',
      groupId: g.grantee === 'group',
      userId: g.grantee === 'user',
      fieldKey: g.grantee === 'user_field' || g.grantee === 'group_field',
    };
    for (const [field, needed] of Object.entries(needs)) {
      if (needed !== (g[field as keyof typeof needs] !== undefined)) {
        return invalid(reply, `${field} does not fit grantee ${g.grantee}`);
      }
    }
    const ws = request.workspaceId;
    const exist = await Promise.all([
      inWorkspace('access_policy', ws, params.data.id),
      inWorkspace('role', ws, g.roleId),
      inWorkspace('user_group', ws, g.groupId),
      inWorkspace('app_user', ws, g.userId),
    ]);
    if (exist.includes(false)) return reply.code(404).send({ error: 'not_found' });
    try {
      const grant = await db.transaction().execute(async (trx) => {
        const row = await trx
          .insertInto('access_grant')
          .values({
            workspace_id: ws,
            policy_id: params.data.id,
            permission: g.permission,
            grantee: g.grantee,
            role_id: g.roleId ?? null,
            group_id: g.groupId ?? null,
            user_id: g.userId ?? null,
            field_key: g.fieldKey ?? null,
          })
          .returning(['id', 'permission', 'grantee'])
          .executeTakeFirstOrThrow();
        await emit(trx, by(request), {
          type: 'access_grant.added',
          subjectId: params.data.id,
          payload: {
            grantId: row.id,
            permission: g.permission,
            grantee: g.grantee,
            roleId: g.roleId ?? null,
            groupId: g.groupId ?? null,
            userId: g.userId ?? null,
            fieldKey: g.fieldKey ?? null,
          },
        });
        return row;
      });
      return reply.code(201).send({ grant });
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ error: 'grant_exists' });
      throw error;
    }
  });

  app.delete('/api/v1/access-policies/:id/grants/:grantId', async (request, reply) => {
    const params = z.object({ id, grantId: id }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    if (!(await policyEditor(request, reply, params.data.id))) return reply;
    const deleted = await db.transaction().execute(async (trx) => {
      const row = await trx
        .deleteFrom('access_grant')
        .where('id', '=', params.data.grantId)
        .where('policy_id', '=', params.data.id)
        .where('workspace_id', '=', request.workspaceId)
        .returning('id')
        .executeTakeFirst();
      if (row) {
        await emit(trx, by(request), {
          type: 'access_grant.removed',
          subjectId: params.data.id,
          payload: { grantId: row.id },
        });
      }
      return row;
    });
    if (!deleted) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });

  // Global grants: site administrators only.
  app.get('/api/v1/global-grants', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const grants = await db
      .selectFrom('global_grant as g')
      .leftJoin('user_group as ug', 'ug.id', 'g.group_id')
      .leftJoin('app_user as u', 'u.id', 'g.user_id')
      .select([
        'g.id',
        'g.permission',
        'g.grantee',
        'g.group_id as groupId',
        'ug.name as groupName',
        'g.user_id as userId',
        'u.name as userName',
      ])
      .where('g.workspace_id', '=', request.workspaceId)
      .orderBy('g.permission')
      .orderBy('g.id')
      .execute();
    return { grants };
  });

  app.post('/api/v1/global-grants', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const parsed = globalBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const g = parsed.data;
    if (!isGlobalPermission(g.permission)) return invalid(reply, 'unknown permission');
    if ((g.grantee === 'group') !== (g.groupId !== undefined)) return invalid(reply, 'groupId');
    if ((g.grantee === 'user') !== (g.userId !== undefined)) return invalid(reply, 'userId');
    if (g.grantee === 'any_user' && ['site_admin', 'configuration_admin'].includes(g.permission)) {
      return invalid(reply, 'administration cannot go to everyone');
    }
    const ws = request.workspaceId;
    const exist = await Promise.all([
      inWorkspace('user_group', ws, g.groupId),
      inWorkspace('app_user', ws, g.userId),
    ]);
    if (exist.includes(false)) return reply.code(404).send({ error: 'not_found' });
    try {
      const grant = await db.transaction().execute(async (trx) => {
        const row = await trx
          .insertInto('global_grant')
          .values({
            workspace_id: ws,
            permission: g.permission,
            grantee: g.grantee,
            group_id: g.groupId ?? null,
            user_id: g.userId ?? null,
          })
          .returning(['id', 'permission', 'grantee'])
          .executeTakeFirstOrThrow();
        await emit(trx, by(request), {
          type: 'global_grant.added',
          subjectId: ws,
          payload: {
            grantId: row.id,
            permission: g.permission,
            grantee: g.grantee,
            groupId: g.groupId ?? null,
            userId: g.userId ?? null,
          },
        });
        return row;
      });
      return reply.code(201).send({ grant });
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ error: 'grant_exists' });
      throw error;
    }
  });

  app.delete('/api/v1/global-grants/:id', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    const deleted = await db.transaction().execute(async (trx) => {
      const row = await trx
        .deleteFrom('global_grant')
        .where('id', '=', params.data.id)
        .where('workspace_id', '=', request.workspaceId)
        .returning('id')
        .executeTakeFirst();
      if (row) {
        await emit(trx, by(request), {
          type: 'global_grant.removed',
          subjectId: request.workspaceId,
          payload: { grantId: row.id },
        });
      }
      return row;
    });
    if (!deleted) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });

  // Track role actors: whoever may administer the track.
  async function trackAdmin(request: FastifyRequest, reply: FastifyReply, trackId: number) {
    if (!requireUser(request, reply)) return false;
    if (
      !(await inWorkspace('track', request.workspaceId, trackId)) ||
      (await trackInTrash(db, trackId))
    ) {
      await reply.code(404).send({ error: 'not_found' });
      return false;
    }
    if (!(await request.authz.can('administer_track', trackId))) {
      await reply.code(403).send({ error: 'forbidden' });
      return false;
    }
    return true;
  }

  app.get('/api/v1/tracks/:id/role-actors', async (request, reply) => {
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    if (!(await trackAdmin(request, reply, params.data.id))) return reply;
    const rows = await db
      .selectFrom('track_role_actor as a')
      .innerJoin('role as r', 'r.id', 'a.role_id')
      .leftJoin('app_user as u', 'u.id', 'a.user_id')
      .leftJoin('user_group as g', 'g.id', 'a.group_id')
      .select([
        'r.id as roleId',
        'r.name as roleName',
        'u.id as userId',
        'u.name as userName',
        'g.id as groupId',
        'g.name as groupName',
      ])
      .where('a.track_id', '=', params.data.id)
      .orderBy(sql`lower(r.name)`)
      .execute();
    const roles = new Map<
      number,
      {
        roleId: number;
        roleName: string;
        users: { id: number; name: string }[];
        groups: { id: number; name: string }[];
      }
    >();
    for (const r of rows) {
      const entry = roles.get(r.roleId) ?? {
        roleId: r.roleId,
        roleName: r.roleName,
        users: [],
        groups: [],
      };
      if (r.userId !== null) entry.users.push({ id: r.userId, name: r.userName ?? '' });
      if (r.groupId !== null) entry.groups.push({ id: r.groupId, name: r.groupName ?? '' });
      roles.set(r.roleId, entry);
    }
    return { roles: [...roles.values()] };
  });

  for (const kind of ['users', 'groups'] as const) {
    const paramsSchema = z.object({ id, roleId: id, actorId: id });
    const path = `/api/v1/tracks/:id/roles/:roleId/${kind}/:actorId`;
    app.put(path, async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) return invalid(reply);
      const { id: trackId, roleId, actorId } = params.data;
      if (!(await trackAdmin(request, reply, trackId))) return reply;
      const ws = request.workspaceId;
      const exist = await Promise.all([
        inWorkspace('role', ws, roleId),
        inWorkspace(kind === 'users' ? 'app_user' : 'user_group', ws, actorId),
      ]);
      if (exist.includes(false)) return reply.code(404).send({ error: 'not_found' });
      await db.transaction().execute(async (trx) => {
        const added = await trx
          .insertInto('track_role_actor')
          .values({
            workspace_id: ws,
            track_id: trackId,
            role_id: roleId,
            user_id: kind === 'users' ? actorId : null,
            group_id: kind === 'groups' ? actorId : null,
          })
          .onConflict((oc) => oc.doNothing())
          .executeTakeFirst();
        if (Number(added.numInsertedOrUpdatedRows ?? 0) > 0) {
          await emit(trx, by(request), {
            type: 'track_role.actor_added',
            subjectId: trackId,
            payload: {
              roleId,
              userId: kind === 'users' ? actorId : null,
              groupId: kind === 'groups' ? actorId : null,
            },
          });
        }
      });
      return reply.code(204).send();
    });
    app.delete(path, async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) return invalid(reply);
      const { id: trackId, roleId, actorId } = params.data;
      if (!(await trackAdmin(request, reply, trackId))) return reply;
      const removed = await db.transaction().execute(async (trx) => {
        const result = await trx
          .deleteFrom('track_role_actor')
          .where('track_id', '=', trackId)
          .where('role_id', '=', roleId)
          .where(kind === 'users' ? 'user_id' : 'group_id', '=', actorId)
          .executeTakeFirst();
        const count = Number(result.numDeletedRows);
        if (count > 0) {
          await emit(trx, by(request), {
            type: 'track_role.actor_removed',
            subjectId: trackId,
            payload: {
              roleId,
              userId: kind === 'users' ? actorId : null,
              groupId: kind === 'groups' ? actorId : null,
            },
          });
        }
        return count;
      });
      if (removed === 0) return reply.code(404).send({ error: 'not_found' });
      return reply.code(204).send();
    });
  }
}
