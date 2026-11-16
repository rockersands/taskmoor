import type { Database } from '@taskmoor/db';
import type { FastifyInstance } from 'fastify';
import { type Kysely, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { requireSiteAdmin, requireUser } from '../auth';
import { diff, emit } from '../events/bus';
import { findTeam } from '../teams';
import { decodeSortCursor, encodeSortCursor, sortCursorParam } from './sort-cursor';

type Db = Kysely<Database> | Transaction<Database>;

/**
 * A page of teams by name, ignoring case, then id (T-286): 100 unless `limit` asks for another
 * number up to 500 (a picker asks for 8, T-282). `after` (or `cursor`, as saved searches name it)
 * is the `next` of the page before; every answer carries `next`, null after the last page.
 */
const listQuery = z
  .object({
    query: z.string().trim().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    after: sortCursorParam.optional(),
    cursor: sortCursorParam.meta({ description: 'The same as `after`.' }).optional(),
  })
  .strict();
const leadId = z.number().int().positive().max(2_147_483_647).nullable();
const teamBody = z
  .object({
    name: z.string().trim().min(1).max(255),
    description: z.string().trim().max(2000).optional(),
    leadId: leadId.optional(),
  })
  .strict();
const patchBody = teamBody.partial().strict();
const idParams = z.object({ id: z.coerce.number().int().positive().max(2_147_483_647) });
const memberParams = z.object({
  id: z.coerce.number().int().positive().max(2_147_483_647),
  userId: z.coerce.number().int().positive().max(2_147_483_647),
});

/** Teams are people: active accounts of the workspace, service accounts left out. */
const activePerson = (db: Db, workspaceId: number, id: number) =>
  db
    .selectFrom('app_user')
    .select('id')
    .where('id', '=', id)
    .where('workspace_id', '=', workspaceId)
    .where('kind', '=', 'person')
    .where('deactivated_at', 'is', null)
    .executeTakeFirst();

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === '23505';
}

/** A team as every answer shows it: the lead by name, members counted. */
export interface TeamView {
  id: number;
  name: string;
  description: string;
  lead: { id: number; name: string } | null;
  memberCount: number;
}

function teamQuery(db: Db, workspaceId: number) {
  return db
    .selectFrom('team as t')
    .leftJoin('app_user as l', 'l.id', 't.lead_id')
    .select((eb) => [
      't.id',
      't.name',
      't.description',
      't.lead_id',
      'l.name as lead_name',
      eb
        .selectFrom('team_member as m')
        .select((m) => m.fn.countAll<string>().as('n'))
        .whereRef('m.team_id', '=', 't.id')
        .as('members'),
    ])
    .where('t.workspace_id', '=', workspaceId);
}

type TeamRow = Awaited<ReturnType<ReturnType<typeof teamQuery>['executeTakeFirstOrThrow']>>;

const view = (r: TeamRow): TeamView => ({
  id: r.id,
  name: r.name,
  description: r.description,
  lead: r.lead_id === null ? null : { id: r.lead_id, name: r.lead_name ?? '' },
  memberCount: Number(r.members ?? 0),
});

/**
 * Teams (M1-123; CORE-027; ADR-076): site-wide, with members, a lead and a description.
 * Everyone signed in reads them, for pickers and the Team field (`?query=` part of a name), a
 * page at a time by name (`?limit=`, `?after=` the `next` of the page before, T-286); site
 * administrators make, change and delete them and choose their members. A team grants nothing:
 * groups do that.
 * Boards, areas and Team fields name a team by id, so a rename shows everywhere at once.
 */
export function registerTeamRoutes(app: FastifyInstance, db: Kysely<Database>): void {
  /** A lead must be an active person of the workspace, not a service account. */
  async function leadFound(trx: Db, workspaceId: number, id: number | null | undefined) {
    if (id === null || id === undefined) return true;
    return (await activePerson(trx, workspaceId, id)) !== undefined;
  }

  app.get('/api/v1/teams', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    let query = teamQuery(db, request.workspaceId);
    if (parsed.data.query) {
      const like = `%${parsed.data.query.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      query = query.where(sql`lower(t.name)`, 'like', like);
    }
    const { limit } = parsed.data;
    const after = parsed.data.after ?? parsed.data.cursor;
    const start = after === undefined ? null : decodeSortCursor(after);
    if (start) {
      query = query.where(
        sql<boolean>`(lower(t.name), t.id) > (${start[0]}::text, ${start[1]}::int)`,
      );
    }
    const rows = await query
      .select(sql<string>`lower(t.name)`.as('sort_name'))
      .orderBy(sql`lower(t.name)`)
      .orderBy('t.id')
      .limit(limit + 1)
      .execute();
    const more = rows.length > limit;
    if (more) rows.length = limit;
    const last = rows[rows.length - 1];
    const next = more && last ? encodeSortCursor(last.sort_name, last.id) : null;
    return { teams: rows.map(view), next };
  });

  app.get('/api/v1/teams/:id', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const ws = request.workspaceId;
    const row = await teamQuery(db, ws).where('t.id', '=', params.data.id).executeTakeFirst();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const members = await db
      .selectFrom('team_member as m')
      .innerJoin('app_user as u', 'u.id', 'm.user_id')
      .select(['u.id', 'u.name', 'u.deactivated_at'])
      .where('m.team_id', '=', row.id)
      .where('m.workspace_id', '=', ws)
      .orderBy(sql`lower(u.name)`)
      .orderBy('u.id')
      .execute();
    return {
      team: view(row),
      members: members.map((m) => ({ id: m.id, name: m.name, active: m.deactivated_at === null })),
    };
  });

  app.post('/api/v1/teams', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const parsed = teamBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const ws = request.workspaceId;
    const body = parsed.data;
    if (!(await leadFound(db, ws, body.leadId))) {
      return reply.code(400).send({ error: 'unknown_lead' });
    }
    try {
      const id = await db.transaction().execute(async (trx) => {
        const created = await trx
          .insertInto('team')
          .values({
            workspace_id: ws,
            name: body.name,
            description: body.description ?? '',
            lead_id: body.leadId ?? null,
          })
          .returning(['id', 'name'])
          .executeTakeFirstOrThrow();
        await emit(
          trx,
          { workspaceId: ws, actorId: admin.id },
          { type: 'team.created', subjectId: created.id, payload: { name: created.name } },
        );
        return created.id;
      });
      const row = await teamQuery(db, ws).where('t.id', '=', id).executeTakeFirstOrThrow();
      return reply.code(201).send({ team: view(row) });
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ error: 'name_taken' });
      throw error;
    }
  });

  app.patch('/api/v1/teams/:id', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const params = idParams.safeParse(request.params);
    const parsed = patchBody.safeParse(request.body);
    if (!params.success || !parsed.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const ws = request.workspaceId;
    const body = parsed.data;
    if (!(await leadFound(db, ws, body.leadId))) {
      return reply.code(400).send({ error: 'unknown_lead' });
    }
    try {
      const found = await db.transaction().execute(async (trx) => {
        const before = await trx
          .selectFrom('team')
          .select(['name', 'description', 'lead_id as leadId'])
          .where('id', '=', params.data.id)
          .where('workspace_id', '=', ws)
          .forUpdate()
          .executeTakeFirst();
        if (!before) return false;
        const next = {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.leadId !== undefined ? { leadId: body.leadId } : {}),
        };
        const changes = diff(before, next);
        if (Object.keys(changes).length === 0) return true;
        await trx
          .updateTable('team')
          .set({
            ...(next.name !== undefined ? { name: next.name } : {}),
            ...(next.description !== undefined ? { description: next.description } : {}),
            ...(next.leadId !== undefined ? { lead_id: next.leadId } : {}),
            updated_at: new Date(),
          })
          .where('id', '=', params.data.id)
          .execute();
        await emit(
          trx,
          { workspaceId: ws, actorId: admin.id },
          { type: 'team.updated', subjectId: params.data.id, payload: { changes } },
        );
        return true;
      });
      if (!found) return reply.code(404).send({ error: 'not_found' });
      const row = await teamQuery(db, ws)
        .where('t.id', '=', params.data.id)
        .executeTakeFirstOrThrow();
      return { team: view(row) };
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ error: 'name_taken' });
      throw error;
    }
  });

  app.delete('/api/v1/teams/:id', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    // Boards and areas let go of it; Team field values that name it read as empty.
    const deleted = await db.transaction().execute(async (trx) => {
      const row = await trx
        .deleteFrom('team')
        .where('id', '=', params.data.id)
        .where('workspace_id', '=', request.workspaceId)
        .returning(['id', 'name'])
        .executeTakeFirst();
      if (row) {
        await emit(
          trx,
          { workspaceId: request.workspaceId, actorId: admin.id },
          { type: 'team.deleted', subjectId: row.id, payload: { name: row.name } },
        );
      }
      return row;
    });
    if (!deleted) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });

  app.put('/api/v1/teams/:id/members/:userId', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const params = memberParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const ws = request.workspaceId;
    const [team, user] = await Promise.all([
      findTeam(db, ws, params.data.id),
      activePerson(db, ws, params.data.userId),
    ]);
    if (!team || !user) return reply.code(404).send({ error: 'not_found' });
    await db.transaction().execute(async (trx) => {
      const added = await trx
        .insertInto('team_member')
        .values({ workspace_id: ws, team_id: team.id, user_id: user.id })
        .onConflict((oc) => oc.columns(['team_id', 'user_id']).doNothing())
        .executeTakeFirst();
      // Adding someone who is already a member changes nothing and tells nobody.
      if (Number(added.numInsertedOrUpdatedRows ?? 0) > 0) {
        await emit(
          trx,
          { workspaceId: ws, actorId: admin.id },
          { type: 'team.member_added', subjectId: team.id, payload: { userId: user.id } },
        );
      }
    });
    return reply.code(204).send();
  });

  app.delete('/api/v1/teams/:id/members/:userId', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const params = memberParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const removed = await db.transaction().execute(async (trx) => {
      const result = await trx
        .deleteFrom('team_member')
        .where('team_id', '=', params.data.id)
        .where('user_id', '=', params.data.userId)
        .where('workspace_id', '=', request.workspaceId)
        .executeTakeFirst();
      const count = Number(result.numDeletedRows);
      if (count > 0) {
        await emit(
          trx,
          { workspaceId: request.workspaceId, actorId: admin.id },
          {
            type: 'team.member_removed',
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
}
