import type { Database, GranteeKind } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';
import { requireUser } from '../auth';
import { diff, emit } from '../events/bus';
import { enforceLimit } from '../guardrails/model';
import { loadTicket, resolveTicket, resolveTrack } from '../tickets/store';
import { setLevels, trackVisibility } from '../tickets/visibility';

/**
 * Visibility policies and levels (M1-020; IAM-011; spec 05a section 1.2).
 *
 * - Shared policies belong to the workspace and are changed by site and configuration
 *   administrators; a local-mode track's own policy by its administrators too. Reading a
 *   policy needs the same rights: members name people and groups.
 * - A policy has up to 50 levels and a default level, which new tickets take and moved tickets
 *   take in their new track. A level's members are any grantee an access grant takes; user and
 *   group field members name a custom field of that type (`cf[12]`).
 * - Deleting a level its tickets still use needs `replaceWith` (another level of the policy,
 *   or `none`); their history records the change. A policy a track uses is not deleted.
 * - `GET /api/v1/tracks/:id/visibility-levels` and `GET /api/v1/tickets/:id/visibility-levels`
 *   give the levels a person may choose from, for the create and edit forms: none without
 *   "Set visibility level".
 *
 * Every successful mutation emits exactly one domain event in its transaction (ADR-015).
 */
const MAX_INT = 2_147_483_647;
/** A hard cap on one request; the limit itself is the guardrail (M1-055). */
const LEVELS_PER_POLICY = 1000;
const MEMBERS_PER_LEVEL = 500;
const id = z.coerce.number().int().positive().max(MAX_INT);
const idValue = z.number().int().positive().max(MAX_INT);
const name = z.string().trim().min(1).max(255);
const description = z.string().max(2000);
const GRANTEES = [
  'role',
  'group',
  'user',
  'track_owner',
  'any_user',
  'anyone',
  'requester',
  'assignee',
  'user_field',
  'group_field',
] as const satisfies readonly GranteeKind[];

const memberBody = z
  .object({
    grantee: z.enum(GRANTEES),
    roleId: idValue.optional(),
    groupId: idValue.optional(),
    userId: idValue.optional(),
    fieldKey: z
      .string()
      .regex(/^cf\[\d{1,10}\]$/)
      .optional(),
  })
  .strict()
  .refine(
    (m) =>
      (m.grantee === 'role') === (m.roleId !== undefined) &&
      (m.grantee === 'group') === (m.groupId !== undefined) &&
      (m.grantee === 'user') === (m.userId !== undefined) &&
      (m.grantee === 'user_field' || m.grantee === 'group_field') === (m.fieldKey !== undefined),
    'roleId, groupId, userId or fieldKey as the grantee needs, and no other',
  );
const levelBody = z
  .object({
    name,
    description: description.optional(),
    members: z.array(memberBody).max(MEMBERS_PER_LEVEL).optional(),
  })
  .strict();
const createPolicyBody = z
  .object({
    name,
    description: description.optional(),
    trackId: idValue.optional(),
    levels: z.array(levelBody).max(LEVELS_PER_POLICY).optional(),
    /** The name of the level new tickets take; none when left out. */
    defaultLevel: name.optional(),
  })
  .strict();
const updatePolicyBody = z
  .object({ name, description, defaultLevelId: idValue.nullable() })
  .partial()
  .strict();
const createLevelBody = levelBody.extend({ isDefault: z.boolean().optional() }).strict();
const updateLevelBody = z
  .object({
    name,
    description,
    position: z
      .number()
      .int()
      .min(0)
      .max(LEVELS_PER_POLICY - 1),
  })
  .partial()
  .strict();
const deleteLevelQuery = z
  .object({ replaceWith: z.union([z.literal('none'), id]).optional() })
  .strict();
const listQuery = z.object({ trackId: id.optional() }).strict();

type Member = z.infer<typeof memberBody>;
type Problem = { status: number; body: Record<string, unknown> };
const problem = (status: number, error: string, extra: Record<string, unknown> = {}): Problem => ({
  status,
  body: { error, ...extra },
});
const isProblem = (v: unknown): v is Problem =>
  typeof v === 'object' && v !== null && 'status' in v && 'body' in v;

const invalid = (reply: FastifyReply, detail?: string) =>
  reply.code(400).send({ error: 'invalid_request', ...(detail ? { detail } : {}) });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });
const zodDetail = (error: z.ZodError) =>
  error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
const uniqueViolation = (error: unknown) => (error as { code?: string }).code === '23505';

type Db = Kysely<Database> | Transaction<Database>;

export function registerVisibilityRoutes(app: FastifyInstance, db: Kysely<Database>): void {
  const by = (request: FastifyRequest) => ({
    workspaceId: request.workspaceId,
    actorId: request.user?.id ?? null,
  });

  async function isAdmin(request: FastifyRequest): Promise<boolean> {
    const global = await request.authz.global();
    return global.has('site_admin') || global.has('configuration_admin');
  }

  /** Administrators manage shared policies; a local-mode track's administrators its own. */
  async function mayConfigure(
    request: FastifyRequest,
    reply: FastifyReply,
    ownerTrackId: number | null,
  ): Promise<boolean> {
    if (!requireUser(request, reply)) return false;
    if (await isAdmin(request)) return true;
    if (ownerTrackId === null) {
      await reply.code(403).send({ error: 'forbidden' });
      return false;
    }
    const track = await db
      .selectFrom('track')
      .select(['mode', 'deleted_at'])
      .where('id', '=', ownerTrackId)
      .where('workspace_id', '=', request.workspaceId)
      .executeTakeFirst();
    if (!track || track.deleted_at) {
      await notFound(reply);
      return false;
    }
    if (track.mode !== 'local') {
      await reply.code(409).send({ error: 'track_not_local' });
      return false;
    }
    if (await request.authz.can('administer_track', ownerTrackId)) return true;
    await reply.code(403).send({ error: 'forbidden' });
    return false;
  }

  /** The tracks using a policy. */
  const usedBy = (d: Db, policyId: number) =>
    d
      .selectFrom('track')
      .select(['id', 'key', 'name'])
      .where('visibility_policy_id', '=', policyId)
      .where('deleted_at', 'is', null)
      .orderBy('key')
      .execute();

  /** A policy with its levels and their members, as the API shows it. */
  async function policyView(d: Db, ws: number, policyId: number) {
    const policy = await d
      .selectFrom('visibility_policy')
      .selectAll()
      .where('id', '=', policyId)
      .where('workspace_id', '=', ws)
      .executeTakeFirst();
    if (!policy) return null;
    const levels = await d
      .selectFrom('visibility_level')
      .select(['id', 'name', 'description', 'position'])
      .where('policy_id', '=', policyId)
      .orderBy('position')
      .orderBy('id')
      .execute();
    const members = await d
      .selectFrom('visibility_member as m')
      .innerJoin('visibility_level as l', 'l.id', 'm.level_id')
      .leftJoin('role as r', 'r.id', 'm.role_id')
      .leftJoin('user_group as g', 'g.id', 'm.group_id')
      .leftJoin('app_user as u', 'u.id', 'm.user_id')
      .select([
        'm.id',
        'm.level_id',
        'm.grantee',
        'm.role_id',
        'r.name as role_name',
        'm.group_id',
        'g.name as group_name',
        'm.user_id',
        'u.name as user_name',
        'm.field_key',
      ])
      .where('l.policy_id', '=', policyId)
      .orderBy('m.id')
      .execute();
    return {
      id: policy.id,
      name: policy.name,
      description: policy.description,
      trackId: policy.track_id,
      defaultLevelId: policy.default_level_id,
      levels: levels.map((l) => ({
        id: l.id,
        name: l.name,
        description: l.description,
        position: l.position,
        members: members
          .filter((m) => m.level_id === l.id)
          .map((m) => ({
            id: m.id,
            grantee: m.grantee,
            role: m.role_id === null ? null : { id: m.role_id, name: m.role_name ?? '' },
            group: m.group_id === null ? null : { id: m.group_id, name: m.group_name ?? '' },
            user: m.user_id === null ? null : { id: m.user_id, name: m.user_name ?? '' },
            fieldKey: m.field_key,
          })),
      })),
      usedBy: await usedBy(d, policyId),
    };
  }

  /** What a member names must exist; a field member names a user or group field. */
  async function memberProblem(
    d: Db,
    ws: number,
    ownerTrackId: number | null,
    m: Member,
  ): Promise<string | null> {
    if (m.roleId !== undefined) {
      const row = await d
        .selectFrom('role')
        .select('id')
        .where('id', '=', m.roleId)
        .where('workspace_id', '=', ws)
        .executeTakeFirst();
      if (!row) return 'roleId';
    }
    if (m.groupId !== undefined) {
      const row = await d
        .selectFrom('user_group')
        .select('id')
        .where('id', '=', m.groupId)
        .where('workspace_id', '=', ws)
        .executeTakeFirst();
      if (!row) return 'groupId';
    }
    if (m.userId !== undefined) {
      const row = await d
        .selectFrom('app_user')
        .select('id')
        .where('id', '=', m.userId)
        .where('workspace_id', '=', ws)
        .executeTakeFirst();
      if (!row) return 'userId';
    }
    if (m.fieldKey !== undefined) {
      const fieldId = Number(/\d+/.exec(m.fieldKey)?.[0]);
      const field = await d
        .selectFrom('field')
        .select(['type', 'track_id'])
        .where('id', '=', fieldId)
        .where('workspace_id', '=', ws)
        .executeTakeFirst();
      const wanted = m.grantee === 'user_field' ? 'user' : 'group';
      if (
        !field ||
        field.type !== wanted ||
        (field.track_id !== null && field.track_id !== ownerTrackId)
      ) {
        return 'fieldKey';
      }
    }
    return null;
  }

  async function insertMember(
    trx: Transaction<Database>,
    ws: number,
    levelId: number,
    m: Member,
  ): Promise<number> {
    const row = await trx
      .insertInto('visibility_member')
      .values({
        workspace_id: ws,
        level_id: levelId,
        grantee: m.grantee,
        role_id: m.roleId ?? null,
        group_id: m.groupId ?? null,
        user_id: m.userId ?? null,
        field_key: m.fieldKey ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** A policy by id, with the rights to change it checked; null after answering. */
  async function managedPolicy(request: FastifyRequest, reply: FastifyReply) {
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) {
      await invalid(reply);
      return null;
    }
    if (!requireUser(request, reply)) return null;
    const policy = await db
      .selectFrom('visibility_policy')
      .select(['id', 'track_id', 'name', 'description', 'default_level_id'])
      .where('id', '=', params.data.id)
      .where('workspace_id', '=', request.workspaceId)
      .executeTakeFirst();
    if (!policy) {
      await notFound(reply);
      return null;
    }
    if (!(await mayConfigure(request, reply, policy.track_id))) return null;
    return policy;
  }

  /** A level of a policy by the route's ids, with the rights checked; null after answering. */
  async function managedLevel(request: FastifyRequest, reply: FastifyReply) {
    const policy = await managedPolicy(request, reply);
    if (!policy) return null;
    const params = z.object({ levelId: id }).safeParse(request.params);
    if (!params.success) {
      await invalid(reply);
      return null;
    }
    const level = await db
      .selectFrom('visibility_level')
      .select(['id', 'name', 'description', 'position'])
      .where('id', '=', params.data.levelId)
      .where('policy_id', '=', policy.id)
      .executeTakeFirst();
    if (!level) {
      await notFound(reply);
      return null;
    }
    return { policy, level };
  }

  /** Answers a transaction's result: a problem, or the policy as it now is. */
  async function respond(
    request: FastifyRequest,
    reply: FastifyReply,
    result: Problem | number | null,
    code = 200,
  ) {
    if (result === null) return notFound(reply);
    if (isProblem(result)) return reply.code(result.status).send(result.body);
    return reply
      .code(code)
      .send({ visibilityPolicy: await policyView(db, request.workspaceId, result) });
  }

  app.get('/api/v1/visibility-policies', async (request, reply) => {
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success) return invalid(reply);
    const trackId = parsed.data.trackId ?? null;
    if (!(await mayConfigure(request, reply, trackId))) return reply;
    let query = db
      .selectFrom('visibility_policy')
      .select('id')
      .where('workspace_id', '=', request.workspaceId);
    query =
      trackId === null
        ? query.where('track_id', 'is', null)
        : query.where('track_id', '=', trackId);
    const rows = await query.orderBy('name').orderBy('id').execute();
    const policies = [];
    for (const r of rows) policies.push(await policyView(db, request.workspaceId, r.id));
    return { visibilityPolicies: policies };
  });

  app.get('/api/v1/visibility-policies/:id', async (request, reply) => {
    const policy = await managedPolicy(request, reply);
    if (!policy) return reply;
    return { visibilityPolicy: await policyView(db, request.workspaceId, policy.id) };
  });

  app.post('/api/v1/visibility-policies', async (request, reply) => {
    const parsed = createPolicyBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply, zodDetail(parsed.error));
    const body = parsed.data;
    const ws = request.workspaceId;
    const trackId = body.trackId ?? null;
    if (!(await mayConfigure(request, reply, trackId))) return reply;
    const levels = body.levels ?? [];
    await enforceLimit(db, ws, 'visibility_levels_per_track', levels.length);
    const names = levels.map((l) => l.name.toLowerCase());
    if (new Set(names).size !== names.length) return invalid(reply, 'levels: repeated name');
    if (body.defaultLevel !== undefined && !names.includes(body.defaultLevel.toLowerCase())) {
      return invalid(reply, 'defaultLevel');
    }
    for (const m of levels.flatMap((l) => l.members ?? [])) {
      const bad = await memberProblem(db, ws, trackId, m);
      if (bad) return invalid(reply, `members: ${bad}`);
    }
    try {
      const result = await db.transaction().execute(async (trx) => {
        const policy = await trx
          .insertInto('visibility_policy')
          .values({
            workspace_id: ws,
            track_id: trackId,
            name: body.name,
            description: body.description ?? '',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        let defaultLevelId: number | null = null;
        for (const [position, level] of levels.entries()) {
          const row = await trx
            .insertInto('visibility_level')
            .values({
              workspace_id: ws,
              policy_id: policy.id,
              name: level.name,
              description: level.description ?? '',
              position,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          for (const m of level.members ?? []) await insertMember(trx, ws, row.id, m);
          if (body.defaultLevel?.toLowerCase() === level.name.toLowerCase()) {
            defaultLevelId = row.id;
          }
        }
        if (defaultLevelId !== null) {
          await trx
            .updateTable('visibility_policy')
            .set({ default_level_id: defaultLevelId })
            .where('id', '=', policy.id)
            .execute();
        }
        await emit(trx, by(request), {
          type: 'visibility_policy.created',
          subjectId: policy.id,
          payload: { name: body.name, trackId, levelCount: levels.length },
        });
        return policy.id;
      });
      return respond(request, reply, result, 201);
    } catch (error) {
      if (uniqueViolation(error)) return reply.code(409).send({ error: 'name_taken' });
      throw error;
    }
  });

  app.patch('/api/v1/visibility-policies/:id', async (request, reply) => {
    const parsed = updatePolicyBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply, zodDetail(parsed.error));
    const body = parsed.data;
    const policy = await managedPolicy(request, reply);
    if (!policy) return reply;
    try {
      const result = await db.transaction().execute(async (trx): Promise<Problem | number> => {
        if (body.defaultLevelId != null) {
          const level = await trx
            .selectFrom('visibility_level')
            .select('id')
            .where('id', '=', body.defaultLevelId)
            .where('policy_id', '=', policy.id)
            .executeTakeFirst();
          if (!level) return problem(400, 'invalid_request', { detail: 'defaultLevelId' });
        }
        const changes = diff<Record<string, unknown>>(
          {
            name: policy.name,
            description: policy.description,
            defaultLevelId: policy.default_level_id,
          },
          body,
        );
        if (Object.keys(changes).length === 0) return policy.id;
        await trx
          .updateTable('visibility_policy')
          .set({
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.description !== undefined ? { description: body.description } : {}),
            ...(body.defaultLevelId !== undefined ? { default_level_id: body.defaultLevelId } : {}),
            updated_at: new Date(),
          })
          .where('id', '=', policy.id)
          .execute();
        await emit(trx, by(request), {
          type: 'visibility_policy.updated',
          subjectId: policy.id,
          payload: { changes, trackIds: (await usedBy(trx, policy.id)).map((t) => t.id) },
        });
        return policy.id;
      });
      return respond(request, reply, result);
    } catch (error) {
      if (uniqueViolation(error)) return reply.code(409).send({ error: 'name_taken' });
      throw error;
    }
  });

  app.delete('/api/v1/visibility-policies/:id', async (request, reply) => {
    const policy = await managedPolicy(request, reply);
    if (!policy) return reply;
    const result = await db.transaction().execute(async (trx) => {
      const locked = await trx
        .selectFrom('visibility_policy')
        .select('id')
        .where('id', '=', policy.id)
        .forUpdate()
        .executeTakeFirst();
      if (!locked) return null;
      const tracks = await usedBy(trx, policy.id);
      if (tracks.length > 0) return problem(409, 'in_use', { usedBy: tracks });
      // Tickets keep no level of a policy no track uses: a track that left it moved them.
      const held = await trx
        .selectFrom('ticket as k')
        .innerJoin('visibility_level as l', 'l.id', 'k.visibility_level_id')
        .select('k.id')
        .where('l.policy_id', '=', policy.id)
        .limit(1)
        .executeTakeFirst();
      if (held) return problem(409, 'levels_in_use');
      await trx.deleteFrom('visibility_policy').where('id', '=', policy.id).execute();
      await emit(trx, by(request), {
        type: 'visibility_policy.deleted',
        subjectId: policy.id,
        payload: { name: policy.name },
      });
      return true;
    });
    if (result === null) return notFound(reply);
    if (isProblem(result)) return reply.code(result.status).send(result.body);
    return reply.code(204).send();
  });

  app.post('/api/v1/visibility-policies/:id/levels', async (request, reply) => {
    const parsed = createLevelBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply, zodDetail(parsed.error));
    const body = parsed.data;
    const policy = await managedPolicy(request, reply);
    if (!policy) return reply;
    const ws = request.workspaceId;
    for (const m of body.members ?? []) {
      const bad = await memberProblem(db, ws, policy.track_id, m);
      if (bad) return invalid(reply, `members: ${bad}`);
    }
    try {
      const result = await db.transaction().execute(async (trx): Promise<Problem | number> => {
        await trx
          .selectFrom('visibility_policy')
          .select('id')
          .where('id', '=', policy.id)
          .forUpdate()
          .execute();
        const count = await trx
          .selectFrom('visibility_level')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('policy_id', '=', policy.id)
          .executeTakeFirstOrThrow();
        await enforceLimit(trx, ws, 'visibility_levels_per_track', Number(count.n) + 1);
        const level = await trx
          .insertInto('visibility_level')
          .values({
            workspace_id: ws,
            policy_id: policy.id,
            name: body.name,
            description: body.description ?? '',
            position: Number(count.n),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        for (const m of body.members ?? []) await insertMember(trx, ws, level.id, m);
        if (body.isDefault) {
          await trx
            .updateTable('visibility_policy')
            .set({ default_level_id: level.id, updated_at: new Date() })
            .where('id', '=', policy.id)
            .execute();
        }
        await emit(trx, by(request), {
          type: 'visibility_level.created',
          subjectId: level.id,
          payload: { policyId: policy.id, name: body.name, memberCount: body.members?.length ?? 0 },
        });
        return policy.id;
      });
      return respond(request, reply, result, 201);
    } catch (error) {
      if (uniqueViolation(error)) return reply.code(409).send({ error: 'name_taken' });
      throw error;
    }
  });

  app.patch('/api/v1/visibility-policies/:id/levels/:levelId', async (request, reply) => {
    const parsed = updateLevelBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply, zodDetail(parsed.error));
    const body = parsed.data;
    const target = await managedLevel(request, reply);
    if (!target) return reply;
    const { policy, level } = target;
    try {
      const result = await db.transaction().execute(async (trx): Promise<Problem | number> => {
        const levels = await trx
          .selectFrom('visibility_level')
          .select('id')
          .where('policy_id', '=', policy.id)
          .orderBy('position')
          .orderBy('id')
          .forUpdate()
          .execute();
        const changes = diff<Record<string, unknown>>(
          { name: level.name, description: level.description, position: level.position },
          body,
        );
        if (Object.keys(changes).length === 0) return policy.id;
        if (body.name !== undefined || body.description !== undefined) {
          await trx
            .updateTable('visibility_level')
            .set({
              ...(body.name !== undefined ? { name: body.name } : {}),
              ...(body.description !== undefined ? { description: body.description } : {}),
            })
            .where('id', '=', level.id)
            .execute();
        }
        if (body.position !== undefined) {
          // The levels in their new order, renumbered without a gap.
          const order = levels.map((l) => l.id).filter((l) => l !== level.id);
          order.splice(Math.min(body.position, order.length), 0, level.id);
          for (const [position, levelId] of order.entries()) {
            await trx
              .updateTable('visibility_level')
              .set({ position })
              .where('id', '=', levelId)
              .execute();
          }
        }
        await emit(trx, by(request), {
          type: 'visibility_level.updated',
          subjectId: level.id,
          payload: { policyId: policy.id, changes },
        });
        return policy.id;
      });
      return respond(request, reply, result);
    } catch (error) {
      if (uniqueViolation(error)) return reply.code(409).send({ error: 'name_taken' });
      throw error;
    }
  });

  app.delete('/api/v1/visibility-policies/:id/levels/:levelId', async (request, reply) => {
    const parsed = deleteLevelQuery.safeParse(request.query);
    if (!parsed.success) return invalid(reply);
    const target = await managedLevel(request, reply);
    if (!target) return reply;
    const { policy, level } = target;
    const ws = request.workspaceId;
    const replaceWith = parsed.data.replaceWith;
    const result = await db.transaction().execute(async (trx): Promise<Problem | number> => {
      await trx
        .selectFrom('visibility_level')
        .select('id')
        .where('policy_id', '=', policy.id)
        .orderBy('id')
        .forUpdate()
        .execute();
      let replacementId: number | null = null;
      if (typeof replaceWith === 'number') {
        const other = await trx
          .selectFrom('visibility_level')
          .select('id')
          .where('id', '=', replaceWith)
          .where('policy_id', '=', policy.id)
          .executeTakeFirst();
        if (!other || other.id === level.id) {
          return problem(400, 'invalid_request', { detail: 'replaceWith' });
        }
        replacementId = other.id;
      }
      const tickets = await trx
        .selectFrom('ticket')
        .select('id')
        .where('visibility_level_id', '=', level.id)
        .execute();
      if (tickets.length > 0 && replaceWith === undefined) {
        return problem(409, 'in_use', { ticketCount: tickets.length });
      }
      const ticketCount = await setLevels(
        trx,
        ws,
        request.user?.id ?? null,
        tickets.map((t) => t.id),
        replacementId,
      );
      await trx.deleteFrom('visibility_level').where('id', '=', level.id).execute();
      // The rest keep their order, renumbered without a gap.
      const rest = await trx
        .selectFrom('visibility_level')
        .select('id')
        .where('policy_id', '=', policy.id)
        .orderBy('position')
        .orderBy('id')
        .execute();
      for (const [position, l] of rest.entries()) {
        await trx
          .updateTable('visibility_level')
          .set({ position })
          .where('id', '=', l.id)
          .execute();
      }
      await emit(trx, by(request), {
        type: 'visibility_level.deleted',
        subjectId: level.id,
        payload: { policyId: policy.id, name: level.name, replacementId, ticketCount },
      });
      return policy.id;
    });
    return respond(request, reply, result);
  });

  app.post('/api/v1/visibility-policies/:id/levels/:levelId/members', async (request, reply) => {
    const parsed = memberBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply, zodDetail(parsed.error));
    const member = parsed.data;
    const target = await managedLevel(request, reply);
    if (!target) return reply;
    const { policy, level } = target;
    const ws = request.workspaceId;
    const bad = await memberProblem(db, ws, policy.track_id, member);
    if (bad) return invalid(reply, bad);
    try {
      const result = await db.transaction().execute(async (trx): Promise<Problem | number> => {
        const count = await trx
          .selectFrom('visibility_member')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('level_id', '=', level.id)
          .executeTakeFirstOrThrow();
        if (Number(count.n) >= MEMBERS_PER_LEVEL) {
          return problem(409, 'too_many_members', { limit: MEMBERS_PER_LEVEL });
        }
        const memberId = await insertMember(trx, ws, level.id, member);
        await emit(trx, by(request), {
          type: 'visibility_level.member_added',
          subjectId: level.id,
          payload: {
            policyId: policy.id,
            memberId,
            grantee: member.grantee,
            roleId: member.roleId ?? null,
            groupId: member.groupId ?? null,
            userId: member.userId ?? null,
            fieldKey: member.fieldKey ?? null,
          },
        });
        return policy.id;
      });
      return respond(request, reply, result, 201);
    } catch (error) {
      if (uniqueViolation(error)) return reply.code(409).send({ error: 'already_member' });
      throw error;
    }
  });

  app.delete(
    '/api/v1/visibility-policies/:id/levels/:levelId/members/:memberId',
    async (request, reply) => {
      const target = await managedLevel(request, reply);
      if (!target) return reply;
      const params = z.object({ memberId: id }).safeParse(request.params);
      if (!params.success) return invalid(reply);
      const { policy, level } = target;
      const result = await db.transaction().execute(async (trx) => {
        const removed = await trx
          .deleteFrom('visibility_member')
          .where('id', '=', params.data.memberId)
          .where('level_id', '=', level.id)
          .returning(['id', 'grantee'])
          .executeTakeFirst();
        if (!removed) return null;
        await emit(trx, by(request), {
          type: 'visibility_level.member_removed',
          subjectId: level.id,
          payload: { policyId: policy.id, memberId: removed.id, grantee: removed.grantee },
        });
        return policy.id;
      });
      return respond(request, reply, result);
    },
  );

  /** The levels a person may give a ticket in a track: none without the permission. */
  async function choosable(request: FastifyRequest, trackId: number) {
    const ws = request.workspaceId;
    const visibility = await trackVisibility(db, ws, trackId);
    const mayChoose = await request.authz.can('set_visibility_level', trackId);
    const levels =
      visibility.policyId === null
        ? []
        : await db
            .selectFrom('visibility_level')
            .select(['id', 'name', 'description'])
            .where('policy_id', '=', visibility.policyId)
            .orderBy('position')
            .orderBy('id')
            .execute();
    return {
      mayChoose,
      defaultLevelId: visibility.defaultLevelId,
      levels: mayChoose ? levels : [],
    };
  }

  app.get('/api/v1/tracks/:id/visibility-levels', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const params = z.object({ id: z.string().min(1).max(300) }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    const trackId = await resolveTrack(db, request.workspaceId, params.data.id);
    if (trackId === null || !(await request.authz.can('browse_track', trackId))) {
      return notFound(reply);
    }
    return choosable(request, trackId);
  });

  app.get('/api/v1/tickets/:id/visibility-levels', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const params = z.object({ id: z.string().min(1).max(300) }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    const found = await resolveTicket(db, request.workspaceId, params.data.id);
    const row = found ? await loadTicket(db, request.workspaceId, found.id) : undefined;
    if (!row || row.deleted_at || !(await request.authz.seesTicket(row))) return notFound(reply);
    const options = await choosable(request, row.track_id);
    return {
      ...options,
      mayChoose: options.mayChoose && (await request.authz.canTicket('set_visibility_level', row)),
      current:
        row.visibility_level_id === null
          ? null
          : { id: row.visibility_level_id, name: row.visibility_level_name ?? '' },
    };
  });
}
