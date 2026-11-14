import type { Database, JsonValue, PlanDraftField } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { requireUser } from '../auth';
import { emit, emitMany } from '../events/bus';
import type { DomainEventInput } from '../events/catalogue';
import type { FieldCatalogs } from '../fields/catalog';
import { planEditable } from '../plans/access';
import {
  applying,
  clearSchedulerDrafts,
  createScenario,
  type DraftValue,
  type DraftWrite,
  draftedTickets,
  draftValue,
  lockScenario,
  MAX_DRAFTED_TICKETS,
  MAX_SCENARIOS,
  sameValue,
  TooManyDrafts,
  writeDrafts,
} from '../plans/drafts';
import { type EvenOutOutput, evenOut } from '../plans/evenOut';
import { idParam, MAX_PERIODS } from '../plans/model';
import { type Period, periodsFrom } from '../plans/periods';
import { browsedTracks } from '../plans/query';
import {
  type DaySnapshot,
  InvalidCondition,
  lockedSnapshots,
  PlanTooLarge,
  readReadiness,
  readScheduleInputs,
  type ScheduleInputs,
  snapshotKey,
} from '../plans/scheduleInputs';
import {
  type DayProposal,
  DEFAULT_RUN_PERIODS,
  DRAFT_CHUNK,
  EVENT_CHUNK,
  MAX_LEFT_OUT,
  MAX_LISTED,
  MAX_OPEN_READ,
  MAX_QUERY,
  MAX_TO_SCHEDULE,
  movableCount,
  type OverLeftCell,
  type ScheduleBody,
  type ScheduleCounts,
  type ScheduleEntry,
  type ScheduleOutput,
  schedule,
  scheduleBody,
} from '../plans/scheduler';
import { DEFAULT_QUERY_TIMEOUT_MS, readOnly } from '../search/run';
import { isCalendarDay } from '../tickets/model';
import { periodOf, planVisible } from './plans';
import { searchRefusal } from './search';

/**
 * The auto-scheduler's routes (T-089f; PLN-004; ADR-122 stage 7).
 *
 * - `GET /api/v1/plans/:id/schedule?scenario=&from=&periods=`: readiness before a run, for anyone
 *   who sees the plan, counted over the tickets the reader is shown; no ticket is named.
 * - `POST /api/v1/plans/:id/schedule`: a run, for the plan's owner and site administrators. It
 *   reads the plan as the runner sees it (`scheduleInputs.ts`), places its open level-0 tickets in
 *   the plan's periods (`scheduler.ts`, pure), or with `mode: 'even_out'` moves only the work that
 *   puts someone over capacity, later (`evenOut.ts`, pure; ADR-122 stage 9), and writes the
 *   proposals as draft days with origin
 *   `scheduler` into one scenario, a new one or one of the plan's, through stage 6's writer. It
 *   changes no ticket. Under the scenario's lock it reads again the tickets it would touch and
 *   leaves out those changed meanwhile, then diffs against its own earlier proposals there, so a
 *   second run on unchanged tickets writes nothing. Earlier proposals on tickets the runner is not
 *   shown stay, counted. The answer reports each ticket's outcome and reason; nothing else is
 *   stored.
 */

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });
const invalidFields = (reply: FastifyReply, fields: Record<string, string>, extra = {}) =>
  reply.code(400).send({ error: 'invalid_fields', fields, ...extra });

function shapeErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || 'body';
    if (!(path in out)) out[path] = issue.message.length < 40 ? issue.message : 'invalid';
  }
  return out;
}

const MAX_INT = 2_147_483_647;
const readinessQuery = z
  .object({
    scenario: z
      .string()
      .regex(/^[1-9]\d{0,9}$/)
      .refine((v) => Number(v) <= MAX_INT, 'too_large')
      .optional(),
    from: z.string().refine(isCalendarDay, 'a calendar day as YYYY-MM-DD').optional(),
    periods: z.coerce.number().int().min(1).max(MAX_PERIODS).optional(),
  })
  .strict();

/** What a run and its dialog may not pass. */
export const SCHEDULE_LIMITS = {
  periods: MAX_PERIODS,
  defaultPeriods: DEFAULT_RUN_PERIODS,
  toSchedule: MAX_TO_SCHEDULE,
  openRead: MAX_OPEN_READ,
  leftOut: MAX_LEFT_OUT,
  query: MAX_QUERY,
  listed: MAX_LISTED,
  scenarios: MAX_SCENARIOS,
  draftedTickets: MAX_DRAFTED_TICKETS,
} as const;

export interface PlanScheduleOptions {
  catalogs: FieldCatalogs;
  timeoutMs?: number;
}

/** A run's counts: the engine's, with what the write found. */
export interface RunCounts {
  /** Placed tickets whose proposal stands in the scenario (changed meanwhile left out). */
  placed: number;
  /** Of those, the ones whose drafts this run did not change. */
  unchanged: number;
  /** Tickets whose earlier proposal this run removed entirely. */
  withdrawn: number;
  /** Tickets left out of the write: their days changed while the run worked. */
  changedMeanwhile: number;
  kept: ScheduleCounts['kept'];
  notPlaced: ScheduleCounts['notPlaced'];
  leftOut: ScheduleCounts['leftOut'];
  warnings: ScheduleCounts['warnings'];
  /** Tickets with earlier proposals here that the runner is not shown, left as they were. */
  notShown: number;
}

const DAY_FIELDS = ['startDate', 'dueDate'] as const;
const today = () => new Date().toISOString().slice(0, 10);

/** A run's draft writes and removals, from the engine's proposals and the drafts under the lock. */
export function diffProposals(options: {
  /** A fill run's days, or evening out's, where a day a ticket has not stays null. */
  proposals: readonly DayProposal[];
  read: ReadonlyMap<number, DaySnapshot>;
  locked: ReadonlyMap<number, DaySnapshot>;
  /** The auto-scheduler's drafts in the scenario on tickets the runner is shown. */
  earlier: ReadonlyMap<number, ReadonlyMap<string, { was: DraftValue; to: DraftValue }>>;
  /** The run's blocking links between open tickets: a proposal placed after a changed one goes too. */
  links?: readonly { from: number; to: number }[];
}) {
  const { proposals, read, locked, earlier, links = [] } = options;
  const writes: DraftWrite[] = [];
  const clears: { ticketId: number; field: string }[] = [];
  const meanwhile = new Set<number>();
  const unchanged = new Set<number>();
  const placed = new Set<number>();
  const changed = (id: number) => {
    const before = read.get(id);
    if (!before) return false;
    const now = locked.get(id);
    return !now || snapshotKey(now) !== snapshotKey(before);
  };
  const proposed = new Set(proposals.map((p) => p.id));
  // A proposal was placed after its blockers' days as the run read them. When a blocker changed
  // meanwhile (placed, kept or left out), so is every proposal placed after it, directly or
  // through other proposals: writing them would make a late link the run never saw.
  const after = new Map<number, number[]>();
  for (const l of links) {
    if (!proposed.has(l.to)) continue;
    const list = after.get(l.from) ?? [];
    list.push(l.to);
    after.set(l.from, list);
  }
  const stale = new Set<number>();
  const queue = [...new Set([...proposed, ...after.keys()])].filter(changed);
  while (queue.length > 0) {
    const id = queue.pop() as number;
    if (stale.has(id)) continue;
    stale.add(id);
    for (const next of after.get(id) ?? []) if (!stale.has(next)) queue.push(next);
  }
  for (const p of proposals) {
    if (stale.has(p.id)) {
      meanwhile.add(p.id);
      continue;
    }
    placed.add(p.id);
    const now = locked.get(p.id) as DaySnapshot;
    const prior = earlier.get(p.id);
    let touched = false;
    for (const field of DAY_FIELDS) {
      const value = field === 'startDate' ? p.start : p.due;
      const live = field === 'startDate' ? now.start : now.due;
      const was = prior?.get(field);
      if (sameValue(value, live)) {
        // Nothing to draft: an earlier proposal on this field goes.
        if (was) {
          clears.push({ ticketId: p.id, field });
          touched = true;
        }
        continue;
      }
      // The same proposal, drafted from the live value still there: left as it is.
      if (was && sameValue(was.to, value) && sameValue(was.was, live)) continue;
      writes.push({ ticketId: p.id, field: field as PlanDraftField, value, live });
      touched = true;
    }
    if (!touched) unchanged.add(p.id);
  }
  // Earlier proposals on tickets this run did not place go, except where a person drafted a day:
  // removing the other alone could put its start after its due.
  for (const [id, fields] of earlier) {
    if (proposed.has(id)) continue;
    if (changed(id)) {
      meanwhile.add(id);
      continue;
    }
    const now = locked.get(id);
    if (now && (now.personStart !== undefined || now.personDue !== undefined)) continue;
    for (const field of fields.keys()) clears.push({ ticketId: id, field });
  }
  return { writes, clears, meanwhile, unchanged, placed };
}

/**
 * The names the answer's ids stand for, as far as the runner is shown them: the plan's teams, the
 * people a reason names, the target releases of tracks the runner browses (as the plan's views
 * show releases), and the keys of tickets a reason names that are not listed themselves (a kept
 * or left-out ticket, all of them tickets the run read as the runner sees the plan).
 */
async function answerNames(
  db: Kysely<Database>,
  request: FastifyRequest,
  listed: readonly ScheduleEntry[],
  inputs: ScheduleInputs,
  overLeft: readonly OverLeftCell[] = [],
) {
  const tickets = new Set<number>();
  const people = new Set<number>();
  const teams = new Set<number>();
  const releases = new Set<number>();
  const visit = (args: ScheduleEntry['args']) => {
    for (const key of ['blockerId', 'ticketId'] as const) {
      const id = args[key];
      if (typeof id === 'number') tickets.add(id);
    }
    if (Array.isArray(args.ticketIds)) for (const id of args.ticketIds) tickets.add(id);
    if (typeof args.userId === 'number') people.add(args.userId);
    if (typeof args.teamId === 'number') teams.add(args.teamId);
    if (Array.isArray(args.teamIds)) for (const id of args.teamIds) teams.add(id);
    if (typeof args.releaseId === 'number') releases.add(args.releaseId);
  };
  for (const e of listed) {
    visit(e.args);
    for (const w of e.warnings) visit(w.args);
  }
  for (const cell of overLeft) {
    if (cell.teamId !== undefined) teams.add(cell.teamId);
    if (cell.userId !== undefined) people.add(cell.userId);
  }
  const shown = new Set(listed.map((e) => e.id));
  const keyOf = new Map(inputs.input.tickets.map((x) => [x.id, x.key]));
  const ws = request.workspaceId;
  const userRows =
    people.size === 0
      ? []
      : await db
          .selectFrom('app_user')
          .select(['id', 'name'])
          .where('workspace_id', '=', ws)
          .where('id', 'in', [...people])
          .orderBy('id')
          .execute();
  const releaseRows =
    releases.size === 0
      ? []
      : await db
          .selectFrom('release')
          .select(['id', 'name', 'track_id'])
          .where('id', 'in', [...releases])
          .orderBy('id')
          .execute();
  const browses = await browsedTracks(request);
  return {
    teams: inputs.teams.filter((x) => teams.has(x.id)),
    people: userRows.map((u) => ({ id: u.id, name: u.name })),
    releases: releaseRows
      .filter((r) => browses(r.track_id))
      .map((r) => ({ id: r.id, name: r.name })),
    tickets: [...tickets]
      .filter((id) => !shown.has(id) && keyOf.has(id))
      .sort((a, b) => a - b)
      .map((id) => ({ id, key: keyOf.get(id) as string })),
  };
}

export function registerPlanScheduleRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: PlanScheduleOptions,
): void {
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  const by = (request: FastifyRequest) => ({
    workspaceId: request.workspaceId,
    actorId: request.user?.id ?? null,
  });

  /** The plan with its settings when the person sees it (site administrators see every one). */
  async function visiblePlan(request: FastifyRequest, id: number) {
    const ws = request.workspaceId;
    let q = db
      .selectFrom('plan as p')
      .select([
        'p.id',
        'p.name',
        'p.owner_id',
        'p.capacity_unit',
        'p.period_kind',
        'p.period_weeks',
        'p.period_anchor',
      ])
      .where('p.workspace_id', '=', ws)
      .where('p.id', '=', id);
    const admin = await request.authz.isSiteAdmin();
    if (!admin) q = q.where(planVisible(ws, request.user?.id as number));
    const plan = await q.executeTakeFirst();
    if (!plan) return null;
    return { ...plan, editable: await planEditable(request, plan.owner_id) };
  }

  const scenarioOf = (ws: number, planId: number, sid: number) =>
    db
      .selectFrom('plan_scenario')
      .select(['id', 'name', 'main', 'version', 'applying_since'])
      .where('workspace_id', '=', ws)
      .where('plan_id', '=', planId)
      .where('id', '=', sid)
      .executeTakeFirst();

  app.get('/api/v1/plans/:id/schedule', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const q = readinessQuery.safeParse(request.query ?? {});
    if (!q.success) return invalidFields(reply, shapeErrors(q.error));
    const ws = request.workspaceId;
    const plan = await visiblePlan(request, p.data.id);
    if (!plan) return notFound(reply);
    const scenario =
      q.data.scenario === undefined
        ? null
        : ((await scenarioOf(ws, plan.id, Number(q.data.scenario))) ?? 'not_found');
    // A scenario of another plan answers as a missing id, as a run into one does.
    if (scenario === 'not_found') return notFound(reply);
    const periods = periodsFrom(
      periodOf(plan),
      q.data.from ?? today(),
      q.data.periods ?? DEFAULT_RUN_PERIODS,
    );
    try {
      const { planTickets: tickets, ...ready } = await readReadiness(db, request, {
        catalogs: options.catalogs,
        timeoutMs,
        plan,
        periods,
        overlay: scenario ? scenario.id : null,
      });
      const scenarios = await db
        .selectFrom('plan_scenario')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('plan_id', '=', plan.id)
        .executeTakeFirstOrThrow();
      let inScenario = {};
      if (scenario) {
        // Its drafts on tickets the reader is shown, by origin; the rest only counted.
        const visible = tickets.unfiltered
          ? sql<boolean>`(k.deleted_at IS NULL AND ${tickets.unfiltered})`
          : sql<boolean>`false`;
        const row = await readOnly(
          db,
          timeoutMs,
          async (trx) =>
            (
              await sql<{ proposals: number; drafts: number; not_shown: number }>`
                SELECT count(DISTINCT d.ticket_id) FILTER (WHERE x.shown AND d.origin = 'scheduler')::int
                         AS proposals,
                       count(DISTINCT d.ticket_id) FILTER (WHERE x.shown AND d.origin = 'person'
                         AND d.field IN ('startDate', 'dueDate'))::int AS drafts,
                       count(DISTINCT d.ticket_id) FILTER (WHERE NOT x.shown)::int AS not_shown
                  FROM plan_draft d JOIN ticket k ON k.id = d.ticket_id,
                       LATERAL (SELECT (${visible}) IS TRUE AS shown) x
                 WHERE d.scenario_id = ${scenario.id}::int`.execute(trx)
            ).rows[0],
        );
        inScenario = {
          scenario: {
            id: scenario.id,
            name: scenario.name,
            main: scenario.main,
            version: scenario.version,
            applying: applying(scenario.applying_since),
            proposals: row?.proposals ?? 0,
            drafts: row?.drafts ?? 0,
            notShown: row?.not_shown ?? 0,
          },
        };
      }
      return {
        plan: { id: plan.id, name: plan.name },
        ...inScenario,
        ...ready,
        period: periodOf(plan),
        scenarios: Number(scenarios.n),
        editable: plan.editable,
        limits: SCHEDULE_LIMITS,
      };
    } catch (error) {
      return searchRefusal(reply, error, timeoutMs);
    }
  });

  app.post('/api/v1/plans/:id/schedule', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const ws = request.workspaceId;
    const plan = await visiblePlan(request, p.data.id);
    if (!plan) return notFound(reply);
    if (!plan.editable)
      return reply.code(403).send({ error: 'forbidden', permission: 'edit_plan' });
    const parsed = scheduleBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const body: ScheduleBody = parsed.data;
    const into = body.into;
    // The scenario run into must be the plan's (404 as a missing id); one copied, too (400).
    let overlay: number | null = null;
    if ('scenarioId' in into) {
      const there = await scenarioOf(ws, plan.id, into.scenarioId);
      if (!there) return notFound(reply);
      if (applying(there.applying_since))
        return reply.code(409).send({ error: 'apply_in_progress' });
      overlay = there.id;
    } else if (into.newScenario.from !== undefined) {
      if (!(await scenarioOf(ws, plan.id, into.newScenario.from)))
        return invalidFields(reply, { 'into.newScenario.from': 'not_found' });
      overlay = into.newScenario.from;
    }
    const from = body.from ?? today();
    const periods: Period[] = periodsFrom(periodOf(plan), from, body.periods);

    try {
      const inputs = await readScheduleInputs(db, request, {
        catalogs: options.catalogs,
        timeoutMs,
        plan,
        overlay,
        from,
        periods,
        body,
      });
      const mode = body.mode ?? 'fill';
      const output: ScheduleOutput | EvenOutOutput =
        mode === 'even_out' ? evenOut(inputs.input) : schedule(inputs.input);
      const overLeft = output.overLeft ?? [];
      const movable = movableCount(output.counts);
      if (movable > MAX_TO_SCHEDULE) {
        return reply
          .code(409)
          .send({ error: 'too_many_to_schedule', limit: MAX_TO_SCHEDULE, count: movable });
      }
      const unfiltered = inputs.tickets.unfiltered;
      const visible = unfiltered
        ? sql<boolean>`(k.deleted_at IS NULL AND ${unfiltered})`
        : sql<boolean>`false`;

      const outcome = await db.transaction().execute(async (trx) => {
        // 1. The scenario: made here, or the one named, locked.
        let scenarioId: number;
        let created = false;
        if ('newScenario' in into) {
          const made = await createScenario(trx, by(request), {
            workspaceId: ws,
            planId: plan.id,
            name: into.newScenario.name,
            from: into.newScenario.from,
            createdBy: user.id,
            shown: unfiltered,
          });
          if ('refused' in made) return { refused: made.refused };
          if ('fields' in made) return { fields: { 'into.newScenario.from': 'not_found' } };
          scenarioId = made.id;
          created = true;
        } else {
          scenarioId = into.scenarioId;
        }
        // 2. Its lock orders the drafts written to it; an apply holding it refuses the run.
        const locked = await lockScenario(trx, plan.id, scenarioId);
        if (!locked) return { missing: true as const };
        if (applying(locked.applying_since)) return { refused: 'apply_in_progress' as const };

        // 3. The auto-scheduler's drafts there: on tickets the runner is shown, or counted.
        const prior = (
          await sql<{
            ticket_id: number;
            field: string;
            old_value: JsonValue | null;
            new_value: JsonValue | null;
            shown: boolean;
          }>`
            SELECT d.ticket_id, d.field, d.old_value, d.new_value, (${visible}) IS TRUE AS shown
              FROM plan_draft d JOIN ticket k ON k.id = d.ticket_id
             WHERE d.scenario_id = ${scenarioId}::int AND d.origin = 'scheduler'`.execute(trx)
        ).rows;
        const earlier = new Map<number, Map<string, { was: DraftValue; to: DraftValue }>>();
        const notShown = new Set<number>();
        for (const r of prior) {
          if (!r.shown) {
            notShown.add(r.ticket_id);
            continue;
          }
          const fields = earlier.get(r.ticket_id) ?? new Map();
          fields.set(r.field, { was: draftValue(r.old_value), to: draftValue(r.new_value) });
          earlier.set(r.ticket_id, fields);
        }
        // 4. The tickets it would touch and the blockers of those it places, read again under
        // the lock: a proposal after a blocker that changed meanwhile is left out with it.
        const proposedIds = new Set(output.proposals.map((x) => x.id));
        const links = inputs.input.links.filter((l) => proposedIds.has(l.to));
        const touched = [
          ...new Set([...proposedIds, ...earlier.keys(), ...links.map((l) => l.from)]),
        ];
        const now = await lockedSnapshots(trx, scenarioId, touched);
        const diff = diffProposals({
          proposals: output.proposals,
          read: inputs.read,
          locked: now,
          earlier,
          links,
        });
        // 5. Removals and writes, in chunks under Postgres's limit on bound values.
        const removed: { ticketId: number; field: string }[] = [];
        for (let i = 0; i < diff.clears.length; i += DRAFT_CHUNK) {
          removed.push(
            ...(await clearSchedulerDrafts(trx, scenarioId, diff.clears.slice(i, i + DRAFT_CHUNK))),
          );
        }
        const set: { ticketId: number; field: string; from: DraftValue; to: DraftValue }[] = [];
        for (let i = 0; i < diff.writes.length; i += DRAFT_CHUNK) {
          const written = await writeDrafts(trx, {
            workspaceId: ws,
            planId: plan.id,
            scenarioId,
            updatedBy: user.id,
            origin: 'scheduler',
            changes: diff.writes.slice(i, i + DRAFT_CHUNK),
            keep: true,
          });
          set.push(...written.set);
          removed.push(...written.removed);
        }
        // 6. The limit: past it, the whole run rolls back.
        if ((await draftedTickets(trx, scenarioId)) > MAX_DRAFTED_TICKETS) {
          throw new TooManyDrafts();
        }
        // Withdrawn: tickets whose earlier proposal is gone altogether.
        const rewritten = new Set(set.map((s) => s.ticketId));
        const lost = new Map<number, number>();
        for (const r of removed) lost.set(r.ticketId, (lost.get(r.ticketId) ?? 0) + 1);
        let withdrawn = 0;
        for (const [id, n] of lost) {
          if (!rewritten.has(id) && n === (earlier.get(id)?.size ?? 0)) withdrawn++;
        }
        const counts: RunCounts = {
          placed: diff.placed.size,
          unchanged: diff.unchanged.size,
          withdrawn,
          changedMeanwhile: diff.meanwhile.size,
          kept: output.counts.kept,
          notPlaced: output.counts.notPlaced,
          leftOut: output.counts.leftOut,
          warnings: output.counts.warnings,
          notShown: notShown.size,
        };
        // 7. Events: the drafts in chunks, none when nothing changed; then the run.
        const entries = [
          ...set.map((c) => ({ kind: 'set' as const, c })),
          ...removed.map((c) => ({ kind: 'removed' as const, c })),
        ];
        const events: DomainEventInput[] = [];
        for (let i = 0; i < entries.length; i += EVENT_CHUNK) {
          const chunk = entries.slice(i, i + EVENT_CHUNK);
          events.push({
            type: 'plan.drafts_set',
            subjectId: plan.id,
            payload: {
              scenarioId,
              changes: chunk.flatMap((e) => (e.kind === 'set' ? [e.c] : [])),
              removed: chunk.flatMap((e) =>
                e.kind === 'removed' ? [{ ticketId: e.c.ticketId, field: e.c.field }] : [],
              ),
              origin: 'scheduler',
            },
          });
        }
        if (events.length > 0) await emitMany(trx, by(request), events);
        await emit(trx, by(request), {
          type: 'plan.schedule_ran',
          subjectId: plan.id,
          payload: {
            scenarioId,
            created,
            from,
            periods: body.periods,
            leftOut: {
              typeIds: body.leaveOut.typeIds,
              releaseIds: body.leaveOut.releaseIds,
              query: body.leaveOut.query !== undefined,
            },
            keep: {
              inProgress: body.keep.inProgress,
              inActiveSprint: body.keep.inActiveSprint,
              query: body.keep.query !== undefined,
            },
            counts,
            mode,
            overLeft: overLeft.length,
          },
        });
        // The scenario as the answer names it, read while its lock still holds it.
        const scenario = await trx
          .selectFrom('plan_scenario')
          .select(['id', 'name', 'main', 'version'])
          .where('id', '=', scenarioId)
          .executeTakeFirstOrThrow();
        return { scenario, created, counts, meanwhile: diff.meanwhile };
      });
      if ('missing' in outcome) return notFound(reply);
      if ('fields' in outcome) return invalidFields(reply, outcome.fields);
      if ('refused' in outcome) {
        return reply
          .code(409)
          .send(
            outcome.refused === 'too_many_scenarios'
              ? { error: outcome.refused, limit: MAX_SCENARIOS }
              : { error: outcome.refused },
          );
      }
      // Evening out places every ticket it leaves where it is, so the answer counts the tickets it
      // moved later whose proposal stands: the list is cut at MAX_LISTED, the moved ones last.
      const moved =
        mode === 'even_out'
          ? output.tickets.filter(
              (t) =>
                t.outcome === 'placed' && t.reason !== 'already' && !outcome.meanwhile.has(t.id),
            ).length
          : undefined;
      const listed: (ScheduleEntry & { changedMeanwhile?: true })[] = output.tickets
        .slice(0, MAX_LISTED)
        .map((t) => (outcome.meanwhile.has(t.id) ? { ...t, changedMeanwhile: true } : t));
      return reply.code(outcome.created ? 201 : 200).send({
        scenario: outcome.scenario,
        created: outcome.created,
        mode,
        from,
        periods,
        counts: moved === undefined ? outcome.counts : { ...outcome.counts, moved },
        tickets: listed,
        more: Math.max(0, output.tickets.length - MAX_LISTED),
        ...(mode === 'even_out' ? { overLeft } : {}),
        names: await answerNames(db, request, listed, inputs, overLeft),
      });
    } catch (error) {
      if (error instanceof InvalidCondition) {
        return invalidFields(
          reply,
          Object.fromEntries(Object.keys(error.errors).map((k) => [k, 'invalid_query'])),
          { messages: error.errors },
        );
      }
      if (error instanceof PlanTooLarge) {
        return reply.code(409).send({ error: 'plan_too_large', limit: MAX_OPEN_READ });
      }
      if (error instanceof TooManyDrafts) {
        return reply.code(409).send({ error: 'too_many_drafts', limit: MAX_DRAFTED_TICKETS });
      }
      return searchRefusal(reply, error, timeoutMs);
    }
  });
}
