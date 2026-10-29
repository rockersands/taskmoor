import type { Database, JsonValue } from '@taskmoor/db';
import { engine } from '@taskmoor/workflow';
import type { FastifyInstance } from 'fastify';
import { type Kysely, sql, type Transaction, type Updateable } from 'kysely';
import { z } from 'zod';
import { requireUser } from '../auth';
import type { Authorizer } from '../authz/authorizer';
import type { TrackPermission } from '../authz/permissions';
import { diff, emit } from '../events/bus';
import type { FieldCatalogs } from '../fields/catalog';
import { refreshFormulas } from '../fields/formulas';
import {
  customKey,
  type FormPlacement,
  fieldLocks,
  fieldOfBody,
  formFields,
  isEmptyOn,
  layoutProblems,
  missingRequired,
  resolveLayout,
  ruleKeyOfWorkflowField,
  ruleOf,
  SYSTEM_FIELDS,
} from '../fields/layouts';
import { changedFieldIds, syncFieldValues } from '../fields/storage';
import {
  checkCustomValues,
  customChanges,
  customFieldViews,
  type FieldValues,
  historyName,
  rememberFieldLabels,
  withoutTrackValues,
} from '../fields/values';
import type { Answer, Caller, TicketHandler, TicketRoute } from '../tickets/caller';
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
import { autoFollow } from '../tickets/followers';
import { DEFAULT_PARENT_RULES, parentLevelAllowed, SUBTICKET_RANK } from '../tickets/hierarchy';
import { changesOf, recordChanges, ticketChanges } from '../tickets/history';
import { canonicalJson, isCalendarDay, SUMMARY_MAX, ticketKey } from '../tickets/model';
import { keyBetween } from '../tickets/rank';
import {
  inFormat,
  keepOriginals,
  type ReadText,
  type RichTextFormat,
  readRichText,
  requestedFormat,
} from '../tickets/rich-text';
import {
  bottomRank,
  inTracks,
  loadTicket,
  loadTickets,
  nextNumber,
  resolveTicket,
  resolveTrack,
  type TicketRow,
  type TicketView,
  ticketQuery,
  ticketView,
} from '../tickets/store';
import { durationValue, timeSettings } from '../tickets/time';
import { levelFor, trackVisibility } from '../tickets/visibility';
import { isKnownField, isWritableField, parseField } from '../workflows/fields';
import {
  audienceOf,
  fieldLockList,
  type Lock,
  type LockAction,
  lockedBody,
  statusGate,
  statusLock,
} from '../workflows/locks';
import { holdMapWorkflows, holdTicketWorkflow, ticketWorkflowId } from '../workflows/maps';
import { pendingTarget, settleStatus } from '../workflows/migration';
import { statusIdsOf } from '../workflows/model';
import {
  channelOf,
  engineActor,
  engineWorkflow,
  storedChanges,
  ticketState,
} from '../workflows/state';
import { statusInfo } from '../workflows/store';

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
 * - Formula fields (M1-013, CORE-011) are recomputed in every write's transaction, after the
 *   write and before its history (`refreshFormulas`): the ticket's own, then its parent's
 *   roll-ups (a parent someone else holds is left to the worker). Their changes join the
 *   write's history; formula values are never written by a request.
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
/** Seconds, or text such as "1w 2d" read with the time tracking settings; null clears it. */
const estimate = z.union([z.string().max(100), z.number()]).nullable();
/** Custom field values by field id (M1-010); null or empty clears one. */
const customValues = z.record(z.string().max(12), z.unknown());

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
    originalEstimate: estimate.optional(),
    remainingEstimate: estimate.optional(),
    fields: customValues.optional(),
    /** Null for none; the track's default level when left out (M1-020). */
    visibilityLevelId: idValue.nullable().optional(),
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
    originalEstimate: estimate.optional(),
    remainingEstimate: estimate.optional(),
    fields: customValues.optional(),
    visibilityLevelId: idValue.nullable().optional(),
    /**
     * With a new ticket type whose workflow lacks the ticket's status: the status it takes;
     * that workflow's initial status if left out (M1-028).
     */
    statusId: idValue.optional(),
    version: idValue.optional(),
  })
  .strict();
const moveBody = z
  .object({
    track: ref,
    ticketTypeId: idValue.optional(),
    subticketTypeId: idValue.optional(),
    /** For tickets whose status the target track's workflow lacks; its initial status if left out. */
    statusId: idValue.optional(),
    parent: ref.nullable().optional(),
    /** The level in the target track; its default when left out (IAM-011 (2)). */
    visibilityLevelId: idValue.nullable().optional(),
    version: idValue.optional(),
  })
  .strict();
const transitionBody = z
  .object({
    transitionId: idValue,
    /** Values for the transition's layout, by field name (`close-reason`, `assignee`, ...). */
    fields: z.record(z.string().max(100), z.unknown()).optional(),
    comment: z.string().max(32_000).optional(),
    version: idValue.optional(),
  })
  .strict();
/** What a bulk change asks of each ticket (M1-021): an edit or a move, without a version. */
export const bulkEditBody = updateBody.omit({ version: true });
export const bulkMoveBody = moveBody.omit({ version: true });
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
    format: z.enum(['doc', 'adf', 'markdown']).optional(),
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

const invalid = (reply: Answer) => reply.code(400).send({ error: 'invalid_request' });
const invalidFields = (reply: Answer, fields: FieldErrors) =>
  reply.code(400).send({ error: 'invalid_fields', fields });
const notFound = (reply: Answer) => reply.code(404).send({ error: 'not_found' });
const forbidden = (reply: Answer, permission: TrackPermission) =>
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
  /** Rich text as read in the request's format, with any original to keep (M1-017). */
  texts?: Partial<Record<'description' | 'environment', ReadText>>;
  startDate?: string | null;
  dueDate?: string | null;
  labels?: string[];
}

/**
 * Checks the plain values of a create or edit; problems go into `fields`. Rich text comes in
 * the request's format (`?format=`, M1-017).
 */
function contentValues(
  body: ContentInput,
  fields: FieldErrors,
  creating: boolean,
  format: RichTextFormat = 'doc',
): ContentValues {
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
    const read = readRichText(body[name], format);
    if (!read.ok) {
      fields[name] = read.problem;
      continue;
    }
    out[name] = read.text.doc;
    out.texts = { ...out.texts, [name]: read.text };
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

/** A ticket outside the trash, locked for an update, as it is now. */
async function lockTicketRow(trx: Transaction<Database>, workspaceId: number, ticketId: number) {
  const locked = await trx
    .selectFrom('ticket')
    .select('id')
    .where('id', '=', ticketId)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  return locked ? loadTicket(trx, workspaceId, ticketId) : undefined;
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
  | { locked: { action: LockAction | 'edit_field'; locks: Lock[] } }
  | { versionConflict: true };

/**
 * Thrown inside a write's transaction to undo what it wrote and answer `outcome`: a refusal
 * found after the ticket was written (a required field the create left empty) must not commit.
 */
class Rollback extends Error {
  constructor(readonly outcome: Outcome) {
    super('rolled back');
  }
}

export function registerTicketRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  authorizer: Authorizer,
  catalogs: FieldCatalogs,
): void {
  for (const r of ticketRoutes(db, authorizer, catalogs)) {
    app.route({
      method: r.method,
      url: r.url,
      handler: (request, reply) => r.handler(request, reply),
    });
  }
}

/**
 * The ticket routes as plain handlers, so a background job can run a person's change through
 * exactly the checks a request does (M1-021): `registerTicketRoutes` serves them over HTTP.
 */
export function ticketRoutes(
  db: Kysely<Database>,
  authorizer: Authorizer,
  catalogs: FieldCatalogs,
): TicketRoute[] {
  const routes: TicketRoute[] = [];
  const route = (method: TicketRoute['method'], url: string, handler: TicketHandler) => {
    routes.push({ method, url, handler });
  };
  const by = (request: Caller) => ({
    workspaceId: request.workspaceId,
    actorId: request.user?.id ?? null,
  });
  const actor = (request: Caller) => request.user?.id ?? null;

  /** A ticket write in a transaction; a `Rollback` thrown inside undoes it and answers. */
  async function transact(
    work: (trx: Transaction<Database>) => Promise<Outcome>,
  ): Promise<Outcome> {
    try {
      return await db.transaction().execute(work);
    } catch (error) {
      if (error instanceof Rollback) return error.outcome;
      throw error;
    }
  }

  /**
   * The same, where a refusal undoes everything written before it: a transition that first
   * moved its ticket for a status migration (M1-028) changes nothing when it is refused.
   */
  function transactAll(work: (trx: Transaction<Database>) => Promise<Outcome>) {
    return transact(async (trx) => {
      const outcome = await work(trx);
      if (!('ticket' in outcome)) throw new Rollback(outcome);
      return outcome;
    });
  }

  /**
   * A ticket the caller may see, trash included, by id or key: they browse it and belong to
   * its visibility level (M1-020).
   */
  async function findTicket(request: Caller, ticketRef: string | number) {
    const ws = request.workspaceId;
    const found = await resolveTicket(db, ws, ticketRef);
    if (!found) return null;
    const row = await loadTicket(db, ws, found.id);
    if (!row || !(await request.authz.seesTicket(row))) return null;
    return { row, asked: found.asked };
  }

  async function viewOf(request: Caller, row: TicketRow) {
    const parent =
      row.parent_id === null ? undefined : await loadTicket(db, request.workspaceId, row.parent_id);
    const parentVisible = parent !== undefined && (await request.authz.seesTicket(parent));
    const [view] = await viewsOf(request, [row], () => parentVisible);
    return view as TicketView;
  }

  /** Views of a page of tickets, with the parents the caller may see named. */
  async function pageViews(request: Caller, rows: readonly TicketRow[]) {
    const parents = rows.flatMap((r) => (r.parent_id === null ? [] : [r.parent_id]));
    const visible = await request.authz.visibleTickets(parents);
    return viewsOf(request, rows, (r) => r.parent_id !== null && visible.has(r.parent_id));
  }

  /** Views of several tickets, their custom values read together. */
  async function viewsOf(
    request: Caller,
    rows: readonly TicketRow[],
    canSeeParent: (row: TicketRow) => boolean,
  ): Promise<TicketView[]> {
    const ws = request.workspaceId;
    const custom = await customFieldViews(db, ws, await catalogs.get(ws), rows);
    return rows.map((r) => ticketView(r, canSeeParent(r), custom.get(r.id)));
  }

  /** A ticket in the trash exists only for those who may restore it. */
  async function inTrash(request: Caller, reply: Answer, row: TicketRow) {
    return (await request.authz.canTicket('delete_tickets', row))
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

  /**
   * The estimates a create or an edit gives, in seconds (M1-019); problems go into `fields`.
   * 'disabled' when time tracking is off.
   */
  async function estimateValues(
    body: {
      originalEstimate?: string | number | null | undefined;
      remainingEstimate?: string | number | null | undefined;
    },
    workspaceId: number,
    fields: FieldErrors,
  ): Promise<{ original?: number | null; remaining?: number | null } | 'disabled'> {
    if (body.originalEstimate === undefined && body.remainingEstimate === undefined) return {};
    const settings = await timeSettings(db, workspaceId);
    if (!settings.enabled) return 'disabled';
    const out: { original?: number | null; remaining?: number | null } = {};
    for (const [name, key] of [
      ['originalEstimate', 'original'],
      ['remainingEstimate', 'remaining'],
    ] as const) {
      const input = body[name];
      if (input === undefined) continue;
      const parsed = durationValue(input, settings);
      if (parsed.ok) out[key] = parsed.seconds;
      else fields[name] = parsed.problem;
    }
    return out;
  }

  /** The people among `ids` who may be assigned in a track (read outside any transaction). */
  async function assignableAmong(
    workspaceId: number,
    trackId: number,
    ids: readonly (number | null | undefined)[],
  ): Promise<Set<number>> {
    const out = new Set<number>();
    for (const id of new Set(ids)) {
      if (id != null && (await assignable(workspaceId, trackId, id))) out.add(id);
    }
    return out;
  }

  /** The owners an "assign to owner" effect may pick: the ticket's areas' and its track's. */
  async function ownersOf(row: TicketRow): Promise<number[]> {
    const owners = await db
      .selectFrom('ticket_area as ta')
      .innerJoin('area as a', 'a.id', 'ta.area_id')
      .select('a.owner_id')
      .where('ta.ticket_id', '=', row.id)
      .where('a.owner_id', 'is not', null)
      .union(db.selectFrom('track').select('owner_id').where('id', '=', row.track_id))
      .execute();
    return owners.map((o) => o.owner_id).filter((id): id is number => id !== null);
  }

  /** Answers an outcome that is not a ticket; null when it is one. */
  function refusal(reply: Answer, outcome: Outcome) {
    if ('missing' in outcome) return notFound(reply);
    if ('fields' in outcome) return invalidFields(reply, outcome.fields);
    if ('conflict' in outcome) {
      return reply.code(409).send({ error: outcome.conflict, ...(outcome.detail ?? {}) });
    }
    if ('denied' in outcome) return forbidden(reply, outcome.denied);
    if ('locked' in outcome) {
      return reply.code(403).send(lockedBody(outcome.locked.action, outcome.locked.locks));
    }
    if ('versionConflict' in outcome) return reply.code(409).send({ error: 'version_conflict' });
    if (!outcome.ticket) return notFound(reply);
    return null;
  }

  async function answer(request: Caller, reply: Answer, outcome: Outcome, code = 200) {
    const refused = refusal(reply, outcome);
    if (refused) return refused;
    const row = (outcome as { ticket: TicketRow }).ticket;
    const view = await viewOf(request, row);
    return reply
      .code(code)
      .send({ ticket: inFormat(view, requestedFormat(request.query) ?? 'doc') });
  }

  route('GET', '/api/v1/tickets', async (request, reply) => {
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success) return invalid(reply);
    const q = parsed.data;
    const ws = request.workspaceId;
    // Track browsing, ticket-level grants and visibility levels, in the statement (QRY-008).
    const filter = await request.authz.ticketFilter();
    if (filter.tracks !== 'all' && filter.tracks.length === 0) return { tickets: [], next: null };
    let query = ticketQuery(db, ws).where('k.deleted_at', 'is', null).where(filter.sql);
    if (q.track !== undefined) {
      const trackId = await resolveTrack(db, ws, q.track);
      if (trackId === null || !inTracks(filter.tracks, trackId)) return notFound(reply);
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
      tickets: (await pageViews(request, page)).map((v) => inFormat(v, q.format ?? 'doc')),
      next: rows.length > q.limit ? (page[page.length - 1]?.rank ?? null) : null,
    };
  });

  route('GET', '/api/v1/tickets/:id', async (request, reply) => {
    const p = params.safeParse(request.params);
    const format = requestedFormat(request.query);
    if (!p.success || !format) return invalid(reply);
    const found = await findTicket(request, p.data.id);
    if (!found) return notFound(reply);
    if (found.row.deleted_at && !(await request.authz.canTicket('delete_tickets', found.row))) {
      return notFound(reply);
    }
    const ticket = await viewOf(request, found.row);
    return {
      ticket: inFormat(ticket, format),
      ...(found.asked !== null && found.asked !== ticket.key
        ? { redirect: { from: found.asked, to: ticket.key } }
        : {}),
    };
  });

  // A ticket's change history (CORE-022), newest first unless asked otherwise, page by page:
  // each page reads one partition through the primary key, however long the history is.
  route('GET', '/api/v1/tickets/:id/history', async (request, reply) => {
    const p = params.safeParse(request.params);
    const parsed = historyQuery.safeParse(request.query);
    if (!p.success || !parsed.success) return invalid(reply);
    const q = parsed.data;
    const found = await findTicket(request, p.data.id);
    if (!found) return notFound(reply);
    if (found.row.deleted_at && !(await request.authz.canTicket('delete_tickets', found.row))) {
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
        'c.transition_id',
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
        transitionId: c.transition_id,
      })),
      next: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  });

  // The trash: tickets the caller may restore, most recently deleted first (CORE-025 (3)).
  route('GET', '/api/v1/trash', async (request, reply) => {
    const parsed = trashQuery.safeParse(request.query);
    if (!parsed.success) return invalid(reply);
    const q = parsed.data;
    const ws = request.workspaceId;
    const allowed = await request.authz.allowedTracks('delete_tickets');
    if (allowed !== 'all' && allowed.length === 0) return { tickets: [], next: null };
    // Only tickets the caller sees at their visibility level (M1-020).
    let query = ticketQuery(db, ws)
      .where('k.deleted_at', 'is not', null)
      .where((await request.authz.ticketFilter()).level);
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
    return {
      tickets: await pageViews(request, page),
      next:
        rows.length > q.limit && last?.deleted_at
          ? `${last.deleted_at.getTime()}.${last.id}`
          : null,
    };
  });

  route('POST', '/api/v1/tickets', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const format = requestedFormat(request.query);
    if (!format) return invalid(reply);
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
      .select(['archived_at', 'field_rule_set_id', 'layout_set_id'])
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
    if (body.visibilityLevelId !== undefined && !held.has('set_visibility_level')) {
      return forbidden(reply, 'set_visibility_level');
    }
    const fields: FieldErrors = {};
    const values = contentValues(body, fields, true, format);
    const estimates = await estimateValues(body, ws, fields);
    if (estimates === 'disabled') return reply.code(409).send({ error: 'time_tracking_disabled' });
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
    // Read before the transaction, which never waits for a second pooled connection: who is
    // creating, and who an area's rule or a create effect could assign.
    const actor = await engineActor(request, trackId);
    const areaOwners =
      body.areaIds === undefined || body.areaIds.length === 0
        ? []
        : (
            await db
              .selectFrom('area')
              .select('owner_id')
              .where('track_id', '=', trackId)
              .where('id', 'in', body.areaIds)
              .execute()
          ).map((a) => a.owner_id);
    const trackOwner = await db
      .selectFrom('track')
      .select('owner_id')
      .where('id', '=', trackId)
      .executeTakeFirst();
    const candidates = await assignableAmong(ws, trackId, [
      user.id,
      requesterId,
      trackOwner?.owner_id,
      ...areaOwners,
    ]);
    const catalog = await catalogs.get(ws);

    const outcome = await transact(async (trx): Promise<Outcome> => {
      await shareHierarchy(trx, ws);
      const offered = await offeredTypes(trx, ws, trackId);
      if (!offered) return { missing: true };
      if (offered.archived) return { conflict: 'track_archived' };
      const typeId = body.ticketTypeId ?? offered.defaultTypeId;
      if (typeId === null) return { fields: { ticketTypeId: 'required' } };
      if (!offered.typeIds.has(typeId)) return { fields: { ticketTypeId: 'not_in_track' } };
      // The workflow the track's map gives the type, held so a publish or a change of map
      // waits; new tickets take its initial status (M1-028).
      const workflow = await holdTicketWorkflow(trx, ws, trackId, typeId);
      if (!workflow) return { missing: true };
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
      // Custom values, and the defaults of the fields left out (M1-010).
      const custom = await checkCustomValues(
        trx,
        catalog,
        { workspaceId: ws, trackId, ticketTypeId: typeId },
        channelOf(request),
        {},
        body.fields,
        true,
      );
      if (!custom.ok) return { fields: custom.errors };
      // The create layout and field rules of the type (M1-012): hidden fields and fields the
      // layout leaves out are not written; required ones are checked once the ticket exists.
      const at: FormPlacement = {
        trackId,
        ticketTypeId: typeId,
        ruleSetId: track.field_rule_set_id,
        layoutSetId: track.layout_set_id,
      };
      const form = formFields(resolveLayout(catalog, at, 'create'));
      // A value left empty writes nothing, so it passes even for a hidden field.
      const given = (v: unknown) =>
        v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);
      const written = [
        ...SYSTEM_FIELDS.filter((f) => given(body[f.body])).map((f) => f.key),
        ...Object.entries(body.fields ?? {})
          .filter(([, v]) => given(v))
          .map(([id]) => customKey(Number(id))),
      ];
      const placed = layoutProblems(catalog, at, form.shown, written);
      if (placed) return { fields: placed };
      // Fields only some roles or groups may set (M1-029).
      const fieldLocked = fieldLocks(catalog, at, written, audienceOf(actor));
      if (fieldLocked.size > 0) {
        return { locked: { action: 'edit_field', locks: await fieldLockList(trx, fieldLocked) } };
      }
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
      // The level asked for, else the track's default (IAM-011).
      const levelId = levelFor(await trackVisibility(trx, ws, trackId), body.visibilityLevelId);
      if (levelId === 'not_in_track') return { fields: { visibilityLevelId: levelId } };
      // No assignee given: the first of its areas whose rule names someone (CORE-015 (1)).
      let assigneeId = body.assigneeId ?? null;
      if (body.assigneeId === undefined && body.areaIds !== undefined) {
        const candidate = await areaDefaultAssignee(trx, trackId, body.areaIds);
        if (candidate !== null && candidates.has(candidate)) assigneeId = candidate;
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
          status_id: workflow.definition.initialStatusId,
          // A close reason means closed (WF-008).
          closed_at: body.closeReasonId != null ? new Date() : null,
          original_estimate: estimates.original ?? null,
          // A new ticket's remaining estimate starts at its original estimate.
          remaining_estimate:
            estimates.remaining !== undefined ? estimates.remaining : (estimates.original ?? null),
          fields: JSON.stringify(custom.fields),
          visibility_level_id: levelId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await rememberFieldLabels(trx, ws, custom.labels);
      // The originals of rich text written in the other format (M1-017, IMP-008).
      if (values.texts) await keepOriginals(trx, ws, row.id, values.texts, user.id);
      await setTicketReleases(trx, ws, row.id, 'target', body.targetReleaseIds ?? []);
      await setTicketReleases(trx, ws, row.id, 'found', body.foundInReleaseIds ?? []);
      await setTicketAreas(trx, ws, row.id, body.areaIds ?? []);
      await rememberLabels(trx, ws, values.labels ?? []);
      // The create transition's effects (WF-005 (3)): what they write is the starting value.
      let fired = { event: 'generic', webhookCount: 0 };
      const effects = workflow.definition.onCreate?.effects ?? [];
      if (workflow.definition.onCreate) {
        const fresh = (await loadTicket(trx, ws, row.id)) as TicketRow;
        const start = await ticketState(trx, ws, fresh);
        const { workflow: engineDef } = await engineWorkflow(
          trx,
          ws,
          workflow.id,
          workflow.published_version,
        );
        const made = engine.create(engineDef, actor, start.fields);
        const writes = (name: string) =>
          effects.some(
            (e) =>
              (name === 'assignee' && e.type.startsWith('assign-')) ||
              ('field' in e && e.field === name) ||
              (e.type === 'copy-field' && e.to === name),
          );
        const stored = storedChanges(fresh, {
          ...start,
          fields: made.ticket.fields,
          assignee: writes('assignee') ? (made.ticket.assignee ?? null) : (start.assignee ?? null),
          closeReason: writes('close-reason') ? (made.ticket.closeReason ?? null) : null,
          closedAt: writes('close-reason') ? (made.ticket.closedAt ?? null) : null,
        });
        if (!stored.ok) throw new Rollback({ fields: { [stored.field]: stored.problem } });
        const set = stored.changes;
        if (set.assigneeId != null && !candidates.has(set.assigneeId)) {
          throw new Rollback({ fields: { assignee: 'not_assignable' } });
        }
        if (Object.keys(set.ticket).length > 0) {
          await trx.updateTable('ticket').set(set.ticket).where('id', '=', row.id).execute();
        }
        if (set.targetReleases)
          await setTicketReleases(trx, ws, row.id, 'target', set.targetReleases);
        if (set.foundReleases) await setTicketReleases(trx, ws, row.id, 'found', set.foundReleases);
        if (set.areas) await setTicketAreas(trx, ws, row.id, set.areas);
        fired = { event: made.event, webhookCount: made.webhooks.length };
      }
      await emit(trx, by(request), {
        type: 'ticket.created',
        subjectId: row.id,
        payload: {
          key: ticketKey(offered.key, number),
          trackId,
          ticketTypeId: typeId,
          parentId,
          ...fired,
        },
      });
      await autoFollow(trx, ws, row.id, user.id);
      if (Object.keys(custom.fields).length > 0) await syncFieldValues(trx, catalog, [row.id]);
      // Formulas see the ticket as created, create effects included (M1-013).
      const computed = await refreshFormulas(trx, catalog, ws, [row.id]);
      const created = await loadTicket(trx, ws, row.id);
      // Required fields (CORE-013 (1), CORE-008 (3)): the values given, defaults and create
      // effects all count.
      const missing = created ? missingRequired(created, form.required) : null;
      if (missing) throw new Rollback({ fields: missing });
      // Every starting value is history too, so "was" finds the first one (ADR-010).
      if (created) {
        await recordChanges(trx, ws, user.id, [
          ...ticketChanges(null, created),
          ...(await customChanges(trx, ws, catalog, created.id, {}, created.fields)),
          ...computed,
        ]);
      }
      return { ticket: created };
    });
    return answer(request, reply, outcome, 201);
  });

  route('PATCH', '/api/v1/tickets/:id', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = params.safeParse(request.params);
    if (!p.success) return invalid(reply);
    const format = requestedFormat(request.query);
    if (!format) return invalid(reply);
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
    const values = contentValues(body, fields, false, format);
    const estimates = await estimateValues(body, ws, fields);
    if (estimates === 'disabled') return reply.code(409).send({ error: 'time_tracking_disabled' });
    // A status comes with a new ticket type only, for a workflow that lacks the one it has.
    if (body.statusId !== undefined && body.ticketTypeId === undefined) {
      fields.statusId = 'without_type_change';
    }
    let parentId: number | null | undefined;
    if (body.parent === null) parentId = null;
    else if (body.parent !== undefined) {
      const parent = await findTicket(request, body.parent);
      if (!parent || parent.row.deleted_at) fields.parent = 'not_found';
      else if (parent.row.id === ticketId) fields.parent = 'self';
      else parentId = parent.row.id;
    }
    if (Object.keys(fields).length > 0) return invalidFields(reply, fields);
    // Permissions and assignability are read before the transaction (see the create route);
    // a ticket that moves meanwhile is refused inside it, so they stay the right track's.
    const held = await request.authz.ticket(found.row);
    const assigneeOk =
      body.assigneeId == null || (await assignable(ws, found.row.track_id, body.assigneeId));
    const catalog = await catalogs.get(ws);
    const gate = await statusGate(db, request, found.row.track_id, found.row.ticket_type_id);

    const outcome = await transact(async (trx): Promise<Outcome> => {
      // Locks in the order every writer takes them: the hierarchy, the track and its type set,
      // its workflow map and the workflow a new type would use, then tickets. A type set change
      // holds its set and then rewrites tickets.
      const structural = body.ticketTypeId !== undefined || body.parent !== undefined;
      if (structural) await shareHierarchy(trx, ws);
      const offered =
        body.ticketTypeId !== undefined ? await offeredTypes(trx, ws, found.row.track_id) : null;
      const typeWorkflow =
        body.ticketTypeId !== undefined
          ? await holdTicketWorkflow(trx, ws, found.row.track_id, body.ticketTypeId)
          : null;
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
      // A new original estimate carries the remaining one along while no time is recorded
      // and the remaining one has not been set apart from it.
      let remainingEstimate = estimates.remaining;
      if (
        estimates.original !== undefined &&
        estimates.remaining === undefined &&
        current.time_spent === 0 &&
        (current.remaining_estimate === null ||
          current.remaining_estimate === current.original_estimate)
      ) {
        remainingEstimate = estimates.original;
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
        originalEstimate: current.original_estimate,
        remainingEstimate: current.remaining_estimate,
        priorityId: current.priority_id,
        closeReasonId: current.close_reason_id,
        visibilityLevelId: current.visibility_level_id,
        labels: current.labels,
        ...had,
      };
      const changes = diff<Record<string, unknown>>(before, {
        ...values,
        texts: undefined,
        ticketTypeId: body.ticketTypeId,
        parentId,
        assigneeId: body.assigneeId,
        requesterId: body.requesterId,
        priorityId: body.priorityId,
        closeReasonId: body.closeReasonId,
        visibilityLevelId: body.visibilityLevelId,
        originalEstimate: estimates.original,
        remainingEstimate,
        ...lists,
      });
      // Custom values (M1-010), checked for the type the ticket will have.
      let customFields: FieldValues | null = null;
      if (body.fields !== undefined) {
        const custom = await checkCustomValues(
          trx,
          catalog,
          {
            workspaceId: ws,
            trackId: current.track_id,
            ticketTypeId: body.ticketTypeId ?? current.ticket_type_id,
          },
          channelOf(request),
          current.fields,
          body.fields,
          false,
        );
        if (!custom.ok) return { fields: custom.errors };
        for (const key of new Set([
          ...Object.keys(current.fields),
          ...Object.keys(custom.fields),
        ])) {
          const from = current.fields[key];
          const to = custom.fields[key];
          if (canonicalJson(from ?? null) !== canonicalJson(to ?? null)) {
            changes[historyName(Number(key))] = { from: from ?? null, to: to ?? null };
          }
        }
        if (Object.keys(changes).some((k) => k.startsWith('cf['))) {
          customFields = custom.fields;
          await rememberFieldLabels(trx, ws, custom.labels);
        }
      }
      if (Object.keys(changes).length === 0) return { ticket: current };
      if (customFields !== null && !held.has('edit_tickets')) return { denied: 'edit_tickets' };
      // The edit layout and field rules of the type the ticket will have (M1-012): fields that
      // change must be on it and not hidden; required ones are checked after the write.
      const at: FormPlacement = {
        trackId: current.track_id,
        ticketTypeId: body.ticketTypeId ?? current.ticket_type_id,
        ruleSetId: current.rule_set_id,
        layoutSetId: current.layout_set_id,
      };
      const form = formFields(resolveLayout(catalog, at, 'edit'));
      const changedKeys = Object.keys(changes).flatMap((k) =>
        k.startsWith('cf[') ? [k] : k === 'parentId' ? ['parent'] : (fieldOfBody(k) ?? []),
      );
      const placed = layoutProblems(catalog, at, form.shown, changedKeys);
      if (placed) return { fields: placed };

      // Each changed field needs its own permission.
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
        ['visibilityLevelId', 'set_visibility_level'],
        ['labels', 'edit_tickets'],
        ['targetReleaseIds', 'edit_tickets'],
        ['foundInReleaseIds', 'edit_tickets'],
        ['areaIds', 'edit_tickets'],
        ['originalEstimate', 'edit_tickets'],
        ['remainingEstimate', 'edit_tickets'],
      ];
      for (const [field, permission] of needs) {
        if (changes[field] && !held.has(permission)) return { denied: permission };
      }
      // Per-status locks (WF-007), for the status the locked row has: an assignee change needs
      // the status's assign list, any other change its edit list. Then the fields only some
      // roles or groups may set (M1-029).
      for (const action of ['edit', 'assign'] as const) {
        const touches = Object.keys(changes).some((k) =>
          action === 'assign' ? k === 'assigneeId' : k !== 'assigneeId',
        );
        const allowed = touches ? gate.check(current.status_id, action) : null;
        if (allowed) {
          return {
            locked: { action, locks: [await statusLock(trx, ws, current.status_id, allowed)] },
          };
        }
      }
      const fieldLocked = fieldLocks(catalog, at, changedKeys, gate.audience);
      if (fieldLocked.size > 0) {
        return { locked: { action: 'edit_field', locks: await fieldLockList(trx, fieldLocked) } };
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
      if (changes.assigneeId && !assigneeOk) {
        return { fields: { assigneeId: 'not_assignable' } };
      }
      if (changes.visibilityLevelId && body.visibilityLevelId != null) {
        const visibility = await trackVisibility(trx, ws, current.track_id);
        if (levelFor(visibility, body.visibilityLevelId) === 'not_in_track') {
          return { fields: { visibilityLevelId: 'not_in_track' } };
        }
      }
      if (changes.requesterId && body.requesterId !== undefined) {
        if (!(await activeUser(ws, body.requesterId)))
          return { fields: { requesterId: 'not_found' } };
      }

      const typeId = body.ticketTypeId ?? current.ticket_type_id;
      const newParentId = parentId === undefined ? current.parent_id : parentId;
      // A type whose workflow lacks the ticket's status takes the status asked for, or that
      // workflow's initial one (M1-028, WF-001 (3)).
      let statusId: number | null = null;
      if (changes.ticketTypeId && typeWorkflow) {
        const statuses = statusIdsOf(typeWorkflow.definition);
        if (body.statusId !== undefined && !statuses.has(body.statusId)) {
          return { fields: { statusId: 'not_in_workflow' } };
        }
        if (!statuses.has(current.status_id)) {
          statusId = body.statusId ?? typeWorkflow.definition.initialStatusId;
          changes.statusId = { from: current.status_id, to: statusId };
        }
      }
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
      if (statusId !== null) set.status_id = statusId;
      if (changes.parentId) set.parent_id = newParentId;
      if (changes.assigneeId) set.assignee_id = body.assigneeId ?? null;
      if (changes.requesterId && body.requesterId !== undefined)
        set.requester_id = body.requesterId;
      if (changes.startDate) set.start_date = values.startDate ?? null;
      if (changes.dueDate) set.due_date = values.dueDate ?? null;
      if (changes.priorityId) set.priority_id = body.priorityId ?? null;
      if (changes.closeReasonId) {
        set.close_reason_id = body.closeReasonId ?? null;
        // The Closed stamp follows the close reason: set (or renewed) with it, cleared with it
        // (WF-008).
        set.closed_at = body.closeReasonId == null ? null : new Date();
      }
      if (changes.labels && values.labels !== undefined) set.labels = values.labels;
      if (changes.visibilityLevelId) set.visibility_level_id = body.visibilityLevelId ?? null;
      if (changes.originalEstimate) set.original_estimate = estimates.original ?? null;
      if (changes.remainingEstimate) set.remaining_estimate = remainingEstimate ?? null;
      if (customFields !== null) set.fields = JSON.stringify(customFields);
      await trx.updateTable('ticket').set(set).where('id', '=', ticketId).execute();
      if (customFields !== null) {
        await syncFieldValues(
          trx,
          catalog,
          [ticketId],
          changedFieldIds(current.fields, customFields),
        );
      }
      if (lists.targetReleaseIds) {
        await setTicketReleases(trx, ws, ticketId, 'target', lists.targetReleaseIds);
      }
      if (lists.foundInReleaseIds) {
        await setTicketReleases(trx, ws, ticketId, 'found', lists.foundInReleaseIds);
      }
      if (lists.areaIds) await setTicketAreas(trx, ws, ticketId, lists.areaIds);
      if (changes.labels) await rememberLabels(trx, ws, values.labels ?? []);
      if (values.texts) {
        const written = Object.fromEntries(
          Object.entries(values.texts).filter(([name]) => changes[name] !== undefined),
        );
        await keepOriginals(trx, ws, ticketId, written, actor(request));
      }
      await emit(trx, by(request), {
        type: 'ticket.updated',
        subjectId: ticketId,
        payload: { key: ticketKey(current.track_key, current.number), changes },
      });
      const editor = actor(request);
      if (editor !== null) await autoFollow(trx, ws, ticketId, editor);
      // Formulas of the ticket and its parents' roll-ups, the one it left included (M1-013).
      const computed = await refreshFormulas(trx, catalog, ws, [ticketId], {
        parents: changes.parentId ? [current.parent_id] : [],
      });
      const updated = await loadTicket(trx, ws, ticketId);
      // A change may not empty a required field; a new type checks all of its required ones.
      const missing = updated
        ? missingRequired(
            updated,
            form.required,
            changes.ticketTypeId ? form.required : changedKeys,
          )
        : null;
      if (missing) throw new Rollback({ fields: missing });
      if (updated) {
        await recordChanges(trx, ws, editor, [
          ...ticketChanges(current, updated),
          ...(await customChanges(trx, ws, catalog, ticketId, current.fields, updated.fields)),
          ...computed,
        ]);
      }
      return { ticket: updated };
    });
    return answer(request, reply, outcome);
  });

  // To another track (CORE-023): new numbers there for the ticket and its subtickets.
  route('POST', '/api/v1/tickets/:id/move', async (request, reply) => {
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
    if (!(await request.authz.canTicket('move_tickets', found.row))) {
      return forbidden(reply, 'move_tickets');
    }
    if (!(await request.authz.can('create_tickets', targetId))) {
      return forbidden(reply, 'create_tickets');
    }
    if (
      body.visibilityLevelId !== undefined &&
      !(await request.authz.can('set_visibility_level', targetId))
    ) {
      return forbidden(reply, 'set_visibility_level');
    }
    let parentId: number | null | undefined;
    if (body.parent === null) parentId = null;
    else if (body.parent !== undefined) {
      const parent = await findTicket(request, body.parent);
      if (!parent || parent.row.deleted_at) return invalidFields(reply, { parent: 'not_found' });
      if (parent.row.id === ticketId) return invalidFields(reply, { parent: 'self' });
      parentId = parent.row.id;
    }

    const catalog = await catalogs.get(ws);
    const gate = await statusGate(db, request, sourceId, found.row.ticket_type_id);
    const outcome = await transact(async (trx): Promise<Outcome> => {
      // The hierarchy, then the target track, its type set, its workflow map and the workflows
      // it names (the types are known once the tickets are locked), then tickets.
      await shareHierarchy(trx, ws);
      const offered = await offeredTypes(trx, ws, targetId);
      if (!offered) return { missing: true };
      if (offered.archived) return { conflict: 'track_archived' };
      const targetFlows = await holdMapWorkflows(trx, ws, targetId);
      if (!targetFlows) return { missing: true };
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
      // A move edits the ticket: a status that limits editing limits moving (WF-007).
      const lockedEdit = gate.check(current.status_id, 'edit');
      if (lockedEdit) {
        return {
          locked: {
            action: 'edit',
            locks: [await statusLock(trx, ws, current.status_id, lockedEdit)],
          },
        };
      }

      const fields: FieldErrors = {};
      const typeId =
        body.ticketTypeId ??
        (offered.typeIds.has(current.ticket_type_id) ? current.ticket_type_id : null);
      if (typeId === null) fields.ticketTypeId = 'required';
      else if (!offered.typeIds.has(typeId)) fields.ticketTypeId = 'not_in_track';
      else if (
        body.statusId !== undefined &&
        !statusIdsOf(targetFlows.forType(typeId).definition).has(body.statusId)
      ) {
        // The status asked for belongs to the workflow the ticket's type has there (M1-028).
        fields.statusId = 'not_in_workflow';
      }

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
      // A status the target workflow lacks becomes the one asked for, or its initial status.
      // The close reason stays: only transitions, layouts and effects set or clear it.
      // The ticket and its subtickets take the level asked for, else the target's default
      // (IAM-011 (2)).
      const levelId = levelFor(await trackVisibility(trx, ws, targetId), body.visibilityLevelId);
      if (levelId === 'not_in_track') {
        throw new Rollback({ fields: { visibilityLevelId: levelId } });
      }
      await trx
        .updateTable('ticket')
        .set({ visibility_level_id: levelId })
        .where('id', 'in', touched)
        .execute();
      // Each ticket's workflow there is the one the target's map gives its type (M1-028): a
      // status it lacks becomes the one asked for when that workflow has it, else its initial
      // status.
      const statusMoves = new Map<number, number[]>();
      for (const t of before.values()) {
        const newType =
          t.id === ticketId ? (typeId as number) : (subticketTypes.get(t.id) as number);
        const flow = targetFlows.forType(newType).definition;
        const statuses = statusIdsOf(flow);
        if (statuses.has(t.status_id)) continue;
        const to =
          body.statusId !== undefined && statuses.has(body.statusId)
            ? body.statusId
            : flow.initialStatusId;
        statusMoves.set(to, [...(statusMoves.get(to) ?? []), t.id]);
      }
      for (const [to, ids] of statusMoves) {
        await trx.updateTable('ticket').set({ status_id: to }).where('id', 'in', ids).execute();
      }
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
      // Custom release and area values name the old track's objects, as the system ones do.
      const lostValues = [];
      for (const t of before.values()) {
        const kept = withoutTrackValues(catalog, t.fields);
        if (kept === null) continue;
        await trx
          .updateTable('ticket')
          .set({ fields: JSON.stringify(kept) })
          .where('id', '=', t.id)
          .execute();
        lostValues.push(...(await customChanges(trx, ws, catalog, t.id, t.fields, kept)));
      }
      await syncFieldValues(trx, catalog, touched);
      // Formulas apply per track and type, and the parent left behind loses a child (M1-013).
      const computed = await refreshFormulas(trx, catalog, ws, touched, {
        parents: [current.parent_id],
      });
      await recordChanges(trx, ws, actor(request), [
        ...changesOf(before, await loadTickets(trx, ws, touched)),
        ...lostValues,
        ...computed,
      ]);
      return { ticket: await loadTicket(trx, ws, ticketId) };
    });
    return answer(request, reply, outcome);
  });

  /** A ticket's workflow (its track's map, for its type): the published version. */
  async function workflowOf(d: Db, ws: number, trackId: number, ticketTypeId: number) {
    const workflowId = await ticketWorkflowId(d, ws, trackId, ticketTypeId);
    const row = await d
      .selectFrom('workflow')
      .select('published_version')
      .where('id', '=', workflowId)
      .executeTakeFirstOrThrow();
    return { workflowId, version: row.published_version };
  }

  /** The values a transition layout was given, in engine form; problems in `fields`. */
  function layoutValues(given: Record<string, unknown>, fields: FieldErrors) {
    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(given)) {
      if (!isKnownField(name)) fields[name] = 'unknown';
      else if (!isWritableField(name)) fields[name] = 'not_writable';
      else {
        const parsed = parseField(name, value);
        if (parsed.ok) out[name] = parsed.value;
        else fields[name] = parsed.problem;
      }
    }
    return out;
  }

  /**
   * Runs a transition through the engine (M1-024 to M1-027): guards, checks and rules first,
   * then the essential effects in their fixed order: status and layout values with the optional
   * effects, history, store, event (WF-005). A refusal changes nothing.
   */
  async function runTransition(
    request: Caller,
    found: TicketRow,
    pick: { transitionId: number } | { event: string },
    entered: Record<string, unknown>,
    channel: 'ui' | 'rest' | 'automation',
    version?: number,
  ): Promise<Outcome> {
    const ws = request.workspaceId;
    const ticketId = found.id;
    // Who is asking, and who could become the assignee, are read before the transaction: a
    // transaction never waits for a second pooled connection, which under load would leave
    // every connection waiting for another.
    const actor = await engineActor(request, found.track_id);
    const candidates = await assignableAmong(ws, found.track_id, [
      request.user?.id,
      found.requester_id,
      ...(await ownersOf(found)),
      entered.assignee == null ? undefined : Number(entered.assignee),
    ]);
    const catalog = await catalogs.get(ws);
    return transactAll(async (trx): Promise<Outcome> => {
      // The track, its map and the workflow it gives the ticket's type, the values given, then
      // the ticket (lock order in workflows/store): a publish or a change of map waits, or this
      // waits for it.
      await trx
        .selectFrom('track')
        .select('id')
        .where('id', '=', found.track_id)
        .forKeyShare()
        .execute();
      const held = await holdTicketWorkflow(trx, ws, found.track_id, found.ticket_type_id);
      if (!held) return { missing: true };
      const { workflow } = await engineWorkflow(trx, ws, held.id, held.published_version);
      const reference = (name: string) =>
        entered[name] === undefined || entered[name] === null ? undefined : Number(entered[name]);
      const list = (name: string) => (entered[name] as string[] | undefined)?.map(Number) ?? [];
      const pointed = await holdValues(trx, ws, {
        priorityId: reference('priority'),
        closeReasonId: reference('close-reason'),
        releaseIds: [...list('target-release'), ...list('found-in-release')],
        areaIds: list('area'),
      });
      const locked = await lockTicketRow(trx, ws, ticketId);
      if (!locked) return { missing: true };
      // Another track or type means another workflow than the one held.
      if (locked.track_id !== found.track_id || locked.ticket_type_id !== found.ticket_type_id) {
        return { conflict: 'moved_meanwhile' };
      }
      if (version !== undefined && version !== locked.version) return { versionConflict: true };
      // A ticket a status migration has not reached yet moves first, as it would (M1-028).
      const current = await settleStatus(trx, catalog, ws, locked, statusIdsOf(held.definition));
      const state = await ticketState(trx, ws, current);
      let transitionId: string | undefined;
      if ('transitionId' in pick) {
        transitionId = String(pick.transitionId);
      } else {
        // The first transition the event triggers that the engine offers from here.
        const offered = new Set(engine.availableTransitions(workflow, state, actor, channel));
        transitionId = held.definition.transitions
          .filter((t) => t.triggers?.some((x) => x.event === pick.event))
          .map((t) => String(t.id))
          .find((id) => offered.has(id));
        if (transitionId === undefined) {
          return { conflict: 'no_transition_for_event', detail: { event: pick.event } };
        }
      }
      const result = engine.transition(workflow, state, actor, {
        transition: transitionId,
        channel,
        fields: entered,
        now: new Date().toISOString(),
      });
      if (result.outcome === 'blocked') {
        if (result.by === 'unknown-transition' || result.by === 'wrong-status') {
          return {
            conflict: 'transition_unavailable',
            detail: { transitionId: Number(transitionId) },
          };
        }
        if (result.by === 'permission') {
          const allowed = (
            held.definition.statusPermissions?.[String(current.status_id)]?.transition ?? []
          ).map((p) =>
            'role' in p
              ? { type: 'role' as const, id: Number(p.role) }
              : { type: 'group' as const, id: Number(p.group) },
          );
          return {
            conflict: 'forbidden_in_status',
            detail: {
              permission: 'transition',
              reason: result.message ?? '',
              locks: [await statusLock(trx, ws, current.status_id, allowed)],
            },
          };
        }
        // A check says which one refused, so a client can word it in its own language: the
        // check's parameters, and whether an administrator wrote the message (WF-004).
        const refusedCheck =
          result.by === 'check'
            ? (() => {
                const checks = held.definition.transitions.find(
                  (t) => String(t.id) === transitionId,
                )?.checks;
                const failed =
                  checks?.find((c) => c.type === result.name && c.message === result.message) ??
                  checks?.find((c) => c.type === result.name && c.message === undefined);
                if (!failed) return undefined;
                const { message, ...params } = failed;
                return { ...params, configured: message !== undefined };
              })()
            : undefined;
        return {
          conflict: 'transition_refused',
          detail: {
            by: result.by,
            name: result.name,
            ...(result.message ? { message: result.message } : {}),
            ...(refusedCheck ? { check: refusedCheck } : {}),
          },
        };
      }
      // Field rules apply to the transition's layout too (M1-012): a hidden field takes no
      // value there, and a required one must have one once the transition is done.
      const at: FormPlacement = {
        trackId: current.track_id,
        ticketTypeId: current.ticket_type_id,
        ruleSetId: current.rule_set_id,
        layoutSetId: current.layout_set_id,
      };
      const transition = held.definition.transitions.find((t) => String(t.id) === transitionId);
      const hiddenGiven = Object.keys(entered).filter(
        (name) => ruleOf(catalog, at, ruleKeyOfWorkflowField(name)).hidden,
      );
      if (hiddenGiven.length > 0) {
        return { fields: Object.fromEntries(hiddenGiven.map((name) => [name, 'hidden'])) };
      }
      // A value the person enters on the layout needs the field's editors too (M1-029).
      const fieldLocked = fieldLocks(
        catalog,
        at,
        Object.keys(entered).map(ruleKeyOfWorkflowField),
        audienceOf(actor),
      );
      if (fieldLocked.size > 0) {
        return { locked: { action: 'edit_field', locks: await fieldLockList(trx, fieldLocked) } };
      }
      const stored = storedChanges(current, result.ticket);
      if (!stored.ok) return { fields: { [stored.field]: stored.problem } };
      const changes = stored.changes;
      // What the transition points at must exist; a new assignee must be assignable.
      if (changes.assigneeId != null && !candidates.has(changes.assigneeId)) {
        return { fields: { assignee: 'not_assignable' } };
      }
      if (changes.priorityId != null || changes.closeReasonId != null) {
        const exists = await holdValues(trx, ws, {
          priorityId: changes.priorityId,
          closeReasonId: changes.closeReasonId,
        });
        if (changes.priorityId != null && !exists.priority)
          return { fields: { priority: 'not_found' } };
        if (changes.closeReasonId != null && !exists.closeReason) {
          return { fields: { 'close-reason': 'not_found' } };
        }
      }
      const lists = [
        ['target-release', pointed.releases, changes.targetReleases, current.target_releases],
        ['found-in-release', pointed.releases, changes.foundReleases, current.found_releases],
        ['area', pointed.areas, changes.areas, current.areas],
      ] as const;
      for (const [name, values, next, had] of lists) {
        if (!next) continue;
        const problem = placementOf(
          values,
          current.track_id,
          next,
          had.map((v) => v.id),
        );
        if (problem) return { fields: { [name]: problem } };
      }
      await trx
        .updateTable('ticket')
        .set({ ...changes.ticket, version: current.version + 1, updated_at: new Date() })
        .where('id', '=', ticketId)
        .execute();
      if (changes.targetReleases) {
        await setTicketReleases(trx, ws, ticketId, 'target', changes.targetReleases);
      }
      if (changes.foundReleases) {
        await setTicketReleases(trx, ws, ticketId, 'found', changes.foundReleases);
      }
      if (changes.areas) await setTicketAreas(trx, ws, ticketId, changes.areas);
      if (changes.ticket.labels) await rememberLabels(trx, ws, changes.ticket.labels as string[]);
      // Effects may have moved what formulas read: dates, estimates, the close (M1-013).
      const computed = await refreshFormulas(trx, catalog, ws, [ticketId]);
      const updated = await loadTicket(trx, ws, ticketId);
      // Required fields of the layout left empty, named as the layout names them.
      const missing = (transition?.layout ?? []).filter((name) => {
        const key = ruleKeyOfWorkflowField(name);
        return (
          updated !== undefined && ruleOf(catalog, at, key).required && isEmptyOn(updated, key)
        );
      });
      if (missing.length > 0) {
        throw new Rollback({
          fields: Object.fromEntries(missing.map((name) => [name, 'required'])),
        });
      }
      if (updated) {
        await recordChanges(
          trx,
          ws,
          request.user?.id ?? null,
          [...ticketChanges(current, updated), ...computed].map((c) => ({
            ...c,
            transitionId: Number(transitionId),
          })),
        );
      }
      await emit(trx, by(request), {
        type: 'ticket.transitioned',
        subjectId: ticketId,
        payload: {
          key: ticketKey(current.track_key, current.number),
          transitionId: Number(transitionId),
          from: current.status_id,
          to: Number(result.ticket.status),
          workflowId: held.id,
          version: held.published_version,
          event: result.event,
          webhookCount: result.webhooks.length,
          channel,
        },
      });
      return { ticket: updated };
    });
  }

  // The transitions a ticket offers to the caller (WF-001, WF-003), with the layout each asks
  // for and its properties (WF-006); none without "Transition tickets".
  route('GET', '/api/v1/tickets/:id/transitions', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = params.safeParse(request.params);
    if (!p.success) return invalid(reply);
    const ws = request.workspaceId;
    const found = await findTicket(request, p.data.id);
    if (!found || found.row.deleted_at) return notFound(reply);
    const row = found.row;
    if (row.track_archived_at || !(await request.authz.canTicket('transition_tickets', row))) {
      return { transitions: [] };
    }
    const { workflowId, version } = await workflowOf(db, ws, row.track_id, row.ticket_type_id);
    const { definition, workflow } = await engineWorkflow(db, ws, workflowId, version);
    // A ticket a status migration has not reached yet offers what its mapped status offers
    // (M1-028): a transition moves it there first.
    const pending = statusIdsOf(definition).has(row.status_id)
      ? null
      : await pendingTarget(db, row);
    const offered = new Set(
      engine.availableTransitions(
        workflow,
        await ticketState(db, ws, pending ? { ...row, status_id: pending.to_status_id } : row),
        await engineActor(request, row.track_id),
        channelOf(request),
      ),
    );
    const transitions = definition.transitions.filter((t) => offered.has(String(t.id)));
    const statuses = await statusInfo(
      db,
      ws,
      transitions.map((t) => t.to),
    );
    return {
      transitions: transitions.map((t) => ({
        id: t.id,
        name: t.name,
        to: { id: t.to, ...(statuses.get(t.to) ?? { name: '', stage: 'new' }) },
        layout: t.layout ?? [],
        properties: t.properties ?? {},
      })),
    };
  });

  route('POST', '/api/v1/tickets/:id/transitions', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const p = params.safeParse(request.params);
    if (!p.success) return invalid(reply);
    const parsed = transitionBody.safeParse(request.body);
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const body = parsed.data;
    const found = await findTicket(request, p.data.id);
    if (!found) return notFound(reply);
    if (found.row.deleted_at) return inTrash(request, reply, found.row);
    if (found.row.track_archived_at) return reply.code(409).send({ error: 'track_archived' });
    const held = await request.authz.ticket(found.row);
    if (!held.has('transition_tickets')) return forbidden(reply, 'transition_tickets');
    const given = body.fields ?? {};
    if ('assignee' in given && !held.has('assign_tickets'))
      return forbidden(reply, 'assign_tickets');
    if ('close-reason' in given && !held.has('set_close_reason')) {
      return forbidden(reply, 'set_close_reason');
    }
    if (body.comment !== undefined) {
      // Comments arrive with M1-017; until then a transition takes none.
      return invalidFields(reply, { comment: 'unsupported' });
    }
    const fields: FieldErrors = {};
    const entered = layoutValues(given, fields);
    if (Object.keys(fields).length > 0) return invalidFields(reply, fields);
    const outcome = await runTransition(
      request,
      found.row,
      { transitionId: body.transitionId },
      entered,
      channelOf(request),
      body.version,
    );
    if ('conflict' in outcome && outcome.conflict === 'forbidden_in_status') {
      return reply.code(403).send({ error: 'forbidden', ...(outcome.detail ?? {}) });
    }
    return answer(request, reply, outcome);
  });

  // An external event moves a ticket along the first transition it triggers that is offered,
  // as automation (M1-024): the hook M2's development integrations call.
  route('POST', '/api/v1/tickets/:id/trigger', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = params.safeParse(request.params);
    if (!p.success) return invalid(reply);
    const parsed = z
      .object({ event: z.string().regex(/^[a-z][a-z0-9.:-]{0,199}$/) })
      .strict()
      .safeParse(request.body);
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const found = await findTicket(request, p.data.id);
    if (!found) return notFound(reply);
    if (found.row.deleted_at) return inTrash(request, reply, found.row);
    if (found.row.track_archived_at) return reply.code(409).send({ error: 'track_archived' });
    if (!(await request.authz.canTicket('transition_tickets', found.row))) {
      return forbidden(reply, 'transition_tickets');
    }
    const outcome = await runTransition(
      request,
      found.row,
      { event: parsed.data.event },
      {},
      'automation',
    );
    if ('conflict' in outcome && outcome.conflict === 'forbidden_in_status') {
      return reply.code(403).send({ error: 'forbidden', ...(outcome.detail ?? {}) });
    }
    return answer(request, reply, outcome);
  });

  // The global rank (AGL-009): before or after another ticket, or to the top or bottom.
  route('PUT', '/api/v1/tickets/:id/rank', async (request, reply) => {
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
    if (!(await request.authz.canTicket('schedule_tickets', found.row))) {
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
  route('DELETE', '/api/v1/tickets/:id', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const p = params.safeParse(request.params);
    if (!p.success) return invalid(reply);
    const ws = request.workspaceId;
    const found = await findTicket(request, p.data.id);
    if (!found) return notFound(reply);
    if (found.row.deleted_at) return inTrash(request, reply, found.row);
    if (found.row.track_archived_at) return reply.code(409).send({ error: 'track_archived' });
    if (!(await request.authz.canTicket('delete_tickets', found.row))) {
      return forbidden(reply, 'delete_tickets');
    }
    const ticketId = found.row.id;
    const catalog = await catalogs.get(ws);
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
      // Tickets in the trash have no side rows; they come back with them (ADR-008).
      await syncFieldValues(trx, catalog, touched);
      // The parent's roll-ups lose a child; tickets in the trash keep their values (M1-013).
      const computed = await refreshFormulas(trx, catalog, ws, [], {
        parents: [before.get(ticketId)?.parent_id],
      });
      await recordChanges(trx, ws, user.id, [
        ...changesOf(before, await loadTickets(trx, ws, touched)),
        ...computed,
      ]);
      return { ticket: await loadTicket(trx, ws, ticketId) };
    });
    const refused = refusal(reply, outcome);
    if (refused) return refused;
    return reply.code(204).send();
  });

  route('POST', '/api/v1/tickets/:id/restore', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = params.safeParse(request.params);
    if (!p.success) return invalid(reply);
    const ws = request.workspaceId;
    const found = await findTicket(request, p.data.id);
    if (!found) return notFound(reply);
    const row = found.row;
    const mayRestore = await request.authz.canTicket('delete_tickets', row);
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
    const catalog = await catalogs.get(ws);
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
      await syncFieldValues(trx, catalog, touched);
      // Restored tickets and the children they take back, then their parents (M1-013).
      const computed = await refreshFormulas(trx, catalog, ws, touched);
      await recordChanges(trx, ws, actor(request), [
        ...changesOf(before, await loadTickets(trx, ws, touched)),
        ...computed,
      ]);
      return { ticket: await loadTicket(trx, ws, ticketId) };
    });
    return answer(request, reply, outcome);
  });
  return routes;
}
