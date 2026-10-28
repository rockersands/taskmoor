import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { requireSiteAdmin } from '../auth';
import { effectiveMemberIds, nestingWouldCycle, toUserView, USER_COLUMNS } from '../directory';
import { diff, emit } from '../events/bus';
import {
  type DirectoryGateway,
  directoryFailure,
  directoryManaged,
  readOnly,
} from '../ldap/gateway';

const listQuery = z.object({ query: z.string().trim().max(200).optional() });
const groupBody = z
  .object({
    name: z.string().trim().min(1).max(255),
    description: z.string().trim().max(2000).optional(),
  })
  .strict();
const patchBody = groupBody.partial().strict();
const idParams = z.object({ id: z.coerce.number().int().positive() });
const memberParams = z.object({
  id: z.coerce.number().int().positive(),
  userId: z.coerce.number().int().positive(),
});
const childParams = z.object({
  id: z.coerce.number().int().positive(),
  childId: z.coerce.number().int().positive(),
});

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === '23505';
}

/**
 * Groups for site administrators (IAM-008): create, rename, delete, members, and groups inside
 * groups. A member of a nested group counts as a member of every group above it; nesting that
 * would close a loop is refused. M1-002 grants permissions to groups.
 */
export function registerGroupRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: { directories: DirectoryGateway },
): void {
  const { directories } = options;
  /**
   * M1-082: a directory owns the members and nested groups of its groups. Read-only ones refuse
   * changes here (the next sync would undo them); read-write ones take them first, for members
   * and groups of the same directory. Renaming or deleting a directory's group is done there.
   */
  async function directoryChange(
    reply: FastifyReply,
    workspaceId: number,
    parentId: number,
    member: { userId: number } | { groupId: number },
    operation: 'add' | 'delete',
  ): Promise<'go' | FastifyReply> {
    const group = await directories.group(workspaceId, parentId);
    if (!group) return 'go';
    if (readOnly(group.directory.mode)) return directoryManaged(reply, group.directory);
    const target =
      'userId' in member
        ? await directories.account(workspaceId, member.userId)
        : await directories.group(workspaceId, member.groupId);
    if (!target || target.directory.id !== group.directory.id) {
      return reply.code(409).send({ error: 'not_in_directory' });
    }
    const failure = await directories.writeMembership(group, target.dn, operation);
    return failure ? directoryFailure(reply, failure) : 'go';
  }

  const findGroup = (workspaceId: number, id: number) =>
    db
      .selectFrom('user_group')
      .select(['id', 'name', 'description', 'created_at'])
      .where('id', '=', id)
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirst();

  app.get('/api/v1/groups', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    let query = db
      .selectFrom('user_group as g')
      .select((eb) => [
        'g.id',
        'g.name',
        'g.description',
        eb
          .selectFrom('group_member as m')
          .select((m) => m.fn.countAll<string>().as('n'))
          .whereRef('m.group_id', '=', 'g.id')
          .as('members'),
        eb
          .selectFrom('group_nesting as n')
          .select((n) => n.fn.countAll<string>().as('n'))
          .whereRef('n.parent_id', '=', 'g.id')
          .as('children'),
      ])
      .where('g.workspace_id', '=', request.workspaceId);
    if (parsed.data.query) {
      const like = `%${parsed.data.query.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      query = query.where(sql`lower(g.name)`, 'like', like);
    }
    const rows = await query.orderBy(sql`lower(g.name)`).orderBy('g.id').execute();
    return {
      groups: rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        memberCount: Number(r.members ?? 0),
        childCount: Number(r.children ?? 0),
      })),
    };
  });

  app.post('/api/v1/groups', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const parsed = groupBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      const row = await db.transaction().execute(async (trx) => {
        const created = await trx
          .insertInto('user_group')
          .values({
            workspace_id: request.workspaceId,
            name: parsed.data.name,
            description: parsed.data.description ?? '',
          })
          .returning(['id', 'name', 'description'])
          .executeTakeFirstOrThrow();
        await emit(
          trx,
          { workspaceId: request.workspaceId, actorId: admin.id },
          { type: 'group.created', subjectId: created.id, payload: { name: created.name } },
        );
        return created;
      });
      return reply.code(201).send({ group: row });
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ error: 'name_taken' });
      throw error;
    }
  });

  app.get('/api/v1/groups/:id', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const ws = request.workspaceId;
    const group = await findGroup(ws, params.data.id);
    if (!group) return reply.code(404).send({ error: 'not_found' });
    const [members, children, parents] = await Promise.all([
      db
        .selectFrom('group_member as m')
        .innerJoin('app_user as u', 'u.id', 'm.user_id')
        .select(USER_COLUMNS.map((c) => `u.${c}` as const))
        .where('m.group_id', '=', group.id)
        .where('m.workspace_id', '=', ws)
        .orderBy(sql`lower(u.name)`)
        .execute(),
      db
        .selectFrom('group_nesting as n')
        .innerJoin('user_group as g', 'g.id', 'n.child_id')
        .select(['g.id', 'g.name'])
        .where('n.parent_id', '=', group.id)
        .where('n.workspace_id', '=', ws)
        .orderBy(sql`lower(g.name)`)
        .execute(),
      db
        .selectFrom('group_nesting as n')
        .innerJoin('user_group as g', 'g.id', 'n.parent_id')
        .select(['g.id', 'g.name'])
        .where('n.child_id', '=', group.id)
        .where('n.workspace_id', '=', ws)
        .orderBy(sql`lower(g.name)`)
        .execute(),
    ]);
    const managed = await directories.group(ws, group.id);
    return {
      group: { id: group.id, name: group.name, description: group.description },
      members: members.map(toUserView),
      children,
      parents,
      directory: managed
        ? {
            id: managed.directory.id,
            name: managed.directory.name,
            dn: managed.dn,
            mode: managed.directory.mode,
          }
        : null,
    };
  });

  app.get('/api/v1/groups/:id/effective-members', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    if (!(await findGroup(request.workspaceId, params.data.id))) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return { userIds: await effectiveMemberIds(db, request.workspaceId, params.data.id) };
  });

  app.patch('/api/v1/groups/:id', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const params = idParams.safeParse(request.params);
    const parsed = patchBody.safeParse(request.body);
    if (!params.success || !parsed.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    if (parsed.data.name !== undefined) {
      const managed = await directories.group(request.workspaceId, params.data.id);
      if (managed) return directoryManaged(reply, managed.directory);
    }
    try {
      const row = await db.transaction().execute(async (trx) => {
        const before = await trx
          .selectFrom('user_group')
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
        const updated = await trx
          .updateTable('user_group')
          .set(next)
          .where('id', '=', params.data.id)
          .returning(['id', 'name', 'description'])
          .executeTakeFirstOrThrow();
        const changes = diff(before, next);
        if (Object.keys(changes).length > 0) {
          await emit(
            trx,
            { workspaceId: request.workspaceId, actorId: admin.id },
            { type: 'group.updated', subjectId: updated.id, payload: { changes } },
          );
        }
        return updated;
      });
      if (!row) return reply.code(404).send({ error: 'not_found' });
      return { group: row };
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ error: 'name_taken' });
      throw error;
    }
  });

  app.delete('/api/v1/groups/:id', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const managed = await directories.group(request.workspaceId, params.data.id);
    if (managed) return directoryManaged(reply, managed.directory);
    const deleted = await db.transaction().execute(async (trx) => {
      const row = await trx
        .deleteFrom('user_group')
        .where('id', '=', params.data.id)
        .where('workspace_id', '=', request.workspaceId)
        .returning(['id', 'name'])
        .executeTakeFirst();
      if (row) {
        await emit(
          trx,
          { workspaceId: request.workspaceId, actorId: admin.id },
          { type: 'group.deleted', subjectId: row.id, payload: { name: row.name } },
        );
      }
      return row;
    });
    if (!deleted) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });

  app.put('/api/v1/groups/:id/members/:userId', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const params = memberParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const ws = request.workspaceId;
    const [group, user] = await Promise.all([
      findGroup(ws, params.data.id),
      db
        .selectFrom('app_user')
        .select('id')
        .where('id', '=', params.data.userId)
        .where('workspace_id', '=', ws)
        .executeTakeFirst(),
    ]);
    if (!group || !user) return reply.code(404).send({ error: 'not_found' });
    const verdict = await directoryChange(reply, ws, group.id, { userId: user.id }, 'add');
    if (verdict !== 'go') return verdict;
    await db.transaction().execute(async (trx) => {
      const added = await trx
        .insertInto('group_member')
        .values({ workspace_id: ws, group_id: group.id, user_id: user.id })
        .onConflict((oc) => oc.columns(['group_id', 'user_id']).doNothing())
        .executeTakeFirst();
      // Adding someone who is already a member changes nothing and tells nobody.
      if (Number(added.numInsertedOrUpdatedRows ?? 0) > 0) {
        await emit(
          trx,
          { workspaceId: ws, actorId: admin.id },
          { type: 'group.member_added', subjectId: group.id, payload: { userId: user.id } },
        );
      }
    });
    return reply.code(204).send();
  });

  app.delete('/api/v1/groups/:id/members/:userId', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const params = memberParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const verdict = await directoryChange(
      reply,
      request.workspaceId,
      params.data.id,
      { userId: params.data.userId },
      'delete',
    );
    if (verdict !== 'go') return verdict;
    const removed = await db.transaction().execute(async (trx) => {
      const result = await trx
        .deleteFrom('group_member')
        .where('group_id', '=', params.data.id)
        .where('user_id', '=', params.data.userId)
        .where('workspace_id', '=', request.workspaceId)
        .executeTakeFirst();
      const count = Number(result.numDeletedRows);
      if (count > 0) {
        await emit(
          trx,
          { workspaceId: request.workspaceId, actorId: admin.id },
          {
            type: 'group.member_removed',
            subjectId: params.data.id,
            payload: { userId: params.data.userId },
          },
        );
      }
      return count;
    });
    if (removed === 0) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });

  app.put('/api/v1/groups/:id/children/:childId', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const params = childParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const ws = request.workspaceId;
    if (params.data.id !== params.data.childId && (await directories.group(ws, params.data.id))) {
      // A directory's group is changed there first: a loop must be refused before that.
      if (await nestingWouldCycle(db, ws, params.data.id, params.data.childId)) {
        return reply.code(409).send({ error: 'nesting_cycle' });
      }
      const verdict = await directoryChange(
        reply,
        ws,
        params.data.id,
        { groupId: params.data.childId },
        'add',
      );
      if (verdict !== 'go') return verdict;
    }
    const outcome = await db.transaction().execute(async (trx) => {
      // One nesting change at a time per workspace, so two requests cannot build a loop together.
      await sql`SELECT pg_advisory_xact_lock(${ws}, 1)`.execute(trx);
      const groups = await trx
        .selectFrom('user_group')
        .select('id')
        .where('workspace_id', '=', ws)
        .where('id', 'in', [params.data.id, params.data.childId])
        .execute();
      const wanted = new Set([params.data.id, params.data.childId]);
      if (groups.length !== wanted.size) return 'not_found' as const;
      if (await nestingWouldCycle(trx, ws, params.data.id, params.data.childId)) {
        return 'cycle' as const;
      }
      const added = await trx
        .insertInto('group_nesting')
        .values({ workspace_id: ws, parent_id: params.data.id, child_id: params.data.childId })
        .onConflict((oc) => oc.columns(['parent_id', 'child_id']).doNothing())
        .executeTakeFirst();
      if (Number(added.numInsertedOrUpdatedRows ?? 0) > 0) {
        await emit(
          trx,
          { workspaceId: ws, actorId: admin.id },
          {
            type: 'group.nested',
            subjectId: params.data.id,
            payload: { childId: params.data.childId },
          },
        );
      }
      return 'ok' as const;
    });
    if (outcome === 'not_found') return reply.code(404).send({ error: 'not_found' });
    if (outcome === 'cycle') return reply.code(409).send({ error: 'nesting_cycle' });
    return reply.code(204).send();
  });

  app.delete('/api/v1/groups/:id/children/:childId', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const params = childParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const verdict = await directoryChange(
      reply,
      request.workspaceId,
      params.data.id,
      { groupId: params.data.childId },
      'delete',
    );
    if (verdict !== 'go') return verdict;
    const removed = await db.transaction().execute(async (trx) => {
      const result = await trx
        .deleteFrom('group_nesting')
        .where('parent_id', '=', params.data.id)
        .where('child_id', '=', params.data.childId)
        .where('workspace_id', '=', request.workspaceId)
        .executeTakeFirst();
      const count = Number(result.numDeletedRows);
      if (count > 0) {
        await emit(
          trx,
          { workspaceId: request.workspaceId, actorId: admin.id },
          {
            type: 'group.unnested',
            subjectId: params.data.id,
            payload: { childId: params.data.childId },
          },
        );
      }
      return count;
    });
    if (removed === 0) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });
}
