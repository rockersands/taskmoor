import type { Database, JsonValue, PlanDraftField, PlanDraftOrigin } from '@taskmoor/db';
import { type Kysely, type RawBuilder, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { isCalendarDay } from '../tickets/model';
import { filterShape } from './model';

/**
 * Draft changes and scenarios of a Multi-track plan (T-089e; PLN-002, PLN-003; ADR-122 stage 6).
 *
 * - A scenario is a named set of draft changes to the plan's tickets; one per plan may be main,
 *   the only one applied from. A draft is one field of one ticket in one scenario: its start day,
 *   its due day or its value in a shared, single-value Team field (`cf:<id>`). It keeps the value
 *   the field had when drafted and the new value; drafting changes nothing about the ticket.
 * - `writeDrafts` is the one writer (the auto-scheduler of T-089f writes through it too): setting
 *   a field back to its live value removes the draft, and every write takes the live value as the
 *   value when drafted, so drafting again after a change made meanwhile is "Keep my draft".
 * - `draftOverlay` gives the views the drafted days and Team values in place of the live ones,
 *   only for tickets the viewer is shown; which tickets a view lists never comes from drafts.
 * - `refusalOf` turns the ticket route's answer into the reason an apply gives for a ticket.
 */
type Db = Kysely<Database> | Transaction<Database>;

const MAX_INT = 2_147_483_647;
const idNum = z.number().int().positive().max(MAX_INT);
const day = z.string().refine(isCalendarDay, 'a calendar day as YYYY-MM-DD');

/** Scenarios a plan holds, main included. */
export const MAX_SCENARIOS = 20;
/** Drafted tickets a scenario holds: a scheduler's preview of a whole listed plan fits. */
export const MAX_DRAFTED_TICKETS = 10_000;
/** Tickets one drafts request holds. */
export const MAX_DRAFT_REQUEST = 200;
/** Tickets one apply request holds; the page loops for more. */
export const MAX_APPLY = 100;
/** An apply holds its scenario this long at most: a hold older than this is stale. */
export const APPLY_STALE_MS = 10 * 60_000;
/** Tickets a page of the change list holds. */
export const CHANGES_PAGE = 100;
/** Tickets a comparison lists as differing; the rest are counted. */
export const DIFFERING = 200;
/** Applies run this many tickets at once, as bulk changes do. */
export const APPLY_CONCURRENCY = 4;

export const LIMITS = {
  scenarios: MAX_SCENARIOS,
  draftedTickets: MAX_DRAFTED_TICKETS,
  perRequest: MAX_DRAFT_REQUEST,
  perApply: MAX_APPLY,
} as const;

/** A drafted value: a day as text, a team's id, or null for none. */
export type DraftValue = string | number | null;

const scenarioName = z.string().trim().min(1).max(100);

export const scenarioParams = z
  .object({
    id: z.coerce.number().int().positive().max(MAX_INT),
    sid: z.coerce.number().int().positive().max(MAX_INT),
  })
  .strict();

export const createScenarioBody = z.object({ name: scenarioName, from: idNum.optional() }).strict();
export const renameScenarioBody = z.object({ name: scenarioName, version: idNum }).strict();
export const versionBody = z.object({ version: idNum }).strict();
export const versionQuery = z.object({ version: z.coerce.number().int().positive().max(MAX_INT) });

export const changesQuery = z
  .object({
    cursor: z.coerce.number().int().min(0).max(MAX_INT).optional(),
    only: z.enum(['ready', 'refused', 'changed']).optional(),
  })
  .strict();

/** One ticket's drafts: its days, and Team values by the Team field's id. */
export const draftChange = z
  .object({
    ticketId: idNum,
    startDate: day.nullable().optional(),
    dueDate: day.nullable().optional(),
    fields: z
      .record(z.string().regex(/^[1-9]\d{0,9}$/), idNum.nullable())
      .refine((f) => Object.keys(f).length <= 20, 'too_many_fields')
      .optional(),
  })
  .strict()
  .refine(
    (c) =>
      c.startDate !== undefined ||
      c.dueDate !== undefined ||
      Object.keys(c.fields ?? {}).length > 0,
    { message: 'nothing_to_draft', path: ['ticketId'] },
  );
export type DraftChangeInput = z.infer<typeof draftChange>;

export const draftsBody = z
  .object({ changes: z.array(draftChange).min(1).max(MAX_DRAFT_REQUEST) })
  .strict()
  .refine((b) => new Set(b.changes.map((c) => c.ticketId)).size === b.changes.length, {
    message: 'duplicate_ticket',
    path: ['changes'],
  });

/** `{ tickets }` or `{ all: true }`, one of the two; a field's error names that field. */
const oneOf = (b: { tickets?: number[] | undefined; all?: true | undefined }) =>
  (b.tickets === undefined) !== (b.all === undefined);
const ticketsOrAll = { message: 'tickets_or_all', path: ['tickets'] };
export const discardBody = z
  .object({
    tickets: z.array(idNum).min(1).max(MAX_DRAFT_REQUEST).optional(),
    all: z.literal(true).optional(),
  })
  .strict()
  .refine(oneOf, ticketsOrAll);
export const applyBody = z
  .object({
    tickets: z.array(idNum).min(1).max(MAX_APPLY).optional(),
    all: z.literal(true).optional(),
    after: z.number().int().min(0).max(MAX_INT).optional(),
  })
  .strict()
  .refine(oneOf, ticketsOrAll);

const side = z.union([z.literal('live'), z.string().regex(/^[1-9]\d{0,9}$/)]);
export const compareQuery = z
  .object({
    ...filterShape,
    a: side,
    b: side,
    teamField: z.coerce.number().int().positive().max(MAX_INT).optional(),
  })
  .strict();

/** The draft field of a Team field. */
export const teamKey = (fieldId: number): PlanDraftField => `cf:${fieldId}`;
/** The Team field's id of a draft field, or null for a day. */
export const teamFieldOf = (field: string): number | null =>
  field.startsWith('cf:') ? Number(field.slice(3)) : null;

/** A stored value as a drafted one: JSON null and SQL null are both none. */
export function draftValue(value: JsonValue | null | undefined): DraftValue {
  if (typeof value === 'string' || typeof value === 'number') return value;
  return null;
}

export const sameValue = (a: DraftValue, b: DraftValue) =>
  a === null || b === null ? a === b : String(a) === String(b);

/** The live value of a field on a ticket row: days as text, a Team value as a number. */
export function liveValue(
  ticket: { start_date: string | null; due_date: string | null; fields: unknown },
  field: string,
): DraftValue {
  if (field === 'startDate') return ticket.start_date;
  if (field === 'dueDate') return ticket.due_date;
  const id = teamFieldOf(field);
  const fields = (ticket.fields ?? {}) as Record<string, unknown>;
  const v = id === null ? null : fields[String(id)];
  return typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null;
}

/** A draft's live value in SQL, as JSON (`d` the draft, `k` its ticket); JSON null for none. */
export const LIVE_JSON = sql<JsonValue>`COALESCE(CASE d.field
    WHEN 'startDate' THEN to_jsonb(k.start_date::text)
    WHEN 'dueDate' THEN to_jsonb(k.due_date::text)
    ELSE k.fields -> substr(d.field, 4) END, 'null'::jsonb)`;
/** The field's live value is its draft's new value: applying it changes nothing. */
export const ALREADY = sql<boolean>`(${LIVE_JSON} = COALESCE(d.new_value, 'null'::jsonb))`;
/** The field changed since drafted, to something other than the draft. */
export const CHANGED = sql<boolean>`(${LIVE_JSON} <> COALESCE(d.old_value, 'null'::jsonb)
  AND NOT ${ALREADY})`;

/**
 * A scenario's drafts over ticket `k` for the views: `join` goes after the ticket's joins, and
 * `start`, `due` and `team(fieldId)` read the drafted value where that field is drafted and the
 * live column otherwise. Only drafts on tickets that `shown` holds apply (the viewer's plan), so
 * drafts on tickets hidden from the viewer change nothing they read. Without a scenario every
 * expression is the live column and `join` is empty.
 */
export interface DraftOverlay {
  join: RawBuilder<unknown>;
  start: RawBuilder<string | null>;
  due: RawBuilder<string | null>;
  team(fieldId: number | null): RawBuilder<number | null>;
  /** Whether the ticket has a draft in the scenario (false without one). */
  drafted: RawBuilder<boolean>;
}

const liveTeam = (fieldId: number | null, alias = 'k') =>
  fieldId === null
    ? sql<number | null>`NULL::bigint`
    : sql<
        number | null
      >`(CASE WHEN jsonb_typeof(${sql.ref(alias)}.fields -> ${String(fieldId)}::text) = 'number'
        THEN (${sql.ref(alias)}.fields ->> ${String(fieldId)}::text)::numeric::bigint END)`;

export function draftOverlay(
  scenarioId: number | null,
  shown: RawBuilder<boolean> | null,
  alias = 'dr',
): DraftOverlay {
  if (scenarioId === null || shown === null) {
    return {
      join: sql``,
      start: sql`k.start_date`,
      due: sql`k.due_date`,
      team: (fieldId) => liveTeam(fieldId),
      drafted: sql<boolean>`false`,
    };
  }
  const a = sql.ref(alias);
  const col = (name: string) => sql.ref(`${alias}.${name}`);
  return {
    join: sql`LEFT JOIN LATERAL (
        SELECT bool_or(d.field = 'startDate') AS has_start,
               max(d.new_value #>> '{}') FILTER (WHERE d.field = 'startDate') AS start,
               bool_or(d.field = 'dueDate') AS has_due,
               max(d.new_value #>> '{}') FILTER (WHERE d.field = 'dueDate') AS due,
               jsonb_object_agg(d.field, COALESCE(d.new_value, 'null'::jsonb)) AS vals
          FROM plan_draft d
         WHERE d.scenario_id = ${scenarioId}::int AND d.ticket_id = k.id AND ${shown}) ${a} ON true`,
    start: sql`(CASE WHEN ${col('has_start')} THEN (${col('start')})::date ELSE k.start_date END)`,
    due: sql`(CASE WHEN ${col('has_due')} THEN (${col('due')})::date ELSE k.due_date END)`,
    team: (fieldId) =>
      fieldId === null
        ? sql<number | null>`NULL::bigint`
        : sql<number | null>`(CASE WHEN ${col('vals')} ? ${`cf:${fieldId}`}::text
            THEN (CASE WHEN jsonb_typeof(${col('vals')} -> ${`cf:${fieldId}`}::text) = 'number'
                       THEN (${col('vals')} ->> ${`cf:${fieldId}`}::text)::numeric::bigint END)
            ELSE ${liveTeam(fieldId)} END)`,
    drafted: sql<boolean>`(${col('vals')} IS NOT NULL)`,
  };
}

/** One field to draft, checked by the caller: the ticket is the plan's and the value valid. */
export interface DraftWrite {
  ticketId: number;
  field: PlanDraftField;
  value: DraftValue;
  /** The field's live value now. */
  live: DraftValue;
}

export interface WrittenDrafts {
  set: { ticketId: number; field: string; from: DraftValue; to: DraftValue }[];
  removed: { ticketId: number; field: string }[];
}

/**
 * Writes drafts into a scenario (the caller holds the scenario's row lock). A value equal to the
 * live one removes the field's draft; any other is stored with the live value as its value when
 * drafted, its refusal cleared. The last write wins.
 */
export async function writeDrafts(
  trx: Transaction<Database>,
  options: {
    workspaceId: number;
    planId: number;
    scenarioId: number;
    updatedBy: number;
    origin: PlanDraftOrigin;
    changes: readonly DraftWrite[];
  },
): Promise<WrittenDrafts> {
  const out: WrittenDrafts = { set: [], removed: [] };
  if (options.changes.length === 0) return out;
  const ticketIds = [...new Set(options.changes.map((c) => c.ticketId))];
  const before = new Map(
    (
      await trx
        .selectFrom('plan_draft')
        .select(['ticket_id', 'field', 'new_value'])
        .where('scenario_id', '=', options.scenarioId)
        .where('ticket_id', 'in', ticketIds)
        .execute()
    ).map((r) => [`${r.ticket_id}/${r.field}`, draftValue(r.new_value)]),
  );
  const toRemove: DraftWrite[] = [];
  const toSet: DraftWrite[] = [];
  for (const c of options.changes) {
    const key = `${c.ticketId}/${c.field}`;
    if (sameValue(c.value, c.live)) {
      if (before.has(key)) {
        toRemove.push(c);
        out.removed.push({ ticketId: c.ticketId, field: c.field });
      }
      continue;
    }
    toSet.push(c);
    const had = before.has(key) ? (before.get(key) as DraftValue) : c.live;
    out.set.push({ ticketId: c.ticketId, field: c.field, from: had, to: c.value });
  }
  if (toRemove.length > 0) {
    await sql`
      DELETE FROM plan_draft d
       USING unnest(${toRemove.map((c) => c.ticketId)}::int[],
                    ${toRemove.map((c) => c.field)}::text[]) AS x(ticket_id, field)
       WHERE d.scenario_id = ${options.scenarioId}::int
         AND d.ticket_id = x.ticket_id AND d.field = x.field`.execute(trx);
  }
  if (toSet.length > 0) {
    const asJson = (v: DraftValue) => (v === null ? null : JSON.stringify(v));
    await trx
      .insertInto('plan_draft')
      .values(
        toSet.map((c) => ({
          workspace_id: options.workspaceId,
          plan_id: options.planId,
          scenario_id: options.scenarioId,
          ticket_id: c.ticketId,
          field: c.field,
          team_field_id: teamFieldOf(c.field),
          old_value: asJson(c.live),
          new_value: asJson(c.value),
          origin: options.origin,
          updated_by: options.updatedBy,
          updated_at: new Date(),
          refusal: null,
          refused_at: null,
        })),
      )
      .onConflict((oc) =>
        oc.columns(['scenario_id', 'ticket_id', 'field']).doUpdateSet((eb) => ({
          old_value: eb.ref('excluded.old_value'),
          new_value: eb.ref('excluded.new_value'),
          origin: eb.ref('excluded.origin'),
          updated_by: eb.ref('excluded.updated_by'),
          updated_at: eb.ref('excluded.updated_at'),
          refusal: null,
          refused_at: null,
        })),
      )
      .execute();
  }
  return out;
}

/** Why an apply left a ticket unchanged (PLN-002 (3)). */
export type RefusalReason =
  | 'no_permission'
  | 'locked'
  | 'track_archived'
  | 'gone'
  | 'changed_meanwhile'
  | 'invalid'
  | 'failed';

export interface Refusal {
  reason: RefusalReason;
  permission?: string;
  locks?: unknown;
  fields?: Record<string, string>;
  /** The drafted fields' values now, for `changed_meanwhile`. */
  now?: Record<string, DraftValue>;
}

/** The reason for a ticket route's answer that was not a success (ADR-122 stage 6's table). */
export function refusalOf(statusCode: number, payload: unknown): Refusal {
  const body = (payload ?? {}) as {
    error?: string;
    permission?: string;
    locks?: unknown;
    fields?: Record<string, string>;
  };
  if (statusCode === 403 && body.locks !== undefined) {
    return {
      reason: 'locked',
      locks: body.locks,
      ...(body.permission ? { permission: body.permission } : {}),
    };
  }
  if (statusCode === 403 && body.error === 'forbidden') {
    return { reason: 'no_permission', ...(body.permission ? { permission: body.permission } : {}) };
  }
  if (statusCode === 409 && body.error === 'track_archived') return { reason: 'track_archived' };
  if (statusCode === 404 || (statusCode === 409 && body.error === 'in_trash')) {
    return { reason: 'gone' };
  }
  if (
    statusCode === 409 &&
    (body.error === 'version_conflict' || body.error === 'moved_meanwhile')
  ) {
    return { reason: 'changed_meanwhile' };
  }
  if (statusCode === 400 && body.error === 'invalid_fields') {
    return { reason: 'invalid', ...(body.fields ? { fields: body.fields } : {}) };
  }
  return { reason: 'failed' };
}

/** Plan scenarios one plan holds, in order: main first, then by name. */
export function scenarioRows(db: Db, ws: number, planId: number) {
  return db
    .selectFrom('plan_scenario as s')
    .innerJoin('app_user as u', 'u.id', 's.created_by')
    .select([
      's.id',
      's.name',
      's.main',
      's.created_by',
      'u.name as created_by_name',
      's.applying_since',
      's.version',
      's.created_at',
      's.updated_at',
    ])
    .where('s.workspace_id', '=', ws)
    .where('s.plan_id', '=', planId);
}

/** How a view marks a drafted ticket: the drafted fields' live values, and whether any is stale. */
export interface DraftMark {
  startDate?: { now: string | null };
  dueDate?: { now: string | null };
  /** Team values by the Team field's id. */
  fields?: Record<string, { now: number | null }>;
  /** A drafted field changed since drafted. */
  stale: boolean;
}

/** The marks of these tickets' drafts in a scenario; the caller passes only tickets it shows. */
export async function draftMarks(
  db: Db,
  scenarioId: number | null,
  ticketIds: readonly number[],
): Promise<Map<number, DraftMark>> {
  const out = new Map<number, DraftMark>();
  if (scenarioId === null || ticketIds.length === 0) return out;
  const rows = (
    await sql<{ ticket_id: number; field: string; live: JsonValue; changed: boolean }>`
      SELECT d.ticket_id, d.field, ${LIVE_JSON} AS live, ${CHANGED} AS changed
        FROM plan_draft d JOIN ticket k ON k.id = d.ticket_id
       WHERE d.scenario_id = ${scenarioId}::int AND d.ticket_id = ANY(${[...ticketIds]}::int[])`.execute(
      db,
    )
  ).rows;
  for (const r of rows) {
    const mark = out.get(r.ticket_id) ?? { stale: false };
    const now = draftValue(r.live);
    if (r.field === 'startDate') mark.startDate = { now: now === null ? null : String(now) };
    else if (r.field === 'dueDate') mark.dueDate = { now: now === null ? null : String(now) };
    else {
      mark.fields = {
        ...(mark.fields ?? {}),
        [String(teamFieldOf(r.field))]: { now: typeof now === 'number' ? now : null },
      };
    }
    if (r.changed) mark.stale = true;
    out.set(r.ticket_id, mark);
  }
  return out;
}

/** Whether a hold on a scenario is still running (set and younger than ten minutes). */
export const applying = (since: Date | null, now = Date.now()) =>
  since !== null && now - since.getTime() < APPLY_STALE_MS;
