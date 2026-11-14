import type { Database, PlanCapacityUnit, StatusStage } from '@taskmoor/db';
import { QueryError } from '@taskmoor/query';
import type { FastifyRequest } from 'fastify';
import { type Kysely, type RawBuilder, sql, type Transaction } from 'kysely';
import { compileCondition } from '../boards/data';
import type { FieldCatalogs } from '../fields/catalog';
import { planTeams } from '../routes/plans';
import { SearchError } from '../search/bind';
import { readOnly } from '../search/run';
import {
  capacityOf,
  capacityRows,
  elsewhereWork,
  estimateSql,
  membersOf,
  periodIndex,
  pointsField,
  teamCapacity,
} from './capacity';
import { blockingLinks, dependencyOptions } from './dependencies';
import { draftOverlay } from './drafts';
import type { Period } from './periods';
import { browsedTracks, type PlanTickets, planTickets, sourceRows } from './query';
import {
  hundredths,
  MAX_OPEN_READ,
  type ScheduleBody,
  type ScheduleInput,
  type SchedulePerson,
  type ScheduleTeam,
  type ScheduleTicket,
} from './scheduler';
import { inActiveSprint, sprintDay } from './sprints';

/**
 * What one run of the auto-scheduler reads (T-089f; PLN-004; ADR-122 stage 7, "What a run
 * reads"), and the readiness check before it. Everything is read as the runner sees it: the
 * plan's tickets without the views' filters (`unfiltered`), never the trash, through `readOnly`
 * with the plan views' statement timeout, outside the write's transaction.
 *
 * - Open tickets with their days as live days plus people's drafts in the scenario (the
 *   auto-scheduler's own earlier proposal is ignored: the run replaces it).
 * - Capacity and the load already there, counted as the Capacity tab counts it (`capacity.ts`):
 *   the plan's closed tickets due in each period and each person's work elsewhere by whole weeks,
 *   only as totals. The engine adds the open tickets' loads itself.
 * - Blocking links into the open tickets; a blocker outside the plan or hidden from the runner
 *   is only a flag on the ticket it blocks, never read further.
 * - Whether the runner may set each ticket's days (`schedule_tickets`).
 */
type Db = Kysely<Database> | Transaction<Database>;

/** A run's plan: its id, unit and periods. */
export interface RunPlan {
  id: number;
  capacity_unit: PlanCapacityUnit;
}

/** A run's condition (`leaveOut.query` or `keep.query`) that does not compile for the runner. */
export class InvalidCondition extends Error {
  constructor(readonly errors: Record<string, string>) {
    super('invalid condition');
  }
}

/** More open tickets than a run reads (PLN-001's plan size): the run is refused. */
export class PlanTooLarge extends Error {}

/**
 * A ticket's days as the run read them: its live days and the people's drafts of its days in
 * the scenario (`undefined` when none). A ticket whose snapshot differs under the scenario's lock
 * changed while the run worked, and is left out of the write.
 */
export interface DaySnapshot {
  start: string | null;
  due: string | null;
  personStart?: string | null;
  personDue?: string | null;
}

export const snapshotKey = (s: DaySnapshot) =>
  JSON.stringify([
    s.start,
    s.due,
    s.personStart === undefined ? '-' : s.personStart,
    s.personDue === undefined ? '-' : s.personDue,
  ]);

export interface ScheduleInputs {
  input: ScheduleInput;
  tickets: PlanTickets;
  /** Each open ticket read: its days, for the check under the lock. */
  read: Map<number, DaySnapshot>;
  /** The plan's teams by name, for the words of the answer. */
  teams: { id: number; name: string }[];
}

interface TicketRow {
  id: number;
  key: string;
  rank: string;
  track_id: number;
  type_id: number;
  level: number;
  stage: StatusStage;
  assignee_id: number | null;
  requester_id: number | null;
  visibility_level_id: number | null;
  fields: Record<string, unknown> | null;
  estimate: number | null;
  live_start: string | null;
  live_due: string | null;
  has_start: boolean;
  person_start: string | null;
  has_due: boolean;
  person_due: string | null;
  start: string | null;
  due: string | null;
  sprint_start: string | null;
  sprint_end: string | null;
  in_active_sprint: boolean;
  release_ids: number[];
  release_id: number | null;
  release_date: string | null;
  left_by_query: boolean;
  kept_by_query: boolean;
}

/** Compiles the run's conditions in the runner's scope; throws `InvalidCondition` naming each. */
async function conditions(
  db: Kysely<Database>,
  tickets: PlanTickets,
  body: Pick<ScheduleBody, 'leaveOut' | 'keep'>,
  now: Date,
): Promise<{ leave: RawBuilder<boolean> | null; keep: RawBuilder<boolean> | null }> {
  const errors: Record<string, string> = {};
  const compile = async (field: string, text: string | undefined) => {
    if (text === undefined) return null;
    try {
      return await compileCondition(db, tickets.scope, text, now);
    } catch (error) {
      if (error instanceof QueryError) errors[field] = error.detail;
      else if (error instanceof SearchError) errors[field] = error.message;
      else throw error;
      return null;
    }
  };
  const leave = await compile('leaveOut.query', body.leaveOut.query);
  const keep = await compile('keep.query', body.keep.query);
  if (Object.keys(errors).length > 0) throw new InvalidCondition(errors);
  return { leave, keep };
}

/** Capacity per period in hundredths, null where none is set. */
const inHundredths = (periods: readonly { amount: number | null }[]) =>
  periods.map((p) => (p.amount === null ? null : hundredths(p.amount)));

/** The plan's teams with their members and capacity over the periods, as Capacity resolves it. */
async function teamsAndPeople(db: Db, ws: number, planId: number, periods: readonly Period[]) {
  const teams = await planTeams(db, planId);
  const members = await membersOf(
    db,
    ws,
    teams.map((t) => t.id),
  );
  const rows = await capacityRows(db, planId);
  const people = [...new Set([...members.values()].flat().map((m) => m.id))].sort((a, b) => a - b);
  const personCapacity = new Map(
    people.map((id) => [id, capacityOf(rows, periods, { userId: id })]),
  );
  const resolved = teams.map((team) => {
    const own = capacityOf(rows, periods, { teamId: team.id });
    const ids = (members.get(team.id) ?? []).map((m) => m.id);
    const capacity = teamCapacity(
      own,
      ids.map((id) => personCapacity.get(id) ?? { default: null, periods: [] }),
    );
    return { id: team.id, name: team.name, members: ids, capacity };
  });
  return { teams: resolved, people, personCapacity };
}

/**
 * Reads one run's input as the runner sees the plan. `overlay` is the scenario whose people's
 * drafts give the days (the scenario run into, or the one a new scenario copies), or none.
 */
export async function readScheduleInputs(
  db: Kysely<Database>,
  request: FastifyRequest,
  options: {
    catalogs: FieldCatalogs;
    timeoutMs: number;
    plan: RunPlan;
    overlay: number | null;
    from: string;
    periods: Period[];
    body: Pick<ScheduleBody, 'leaveOut' | 'keep'>;
  },
): Promise<ScheduleInputs> {
  const { plan, periods, body } = options;
  const ws = request.workspaceId;
  const tickets = await planTickets(db, options.catalogs, request, await sourceRows(db, [plan.id]));
  const now = new Date();
  const conds = await conditions(db, tickets, body, now);
  const { teams, people, personCapacity } = await teamsAndPeople(db, ws, plan.id, periods);
  const empty: ScheduleInputs = {
    tickets,
    read: new Map(),
    teams: teams.map((t) => ({ id: t.id, name: t.name })),
    input: {
      from: options.from,
      periods,
      tickets: [],
      links: [],
      teams: teams.map((t) => ({
        id: t.id,
        members: t.members,
        capacity: inHundredths(t.capacity.periods),
      })),
      people: people.map((id) => ({
        id,
        capacity: inHundredths(personCapacity.get(id)?.periods ?? []),
        load: periods.map(() => 0),
      })),
      leaveOut: { typeIds: body.leaveOut.typeIds, releaseIds: body.leaveOut.releaseIds },
      keep: { inProgress: body.keep.inProgress, inActiveSprint: body.keep.inActiveSprint },
    },
  };
  const unfiltered = tickets.unfiltered;
  if (unfiltered === null) return empty;
  const field = plan.capacity_unit === 'points' ? await pointsField(db, ws) : null;
  const value = estimateSql(plan.capacity_unit, field?.id ?? null);
  const over = draftOverlay(options.overlay, unfiltered, 'so', { origin: 'person' });
  const links = await dependencyOptions(db, plan.id);
  const windowStart = periods[0]?.start as string;
  const windowEnd = periods.at(-1)?.end as string;

  const read = await readOnly(db, options.timeoutMs, async (trx) => {
    const open = (
      await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM (
          SELECT 1 FROM ticket k JOIN status s ON s.id = k.status_id
           WHERE ${unfiltered} AND s.stage <> 'closed' LIMIT ${MAX_OPEN_READ + 1}) x`.execute(trx)
    ).rows[0]?.n;
    if ((open ?? 0) > MAX_OPEN_READ) throw new PlanTooLarge();
    const rows = (
      await sql<TicketRow>`
        SELECT k.id, t.key || '-' || k.number AS key, k.rank, k.track_id,
               k.ticket_type_id AS type_id, h.rank AS level, s.stage, k.assignee_id,
               k.requester_id, k.visibility_level_id, k.fields,
               (${value})::float8 AS estimate,
               k.start_date::text AS live_start, k.due_date::text AS live_due,
               ${
                 options.overlay === null
                   ? sql`false AS has_start, NULL::text AS person_start,
                         false AS has_due, NULL::text AS person_due,`
                   : sql`COALESCE(so.has_start, false) AS has_start, so.start AS person_start,
                         COALESCE(so.has_due, false) AS has_due, so.due AS person_due,`
               }
               ${over.start}::text AS start, ${over.due}::text AS due,
               ${sprintDay('start_at')}::text AS sprint_start,
               ${sprintDay('end_at')}::text AS sprint_end,
               ${inActiveSprint()} AS in_active_sprint,
               ARRAY(SELECT tr.release_id FROM ticket_release tr
                      WHERE tr.ticket_id = k.id AND tr.role = 'target'
                      ORDER BY tr.release_id) AS release_ids,
               rel.id AS release_id, rel.release_date::text AS release_date,
               ${conds.leave ? sql`(${conds.leave}) IS TRUE` : sql`false`} AS left_by_query,
               ${conds.keep ? sql`(${conds.keep}) IS TRUE` : sql`false`} AS kept_by_query
          FROM ticket k
          JOIN track t ON t.id = k.track_id
          JOIN status s ON s.id = k.status_id
          JOIN ticket_type y ON y.id = k.ticket_type_id
          JOIN hierarchy_level h ON h.id = y.level_id
          ${over.join}
          LEFT JOIN LATERAL (
            SELECT r.id, r.release_date FROM ticket_release tr
              JOIN release r ON r.id = tr.release_id
             WHERE tr.ticket_id = k.id AND tr.role = 'target' AND r.shipped_at IS NULL
               AND r.archived_at IS NULL AND r.release_date IS NOT NULL
             ORDER BY r.release_date, r.id LIMIT 1) rel ON true
         WHERE ${unfiltered} AND s.stage <> 'closed'`.execute(trx)
    ).rows;
    const ids = rows.map((r) => r.id);
    const all = await blockingLinks(trx, ws, ids, links);
    const openIds = new Set(ids);
    const outsiders = [...new Set(all.filter((l) => !openIds.has(l.from)).map((l) => l.from))];
    // A blocker of the plan for the runner that is not open is closed, and holds nothing up.
    const closedInPlan = new Set(
      outsiders.length === 0
        ? []
        : (
            await sql<{ id: number }>`
              SELECT k.id FROM ticket k
               WHERE k.id = ANY(${outsiders}::int[]) AND ${unfiltered}`.execute(trx)
          ).rows.map((r) => r.id),
    );
    const hidden = new Set(
      all.filter((l) => !openIds.has(l.from) && !closedInPlan.has(l.from)).map((l) => l.to),
    );
    // The plan's closed tickets due in the window, by person and day: their load stays.
    const closed =
      people.length === 0
        ? []
        : (
            await sql<{ assignee_id: number; due: string; amount: number }>`
              SELECT k.assignee_id, ${over.due}::text AS due,
                     COALESCE(sum(${value}), 0)::float8 AS amount
                FROM ticket k JOIN status s ON s.id = k.status_id
                ${over.join}
               WHERE ${unfiltered} AND s.stage = 'closed'
                 AND k.assignee_id = ANY(${people}::int[])
                 AND ${over.due} BETWEEN ${windowStart}::date AND ${windowEnd}::date
               GROUP BY k.assignee_id, ${over.due}`.execute(trx)
          ).rows;
    // Work elsewhere: outside the plan or hidden from the runner, by whole weeks, totals only.
    const elsewhere = await elsewhereWork(trx, { ws, people, where: unfiltered, value, periods });
    return { rows, links: all.filter((l) => openIds.has(l.from)), hidden, closed, elsewhere };
  });

  // Loads already there, in hundredths per person and period.
  const loads = new Map<number, number[]>(people.map((id) => [id, periods.map(() => 0)]));
  for (const r of read.closed) {
    const at = periodIndex(periods, r.due);
    const row = loads.get(r.assignee_id);
    if (row && at >= 0) row[at] = (row[at] as number) + Number(r.amount);
  }
  for (const [id, cells] of read.elsewhere) {
    const row = loads.get(id);
    if (!row) continue;
    cells.forEach((c, i) => {
      row[i] = (row[i] as number) + c.amount;
    });
  }
  const peopleInput: SchedulePerson[] = people.map((id) => ({
    id,
    capacity: inHundredths(personCapacity.get(id)?.periods ?? []),
    load: (loads.get(id) ?? []).map(hundredths),
  }));
  const teamsInput: ScheduleTeam[] = teams.map((t) => ({
    id: t.id,
    members: t.members,
    capacity: inHundredths(t.capacity.periods),
  }));

  const snapshots = new Map<number, DaySnapshot>();
  const input: ScheduleTicket[] = [];
  for (const r of read.rows) {
    const permissions = await request.authz.ticket({
      id: r.id,
      track_id: r.track_id,
      requester_id: r.requester_id,
      assignee_id: r.assignee_id,
      visibility_level_id: r.visibility_level_id,
      fields: r.fields ?? {},
    });
    snapshots.set(r.id, {
      start: r.live_start,
      due: r.live_due,
      ...(r.has_start ? { personStart: r.person_start } : {}),
      ...(r.has_due ? { personDue: r.person_due } : {}),
    });
    const dated = r.start !== null || r.due !== null;
    input.push({
      id: r.id,
      key: r.key,
      rank: r.rank,
      level: r.level,
      typeId: r.type_id,
      stage: r.stage,
      assigneeId: r.assignee_id,
      estimate: r.estimate === null ? null : hundredths(Number(r.estimate)),
      start: r.start,
      due: r.due,
      sprint:
        !dated && r.sprint_start !== null && r.sprint_end !== null
          ? { start: r.sprint_start, end: r.sprint_end }
          : null,
      inActiveSprint: r.in_active_sprint,
      releaseIds: r.release_ids ?? [],
      release:
        r.release_id !== null && r.release_date !== null
          ? { id: r.release_id, date: r.release_date }
          : null,
      personDraft: r.has_start || r.has_due,
      maySchedule: permissions.has('schedule_tickets'),
      leftOutByQuery: r.left_by_query,
      keptByQuery: r.kept_by_query,
      hiddenBlocker: read.hidden.has(r.id),
    });
  }
  return {
    tickets,
    read: snapshots,
    teams: empty.teams,
    input: {
      ...empty.input,
      tickets: input,
      links: read.links.map((l) => ({ from: l.from, to: l.to })),
      teams: teamsInput,
      people: peopleInput,
    },
  };
}

/**
 * The days of these tickets now, under the scenario's lock: live days and the people's drafts
 * of days in the scenario. A ticket gone from the table has no entry.
 */
export async function lockedSnapshots(
  trx: Transaction<Database>,
  scenarioId: number,
  ids: readonly number[],
): Promise<Map<number, DaySnapshot>> {
  const out = new Map<number, DaySnapshot>();
  if (ids.length === 0) return out;
  const rows = (
    await sql<{
      id: number;
      live_start: string | null;
      live_due: string | null;
      has_start: boolean | null;
      person_start: string | null;
      has_due: boolean | null;
      person_due: string | null;
    }>`
      SELECT k.id, k.start_date::text AS live_start, k.due_date::text AS live_due,
             bool_or(d.field = 'startDate') AS has_start,
             max(d.new_value #>> '{}') FILTER (WHERE d.field = 'startDate') AS person_start,
             bool_or(d.field = 'dueDate') AS has_due,
             max(d.new_value #>> '{}') FILTER (WHERE d.field = 'dueDate') AS person_due
        FROM ticket k
        LEFT JOIN plan_draft d ON d.ticket_id = k.id AND d.scenario_id = ${scenarioId}::int
             AND d.origin = 'person' AND d.field IN ('startDate', 'dueDate')
       WHERE k.id = ANY(${[...ids]}::int[])
       GROUP BY k.id`.execute(trx)
  ).rows;
  for (const r of rows) {
    out.set(r.id, {
      start: r.live_start,
      due: r.live_due,
      ...(r.has_start ? { personStart: r.person_start } : {}),
      ...(r.has_due ? { personDue: r.person_due } : {}),
    });
  }
  return out;
}

/** What the readiness check says (`GET /plans/:id/schedule`): counts only, never a ticket. */
export interface Readiness {
  unit: PlanCapacityUnit;
  pointsField: { id: number; name: string } | null;
  periods: Period[];
  teams: { id: number; name: string; withCapacity: boolean }[];
  people: { withCapacity: number; without: number };
  tickets: { open: number; unestimated: number; unassigned: number; noTeam: number };
  /** The ticket types of the reader's open level-0 tickets, for Leave out ticket types. */
  types: { id: number; name: string }[];
  /**
   * The releases those tickets target, neither shipped nor archived, for Leave out releases: only
   * of tracks the reader browses, as the plan's views show releases.
   */
  releases: { id: number; name: string; date: string | null }[];
}

/** Choices a leave-out list offers at most. */
export const MAX_CHOICES = 200;

/**
 * Readiness before a run, over the reader's tickets: the plan's teams and whether each has a
 * capacity in some period of the run, how many of their members do, and how many open level-0
 * tickets lack an estimate, an assignee or a plan team.
 */
export async function readReadiness(
  db: Kysely<Database>,
  request: FastifyRequest,
  options: { catalogs: FieldCatalogs; timeoutMs: number; plan: RunPlan; periods: Period[] },
): Promise<Readiness & { planTickets: PlanTickets }> {
  const { plan, periods } = options;
  const ws = request.workspaceId;
  const tickets = await planTickets(db, options.catalogs, request, await sourceRows(db, [plan.id]));
  const { teams, people, personCapacity } = await teamsAndPeople(db, ws, plan.id, periods);
  const field = plan.capacity_unit === 'points' ? await pointsField(db, ws) : null;
  const value = estimateSql(plan.capacity_unit, field?.id ?? null);
  const any = (c: { periods: { amount: number | null }[] } | undefined) =>
    (c?.periods ?? []).some((p) => p.amount !== null);
  const withCapacity = people.filter((id) => any(personCapacity.get(id))).length;
  const unfiltered = tickets.unfiltered;
  const counts = unfiltered
    ? await readOnly(
        db,
        options.timeoutMs,
        async (trx) =>
          (
            await sql<{ open: number; unestimated: number; unassigned: number; no_team: number }>`
              SELECT count(*)::int AS open,
                     count(*) FILTER (WHERE (${value}) IS NULL)::int AS unestimated,
                     count(*) FILTER (WHERE k.assignee_id IS NULL)::int AS unassigned,
                     count(*) FILTER (WHERE k.assignee_id IS NOT NULL
                                        AND NOT (k.assignee_id = ANY(${people}::int[])))::int
                       AS no_team
                FROM ticket k
                JOIN status s ON s.id = k.status_id
                JOIN ticket_type y ON y.id = k.ticket_type_id
                JOIN hierarchy_level h ON h.id = y.level_id
               WHERE ${unfiltered} AND s.stage <> 'closed' AND h.rank = 0`.execute(trx)
          ).rows[0],
      )
    : undefined;
  // What the run may leave out: the types and target releases of the same tickets.
  const choices = unfiltered
    ? await readOnly(db, options.timeoutMs, async (trx) => {
        const types = (
          await sql<{ id: number; name: string }>`
            SELECT DISTINCT y.id, y.name
              FROM ticket k
              JOIN status s ON s.id = k.status_id
              JOIN ticket_type y ON y.id = k.ticket_type_id
              JOIN hierarchy_level h ON h.id = y.level_id
             WHERE ${unfiltered} AND s.stage <> 'closed' AND h.rank = 0
             ORDER BY y.name, y.id
             LIMIT ${MAX_CHOICES}`.execute(trx)
        ).rows;
        const releases = (
          await sql<{ id: number; name: string; date: string | null; track_id: number }>`
            SELECT r.id, r.name, r.release_date::text AS date, r.track_id
              FROM release r
             WHERE r.shipped_at IS NULL AND r.archived_at IS NULL
               AND r.id IN (
                 SELECT tr.release_id
                   FROM ticket k
                   JOIN status s ON s.id = k.status_id
                   JOIN ticket_type y ON y.id = k.ticket_type_id
                   JOIN hierarchy_level h ON h.id = y.level_id
                   JOIN ticket_release tr ON tr.ticket_id = k.id AND tr.role = 'target'
                  WHERE ${unfiltered} AND s.stage <> 'closed' AND h.rank = 0)
             ORDER BY r.release_date NULLS LAST, r.name, r.id`.execute(trx)
        ).rows;
        return { types, releases };
      })
    : { types: [], releases: [] };
  const browses = await browsedTracks(request);
  return {
    planTickets: tickets,
    unit: plan.capacity_unit,
    pointsField: field,
    periods,
    teams: teams.map((t) => ({ id: t.id, name: t.name, withCapacity: any(t.capacity) })),
    people: { withCapacity, without: people.length - withCapacity },
    tickets: {
      open: counts?.open ?? 0,
      unestimated: counts?.unestimated ?? 0,
      unassigned: counts?.unassigned ?? 0,
      noTeam: counts?.no_team ?? 0,
    },
    types: choices.types,
    releases: choices.releases
      .filter((r) => browses(r.track_id))
      .slice(0, MAX_CHOICES)
      .map((r) => ({ id: r.id, name: r.name, date: r.date })),
  };
}
