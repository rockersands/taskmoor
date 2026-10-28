import type { Database, JsonValue } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, sql, type Transaction, type Updateable } from 'kysely';
import { z } from 'zod';
import { requireUser } from '../auth';
import type { Authorizer } from '../authz/authorizer';
import type { TrackPermission } from '../authz/permissions';
import { diff, emit } from '../events/bus';
import { shareHierarchy } from '../tickets/configuration';
import {
  AREAS_PER_TICKET,
  areaDefaultAssignee,
  checkLabels,
  holdValues,
  placementOf,
  RELEASES_PER_TICKET,
  rememberLabels,
  sameIds,
  setTicketAreas,
  setTicketReleases,
  trackPrioritySet,
} from '../tickets/fields';
import { DEFAULT_PARENT_RULES, parentLevelAllowed, SUBTICKET_RANK } from '../tickets/hierarchy';
import { changesOf, recordChanges, ticketChanges } from '../tickets/history';
import {
  canonicalJson,
  checkRichText,
  isCalendarDay,
  SUMMARY_MAX,
  ticketKey,
} from '../tickets/model';
import { keyBetween } from '../tickets/rank';
import {
  bottomRank,
  inTracks,
  loadTicket,
  loadTickets,
  nextNumber,
  resolveTicket,
  resolveTrack,
  type TicketRow,
  ticketQuery,
  ticketView,
} from '../tickets/store';

/**
 * Tickets (M1-008; CORE-001, CORE-008, CORE-023, CORE-025, AGL-009; spec 01a sections 1.2 and
 * 1.3).
 *
 * - A ticket is found by id or by key, ignoring case; an old key (an earlier track key, or the
 *   number a ticket had before a move) answers with the ticket and a redirect to its key now.
 * - Everyone who may browse a track sees its tickets. A parent in a track the viewer may not
 *   browse shows only its id (rule 5).
 * - Creating needs "Create tickets"; setting an assignee "Assign tickets" (and the assignee
 *   "Assignable user"); naming another requester "Modify requester"; dates "Schedule tickets".
 *   Editing needs the same per field, with "Edit tickets" for summary, rich text, type and
 *   parent. Errors in values answer 400 `invalid_fields` with a reason per field (CORE-008 (3)).
 * - Levels (spec 01a section 1.2): a parent sits one level up, a subticket always has one in
 *   its own track and moves with it. Writes that check levels hold the workspace's hierarchy
 *   lock shared, and the track and type set they rely on, so neither can change before commit.
 * - New tickets take the next number of their track and go to the bottom of the global rank;
 *   `PUT .../rank` moves one before or after another ticket, or to the top or bottom (AGL-009).
 * - Moving to another track gives the ticket and its subtickets new numbers there; their old
 *   keys keep resolving (CORE-023 (3)). It needs "Move tickets" in the source and "Create
 *   tickets" in the target.
 * - Deleting sends the ticket and its subtickets to the trash; children above that level lose
 *   the link and get it back on restore (CORE-025 (3)). Both need "Delete tickets"; only those
 *   who may restore a ticket see it in the trash.
 * - Priority, close reason, labels, releases and areas (M1-014, CORE-014 to CORE-017): a new
 *   ticket takes its track's default priority, and the assignee its areas' rule names when it
 *   has none. A priority must be one the track's priority set offers; releases and areas must
 *   be the track's own and not archived (a ticket keeps one it has). Setting a close reason
 *   needs "Set close reason"; the rest "Edit tickets". Moving drops releases and areas, which
 *   belong to the old track.
 * - A ticket in an archived track is read-only (409 `track_archived`).
 * - `version` counts changes; a write that names the version it read fails with 409
 *   `version_conflict` when someone else saved in between.
 *
 * Every successful mutation emits exactly one domain event in its transaction (ADR-015).
 */
const MAX_INT = 2_147_483_647;
const idValue = z.number().int().positive().max(MAX_INT);
/** A ticket or a track: its id, or a key. */
const ref = z.union([idValue, z.string().trim().min(1).max(300)]);
const day = z.string().nullable();
const labels = z.array(z.string().max(1000)).max(1000);
const releaseIds = z.array(idValue).max(RELEASES_PER_TICKET);
const areaIds = z.array(idValue).max(AREAS_PER_TICKET);

const createBody = z
  .object({
    track: ref,
    ticketTypeId: idValue.optional(),
    summary: z.string().optional(),
    description: z.unknown().optional(),
    environment: z.unknown().optional(),
    parent: ref.nullable().optional(),
    assigneeId: idValue.nullable().optional(),
    requesterId: idValue.optional(),
    startDate: day.optional(),
    dueDate: day.optional(),
    priorityId: idValue.nullable().optional(),
    closeReasonId: idValue.nullable().optional(),
    labels: labels.optional(),
    targetReleaseIds: releaseIds.optional(),
    foundInReleaseIds: releaseIds.optional(),
    areaIds: areaIds.optional(),
  })
  .strict();
const updateBody = z
  .object({
    ticketTypeId: idValue.optional(),
    summary: z.string().optional(),
    description: z.unknown().optional(),
    environment: z.unknown().optional(),
    parent: ref.nullable().optional(),
    assigneeId: idValue.nullable().optional(),
    requesterId: idValue.optional(),
    startDate: day.optional(),
    dueDate: day.optional(),
    priorityId: idValue.nullable().optional(),
    closeReasonId: idValue.nullable().optional(),
    labels: labels.optional(),
    targetReleaseIds: releaseIds.optional(),
    foundInReleaseIds: releaseIds.optional(),
    areaIds: areaIds.optional(),
    version: idValue.optional(),
  })
  .strict();
const moveBody = z
  .object({
    track: ref,
    ticketTypeId: idValue.optional(),
    subticketTypeId: idValue.optional(),
    parent: ref.nullable().optional(),
    version: idValue.optional(),
  })
  .strict();
const rankBody = z
  .object({
    before: ref.optional(),
    after: ref.optional(),
    position: z.enum(['top', 'bottom']).optional(),
  })
  .strict()
  .refine(
    (b) => [b.before, b.after, b.position].filter((v) => v !== undefined).length === 1,
    'exactly one of before, after and position',
  );
const listQuery = z
  .object({
    track: z.string().min(1).max(300).optional(),
    parent: z.string().min(1).max(300).optional(),
    after: z.string().min(1).max(2000).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
const trashQuery = z
  .object({
    track: z.string().min(1).max(300).optional(),
    after: z
      .string()
      .regex(/^\d{1,15}\.\d{1,10}$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
const historyQuery = z
  .object({
    order: z.enum(['desc', 'asc']).default('desc'),
    cursor: z
      .string()
      .regex(/^[1-9][0-9]{0,18}$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(100),
  })
  .strict();
const params = z.object({ id: z.string().min(1).max(300) });

type Db = Kysely<Database> | Transaction<Database>;
type FieldErrors = Record<string, string>;

/** The body's shape problems, one reason per field. */
function shapeErrors(error: z.ZodError): FieldErrors {
  const fields: FieldErrors = {};
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) fields[key] = 'unknown';
    } else {
      fields[String(issue.path[0] ?? 'body')] ??= 'invalid';
    }
  }
  return fields;
}

const invalid = (reply: FastifyReply) => reply.code(400).send({ error: 'invalid_request' });
const invalidFields = (reply: FastifyReply, fields: FieldErrors) =>
  reply.code(400).send({ error: 'invalid_fields', fields });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });
const forbidden = (reply: FastifyReply, permission: TrackPermission) =>
  reply.code(403).send({ error: 'forbidden', permission });

interface ContentInput {
  summary?: string | undefined;
  description?: unknown;
  environment?: unknown;
  startDate?: string | null | undefined;
  dueDate?: string | null | undefined;
  labels?: string[] | undefined;
}
interface ContentValues {
  summary?: string;
  description?: JsonValue | null;
  environment?: JsonValue | null;
  startDate?: string | null;
  dueDate?: string | null;
  labels?: string[];
}

/** Checks the plain values of a create or edit; problems go into `fields`. */
function contentValues(body: ContentInput, fields: FieldErrors, creating: boolean): ContentValues {
  const out: ContentValues = {};
  if (body.summary !== undefined || creating) {
    const summary = (body.summary ?? '').trim();
    if (summary === '') fields.summary = 'required';
    else if ([...summary].length > SUMMARY_MAX) fields.summary = 'too_long';
    else if (/[\r\n]/.test(summary)) fields.summary = 'invalid';
    else out.summary = summary;
  }
  for (const name of ['description', 'environment'] as const) {
    if (body[name] === undefined) continue;
    const checked = checkRichText(body[name]);
    if (checked.ok) out[name] = checked.doc;
    else fields[name] = checked.problem;
  }
  for (const name of ['startDate', 'dueDate'] as const) {
    const value = body[name];
    if (value === undefined) continue;
    if (value !== null && !isCalendarDay(value)) fields[name] = 'invalid';
    else out[name] = value;
  }
  if (body.labels !== undefined) {
    const checked = checkLabels(body.labels);
    if (checked.ok) out.labels = checked.labels;
    else fields.labels = checked.problem;
  }
  return out;
}

interface ValueInput {
  priorityId?: number | null | undefined;
  closeReasonId?: number | null | undefined;
  targetReleaseIds?: number[] | undefined;
  foundInReleaseIds?: number[] | undefined;
  areaIds?: number[] | undefined;
}

/**
 * Checks the priority, close reason, releases and areas a write gives against the values
 * held for it; `current` is the ticket as it is (null for a new one). Problems go into
 * `fields`.
 */
function valueProblems(
  body: ValueInput,
  held: Awaited<ReturnType<typeof holdValues>>,
  offered: { priorityIds: Set<number> } | null,
  trackId: number,
  current: TicketRow | null,
  fields: FieldErrors,
): void {
  if (body.priorityId != null && body.priorityId !== current?.priority_id) {
    if (!held.priority) fields.priorityId = 'not_found';
    else if (!offered?.priorityIds.has(body.priorityId)) fields.priorityId = 'not_in_track';
  }
  if (body.closeReasonId != null && !held.closeReason) fields.closeReasonId = 'not_found';
  const lists = [
    ['targetReleaseIds', held.releases, current?.target_releases],
    ['foundInReleaseIds', held.releases, current?.found_releases],
    ['areaIds', held.areas, current?.areas],
  ] as const;
  for (const [name, values, had] of lists) {
    const ids = body[name];
    if (ids === undefined) continue;
    const problem = placementOf(
      values,
      trackId,
      ids,
      (had ?? []).map((v) => v.id),
    );
    if (problem) fields[name] = problem;
  }
}

/** The level rank of each ticket type named. */
async function typeLevels(
  db: Db,
  workspaceId: number,
  typeIds: readonly number[],
): Promise<Map<number, number>> {
  if (typeIds.length === 0) return new Map();
  const rows = await db
    .selectFrom('ticket_type as ty')
    .innerJoin('hierarchy_level as l', 'l.id', 'ty.level_id')
    .select(['ty.id', 'l.rank'])
    .where('ty.workspace_id', '=', workspaceId)
    .where('ty.id', 'in', [...new Set(typeIds)])
    .execute();
  return new Map(rows.map((r) => [r.id, r.rank]));
}

/**
 * The ticket types a track offers, with the track and its type set held (key share) until the
 * transaction ends: a type set change or a switch of set waits for this write, and then counts
 * the ticket it wrote.
 */
async function offeredTypes(trx: Transaction<Database>, workspaceId: number, trackId: number) {
  const track = await trx
    .selectFrom('track')
    .select(['key', 'type_set_id', 'archived_at'])
    .where('id', '=', trackId)
    .where('workspace_id', '=', workspaceId)
    .forKeyShare()
    .executeTakeFirst();
  if (!track) return null;
  const offered = {
    key: track.key,
    archived: track.archived_at !== null,
    defaultTypeId: null as number | null,
    typeIds: new Set<number>(),
  };
  if (track.type_set_id === null) return offered;
  const set = await trx
    .selectFrom('type_set')
    .select('default_type_id')
    .where('id', '=', track.type_set_id)
    .forKeyShare()
    .executeTakeFirstOrThrow();
  const members = await trx
    .selectFrom('type_set_member')
    .select('ticket_type_id')
    .where('type_set_id', '=', track.type_set_id)
    .execute();
  offered.defaultTypeId = set.default_type_id;
  for (const m of members) offered.typeIds.add(m.ticket_type_id);
  return offered;
}

/** A live parent, held (share) so it cannot change type, move or go to the trash first. */
function lockParent(trx: Transaction<Database>, workspaceId: number, parentId: number) {
  return trx
    .selectFrom('ticket')
    .select(['id', 'track_id', 'ticket_type_id'])
    .where('id', '=', parentId)
    .where('workspace_id', '=', workspaceId)
    .where('deleted_at', 'is', null)
    .forShare()
    .executeTakeFirst();
}

/**
 * Why a ticket at `rank` in `trackId` may not sit under a parent at `parentRank` in
 * `parentTrackId` (null: no parent), or null when it may (spec 01a section 1.2 rules 4 and 6).
 */
function placementProblem(
  rank: number | undefined,
  parent: { rank: number | undefined; trackId: number } | null,
  trackId: number,
): 'required' | 'wrong_level' | 'other_track' | null {
  if (rank === undefined) return 'wrong_level';
  if (parent === null) return rank === SUBTICKET_RANK ? 'required' : null;
  if (parent.rank === undefined || !parentLevelAllowed(rank, parent.rank, DEFAULT_PARENT_RULES)) {
    return 'wrong_level';
  }
  // A subticket lives in its parent's track and moves with it.
  return rank === SUBTICKET_RANK && parent.trackId !== trackId ? 'other_track' : null;
}

function uniqueViolation(error: unknown): string | null {
  const e = error as { code?: string; constraint?: string };
  return e.code === '23505' ? (e.constraint ?? '') : null;
}

type Outcome =
  | { ticket: TicketRow | undefined }
  | { missing: true }
  | { fields: FieldErrors }
  | { conflict: string; detail?: Record<string, unknown> }
  | { denied: TrackPermission }
  | { versionConflict: true };

export function registerTicketRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  authorizer: Authorizer,
): void {
  const by = (request: FastifyRequest) => ({
    workspaceId: request.workspaceId,
    actorId: request.user?.id ?? null,
  });
  const actor = (request: FastifyRequest) => request.user?.id ?? null;

  /** A ticket the caller may browse, trash included, by id or key. */
  async function findTicket(request: FastifyRequest, ticketRef: string | number) {
    const ws = request.workspaceId;
    const found = await resolveTicket(db, ws, ticketRef);
    if (!found) return null;
    const row = await loadTicket(db, ws, found.id);
    if (!row || !(await request.authz.can('browse_track', row.track_id))) return null;
    return { row, asked: found.asked };
  }

  async function viewOf(request: FastifyRequest, row: TicketRow) {
    const parentVisible =
      row.parent_track_id === null ||
      (await request.authz.can('browse_track', row.parent_track_id));
    return ticketView(row, parentVisible);
  }

  /** A ticket in the trash exists only for those who may restore it. */
  async function inTrash(request: FastifyRequest, reply: FastifyReply, row: TicketRow) {
    return (await request.authz.can('delete_tickets', row.track_id))
      ? reply.code(409).send({ error: 'in_trash' })
      : notFound(reply);
  }

  async function activeUser(workspaceId: number, userId: number): Promise<boolean> {
    const row = await db
      .selectFrom('app_user')
      .select('id')
      .where('id', '=', userId)
      .where('workspace_id', '=', workspaceId)
      .where('deactivated_at', 'is', null)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** Active, and holding "Assignable user" in the track. */
  async function assignable(workspaceId: number, trackId: number, userId: number) {
    if (!(await activeUser(workspaceId, userId))) return false;
    return (await authorizer.trackPermissions(workspaceId, { userId }, trackId)).has(
      'assignable_user',
    );
  }

  /** Answers an outcome that is not a ticket; null when it is one. */
  function refusal(reply: FastifyReply, outcome: Outcome) {
    if ('missing' in outcome) return notFound(reply);
    if ('fields' in outcome) return invalidFields(reply, outcome.fields);
    if ('conflict' in outcome) {
      return reply.code(409).send({ error: outcome.conflict, ...(outcome.detail ?? {}) });
    }
    if ('denied' in outcome) return forbidden(reply, outcome.denied);
    if ('versionConflict' in outcome) return reply.code(409).send({ error: 'version_conflict' });
    if (!outcome.ticket) return notFound(reply);
    return null;
  }

  async function answer(
    request: FastifyRequest,
    reply: FastifyReply,
    outcome: Outcome,
    code = 200,
  ) {
    const refused = refusal(reply, outcome);
    if (refused) return refused;
    const row = (outcome as { ticket: TicketRow }).ticket;
    return reply.code(code).send({ ticket: await viewOf(request, row) });
  }

  app.get('/api/v1/tickets', async (request, reply) => {
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success) return invalid(reply);
    const q = parsed.data;
    const ws = request.workspaceId;
    const browse = await request.authz.allowedTracks('browse_track');
    if (browse !== 'all' && browse.length === 0) return { tickets: [], next: null };
    let query = ticketQuery(db, ws).where('k.deleted_at', 'is', null);
    if (browse !== 'all') query = query.where('k.track_id', 'in', browse);
    if (q.track !== undefined) {
      const trackId = await resolveTrack(db, ws, q.track);
      if (trackId === null || !inTracks(browse, trackId)) return notFound(reply);
      query = query.where('k.track_id', '=', trackId);
    }
    if (q.parent !== undefined) {
      const parent = await findTicket(request, q.parent);
      if (!parent || parent.row.deleted_at) return notFound(reply);
      query = query.where('k.parent_id', '=', parent.row.id);
    }
    if (q.after !== undefined) query = query.where('k.rank', '>', q.after);
    const rows = await query
      .orderBy('k.rank')
      .limit(q.limit + 1)
      .execute();
    const page = rows.slice(0, q.limit);
    return {
      tickets: page.map((r) =>
        ticketView(r, r.parent_track_id === null || inTracks(browse, r.parent_track_id)),
      ),
      next: rows.length > q.limit ? (page[page.length - 1]?.rank ?? null) : null,
    };
  });

  app.get('/api/v1/tickets/:id', async (request, reply) => {
    const p = params.safeParse(request.params);
    if (!p.success) return invalid(reply);
    const found = await findTicket(request, p.data.id);
    if (!found) return notFound(reply);
    if (found.row.deleted_at && !(await request.authz.can('delete_tickets', found.row.track_id))) {
      return notFound(reply);
    }
    const ticket = await viewOf(request, found.row);
    return {
      ticket,
      ...(found.asked !== null && found.asked !== ticket.key
        ? { redirect: { from: found.asked, to: ticket.key } }
        : {}),
    };
  });

  // A ticket's change history (CORE-022), newest first unless asked otherwise, page by page:
  // each page reads one partition through the primary key, however long the history is.
  app.get('/api/v1/tickets/:id/history', async (request, reply) => {
    const p = params.safeParse(request.params);
    const parsed = historyQuery.safeParse(request.query);
    if (!p.success || !parsed.success) return invalid(reply);
    const q = parsed.data;
    const found = await findTicket(request, p.data.id);
    if (!found) return notFound(reply);
    if (found.row.deleted_at && !(await request.authz.can('delete_tickets', found.row.track_id))) {
      return notFound(reply);
    }
    let query = db
      .selectFrom('ticket_change as c')
      .leftJoin('app_user as u', 'u.id', 'c.actor_id')
      .select([
        'c.id',
        'c.change_set',
        'c.at',
        'c.actor_id',
        'u.name as actor_name',
        'c.field',
        'c.from_value',
        'c.to_value',
        'c.from_display',
        'c.to_display',
      ])
      .where('c.ticket_id', '=', found.row.id)
      .where('c.workspace_id', '=', request.workspaceId);
    if (q.cursor !== undefined) {
      query = query.where('c.id', q.order === 'desc' ? '<' : '>', q.cursor);
    }
    const rows = await query
      .orderBy('c.id', q.order)
      .limit(q.limit + 1)
      .execute();
    const page = rows.slice(0, q.limit);
    return {
      changes: page.map((c) => ({
        id: c.id,
        changeSet: c.change_set,
        at: c.at.toISOString(),
        actor: c.actor_id === null ? null : { id: c.actor_id, name: c.actor_name ?? '' },
        field: c.field,
        from: { value: c.from_value, display: c.from_display },
        to: { value: c.to_value, display: c.to_display },
      })),
      next: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  });

  // The trash: tickets the caller may restore, most recently deleted first (CORE-025 (3)).
  app.get('/api/v1/trash', async (request, reply) => {
    const parsed = trashQuery.safeParse(request.query);
    if (!parsed.success) return invalid(reply);
    const q = parsed.data;
    const ws = request.workspaceId;
    const allowed = await request.authz.allowedTracks('delete_tickets');
    if (allowed !== 'all' && allowed.length === 0) return { tickets: [], next: null };
    let query = ticketQuery(db, ws).where('k.deleted_at', 'is not', null);
    if (allowed !== 'all') query = query.where('k.track_id', 'in', allowed);
    if (q.track !== undefined) {
      const trackId = await resolveTrack(db, ws, q.track);
      if (trackId === null || !inTracks(allowed, trackId)) return notFound(reply);
      query = query.where('k.track_id', '=', trackId);
    }
    if (q.after !== undefined) {
      const [ms, id] = q.after.split('.').map(Number) as [number, number];
      query = query.where(
        sql<boolean>`(k.deleted_at, k.id) < (${new Date(ms)}::timestamptz, ${id}::int)`,
      );
    }
    const rows = await query
      .orderBy('k.deleted_at', 'desc')
      .orderBy('k.id', 'desc')
      .limit(q.limit + 1)
      .execute();
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    const browse = await request.authz.allowedTracks('browse_track');
    return {
      tickets: page.map((r) =>
        ticketView(r, r.parent_track_id === null || inTracks(browse, r.parent_track_id)),
      ),
      next:
        rows.length > q.limit && last?.deleted_at
          ? `${last.deleted_at.getTime()}.${last.id}`
          : null,
    };
  });

  app.post('/api/v1/tickets', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const parsed = createBody.safeParse(request.body);
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const body = parsed.data;
    const ws = request.workspaceId;
    const trackId = await resolveTrack(db, ws, body.track);
    if (trackId === null || !(await request.authz.can('browse_track', trackId))) {
      return invalidFields(reply, { track: 'not_found' });
    }
    const held = await request.authz.track(trackId);
    const track = await db
      .selectFrom('track')
      .select('archived_at')
      .where('id', '=', trackId)
      .executeTakeFirstOrThrow();
    if (track.archived_at) return reply.code(409).send({ error: 'track_archived' });
    if (!held.has('create_tickets')) return forbidden(reply, 'create_tickets');
    if (body.assigneeId != null && !held.has('assign_tickets')) {
      return forbidden(reply, 'assign_tickets');
    }
    const requesterId = body.requesterId ?? user.id;
    if (requesterId !== user.id && !held.has('modify_requester')) {
      return forbidden(reply, 'modify_requester');
    }
    if ((body.startDate != null || body.dueDate != null) && !held.has('schedule_tickets')) {
      return forbidden(reply, 'schedule_tickets');
    }
    if (body.closeReasonId != null && !held.has('set_close_reason')) {
      return forbidden(reply, 'set_close_reason');
    }
    const fields: FieldErrors = {};
    const values = contentValues(body, fields, true);
    if (body.assigneeId != null && !(await assignable(ws, trackId, body.assigneeId))) {
      fields.assigneeId = 'not_assignable';
    }
    if (requesterId !== user.id && !(await activeUser(ws, requesterId))) {
      fields.requesterId = 'not_found';
    }
    let parentId: number | null = null;
    if (body.parent != null) {
      const parent = await findTicket(request, body.parent);
      if (!parent || parent.row.deleted_at) fields.parent = 'not_found';
      else parentId = parent.row.id;
    }
    if (Object.keys(fields).length > 0) return invalidFields(reply, fields);

    const outcome = await db.transaction().execute(async (trx): Promise<Outcome> => {
      await shareHierarchy(trx, ws);
      const offered = await offeredTypes(trx, ws, trackId);
      if (!offered) return { missing: true };
      if (offered.archived) return { conflict: 'track_archived' };
      const typeId = body.ticketTypeId ?? offered.defaultTypeId;
      if (typeId === null) return { fields: { ticketTypeId: 'required' } };
      if (!offered.typeIds.has(typeId)) return { fields: { ticketTypeId: 'not_in_track' } };
      // The track's default priority unless one is given (CORE-014 (2)). Values are held
      // before any ticket, as their deletions lock them before their tickets.
      const prioritySet = await trackPrioritySet(trx, ws, trackId);
      const pointed = await holdValues(trx, ws, {
        priorityId:
          body.priorityId === undefined ? prioritySet?.defaultPriorityId : body.priorityId,
        closeReasonId: body.closeReasonId,
        releaseIds: [...(body.targetReleaseIds ?? []), ...(body.foundInReleaseIds ?? [])],
        areaIds: body.areaIds,
      });
      const problems: FieldErrors = {};
      valueProblems(body, pointed, prioritySet, trackId, null, problems);
      if (Object.keys(problems).length > 0) return { fields: problems };
      const priorityId =
        body.priorityId !== undefined
          ? body.priorityId
          : pointed.priority
            ? (prioritySet?.defaultPriorityId ?? null)
            : null;
      const parent = parentId === null ? null : await lockParent(trx, ws, parentId);
      if (parentId !== null && !parent) return { fields: { parent: 'not_found' } };
      const levels = await typeLevels(trx, ws, [
        typeId,
        ...(parent ? [parent.ticket_type_id] : []),
      ]);
      const problem = placementProblem(
        levels.get(typeId),
        parent ? { rank: levels.get(parent.ticket_type_id), trackId: parent.track_id } : null,
        trackId,
      );
      if (problem) return { fields: { parent: problem } };
      // No assignee given: the first of its areas whose rule names someone (CORE-015 (1)).
      let assigneeId = body.assigneeId ?? null;
      if (body.assigneeId === undefined && body.areaIds !== undefined) {
        const candidate = await areaDefaultAssignee(trx, trackId, body.areaIds);
        if (candidate !== null && (await assignable(ws, trackId, candidate))) {
          assigneeId = candidate;
        }
      }
      const number = await nextNumber(trx, ws, trackId);
      const row = await trx
        .insertInto('ticket')
        .values({
          workspace_id: ws,
          track_id: trackId,
          number,
          ticket_type_id: typeId,
          parent_id: parentId,
          summary: values.summary as string,
          description: values.description == null ? null : JSON.stringify(values.description),
          environment: values.environment == null ? null : JSON.stringify(values.environment),
          assignee_id: assigneeId,
          requester_id: requesterId,
          creator_id: user.id,
          start_date: values.startDate ?? null,
          due_date: values.dueDate ?? null,
          rank: await bottomRank(trx),
          priority_id: priorityId,
          close_reason_id: body.closeReasonId ?? null,
          labels: values.labels ?? [],
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await setTicketReleases(trx, ws, row.id, 'target', body.targetReleaseIds ?? []);
      await setTicketReleases(trx, ws, row.id, 'found', body.foundInReleaseIds ?? []);
      await setTicketAreas(trx, ws, row.id, body.areaIds ?? []);
      await rememberLabels(trx, ws, values.labels ?? []);
      await emit(trx, by(request), {
        type: 'ticket.created',
        subjectId: row.id,
        payload: { key: ticketKey(offered.key, number), trackId, ticketTypeId: typeId, parentId },
      });
      const created = await loadTicket(trx, ws, row.id);
      // Every starting value is history too, so "was" finds the first one (ADR-010).
      if (created) await recordChanges(trx, ws, user.id, ticketChanges(null, created));
      return { ticket: created };
    });
    return answer(request, reply, outcome, 201);
  });

  app.patch('/api/v1/tickets/:id', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = params.safeParse(request.params);
    if (!p.success) return invalid(reply);
    const parsed = updateBody.safeParse(request.body);
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const body = parsed.data;
    const ws = request.workspaceId;
    const found = await findTicket(request, p.data.id);
    if (!found) return notFound(reply);
    if (found.row.deleted_at) return inTrash(request, reply, found.row);
    if (found.row.track_archived_at) return reply.code(409).send({ error: 'track_archived' });
    const ticketId = found.row.id;
    const fields: FieldErrors = {};
    const values = contentValues(body, fields, false);
    let parentId: number | null | undefined;
    if (body.parent === null) parentId = null;
    else if (body.parent !== undefined) {
      const parent = await findTicket(request, body.parent);
      if (!parent || parent.row.deleted_at) fields.parent = 'not_found';
      else if (parent.row.id === ticketId) fields.parent = 'self';
      else parentId = parent.row.id;
    }
    if (Object.keys(fields).length > 0) return invalidFields(reply, fields);

    const outcome = await db.transaction().execute(async (trx): Promise<Outcome> => {
      // Locks in the order every writer takes them: the hierarchy, the track and its type set,
      // then tickets. A type set change holds its set and then rewrites tickets.
      const structural = body.ticketTypeId !== undefined || body.parent !== undefined;
      if (structural) await shareHierarchy(trx, ws);
      const offered =
        body.ticketTypeId !== undefined ? await offeredTypes(trx, ws, found.row.track_id) : null;
      const pointed = await holdValues(trx, ws, {
        priorityId: body.priorityId,
        closeReasonId: body.closeReasonId,
        releaseIds: [...(body.targetReleaseIds ?? []), ...(body.foundInReleaseIds ?? [])],
        areaIds: body.areaIds,
      });
      const locked = await trx
        .selectFrom('ticket')
        .select('id')
        .where('id', '=', ticketId)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      const current = locked ? await loadTicket(trx, ws, ticketId) : undefined;
      if (!current) return { missing: true };
      if (current.track_id !== found.row.track_id) return { conflict: 'moved_meanwhile' };
      if (body.version !== undefined && body.version !== current.version) {
        return { versionConflict: true };
      }
      // Rich text that reads the same is no change, whatever order its keys are stored in.
      for (const name of ['description', 'environment'] as const) {
        if (
          values[name] !== undefined &&
          canonicalJson(values[name]) === canonicalJson(current[name])
        ) {
          delete values[name];
        }
      }
      // Releases and areas compare as sets: the view lists them in its own order.
      const had = {
        targetReleaseIds: current.target_releases.map((r) => r.id),
        foundInReleaseIds: current.found_releases.map((r) => r.id),
        areaIds: current.areas.map((a) => a.id),
      };
      const lists: Partial<Record<keyof typeof had, number[]>> = {};
      for (const name of Object.keys(had) as (keyof typeof had)[]) {
        const ids = body[name];
        if (ids !== undefined && !sameIds(ids, had[name])) lists[name] = [...new Set(ids)];
      }
      const before = {
        summary: current.summary,
        description: current.description,
        environment: current.environment,
        ticketTypeId: current.ticket_type_id,
        parentId: current.parent_id,
        assigneeId: current.assignee_id,
        requesterId: current.requester_id,
        startDate: current.start_date,
        dueDate: current.due_date,
        priorityId: current.priority_id,
        closeReasonId: current.close_reason_id,
        labels: current.labels,
        ...had,
      };
      const changes = diff<Record<string, unknown>>(before, {
        ...values,
        ticketTypeId: body.ticketTypeId,
        parentId,
        assigneeId: body.assigneeId,
        requesterId: body.requesterId,
        priorityId: body.priorityId,
        closeReasonId: body.closeReasonId,
        ...lists,
      });
      if (Object.keys(changes).length === 0) return { ticket: current };

      // Each changed field needs its own permission.
      const held = await request.authz.track(current.track_id);
      const needs: [string, TrackPermission][] = [
        ['summary', 'edit_tickets'],
        ['description', 'edit_tickets'],
        ['environment', 'edit_tickets'],
        ['ticketTypeId', 'edit_tickets'],
        ['parentId', 'edit_tickets'],
        ['assigneeId', 'assign_tickets'],
        ['requesterId', 'modify_requester'],
        ['startDate', 'schedule_tickets'],
        ['dueDate', 'schedule_tickets'],
        ['priorityId', 'edit_tickets'],
        ['closeReasonId', 'set_close_reason'],
        ['labels', 'edit_tickets'],
        ['targetReleaseIds', 'edit_tickets'],
        ['foundInReleaseIds', 'edit_tickets'],
        ['areaIds', 'edit_tickets'],
      ];
      for (const [field, permission] of needs) {
        if (changes[field] && !held.has(permission)) return { denied: permission };
      }
      if (changes.priorityId || changes.closeReasonId || Object.keys(lists).length > 0) {
        const problems: FieldErrors = {};
        const prioritySet =
          changes.priorityId && body.priorityId != null
            ? await trackPrioritySet(trx, ws, current.track_id)
            : null;
        valueProblems(
          {
            ...(changes.priorityId ? { priorityId: body.priorityId } : {}),
            ...(changes.closeReasonId ? { closeReasonId: body.closeReasonId } : {}),
            ...lists,
          },
          pointed,
          prioritySet,
          current.track_id,
          current,
          problems,
        );
        if (Object.keys(problems).length > 0) return { fields: problems };
      }
      if (
        changes.assigneeId &&
        body.assigneeId != null &&
        !(await assignable(ws, current.track_id, body.assigneeId))
      ) {
        return { fields: { assigneeId: 'not_assignable' } };
      }
      if (changes.requesterId && body.requesterId !== undefined) {
        if (!(await activeUser(ws, body.requesterId)))
          return { fields: { requesterId: 'not_found' } };
      }

      const typeId = body.ticketTypeId ?? current.ticket_type_id;
      const newParentId = parentId === undefined ? current.parent_id : parentId;
      if (changes.ticketTypeId || changes.parentId) {
        if (changes.ticketTypeId && !offered?.typeIds.has(typeId)) {
          return { fields: { ticketTypeId: 'not_in_track' } };
        }
        const parent = newParentId === null ? null : await lockParent(trx, ws, newParentId);
        if (newParentId !== null && !parent) return { fields: { parent: 'not_found' } };
        const children = await trx
          .selectFrom('ticket')
          .select('ticket_type_id')
          .where('parent_id', '=', ticketId)
          .execute();
        const levels = await typeLevels(trx, ws, [
          typeId,
          ...(parent ? [parent.ticket_type_id] : []),
          ...children.map((c) => c.ticket_type_id),
        ]);
        const problem = placementProblem(
          levels.get(typeId),
          parent ? { rank: levels.get(parent.ticket_type_id), trackId: parent.track_id } : null,
          current.track_id,
        );
        if (problem) {
          return { fields: changes.parentId ? { parent: problem } : { ticketTypeId: problem } };
        }
        const rank = levels.get(typeId) as number;
        for (const child of children) {
          const childRank = levels.get(child.ticket_type_id);
          if (
            childRank === undefined ||
            !parentLevelAllowed(childRank, rank, DEFAULT_PARENT_RULES)
          ) {
            return { fields: { ticketTypeId: 'children_wrong_level' } };
          }
        }
        if (changes.parentId && newParentId !== null) {
          // A new parent replaces the one a deletion took away.
          await trx
            .deleteFrom('ticket_detached_parent')
            .where('ticket_id', '=', ticketId)
            .execute();
        }
      }

      const set: Updateable<Database['ticket']> = {
        version: current.version + 1,
        updated_at: new Date(),
      };
      if (changes.summary) set.summary = values.summary as string;
      if (changes.description) {
        set.description = values.description == null ? null : JSON.stringify(values.description);
      }
      if (changes.environment) {
        set.environment = values.environment == null ? null : JSON.stringify(values.environment);
      }
      if (changes.ticketTypeId) set.ticket_type_id = typeId;
      if (changes.parentId) set.parent_id = newParentId;
      if (changes.assigneeId) set.assignee_id = body.assigneeId ?? null;
      if (changes.requesterId && body.requesterId !== undefined)
        set.requester_id = body.requesterId;
      if (changes.startDate) set.start_date = values.startDate ?? null;
      if (changes.dueDate) set.due_date = values.dueDate ?? null;
      if (changes.priorityId) set.priority_id = body.priorityId ?? null;
      if (changes.closeReasonId) set.close_reason_id = body.closeReasonId ?? null;
      if (changes.labels && values.labels !== undefined) set.labels = values.labels;
      await trx.updateTable('ticket').set(set).where('id', '=', ticketId).execute();
      if (lists.targetReleaseIds) {
        await setTicketReleases(trx, ws, ticketId, 'target', lists.targetReleaseIds);
      }
      if (lists.foundInReleaseIds) {
        await setTicketReleases(trx, ws, ticketId, 'found', lists.foundInReleaseIds);
      }
      if (lists.areaIds) await setTicketAreas(trx, ws, ticketId, lists.areaIds);
      if (changes.labels) await rememberLabels(trx, ws, values.labels ?? []);
      await emit(trx, by(request), {
        type: 'ticket.updated',
        subjectId: ticketId,
        payload: { key: ticketKey(current.track_key, current.number), changes },
      });
      const updated = await loadTicket(trx, ws, ticketId);
      if (updated) await recordChanges(trx, ws, actor(request), ticketChanges(current, updated));
      return { ticket: updated };
    });
    return answer(request, reply, outcome);
  });

  // To another track (CORE-023): new numbers there for the ticket and its subtickets.
  app.post('/api/v1/tickets/:id/move', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = params.safeParse(request.params);
    if (!p.success) return invalid(reply);
    const parsed = moveBody.safeParse(request.body);
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const body = parsed.data;
    const ws = request.workspaceId;
    const found = await findTicket(request, p.data.id);
    if (!found) return notFound(reply);
    if (found.row.deleted_at) return inTrash(request, reply, found.row);
    if (found.row.track_archived_at) return reply.code(409).send({ error: 'track_archived' });
    const ticketId = found.row.id;
    const sourceId = found.row.track_id;
    const targetId = await resolveTrack(db, ws, body.track);
    if (targetId === null || !(await request.authz.can('browse_track', targetId))) {
      return invalidFields(reply, { track: 'not_found' });
    }
    if (targetId === sourceId) return invalidFields(reply, { track: 'same_track' });
    if (!(await request.authz.can('move_tickets', sourceId))) {
      return forbidden(reply, 'move_tickets');
    }
    if (!(await request.authz.can('create_tickets', targetId))) {
      return forbidden(reply, 'create_tickets');
    }
    let parentId: number | null | undefined;
    if (body.parent === null) parentId = null;
    else if (body.parent !== undefined) {
      const parent = await findTicket(request, body.parent);
      if (!parent || parent.row.deleted_at) return invalidFields(reply, { parent: 'not_found' });
      if (parent.row.id === ticketId) return invalidFields(reply, { parent: 'self' });
      parentId = parent.row.id;
    }

    const outcome = await db.transaction().execute(async (trx): Promise<Outcome> => {
      // The hierarchy, then the target track and its type set, then tickets (see PATCH).
      await shareHierarchy(trx, ws);
      const offered = await offeredTypes(trx, ws, targetId);
      if (!offered) return { missing: true };
      if (offered.archived) return { conflict: 'track_archived' };
      const locked = await trx
        .selectFrom('ticket')
        .select('id')
        .where('id', '=', ticketId)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      const current = locked ? await loadTicket(trx, ws, ticketId) : undefined;
      if (!current) return { missing: true };
      if (current.track_id !== sourceId) return { conflict: 'moved_meanwhile' };
      if (body.version !== undefined && body.version !== current.version) {
        return { versionConflict: true };
      }
      if (current.level_rank === SUBTICKET_RANK) return { conflict: 'subticket_moves_with_parent' };

      const fields: FieldErrors = {};
      const typeId =
        body.ticketTypeId ??
        (offered.typeIds.has(current.ticket_type_id) ? current.ticket_type_id : null);
      if (typeId === null) fields.ticketTypeId = 'required';
      else if (!offered.typeIds.has(typeId)) fields.ticketTypeId = 'not_in_track';

      // Subtickets come along, those in the trash too, so they never end up in another track
      // than their parent.
      const children = await trx
        .selectFrom('ticket as k')
        .innerJoin('ticket_type as ty', 'ty.id', 'k.ticket_type_id')
        .innerJoin('hierarchy_level as l', 'l.id', 'ty.level_id')
        .select(['k.id', 'k.number', 'k.ticket_type_id', 'l.rank'])
        .where('k.parent_id', '=', ticketId)
        .orderBy('k.number')
        .forUpdate('k')
        .execute();
      const subtickets = children.filter((c) => c.rank === SUBTICKET_RANK);
      const subticketTypes = new Map<number, number>();
      for (const s of subtickets) {
        const mapped = offered.typeIds.has(s.ticket_type_id)
          ? s.ticket_type_id
          : body.subticketTypeId;
        if (mapped === undefined) fields.subticketTypeId = 'required';
        else if (!offered.typeIds.has(mapped)) fields.subticketTypeId = 'not_in_track';
        else subticketTypes.set(s.id, mapped);
      }
      if (Object.keys(fields).length > 0) return { fields };

      const newParentId = parentId === undefined ? current.parent_id : parentId;
      const parent = newParentId === null ? null : await lockParent(trx, ws, newParentId);
      if (newParentId !== null && !parent) return { fields: { parent: 'not_found' } };
      const levels = await typeLevels(trx, ws, [
        typeId as number,
        ...(parent ? [parent.ticket_type_id] : []),
        ...children.map((c) => c.ticket_type_id),
        ...subticketTypes.values(),
      ]);
      const rank = levels.get(typeId as number);
      const problem = placementProblem(
        rank,
        parent ? { rank: levels.get(parent.ticket_type_id), trackId: parent.track_id } : null,
        targetId,
      );
      if (problem) {
        return { fields: parentId !== undefined ? { parent: problem } : { ticketTypeId: problem } };
      }
      for (const child of children) {
        const childRank = levels.get(subticketTypes.get(child.id) ?? child.ticket_type_id);
        if (
          childRank === undefined ||
          rank === undefined ||
          !parentLevelAllowed(childRank, rank, DEFAULT_PARENT_RULES)
        ) {
          return {
            fields: subticketTypes.has(child.id)
              ? { subticketTypeId: 'wrong_level' }
              : { ticketTypeId: 'children_wrong_level' },
          };
        }
      }

      const touched = [ticketId, ...subtickets.map((st) => st.id)];
      const before = await loadTickets(trx, ws, touched);
      const number = await nextNumber(trx, ws, targetId);
      const now = new Date();
      await trx
        .updateTable('ticket')
        .set({
          track_id: targetId,
          number,
          ticket_type_id: typeId as number,
          parent_id: newParentId,
          version: current.version + 1,
          updated_at: now,
        })
        .where('id', '=', ticketId)
        .execute();
      if (parentId != null && parentId !== current.parent_id) {
        await trx.deleteFrom('ticket_detached_parent').where('ticket_id', '=', ticketId).execute();
      }
      const moved: { id: number; from: string; to: string; ticketTypeId: number }[] = [];
      for (const s of subtickets) {
        const subNumber = await nextNumber(trx, ws, targetId);
        const subType = subticketTypes.get(s.id) as number;
        await trx
          .updateTable('ticket')
          .set((eb) => ({
            track_id: targetId,
            number: subNumber,
            ticket_type_id: subType,
            version: eb('version', '+', 1),
            updated_at: now,
          }))
          .where('id', '=', s.id)
          .execute();
        moved.push({
          id: s.id,
          from: ticketKey(current.track_key, s.number),
          to: ticketKey(offered.key, subNumber),
          ticketTypeId: subType,
        });
      }
      // Releases and areas belong to the old track.
      await trx.deleteFrom('ticket_release').where('ticket_id', 'in', touched).execute();
      await trx.deleteFrom('ticket_area').where('ticket_id', 'in', touched).execute();
      await emit(trx, by(request), {
        type: 'ticket.moved',
        subjectId: ticketId,
        payload: {
          from: {
            key: ticketKey(current.track_key, current.number),
            trackId: sourceId,
            ticketTypeId: current.ticket_type_id,
          },
          to: {
            key: ticketKey(offered.key, number),
            trackId: targetId,
            ticketTypeId: typeId as number,
          },
          parentId: newParentId,
          subtickets: moved,
        },
      });
      await recordChanges(
        trx,
        ws,
        actor(request),
        changesOf(before, await loadTickets(trx, ws, touched)),
      );
      return { ticket: await loadTicket(trx, ws, ticketId) };
    });
    return answer(request, reply, outcome);
  });

  // The global rank (AGL-009): before or after another ticket, or to the top or bottom.
  app.put('/api/v1/tickets/:id/rank', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = params.safeParse(request.params);
    if (!p.success) return invalid(reply);
    const parsed = rankBody.safeParse(request.body);
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const body = parsed.data;
    const ws = request.workspaceId;
    const found = await findTicket(request, p.data.id);
    if (!found) return notFound(reply);
    if (found.row.deleted_at) return inTrash(request, reply, found.row);
    if (found.row.track_archived_at) return reply.code(409).send({ error: 'track_archived' });
    if (!(await request.authz.can('schedule_tickets', found.row.track_id))) {
      return forbidden(reply, 'schedule_tickets');
    }
    const ticketId = found.row.id;
    const anchorRef = body.before ?? body.after;
    let anchorId: number | null = null;
    if (anchorRef !== undefined) {
      const field = body.before !== undefined ? 'before' : 'after';
      const anchor = await findTicket(request, anchorRef);
      if (!anchor || anchor.row.deleted_at) return invalidFields(reply, { [field]: 'not_found' });
      if (anchor.row.id === ticketId) return invalidFields(reply, { [field]: 'self' });
      anchorId = anchor.row.id;
    }

    /** Ranks around `rank` among every ticket but this one. */
    const neighbour = async (trx: Db, side: 'before' | 'after', rank: string | null) => {
      let query = trx
        .selectFrom('ticket')
        .select('rank')
        .where('workspace_id', '=', ws)
        .where('id', '<>', ticketId);
      if (rank !== null) query = query.where('rank', side === 'before' ? '<' : '>', rank);
      const row = await query
        .orderBy('rank', side === 'before' ? 'desc' : 'asc')
        .limit(1)
        .executeTakeFirst();
      return row?.rank ?? null;
    };

    // Two moves into one gap at the same moment may pick the same key: the unique index
    // refuses the second, which then tries again with fresh neighbours.
    for (let attempt = 1; ; attempt++) {
      try {
        const outcome = await db.transaction().execute(async (trx): Promise<Outcome> => {
          const locked = await trx
            .selectFrom('ticket')
            .select(['rank', 'number', 'track_id'])
            .where('id', '=', ticketId)
            .where('deleted_at', 'is', null)
            .forUpdate()
            .executeTakeFirst();
          if (!locked) return { missing: true };
          let low: string | null;
          let high: string | null;
          if (body.position !== undefined) {
            low = body.position === 'top' ? null : await neighbour(trx, 'before', null);
            high = body.position === 'top' ? await neighbour(trx, 'after', null) : null;
          } else {
            const anchor = await trx
              .selectFrom('ticket')
              .select('rank')
              .where('id', '=', anchorId as number)
              .where('deleted_at', 'is', null)
              .executeTakeFirst();
            if (!anchor) {
              return { fields: { [body.before !== undefined ? 'before' : 'after']: 'not_found' } };
            }
            low =
              body.before !== undefined ? await neighbour(trx, 'before', anchor.rank) : anchor.rank;
            high =
              body.before !== undefined ? anchor.rank : await neighbour(trx, 'after', anchor.rank);
          }
          // Already there: nothing to write.
          const placed =
            (low === null || low < locked.rank) && (high === null || locked.rank < high);
          if (placed) return { ticket: await loadTicket(trx, ws, ticketId) };
          const rank = high === null ? await bottomRank(trx) : keyBetween(low, high);
          await trx.updateTable('ticket').set({ rank }).where('id', '=', ticketId).execute();
          const track = await trx
            .selectFrom('track')
            .select('key')
            .where('id', '=', locked.track_id)
            .executeTakeFirstOrThrow();
          await emit(trx, by(request), {
            type: 'ticket.ranked',
            subjectId: ticketId,
            payload: { key: ticketKey(track.key, locked.number), from: locked.rank, to: rank },
          });
          await recordChanges(trx, ws, actor(request), [
            {
              ticketId,
              field: 'rank',
              from: locked.rank,
              to: rank,
              fromDisplay: null,
              toDisplay: null,
            },
          ]);
          return { ticket: await loadTicket(trx, ws, ticketId) };
        });
        return await answer(request, reply, outcome);
      } catch (error) {
        if (uniqueViolation(error) === 'ticket_rank_key' && attempt < 5) continue;
        throw error;
      }
    }
  });

  // To the trash, with the subtickets; other children lose the link until a restore.
  app.delete('/api/v1/tickets/:id', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const p = params.safeParse(request.params);
    if (!p.success) return invalid(reply);
    const ws = request.workspaceId;
    const found = await findTicket(request, p.data.id);
    if (!found) return notFound(reply);
    if (found.row.deleted_at) return inTrash(request, reply, found.row);
    if (found.row.track_archived_at) return reply.code(409).send({ error: 'track_archived' });
    if (!(await request.authz.can('delete_tickets', found.row.track_id))) {
      return forbidden(reply, 'delete_tickets');
    }
    const ticketId = found.row.id;
    const outcome = await db.transaction().execute(async (trx): Promise<Outcome> => {
      await shareHierarchy(trx, ws);
      const locked = await trx
        .selectFrom('ticket as k')
        .innerJoin('track as t', 't.id', 'k.track_id')
        .select(['k.number', 't.key'])
        .where('k.id', '=', ticketId)
        .where('k.deleted_at', 'is', null)
        .forUpdate('k')
        .executeTakeFirst();
      if (!locked) return { missing: true };
      const children = await trx
        .selectFrom('ticket as k')
        .innerJoin('ticket_type as ty', 'ty.id', 'k.ticket_type_id')
        .innerJoin('hierarchy_level as l', 'l.id', 'ty.level_id')
        .select(['k.id', 'l.rank'])
        .where('k.parent_id', '=', ticketId)
        .where('k.deleted_at', 'is', null)
        .orderBy('k.id')
        .forUpdate('k')
        .execute();
      const subtickets = children.filter((c) => c.rank === SUBTICKET_RANK).map((c) => c.id);
      const detached = children.filter((c) => c.rank !== SUBTICKET_RANK).map((c) => c.id);
      const touched = [ticketId, ...subtickets, ...detached];
      const before = await loadTickets(trx, ws, touched);
      const now = new Date();
      await trx
        .updateTable('ticket')
        .set({ deleted_at: now, deleted_by: user.id })
        .where('id', '=', ticketId)
        .execute();
      if (subtickets.length > 0) {
        await trx
          .updateTable('ticket')
          .set({ deleted_at: now, deleted_by: user.id, trashed_with: ticketId })
          .where('id', 'in', subtickets)
          .execute();
      }
      if (detached.length > 0) {
        await trx
          .updateTable('ticket')
          .set((eb) => ({ parent_id: null, version: eb('version', '+', 1), updated_at: now }))
          .where('id', 'in', detached)
          .execute();
        await trx
          .insertInto('ticket_detached_parent')
          .values(detached.map((id) => ({ workspace_id: ws, ticket_id: id, parent_id: ticketId })))
          .onConflict((oc) =>
            oc.column('ticket_id').doUpdateSet({ parent_id: ticketId, detached_at: now }),
          )
          .execute();
      }
      await emit(trx, by(request), {
        type: 'ticket.deleted',
        subjectId: ticketId,
        payload: {
          key: ticketKey(locked.key, locked.number),
          subtickets,
          detachedChildren: detached,
        },
      });
      await recordChanges(trx, ws, user.id, changesOf(before, await loadTickets(trx, ws, touched)));
      return { ticket: await loadTicket(trx, ws, ticketId) };
    });
    const refused = refusal(reply, outcome);
    if (refused) return refused;
    return reply.code(204).send();
  });

  app.post('/api/v1/tickets/:id/restore', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = params.safeParse(request.params);
    if (!p.success) return invalid(reply);
    const ws = request.workspaceId;
    const found = await findTicket(request, p.data.id);
    if (!found) return notFound(reply);
    const row = found.row;
    const mayRestore = await request.authz.can('delete_tickets', row.track_id);
    if (!row.deleted_at) return reply.code(409).send({ error: 'not_in_trash' });
    if (!mayRestore) return notFound(reply);
    if (row.track_archived_at) return reply.code(409).send({ error: 'track_archived' });
    if (row.trashed_with !== null) {
      // A subticket that went with its parent comes back with it.
      const view = ticketView(row, true);
      return reply
        .code(409)
        .send({ error: 'deleted_with_parent', parent: view.trash?.deletedWith });
    }
    const ticketId = row.id;
    const outcome = await db.transaction().execute(async (trx): Promise<Outcome> => {
      await shareHierarchy(trx, ws);
      const locked = await trx
        .selectFrom('ticket as k')
        .innerJoin('track as t', 't.id', 'k.track_id')
        .innerJoin('ticket_type as ty', 'ty.id', 'k.ticket_type_id')
        .innerJoin('hierarchy_level as l', 'l.id', 'ty.level_id')
        .select(['k.number', 'k.parent_id', 'k.version', 'k.trashed_with', 't.key', 'l.rank'])
        .where('k.id', '=', ticketId)
        .where('k.deleted_at', 'is not', null)
        .forUpdate('k')
        .executeTakeFirst();
      if (!locked) return { conflict: 'not_in_trash' };
      if (locked.trashed_with !== null) return { conflict: 'deleted_with_parent' };
      // Everything a restore may touch, as it was, for the history.
      const related = await trx
        .selectFrom('ticket')
        .select('id')
        .where('trashed_with', '=', ticketId)
        .union(
          trx
            .selectFrom('ticket_detached_parent')
            .select('ticket_id as id')
            .where('parent_id', '=', ticketId),
        )
        .execute();
      const touched = [ticketId, ...related.map((r) => r.id)];
      const before = await loadTickets(trx, ws, touched);
      let parentId = locked.parent_id;
      let detachedFrom: number | null = null;
      if (parentId !== null) {
        const parent = await trx
          .selectFrom('ticket')
          .select('deleted_at')
          .where('id', '=', parentId)
          .forShare()
          .executeTakeFirstOrThrow();
        if (parent.deleted_at) {
          // A subticket needs its parent back first; anything else returns without the link,
          // which the parent's own restore puts back.
          if (locked.rank === SUBTICKET_RANK) return { conflict: 'parent_in_trash' };
          detachedFrom = parentId;
          parentId = null;
        }
      }
      const now = new Date();
      await trx
        .updateTable('ticket')
        .set({
          deleted_at: null,
          deleted_by: null,
          parent_id: parentId,
          ...(detachedFrom !== null ? { version: locked.version + 1, updated_at: now } : {}),
        })
        .where('id', '=', ticketId)
        .execute();
      if (detachedFrom !== null) {
        await trx
          .insertInto('ticket_detached_parent')
          .values({ workspace_id: ws, ticket_id: ticketId, parent_id: detachedFrom })
          .onConflict((oc) =>
            oc.column('ticket_id').doUpdateSet({ parent_id: detachedFrom, detached_at: now }),
          )
          .execute();
      }
      const subtickets = await trx
        .updateTable('ticket')
        .set({ deleted_at: null, deleted_by: null, trashed_with: null })
        .where('trashed_with', '=', ticketId)
        .returning('id')
        .execute();
      // Children that lost the link get it back if nothing else took its place.
      const detached = await trx
        .selectFrom('ticket_detached_parent as d')
        .innerJoin('ticket as k', 'k.id', 'd.ticket_id')
        .select(['k.id', 'k.ticket_type_id', 'k.parent_id', 'k.deleted_at'])
        .where('d.parent_id', '=', ticketId)
        .orderBy('k.id')
        .forUpdate('k')
        .execute();
      const levels = await typeLevels(
        trx,
        ws,
        detached.map((d) => d.ticket_type_id),
      );
      const reattached: number[] = [];
      for (const child of detached) {
        const childRank = levels.get(child.ticket_type_id);
        if (
          child.deleted_at === null &&
          child.parent_id === null &&
          childRank !== undefined &&
          parentLevelAllowed(childRank, locked.rank, DEFAULT_PARENT_RULES)
        ) {
          reattached.push(child.id);
        }
      }
      if (reattached.length > 0) {
        await trx
          .updateTable('ticket')
          .set((eb) => ({ parent_id: ticketId, version: eb('version', '+', 1), updated_at: now }))
          .where('id', 'in', reattached)
          .execute();
      }
      await trx.deleteFrom('ticket_detached_parent').where('parent_id', '=', ticketId).execute();
      await emit(trx, by(request), {
        type: 'ticket.restored',
        subjectId: ticketId,
        payload: {
          key: ticketKey(locked.key, locked.number),
          subtickets: subtickets.map((s) => s.id).sort((a, b) => a - b),
          reattachedChildren: reattached,
          detachedFrom,
        },
      });
      await recordChanges(
        trx,
        ws,
        actor(request),
        changesOf(before, await loadTickets(trx, ws, touched)),
      );
      return { ticket: await loadTicket(trx, ws, ticketId) };
    });
    return answer(request, reply, outcome);
  });
}
