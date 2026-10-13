import type { Database } from '@taskmoor/db';
import type { FastifyInstance } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { requireSiteAdmin } from '../auth';
import { effectiveMemberIds, nestingWouldCycle, toUserView, USER_COLUMNS } from '../directory';

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
export function registerGroupRoutes(app: FastifyInstance, db: Kysely<Database>): void {
  const findGroup = (workspaceId: number, id: number) =>
    db
      .selectFrom('user_group')
      .select(['id', 'name', 'description', 'created_at'])
      .where('id', '=', id)
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirst();

  app.get('/api/v1/groups', async (request, reply) => {
    if (!requireSiteAdmin(request, reply)) return reply;
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
    if (!requireSiteAdmin(request, reply)) return reply;
    const parsed = groupBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      const row = await db
        .insertInto('user_group')
        .values({
          workspace_id: request.workspaceId,
          name: parsed.data.name,
          description: parsed.data.description ?? '',
        })
        .returning(['id', 'name', 'description'])
        .executeTakeFirstOrThrow();
      return reply.code(201).send({ group: row });
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ error: 'name_taken' });
      throw error;
    }
  });

  app.get('/api/v1/groups/:id', async (request, reply) => {
    if (!requireSiteAdmin(request, reply)) return reply;
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
    return {
      group: { id: group.id, name: group.name, description: group.description },
      members: members.map(toUserView),
      children,
      parents,
    };
  });

  app.get('/api/v1/groups/:id/effective-members', async (request, reply) => {
    if (!requireSiteAdmin(request, reply)) return reply;
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    if (!(await findGroup(request.workspaceId, params.data.id))) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return { userIds: await effectiveMemberIds(db, request.workspaceId, params.data.id) };
  });

  app.patch('/api/v1/groups/:id', async (request, reply) => {
    if (!requireSiteAdmin(request, reply)) return reply;
    const params = idParams.safeParse(request.params);
    const parsed = patchBody.safeParse(request.body);
    if (!params.success || !parsed.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    try {
      const row = await db
        .updateTable('user_group')
        .set({
          ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
          ...(parsed.data.description !== undefined
            ? { description: parsed.data.description }
            : {}),
        })
        .where('id', '=', params.data.id)
        .where('workspace_id', '=', request.workspaceId)
        .returning(['id', 'name', 'description'])
        .executeTakeFirst();
      if (!row) return reply.code(404).send({ error: 'not_found' });
      return { group: row };
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ error: 'name_taken' });
      throw error;
    }
  });

  app.delete('/api/v1/groups/:id', async (request, reply) => {
    if (!requireSiteAdmin(request, reply)) return reply;
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const result = await db
      .deleteFrom('user_group')
      .where('id', '=', params.data.id)
      .where('workspace_id', '=', request.workspaceId)
      .executeTakeFirst();
    if (Number(result.numDeletedRows) === 0) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });

  app.put('/api/v1/groups/:id/members/:userId', async (request, reply) => {
    if (!requireSiteAdmin(request, reply)) return reply;
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
    await db
      .insertInto('group_member')
      .values({ workspace_id: ws, group_id: group.id, user_id: user.id })
      .onConflict((oc) => oc.columns(['group_id', 'user_id']).doNothing())
      .execute();
    return reply.code(204).send();
  });

  app.delete('/api/v1/groups/:id/members/:userId', async (request, reply) => {
    if (!requireSiteAdmin(request, reply)) return reply;
    const params = memberParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const result = await db
      .deleteFrom('group_member')
      .where('group_id', '=', params.data.id)
      .where('user_id', '=', params.data.userId)
      .where('workspace_id', '=', request.workspaceId)
      .executeTakeFirst();
    if (Number(result.numDeletedRows) === 0) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });

  app.put('/api/v1/groups/:id/children/:childId', async (request, reply) => {
    if (!requireSiteAdmin(request, reply)) return reply;
    const params = childParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const ws = request.workspaceId;
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
      await trx
        .insertInto('group_nesting')
        .values({ workspace_id: ws, parent_id: params.data.id, child_id: params.data.childId })
        .onConflict((oc) => oc.columns(['parent_id', 'child_id']).doNothing())
        .execute();
      return 'ok' as const;
    });
    if (outcome === 'not_found') return reply.code(404).send({ error: 'not_found' });
    if (outcome === 'cycle') return reply.code(409).send({ error: 'nesting_cycle' });
    return reply.code(204).send();
  });

  app.delete('/api/v1/groups/:id/children/:childId', async (request, reply) => {
    if (!requireSiteAdmin(request, reply)) return reply;
    const params = childParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const result = await db
      .deleteFrom('group_nesting')
      .where('parent_id', '=', params.data.id)
      .where('child_id', '=', params.data.childId)
      .where('workspace_id', '=', request.workspaceId)
      .executeTakeFirst();
    if (Number(result.numDeletedRows) === 0) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });
}
