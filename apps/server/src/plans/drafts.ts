import type { Database, JsonValue, PlanDraftField, PlanDraftOrigin } from '@taskmoor/db';
import { type Kysely, type RawBuilder, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { type EventContext, emit } from '../events/bus';
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
 *   a field back to its live value removes the draft, and a new value takes the live value as the
 *   value when drafted. A value sent again unchanged (a bar's start sent with its moved end) keeps
 *   the draft as it was, a change made meanwhile still marked; only "Keep my draft" (`keep`) takes
 *   the live value as the value when drafted for a value it sends again. `clearSchedulerDrafts`
 *   removes the auto-scheduler's own drafts that a run no longer proposes (ADR-122 stage 7).
 * - `draftOverlay` gives the views the drafted days and Team values in place of the live ones,
 *   only for tickets the viewer is shown; which tickets a view lists never comes from drafts.
 *   With `{ origin }` it folds only drafts of that origin (a run reads people's drafts only).
 * - `lockPlan`, `lockScenario`, `createScenario`, `draftedTickets` and `TooManyDrafts` are shared
 *   by the scenario routes and the auto-scheduler's run.
 * - `refusalOf` turns the ticket route's answer into the reason an apply gives for a ticket.
 */
type Db = Kysely<Database> | Transaction<Database>;

const MAX_INT = 2_147_483_647;
const idNum = z.number().int().positive().max(MAX_INT);
/** An id written as text (a scenario's in an address, a field's as a key): an int4 at most. */
const idText = z
  .string()
  .regex(/^[1-9]\d{0,9}$/)
  .refine((v) => Number(v) <= MAX_INT, 'too_large');
const day = z.string().refine(isCalendarDay, 'a calendar day as YYYY-MM-DD');

/** Scenarios a plan holds, main included. */
export const MAX_SCENARIOS = 20;
/** Drafted tickets a scenario holds: a scheduler's preview of a whole listed plan fits. */
export const MAX_DRAFTED_TICKETS = 10_000;
/** Tickets one drafts request holds. */
export const MAX_DRAFT_REQUEST = 200;
/**
 * Changes one `writeDrafts` call takes from a caller that writes many (the auto-scheduler): its
 * insert binds 13 values a row and one statement takes at most 65,535.
 */
export const MAX_DRAFT_WRITE = 2_000;
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
      .record(idText, idNum.nullable())
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
  .object({
    changes: z.array(draftChange).min(1).max(MAX_DRAFT_REQUEST),
    /** Keep my draft: each value named takes the live value as its value when drafted. */
    keep: z.literal(true).optional(),
  })
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

const side = z.union([z.literal('live'), idText]);
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
 * expression is the live column and `join` is empty. With `origin`, only drafts of that origin
 * fold (the auto-scheduler reads live days plus people's drafts, ignoring its own earlier run).
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
  options: { origin?: PlanDraftOrigin } = {},
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
  const ofOrigin = options.origin === undefined ? sql`` : sql`AND d.origin = ${options.origin}`;
  return {
    join: sql`LEFT JOIN LATERAL (
        SELECT bool_or(d.field = 'startDate') AS has_start,
               max(d.new_value #>> '{}') FILTER (WHERE d.field = 'startDate') AS start,
               bool_or(d.field = 'dueDate') AS has_due,
               max(d.new_value #>> '{}') FILTER (WHERE d.field = 'dueDate') AS due,
               jsonb_object_agg(d.field, COALESCE(d.new_value, 'null'::jsonb)) AS vals
          FROM plan_draft d
         WHERE d.scenario_id = ${scenarioId}::int AND d.ticket_id = k.id AND ${shown}
               ${ofOrigin}) ${a} ON true`,
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
 * live one removes the field's draft; a new value is stored with the live value as its value when
 * drafted. A field's drafted value sent again is left as it was, its value when drafted included,
 * unless `keep` is set (Keep my draft): then it too takes the live value. A ticket with a field
 * written or removed loses its refusal. The last write wins. A person who drafts a day takes over
 * the auto-scheduler's drafts of that ticket's days.
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
    /** Keep my draft: a value sent again takes the live value as its value when drafted. */
    keep?: boolean;
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
    // The same value again, beside another field's change: the draft stays as it was.
    if (!options.keep && before.has(key) && sameValue(before.get(key) as DraftValue, c.value)) {
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
  // A person who drafts a day of a ticket takes over the auto-scheduler's draft of its other day
  // too (one end of a proposed bar moved, the other resent unchanged or not sent at all). The
  // ticket's days are then all theirs: a run keeps it where both drafted days put it, and no view
  // says "auto-scheduled" beside "Your draft now" (ADR-122 stage 7).
  if (options.origin === 'person') {
    const adopt = [
      ...new Set(
        options.changes
          .filter(
            (c) =>
              (c.field === 'startDate' || c.field === 'dueDate') && !sameValue(c.value, c.live),
          )
          .map((c) => c.ticketId),
      ),
    ];
    if (adopt.length > 0) {
      await trx
        .updateTable('plan_draft')
        .set({ origin: 'person', updated_by: options.updatedBy, updated_at: new Date() })
        .where('scenario_id', '=', options.scenarioId)
        .where('ticket_id', 'in', adopt)
        .where('field', 'in', ['startDate', 'dueDate'])
        .where('origin', '=', 'scheduler')
        .execute();
    }
  }
  // A ticket whose drafts changed is no longer refused: its next apply says again.
  const touched = [...new Set([...out.set, ...out.removed].map((c) => c.ticketId))];
  if (touched.length > 0) {
    await trx
      .updateTable('plan_draft')
      .set({ refusal: null, refused_at: null })
      .where('scenario_id', '=', options.scenarioId)
      .where('ticket_id', 'in', touched)
      .where('refusal', 'is not', null)
      .execute();
  }
  return out;
}

/**
 * Removes the auto-scheduler's drafts on these fields (the caller holds the scenario's row lock):
 * only rows whose origin is still `scheduler`, so a draft a person has taken over since stays. A
 * ticket that lost a draft loses its refusal, as `writeDrafts` does. Returns what went, in ticket
 * and field order.
 */
export async function clearSchedulerDrafts(
  trx: Transaction<Database>,
  scenarioId: number,
  pairs: readonly { ticketId: number; field: string }[],
): Promise<{ ticketId: number; field: string }[]> {
  if (pairs.length === 0) return [];
  const gone = await sql<{ ticket_id: number; field: string }>`
    DELETE FROM plan_draft d
     USING unnest(${pairs.map((p) => p.ticketId)}::int[],
                  ${pairs.map((p) => p.field)}::text[]) AS x(ticket_id, field)
     WHERE d.scenario_id = ${scenarioId}::int AND d.origin = 'scheduler'
       AND d.ticket_id = x.ticket_id AND d.field = x.field
    RETURNING d.ticket_id, d.field`.execute(trx);
  const removed = gone.rows
    .map((r) => ({ ticketId: r.ticket_id, field: r.field }))
    .sort(
      (a, b) => a.ticketId - b.ticketId || (a.field < b.field ? -1 : a.field > b.field ? 1 : 0),
    );
  const touched = [...new Set(removed.map((r) => r.ticketId))];
  if (touched.length > 0) {
    await trx
      .updateTable('plan_draft')
      .set({ refusal: null, refused_at: null })
      .where('scenario_id', '=', scenarioId)
      .where('ticket_id', 'in', touched)
      .where('refusal', 'is not', null)
      .execute();
  }
  return removed;
}

/**
 * Locks the plan's row: making, deleting and promoting scenarios take it first, so each sees the
 * scenarios the others committed (which is main, and whether another exists). A no-key lock, so
 * a draft written meanwhile (whose foreign keys share the plan's key) never waits on it.
 */
export async function lockPlan(trx: Transaction<Database>, planId: number) {
  await trx.selectFrom('plan').select('id').where('id', '=', planId).forNoKeyUpdate().execute();
}

/**
 * Locks a scenario's row, which orders the drafts written to it and the limit on them; undefined
 * when it is gone or of another plan. `applying_since` says whether an apply holds it.
 */
export function lockScenario(trx: Transaction<Database>, planId: number, scenarioId: number) {
  return trx
    .selectFrom('plan_scenario')
    .select(['id', 'applying_since'])
    .where('id', '=', scenarioId)
    .where('plan_id', '=', planId)
    .forUpdate()
    .executeTakeFirst();
}

/** How many drafted tickets a scenario holds in all. */
export async function draftedTickets(q: Db, scenarioId: number) {
  const row = await sql<{ n: number }>`
    SELECT count(DISTINCT ticket_id)::int AS n FROM plan_draft
     WHERE scenario_id = ${scenarioId}::int`.execute(q);
  return row.rows[0]?.n ?? 0;
}

/** A write that would leave a scenario over `MAX_DRAFTED_TICKETS`: its transaction rolls back. */
export class TooManyDrafts extends Error {}

/**
 * Makes a scenario in a plan (`POST /scenarios`, and a run of the auto-scheduler into a new one):
 * takes the plan's row lock, refuses past `MAX_SCENARIOS`, makes the plan's first scenario main,
 * copies `from`'s drafts on tickets `shown` holds with their origin (the rest counted), and emits
 * `plan.scenario_created`. `from` must be a scenario of the plan.
 */
export async function createScenario(
  trx: Transaction<Database>,
  by: EventContext,
  options: {
    workspaceId: number;
    planId: number;
    name: string;
    from?: number | undefined;
    createdBy: number;
    /** The maker's plan without its filters (`unfiltered`); null copies nothing. */
    shown: RawBuilder<boolean> | null;
  },
): Promise<
  | { refused: 'too_many_scenarios' }
  | { fields: { from: 'not_found' } }
  | { id: number; main: boolean; copied: number; notShown: number }
> {
  const { workspaceId: ws, planId, name, from, createdBy, shown } = options;
  // The plan's row orders scenario writes, so two makers never pass the limit together.
  await lockPlan(trx, planId);
  const existing = await trx
    .selectFrom('plan_scenario')
    .select(['id'])
    .where('plan_id', '=', planId)
    .execute();
  if (existing.length >= MAX_SCENARIOS) return { refused: 'too_many_scenarios' };
  if (from !== undefined && !existing.some((s) => s.id === from)) {
    return { fields: { from: 'not_found' } };
  }
  const main = existing.length === 0;
  const made = await trx
    .insertInto('plan_scenario')
    .values({ workspace_id: ws, plan_id: planId, name, main, created_by: createdBy })
    .returning('id')
    .executeTakeFirstOrThrow();
  let copied = 0;
  let notShown = 0;
  if (from !== undefined) {
    const visible = shown ? sql<boolean>`(k.deleted_at IS NULL AND ${shown})` : sql<boolean>`false`;
    const inserted = await sql<{ ticket_id: number }>`
      INSERT INTO plan_draft (workspace_id, plan_id, scenario_id, ticket_id, field,
                              team_field_id, old_value, new_value, origin, updated_by)
      SELECT d.workspace_id, d.plan_id, ${made.id}::int, d.ticket_id, d.field,
             d.team_field_id, d.old_value, d.new_value, d.origin, ${createdBy}::int
        FROM plan_draft d JOIN ticket k ON k.id = d.ticket_id
       WHERE d.scenario_id = ${from}::int AND ${visible}
      RETURNING ticket_id`.execute(trx);
    copied = new Set(inserted.rows.map((r) => r.ticket_id)).size;
    notShown =
      (
        await sql<{ n: number }>`
          SELECT count(DISTINCT d.ticket_id)::int AS n
            FROM plan_draft d JOIN ticket k ON k.id = d.ticket_id
           WHERE d.scenario_id = ${from}::int AND (${visible}) IS NOT TRUE`.execute(trx)
      ).rows[0]?.n ?? 0;
  }
  await emit(trx, by, {
    type: 'plan.scenario_created',
    subjectId: planId,
    payload: { scenarioId: made.id, name, from: from ?? null, drafts: copied, notShown },
  });
  return { id: made.id, main, copied, notShown };
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
  /** `scheduler` when any of the ticket's drafts is the auto-scheduler's, as the change list says. */
  origin: PlanDraftOrigin;
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
    await sql<{
      ticket_id: number;
      field: string;
      live: JsonValue;
      changed: boolean;
      origin: PlanDraftOrigin;
    }>`
      SELECT d.ticket_id, d.field, ${LIVE_JSON} AS live, ${CHANGED} AS changed, d.origin
        FROM plan_draft d JOIN ticket k ON k.id = d.ticket_id
       WHERE d.scenario_id = ${scenarioId}::int AND d.ticket_id = ANY(${[...ticketIds]}::int[])`.execute(
      db,
    )
  ).rows;
  for (const r of rows) {
    const mark: DraftMark = out.get(r.ticket_id) ?? { stale: false, origin: 'person' };
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
    if (r.origin === 'scheduler') mark.origin = 'scheduler';
    out.set(r.ticket_id, mark);
  }
  return out;
}

/** Whether a hold on a scenario is still running (set and younger than ten minutes). */
export const applying = (since: Date | null, now = Date.now()) =>
  since !== null && now - since.getTime() < APPLY_STALE_MS;
