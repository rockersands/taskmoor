import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { requireUser } from '../auth';
import { diff, emit } from '../events/bus';
import {
  CHANNELS,
  isNotificationEvent,
  NOTIFICATION_EVENTS,
  RECIPIENTS,
} from '../notifications/model';

/**
 * Notification policies and personal preferences (M1-056; NTF-001, NTF-004; spec 01c
 * section 3).
 *
 * - A policy lists rules: an event (a built-in one or `custom:<name>` for a transition's own
 *   event) and a recipient type, with the user, group, role or field it names. Shared policies
 *   are changed by site and configuration administrators; a local-mode track's own policy by
 *   its administrators too. A save replaces the rules as a whole. The default policy serves
 *   tracks that name none; it and policies in use are not deleted.
 * - `GET`/`PATCH /api/v1/account/notification-preferences`: per event and channel on or off
 *   (on unless turned off), and whether to hear of one's own changes (off unless turned on).
 *
 * Every successful mutation emits exactly one domain event in its transaction (ADR-015).
 */
const MAX_INT = 2_147_483_647;
const id = z.coerce.number().int().positive().max(MAX_INT);
const idValue = z.number().int().positive().max(MAX_INT);
const name = z.string().trim().min(1).max(255);
const description = z.string().max(2000);
const RULES_PER_POLICY = 2000;

const eventName = z.string().refine(isNotificationEvent, 'a notification event');
const ruleBody = z
  .object({
    event: eventName,
    recipient: z.enum(RECIPIENTS),
    userId: idValue.optional(),
    groupId: idValue.optional(),
    roleId: idValue.optional(),
    fieldKey: z
      .string()
      .regex(/^cf\[\d{1,10}\]$/)
      .optional(),
  })
  .strict()
  .refine(
    (r) =>
      (r.recipient === 'user') === (r.userId !== undefined) &&
      (r.recipient === 'group') === (r.groupId !== undefined) &&
      (r.recipient === 'role') === (r.roleId !== undefined) &&
      (r.recipient === 'user_field' || r.recipient === 'group_field') ===
        (r.fieldKey !== undefined),
    'userId, groupId, roleId or fieldKey as the recipient needs, and no other',
  );
const createBody = z
  .object({
    name,
    description: description.optional(),
    trackId: idValue.optional(),
    rules: z.array(ruleBody).max(RULES_PER_POLICY).optional(),
  })
  .strict();
const updateBody = z
  .object({ name, description, rules: z.array(ruleBody).max(RULES_PER_POLICY) })
  .partial()
  .strict();
const listQuery = z.object({ trackId: id.optional() }).strict();
const channelChoice = z.object({ email: z.boolean(), inbox: z.boolean() }).partial().strict();
const hour = z.number().int().min(0).max(23);
const preferencesBody = z
  .object({
    ownChanges: z.boolean(),
    events: z.record(eventName, channelChoice),
    /** Email at once, as a daily or weekly digest, or none (M1-057). */
    emailDelivery: z.enum(['instant', 'daily', 'weekly', 'off']),
    /** Local hours email waits through; null for none. */
    quietHours: z.object({ start: hour, end: hour }).strict().nullable(),
  })
  .partial()
  .strict();

type Rule = z.infer<typeof ruleBody>;
type Db = Kysely<Database> | Transaction<Database>;

const invalid = (reply: FastifyReply, detail?: string) =>
  reply.code(400).send({ error: 'invalid_request', ...(detail ? { detail } : {}) });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });
const zodDetail = (error: z.ZodError) =>
  error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
const uniqueViolation = (error: unknown) => (error as { code?: string }).code === '23505';
const ruleKey = (r: Rule) =>
  [r.event, r.recipient, r.userId ?? 0, r.groupId ?? 0, r.roleId ?? 0, r.fieldKey ?? ''].join(':');

export function registerNotificationRoutes(app: FastifyInstance, db: Kysely<Database>): void {
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
    if (ownerTrackId !== null) {
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
      if (track.mode === 'local' && (await request.authz.can('administer_track', ownerTrackId))) {
        return true;
      }
    }
    await reply.code(403).send({ error: 'forbidden' });
    return false;
  }

  /** The tracks a policy serves: those naming it, and for the default those naming none. */
  const usedBy = (d: Db, policyId: number, isDefault: boolean) =>
    d
      .selectFrom('track')
      .select(['id', 'key', 'name'])
      .where((eb) =>
        isDefault
          ? eb.or([
              eb('notification_policy_id', '=', policyId),
              eb('notification_policy_id', 'is', null),
            ])
          : eb('notification_policy_id', '=', policyId),
      )
      .where('deleted_at', 'is', null)
      .orderBy('key')
      .execute();

  async function policyView(d: Db, ws: number, policyId: number) {
    const policy = await d
      .selectFrom('notification_policy')
      .selectAll()
      .where('id', '=', policyId)
      .where('workspace_id', '=', ws)
      .executeTakeFirst();
    if (!policy) return null;
    const rules = await d
      .selectFrom('notification_rule')
      .select(['id', 'event', 'recipient', 'user_id', 'group_id', 'role_id', 'field_key'])
      .where('policy_id', '=', policyId)
      .orderBy('event')
      .orderBy('id')
      .execute();
    return {
      id: policy.id,
      name: policy.name,
      description: policy.description,
      trackId: policy.track_id,
      isDefault: policy.is_default,
      rules: rules.map((r) => ({
        id: r.id,
        event: r.event,
        recipient: r.recipient,
        userId: r.user_id,
        groupId: r.group_id,
        roleId: r.role_id,
        fieldKey: r.field_key,
      })),
      usedBy: await usedBy(d, policy.id, policy.is_default),
    };
  }

  /** What a rule names must exist; a field rule names a user or group field. */
  async function ruleProblem(
    ws: number,
    ownerTrackId: number | null,
    rule: Rule,
  ): Promise<string | null> {
    for (const [table, value, label] of [
      ['app_user', rule.userId, 'userId'],
      ['user_group', rule.groupId, 'groupId'],
      ['role', rule.roleId, 'roleId'],
    ] as const) {
      if (value === undefined) continue;
      const row = await db
        .selectFrom(table)
        .select('id')
        .where('id', '=', value)
        .where('workspace_id', '=', ws)
        .executeTakeFirst();
      if (!row) return label;
    }
    if (rule.fieldKey !== undefined) {
      const field = await db
        .selectFrom('field')
        .select(['type', 'track_id'])
        .where('id', '=', Number(/\d+/.exec(rule.fieldKey)?.[0]))
        .where('workspace_id', '=', ws)
        .executeTakeFirst();
      const wanted = rule.recipient === 'user_field' ? 'user' : 'group';
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

  async function writeRules(
    trx: Transaction<Database>,
    ws: number,
    policyId: number,
    rules: readonly Rule[],
  ) {
    await trx.deleteFrom('notification_rule').where('policy_id', '=', policyId).execute();
    const unique = new Map(rules.map((r) => [ruleKey(r), r]));
    if (unique.size === 0) return;
    await trx
      .insertInto('notification_rule')
      .values(
        [...unique.values()].map((r) => ({
          workspace_id: ws,
          policy_id: policyId,
          event: r.event,
          recipient: r.recipient,
          user_id: r.userId ?? null,
          group_id: r.groupId ?? null,
          role_id: r.roleId ?? null,
          field_key: r.fieldKey ?? null,
        })),
      )
      .execute();
  }

  /** A policy by the route's id, with the rights to change it checked; null after answering. */
  async function managedPolicy(request: FastifyRequest, reply: FastifyReply) {
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) {
      await invalid(reply);
      return null;
    }
    if (!requireUser(request, reply)) return null;
    const policy = await db
      .selectFrom('notification_policy')
      .selectAll()
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

  app.get('/api/v1/notification-events', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    return { events: NOTIFICATION_EVENTS, recipients: RECIPIENTS, channels: CHANNELS };
  });

  app.get('/api/v1/notification-policies', async (request, reply) => {
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success) return invalid(reply);
    const trackId = parsed.data.trackId ?? null;
    if (!(await mayConfigure(request, reply, trackId))) return reply;
    let query = db
      .selectFrom('notification_policy')
      .select('id')
      .where('workspace_id', '=', request.workspaceId);
    query =
      trackId === null
        ? query.where('track_id', 'is', null)
        : query.where('track_id', '=', trackId);
    const rows = await query.orderBy(sql`lower(name)`).orderBy('id').execute();
    const policies = [];
    for (const r of rows) policies.push(await policyView(db, request.workspaceId, r.id));
    return { notificationPolicies: policies };
  });

  app.get('/api/v1/notification-policies/:id', async (request, reply) => {
    const policy = await managedPolicy(request, reply);
    if (!policy) return reply;
    return { notificationPolicy: await policyView(db, request.workspaceId, policy.id) };
  });

  app.post('/api/v1/notification-policies', async (request, reply) => {
    const parsed = createBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply, zodDetail(parsed.error));
    const body = parsed.data;
    const ws = request.workspaceId;
    const trackId = body.trackId ?? null;
    if (!(await mayConfigure(request, reply, trackId))) return reply;
    for (const rule of body.rules ?? []) {
      const bad = await ruleProblem(ws, trackId, rule);
      if (bad) return invalid(reply, `rules: ${bad}`);
    }
    try {
      const policyId = await db.transaction().execute(async (trx) => {
        const row = await trx
          .insertInto('notification_policy')
          .values({
            workspace_id: ws,
            track_id: trackId,
            name: body.name,
            description: body.description ?? '',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await writeRules(trx, ws, row.id, body.rules ?? []);
        await emit(trx, by(request), {
          type: 'notification_policy.created',
          subjectId: row.id,
          payload: { name: body.name, trackId, count: body.rules?.length ?? 0 },
        });
        return row.id;
      });
      return reply.code(201).send({ notificationPolicy: await policyView(db, ws, policyId) });
    } catch (error) {
      if (uniqueViolation(error)) return reply.code(409).send({ error: 'name_taken' });
      throw error;
    }
  });

  app.patch('/api/v1/notification-policies/:id', async (request, reply) => {
    const parsed = updateBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply, zodDetail(parsed.error));
    const body = parsed.data;
    const policy = await managedPolicy(request, reply);
    if (!policy) return reply;
    const ws = request.workspaceId;
    for (const rule of body.rules ?? []) {
      const bad = await ruleProblem(ws, policy.track_id, rule);
      if (bad) return invalid(reply, `rules: ${bad}`);
    }
    try {
      await db.transaction().execute(async (trx) => {
        const had = await trx
          .selectFrom('notification_rule')
          .select(['event', 'recipient', 'user_id', 'group_id', 'role_id', 'field_key'])
          .where('policy_id', '=', policy.id)
          .forUpdate()
          .execute();
        const before = had
          .map((r) =>
            ruleKey({
              event: r.event,
              recipient: r.recipient,
              ...(r.user_id !== null ? { userId: r.user_id } : {}),
              ...(r.group_id !== null ? { groupId: r.group_id } : {}),
              ...(r.role_id !== null ? { roleId: r.role_id } : {}),
              ...(r.field_key !== null ? { fieldKey: r.field_key } : {}),
            }),
          )
          .sort();
        const after = body.rules ? [...new Set(body.rules.map(ruleKey))].sort() : undefined;
        const changes = diff<Record<string, unknown>>(
          { name: policy.name, description: policy.description, rules: before },
          { name: body.name, description: body.description, rules: after },
        );
        if (Object.keys(changes).length === 0) return;
        if (body.name !== undefined || body.description !== undefined) {
          await trx
            .updateTable('notification_policy')
            .set({
              ...(body.name !== undefined ? { name: body.name } : {}),
              ...(body.description !== undefined ? { description: body.description } : {}),
              updated_at: new Date(),
            })
            .where('id', '=', policy.id)
            .execute();
        }
        if (changes.rules && body.rules) await writeRules(trx, ws, policy.id, body.rules);
        await emit(trx, by(request), {
          type: 'notification_policy.updated',
          subjectId: policy.id,
          payload: {
            changes,
            trackIds: (await usedBy(trx, policy.id, policy.is_default)).map((t) => t.id),
          },
        });
      });
      return { notificationPolicy: await policyView(db, ws, policy.id) };
    } catch (error) {
      if (uniqueViolation(error)) return reply.code(409).send({ error: 'name_taken' });
      throw error;
    }
  });

  app.delete('/api/v1/notification-policies/:id', async (request, reply) => {
    const policy = await managedPolicy(request, reply);
    if (!policy) return reply;
    if (policy.is_default) return reply.code(409).send({ error: 'default_policy' });
    const result = await db.transaction().execute(async (trx) => {
      const tracks = await usedBy(trx, policy.id, false);
      if (tracks.length > 0) return { inUse: tracks };
      await trx.deleteFrom('notification_policy').where('id', '=', policy.id).execute();
      await emit(trx, by(request), {
        type: 'notification_policy.deleted',
        subjectId: policy.id,
        payload: { name: policy.name },
      });
      return null;
    });
    if (result) return reply.code(409).send({ error: 'in_use', usedBy: result.inUse });
    return reply.code(204).send();
  });

  /** A person's choices: every event and channel, on unless turned off. */
  async function preferencesOf(d: Db, userId: number) {
    const [rows, own] = await Promise.all([
      d
        .selectFrom('notification_preference')
        .select(['event', 'channel', 'enabled'])
        .where('user_id', '=', userId)
        .execute(),
      d
        .selectFrom('user_preference')
        .select(['notify_own_changes', 'email_delivery', 'quiet_start', 'quiet_end'])
        .where('user_id', '=', userId)
        .executeTakeFirst(),
    ]);
    const events: Record<string, Record<string, boolean>> = {};
    for (const event of [...NOTIFICATION_EVENTS, ...rows.map((r) => r.event)]) {
      events[event] ??= Object.fromEntries(CHANNELS.map((c) => [c, true]));
    }
    for (const r of rows) (events[r.event] as Record<string, boolean>)[r.channel] = r.enabled;
    return {
      ownChanges: own?.notify_own_changes ?? false,
      emailDelivery: own?.email_delivery ?? 'instant',
      quietHours:
        own?.quiet_start == null || own.quiet_end == null
          ? null
          : { start: own.quiet_start, end: own.quiet_end },
      events,
    };
  }

  app.get('/api/v1/account/notification-preferences', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    return { preferences: await preferencesOf(db, user.id) };
  });

  app.patch('/api/v1/account/notification-preferences', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const parsed = preferencesBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply, zodDetail(parsed.error));
    const body = parsed.data;
    const ws = request.workspaceId;
    await db.transaction().execute(async (trx) => {
      await trx.selectFrom('app_user').select('id').where('id', '=', user.id).forUpdate().execute();
      const was = await preferencesOf(trx, user.id);
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      // The settings kept on the person's preference row.
      const row: {
        notify_own_changes?: boolean;
        email_delivery?: 'instant' | 'daily' | 'weekly' | 'off';
        quiet_start?: number | null;
        quiet_end?: number | null;
      } = {};
      if (body.ownChanges !== undefined && body.ownChanges !== was.ownChanges) {
        changes.ownChanges = { from: was.ownChanges, to: body.ownChanges };
        row.notify_own_changes = body.ownChanges;
      }
      if (body.emailDelivery !== undefined && body.emailDelivery !== was.emailDelivery) {
        changes.emailDelivery = { from: was.emailDelivery, to: body.emailDelivery };
        row.email_delivery = body.emailDelivery;
      }
      if (
        body.quietHours !== undefined &&
        JSON.stringify(body.quietHours) !== JSON.stringify(was.quietHours)
      ) {
        changes.quietHours = { from: was.quietHours, to: body.quietHours };
        row.quiet_start = body.quietHours?.start ?? null;
        row.quiet_end = body.quietHours?.end ?? null;
      }
      if (Object.keys(row).length > 0) {
        await trx
          .insertInto('user_preference')
          .values({ user_id: user.id, workspace_id: ws, ...row })
          .onConflict((oc) => oc.column('user_id').doUpdateSet({ ...row, updated_at: new Date() }))
          .execute();
      }
      for (const [event, choice] of Object.entries(body.events ?? {})) {
        for (const channel of CHANNELS) {
          const enabled = choice[channel];
          const had = was.events[event]?.[channel] ?? true;
          if (enabled === undefined || enabled === had) continue;
          changes[`${event}.${channel}`] = { from: had, to: enabled };
          if (enabled) {
            await trx
              .deleteFrom('notification_preference')
              .where('user_id', '=', user.id)
              .where('event', '=', event)
              .where('channel', '=', channel)
              .execute();
          } else {
            await trx
              .insertInto('notification_preference')
              .values({ user_id: user.id, workspace_id: ws, event, channel, enabled: false })
              .onConflict((oc) =>
                oc.columns(['user_id', 'event', 'channel']).doUpdateSet({ enabled: false }),
              )
              .execute();
          }
        }
      }
      if (Object.keys(changes).length === 0) return;
      await emit(trx, by(request), {
        type: 'user.preferences_updated',
        subjectId: user.id,
        payload: { changes },
      });
    });
    return { preferences: await preferencesOf(db, user.id) };
  });
}
