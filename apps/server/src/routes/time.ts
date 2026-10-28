import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { requireGlobal, requireUser } from '../auth';
import type { TrackPermission } from '../authz/permissions';
import { diff, emit } from '../events/bus';
import { DISPLAY_FORMATS, DURATION_UNITS } from '../tickets/duration';
import { type FieldChange, recordChanges, ticketChanges } from '../tickets/history';
import { ticketKey } from '../tickets/model';
import { loadTicket, resolveTicket, type TicketRow } from '../tickets/store';
import {
  durationValue,
  nextRemaining,
  type RemainingMode,
  type TimeSettings,
  timeSettings,
} from '../tickets/time';

/**
 * Time tracking (M1-019; TIM-001; spec 03 section 3).
 *
 * - The settings (working hours per day, days per week, display format, default unit) are the
 *   workspace's: everyone signed in reads them, to parse and show durations; site and
 *   configuration administrators change them. Turned off, estimates and time entries are
 *   refused (409 `time_tracking_disabled`) and existing values stay.
 * - Recording time needs "Record time on tickets". Changing or deleting a time entry needs
 *   "Edit/Delete own time entries" for one's own and "Edit/Delete all time entries" for
 *   others'. Each write keeps the ticket's time spent equal to the sum of its entries and moves
 *   the remaining estimate as asked: automatically, left alone, set, or reduced by an amount.
 * - A time entry can be visible to one role in the track or one group only; its author always
 *   sees it. Hidden entries still count in time spent, as the total is the ticket's.
 * - Every write records history on the ticket (`timeEntry`, `timeSpent`, `remainingEstimate`)
 *   and counts a new ticket version.
 *
 * Every successful mutation emits exactly one domain event in its transaction (ADR-015).
 */
const MAX_INT = 2_147_483_647;
const id = z.coerce.number().int().positive().max(MAX_INT);
const duration = z.union([z.string().max(100), z.number()]);
const remaining = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('auto') }).strict(),
  z.object({ mode: z.literal('leave') }).strict(),
  z.object({ mode: z.literal('set'), value: duration }).strict(),
  z.object({ mode: z.literal('reduce'), value: duration }).strict(),
]);
const visibility = z
  .union([z.object({ roleId: id }).strict(), z.object({ groupId: id }).strict()])
  .nullable();
const instant = z
  .string()
  .max(40)
  .refine((v) => !Number.isNaN(Date.parse(v)), 'an ISO date and time');
const createBody = z
  .object({
    duration,
    startedAt: instant.optional(),
    description: z.string().max(32_000).optional(),
    visibility: visibility.optional(),
    remainingEstimate: remaining.optional(),
  })
  .strict();
const updateBody = z
  .object({
    duration: duration.optional(),
    startedAt: instant.optional(),
    description: z.string().max(32_000).optional(),
    visibility: visibility.optional(),
    remainingEstimate: remaining.optional(),
  })
  .strict();
const deleteQuery = z
  .object({
    remainingEstimate: z.enum(['auto', 'leave', 'set']).default('auto'),
    value: z.string().max(100).optional(),
  })
  .strict();
const listQuery = z
  .object({
    cursor: z.coerce.number().int().positive().max(MAX_INT).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();
const settingsBody = z
  .object({
    enabled: z.boolean(),
    hoursPerDay: z.number().gt(0).max(24).multipleOf(0.01),
    daysPerWeek: z.number().gt(0).max(7).multipleOf(0.01),
    displayFormat: z.enum(DISPLAY_FORMATS),
    defaultUnit: z.enum(DURATION_UNITS),
    copyTransitionComments: z.boolean(),
  })
  .partial()
  .strict();

type Db = Kysely<Database> | Transaction<Database>;

const invalid = (reply: FastifyReply, detail?: string) =>
  reply.code(400).send({ error: 'invalid_request', ...(detail ? { detail } : {}) });
const invalidFields = (reply: FastifyReply, fields: Record<string, string>) =>
  reply.code(400).send({ error: 'invalid_fields', fields });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });
const forbidden = (reply: FastifyReply, permission: TrackPermission) =>
  reply.code(403).send({ error: 'forbidden', permission });

function entryQuery(db: Db) {
  return db
    .selectFrom('time_entry as e')
    .innerJoin('app_user as a', 'a.id', 'e.author_id')
    .select([
      'e.id',
      'e.ticket_id',
      'e.author_id',
      'a.name as author_name',
      'e.started_at',
      'e.duration',
      'e.description',
      'e.visible_role_id',
      'e.visible_group_id',
      'e.created_at',
      'e.updated_at',
    ]);
}
type EntryRow = Awaited<ReturnType<ReturnType<typeof entryQuery>['executeTakeFirstOrThrow']>>;

const entryView = (e: EntryRow) => ({
  id: e.id,
  author: { id: e.author_id, name: e.author_name },
  startedAt: e.started_at.toISOString(),
  duration: e.duration,
  description: e.description,
  visibility:
    e.visible_role_id !== null
      ? { roleId: e.visible_role_id }
      : e.visible_group_id !== null
        ? { groupId: e.visible_group_id }
        : null,
  createdAt: e.created_at.toISOString(),
  updatedAt: e.updated_at.toISOString(),
});

const settingsView = (s: TimeSettings) => ({ ...s });

/** The history row of a time entry: its id and duration, before and after. */
const entryChange = (
  ticketId: number,
  before: { id: number; duration: number } | null,
  after: { id: number; duration: number } | null,
): FieldChange => ({
  ticketId,
  field: 'timeEntry',
  from: before ? `${before.id}:${before.duration}` : null,
  to: after ? `${after.id}:${after.duration}` : null,
  fromDisplay: null,
  toDisplay: null,
});

export function registerTimeRoutes(app: FastifyInstance, db: Kysely<Database>): void {
  const by = (request: FastifyRequest) => ({
    workspaceId: request.workspaceId,
    actorId: request.user?.id ?? null,
  });

  /** The route's ticket: outside the trash, browsable, in a live track; or the refusal. */
  async function routeTicket(request: FastifyRequest, reply: FastifyReply, writing: boolean) {
    const params = z.object({ id: z.string().min(1).max(300) }).safeParse(request.params);
    if (!params.success) {
      await invalid(reply);
      return null;
    }
    const found = await resolveTicket(db, request.workspaceId, params.data.id);
    const row = found ? await loadTicket(db, request.workspaceId, found.id) : undefined;
    if (!row || row.deleted_at || !(await request.authz.seesTicket(row))) {
      await notFound(reply);
      return null;
    }
    if (writing && row.track_archived_at) {
      await reply.code(409).send({ error: 'track_archived' });
      return null;
    }
    return row;
  }

  /** Whether the caller sees an entry: it is open, theirs, or for a role or group they hold. */
  async function visibleTo(request: FastifyRequest, trackId: number) {
    const userId = request.user?.id ?? null;
    let audience: Awaited<ReturnType<typeof request.authz.audience>> | null = null;
    return async (e: EntryRow) => {
      if (e.visible_role_id === null && e.visible_group_id === null) return true;
      if (e.author_id === userId) return true;
      audience ??= await request.authz.audience(trackId);
      return e.visible_role_id !== null
        ? audience.roleIds.has(e.visible_role_id)
        : audience.groupIds.has(e.visible_group_id as number);
    };
  }

  /** A visibility the caller may give: a role of the workspace, or a group they are in. */
  async function checkVisibility(
    request: FastifyRequest,
    trackId: number,
    value: z.infer<typeof visibility> | undefined,
  ): Promise<string | null> {
    if (!value) return null;
    if ('roleId' in value) {
      const role = await db
        .selectFrom('role')
        .select('id')
        .where('id', '=', value.roleId)
        .where('workspace_id', '=', request.workspaceId)
        .executeTakeFirst();
      return role ? null : 'not_found';
    }
    // Only a group one belongs to.
    const audience = await request.authz.audience(trackId);
    return audience.groupIds.has(value.groupId) ? null : 'not_a_member';
  }

  /** Parses a remaining-estimate instruction; problems go into `fields`. */
  function remainingMode(
    value: z.infer<typeof remaining> | undefined,
    settings: TimeSettings,
    fields: Record<string, string>,
  ): RemainingMode {
    if (!value || value.mode === 'auto') return { mode: 'auto' };
    if (value.mode === 'leave') return { mode: 'leave' };
    const parsed = durationValue(value.value, settings);
    if (!parsed.ok || parsed.seconds === null) {
      fields.remainingEstimate = parsed.ok ? 'invalid' : parsed.problem;
      return { mode: 'leave' };
    }
    return { mode: value.mode, seconds: parsed.seconds };
  }

  /** Writes the ticket's new time spent and remaining estimate, with history and an event. */
  async function updateTicket(
    trx: Transaction<Database>,
    request: FastifyRequest,
    before: TicketRow,
    delta: number,
    how: RemainingMode,
    change: FieldChange,
  ) {
    const ws = request.workspaceId;
    await trx
      .updateTable('ticket')
      .set({
        time_spent: sql<number>`time_spent + ${delta}`,
        remaining_estimate: nextRemaining(before.remaining_estimate, delta, how),
        version: before.version + 1,
        updated_at: new Date(),
      })
      .where('id', '=', before.id)
      .execute();
    const after = await loadTicket(trx, ws, before.id);
    if (after) {
      await recordChanges(trx, ws, request.user?.id ?? null, [
        change,
        ...ticketChanges(before, after),
      ]);
    }
    return after;
  }

  /** Locks the ticket for a time write and reads it as it is. */
  async function lockTicket(trx: Transaction<Database>, workspaceId: number, ticketId: number) {
    const locked = await trx
      .selectFrom('ticket')
      .select('id')
      .where('id', '=', ticketId)
      .where('deleted_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    return locked ? loadTicket(trx, workspaceId, ticketId) : undefined;
  }

  // Settings

  app.get('/api/v1/time-tracking', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    return { settings: settingsView(await timeSettings(db, request.workspaceId)) };
  });

  app.patch('/api/v1/time-tracking', async (request, reply) => {
    if (!(await requireGlobal(request, reply, 'site_admin', 'configuration_admin'))) return reply;
    const parsed = settingsBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const body = parsed.data;
    const ws = request.workspaceId;
    const settings = await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('time_tracking_setting')
        .values({ workspace_id: ws })
        .onConflict((oc) => oc.doNothing())
        .execute();
      await trx
        .selectFrom('time_tracking_setting')
        .select('workspace_id')
        .where('workspace_id', '=', ws)
        .forUpdate()
        .execute();
      const current = await timeSettings(trx, ws);
      const changes = diff<Record<string, unknown>>({ ...current }, body);
      if (Object.keys(changes).length === 0) return current;
      await trx
        .updateTable('time_tracking_setting')
        .set({
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          ...(body.hoursPerDay !== undefined ? { hours_per_day: body.hoursPerDay } : {}),
          ...(body.daysPerWeek !== undefined ? { days_per_week: body.daysPerWeek } : {}),
          ...(body.displayFormat !== undefined ? { display_format: body.displayFormat } : {}),
          ...(body.defaultUnit !== undefined ? { default_unit: body.defaultUnit } : {}),
          ...(body.copyTransitionComments !== undefined
            ? { copy_transition_comments: body.copyTransitionComments }
            : {}),
          updated_at: new Date(),
        })
        .where('workspace_id', '=', ws)
        .execute();
      await emit(trx, by(request), {
        type: 'time_tracking.settings_updated',
        subjectId: ws,
        payload: { changes },
      });
      return timeSettings(trx, ws);
    });
    return { settings: settingsView(settings) };
  });

  // Time entries

  app.get('/api/v1/tickets/:id/time-entries', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const ticket = await routeTicket(request, reply, false);
    if (!ticket) return reply;
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success) return invalid(reply);
    const q = parsed.data;
    // Oldest first, in pages by id; hidden entries are left out of the page.
    let query = entryQuery(db).where('e.ticket_id', '=', ticket.id);
    if (q.cursor !== undefined) query = query.where('e.id', '>', q.cursor);
    const rows = await query
      .orderBy('e.id')
      .limit(q.limit + 1)
      .execute();
    const page = rows.slice(0, q.limit);
    const sees = await visibleTo(request, ticket.track_id);
    const entries = [];
    for (const e of page) if (await sees(e)) entries.push(entryView(e));
    return {
      timeEntries: entries,
      next: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  });

  app.post('/api/v1/tickets/:id/time-entries', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const ticket = await routeTicket(request, reply, true);
    if (!ticket) return reply;
    const parsed = createBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const body = parsed.data;
    const ws = request.workspaceId;
    const settings = await timeSettings(db, ws);
    if (!settings.enabled) return reply.code(409).send({ error: 'time_tracking_disabled' });
    if (!(await request.authz.canTicket('record_time', ticket))) {
      return forbidden(reply, 'record_time');
    }
    const fields: Record<string, string> = {};
    const seconds = durationValue(body.duration, settings);
    if (!seconds.ok) fields.duration = seconds.problem;
    else if (!seconds.seconds) fields.duration = 'invalid';
    const how = remainingMode(body.remainingEstimate, settings, fields);
    const visible = await checkVisibility(request, ticket.track_id, body.visibility);
    if (visible) fields.visibility = visible;
    if (Object.keys(fields).length > 0) return invalidFields(reply, fields);
    const durationSeconds = (seconds as { seconds: number }).seconds;
    const startedAt = body.startedAt ? new Date(body.startedAt) : new Date();

    const result = await db.transaction().execute(async (trx) => {
      const current = await lockTicket(trx, ws, ticket.id);
      if (!current) return null;
      if (current.time_spent + durationSeconds > MAX_INT) return { tooLong: true as const };
      const entry = await trx
        .insertInto('time_entry')
        .values({
          workspace_id: ws,
          ticket_id: ticket.id,
          author_id: user.id,
          started_at: startedAt,
          duration: durationSeconds,
          description: body.description ?? '',
          visible_role_id:
            body.visibility && 'roleId' in body.visibility ? body.visibility.roleId : null,
          visible_group_id:
            body.visibility && 'groupId' in body.visibility ? body.visibility.groupId : null,
          created_by: user.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await emit(trx, by(request), {
        type: 'time_entry.created',
        subjectId: entry.id,
        payload: {
          key: ticketKey(current.track_key, current.number),
          ticketId: ticket.id,
          duration: durationSeconds,
          startedAt: startedAt.toISOString(),
        },
      });
      await updateTicket(
        trx,
        request,
        current,
        durationSeconds,
        how,
        entryChange(ticket.id, null, { id: entry.id, duration: durationSeconds }),
      );
      return entryQuery(trx).where('e.id', '=', entry.id).executeTakeFirstOrThrow();
    });
    if (!result) return notFound(reply);
    if ('tooLong' in result) return invalidFields(reply, { duration: 'too_long' });
    return reply.code(201).send({ timeEntry: entryView(result) });
  });

  /** The entry of the route, checked for the caller's own/all permission. */
  async function routeEntry(
    request: FastifyRequest,
    reply: FastifyReply,
    ticket: TicketRow,
    action: 'edit' | 'delete',
  ) {
    const entryId = id.safeParse((request.params as { entryId?: string }).entryId);
    if (!entryId.success) {
      await invalid(reply);
      return null;
    }
    const entry = await entryQuery(db)
      .where('e.id', '=', entryId.data)
      .where('e.ticket_id', '=', ticket.id)
      .executeTakeFirst();
    if (!entry || !(await (await visibleTo(request, ticket.track_id))(entry))) {
      await notFound(reply);
      return null;
    }
    const own = entry.author_id === request.user?.id;
    const permission: TrackPermission = own
      ? action === 'edit'
        ? 'edit_own_time_entries'
        : 'delete_own_time_entries'
      : action === 'edit'
        ? 'edit_all_time_entries'
        : 'delete_all_time_entries';
    // Whoever may change all entries may also change their own.
    const held = await request.authz.ticket(ticket);
    const all = action === 'edit' ? 'edit_all_time_entries' : 'delete_all_time_entries';
    if (!held.has(permission) && !held.has(all)) {
      await forbidden(reply, permission);
      return null;
    }
    return entry;
  }

  app.patch('/api/v1/tickets/:id/time-entries/:entryId', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const ticket = await routeTicket(request, reply, true);
    if (!ticket) return reply;
    const parsed = updateBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const body = parsed.data;
    const ws = request.workspaceId;
    const settings = await timeSettings(db, ws);
    if (!settings.enabled) return reply.code(409).send({ error: 'time_tracking_disabled' });
    const entry = await routeEntry(request, reply, ticket, 'edit');
    if (!entry) return reply;
    const fields: Record<string, string> = {};
    let durationSeconds = entry.duration;
    if (body.duration !== undefined) {
      const seconds = durationValue(body.duration, settings);
      if (!seconds.ok) fields.duration = seconds.problem;
      else if (!seconds.seconds) fields.duration = 'invalid';
      else durationSeconds = seconds.seconds;
    }
    const how = remainingMode(body.remainingEstimate, settings, fields);
    if (body.visibility !== undefined) {
      const visible = await checkVisibility(request, ticket.track_id, body.visibility);
      if (visible) fields.visibility = visible;
    }
    if (Object.keys(fields).length > 0) return invalidFields(reply, fields);

    const result = await db.transaction().execute(async (trx) => {
      const current = await lockTicket(trx, ws, ticket.id);
      if (!current) return null;
      const locked = await trx
        .selectFrom('time_entry')
        .select([
          'id',
          'duration',
          'started_at',
          'description',
          'visible_role_id',
          'visible_group_id',
        ])
        .where('id', '=', entry.id)
        .forUpdate()
        .executeTakeFirst();
      if (!locked) return null;
      const delta = durationSeconds - locked.duration;
      if (current.time_spent + delta > MAX_INT) return { tooLong: true as const };
      const visibilityNow =
        body.visibility === undefined
          ? undefined
          : body.visibility === null
            ? { role: null, group: null }
            : 'roleId' in body.visibility
              ? { role: body.visibility.roleId, group: null }
              : { role: null, group: body.visibility.groupId };
      const changes = diff<Record<string, unknown>>(
        {
          duration: locked.duration,
          startedAt: locked.started_at.toISOString(),
          description: locked.description,
          visibleRoleId: locked.visible_role_id,
          visibleGroupId: locked.visible_group_id,
        },
        {
          duration: durationSeconds,
          startedAt: body.startedAt ? new Date(body.startedAt).toISOString() : undefined,
          description: body.description,
          visibleRoleId: visibilityNow?.role,
          visibleGroupId: visibilityNow?.group,
        },
      );
      if (Object.keys(changes).length === 0) return { id: entry.id };
      await trx
        .updateTable('time_entry')
        .set({
          duration: durationSeconds,
          ...(body.startedAt ? { started_at: new Date(body.startedAt) } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(visibilityNow
            ? { visible_role_id: visibilityNow.role, visible_group_id: visibilityNow.group }
            : {}),
          updated_at: new Date(),
        })
        .where('id', '=', entry.id)
        .execute();
      // Description and visibility hold no data the event needs to repeat.
      await emit(trx, by(request), {
        type: 'time_entry.updated',
        subjectId: entry.id,
        payload: {
          key: ticketKey(current.track_key, current.number),
          ticketId: ticket.id,
          fields: Object.keys(changes),
        },
      });
      await updateTicket(
        trx,
        request,
        current,
        delta,
        // An entry changed without a new duration leaves the estimate alone.
        delta === 0 && how.mode === 'auto' ? { mode: 'leave' } : how,
        entryChange(
          ticket.id,
          { id: entry.id, duration: locked.duration },
          { id: entry.id, duration: durationSeconds },
        ),
      );
      return { id: entry.id };
    });
    if (!result) return notFound(reply);
    if ('tooLong' in result) return invalidFields(reply, { duration: 'too_long' });
    const row = await entryQuery(db).where('e.id', '=', result.id).executeTakeFirstOrThrow();
    return { timeEntry: entryView(row) };
  });

  app.delete('/api/v1/tickets/:id/time-entries/:entryId', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const ticket = await routeTicket(request, reply, true);
    if (!ticket) return reply;
    const parsed = deleteQuery.safeParse(request.query);
    if (!parsed.success) return invalid(reply);
    const ws = request.workspaceId;
    const settings = await timeSettings(db, ws);
    if (!settings.enabled) return reply.code(409).send({ error: 'time_tracking_disabled' });
    const entry = await routeEntry(request, reply, ticket, 'delete');
    if (!entry) return reply;
    const fields: Record<string, string> = {};
    const how =
      parsed.data.remainingEstimate === 'set'
        ? remainingMode({ mode: 'set', value: parsed.data.value ?? '' }, settings, fields)
        : ({ mode: parsed.data.remainingEstimate } as RemainingMode);
    if (Object.keys(fields).length > 0) return invalidFields(reply, fields);

    const removed = await db.transaction().execute(async (trx) => {
      const current = await lockTicket(trx, ws, ticket.id);
      if (!current) return false;
      const row = await trx
        .deleteFrom('time_entry')
        .where('id', '=', entry.id)
        .returning(['id', 'duration'])
        .executeTakeFirst();
      if (!row) return false;
      await emit(trx, by(request), {
        type: 'time_entry.deleted',
        subjectId: row.id,
        payload: {
          key: ticketKey(current.track_key, current.number),
          ticketId: ticket.id,
          duration: row.duration,
        },
      });
      // "auto" gives the time back to the remaining estimate.
      await updateTicket(
        trx,
        request,
        current,
        -row.duration,
        how,
        entryChange(ticket.id, row, null),
      );
      return true;
    });
    if (!removed) return notFound(reply);
    return reply.code(204).send();
  });
}
