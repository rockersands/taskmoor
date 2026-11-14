import type { DraftMark } from '../timeline/client';
import type { PlanTimelineItem } from './client';
import type { fakePlanClient } from './fixtures';
import {
  type ApplyResult,
  type ChangeField,
  type ChangePage,
  type ChangeRefusal,
  type Comparison,
  type DraftInput,
  KEPT_REASONS,
  LEFT_OUT_REASONS,
  NOT_PLACED_REASONS,
  type Outcome,
  type PlanChange,
  SCHEDULE_WARNINGS,
  type ScenarioClient,
  type ScenarioList,
  type ScenarioRow,
  type ScheduleCounts,
  type ScheduleEntry,
  type ScheduleReadiness,
  type ScheduleRequest,
  type ScheduleRun,
} from './scenarioClient';

/**
 * Scenarios of the fake plan "Spring launch" in memory, for stories and tests (ADR-122 stage 6):
 * drafts of start and due days over the plan's tickets, read by the plan's views through
 * `attachScenarios`, listed as changes, applied through the plan's own `reschedule` (so the
 * tickets change only then), discarded, compared and made main. `refuse` answers an apply of a
 * ticket with a refusal, `cannotApply` lists the tickets the reader may not schedule, and
 * `notShown` counts drafts on tickets hidden from the reader in each scenario.
 *
 * The auto-scheduler (ADR-122 stage 7) runs over the plan's open level-0 tickets: SHOP-2 (5
 * points, Ana, in progress), SHOP-3 (8, Bo) and OPS-4 (3, Ana), both blocked by SHOP-2, and OPS-5
 * (no estimate, nobody assigned). Web has 20 points a period and Ops none. Its drafts have origin
 * `scheduler` until a person drafts the same ticket; a re-run replaces only its own.
 */
export interface FakeScenarioOptions {
  editable?: boolean;
  /**
   * Scenarios to start with, the first main, each with people's drafts and the auto-scheduler's
   * proposals (origin `scheduler`).
   */
  scenarios?: { name: string; drafts?: DraftInput[]; proposals?: DraftInput[] }[];
  /** An apply of these tickets (by key) is refused so. */
  refuse?: Record<string, ChangeRefusal>;
  /** Tickets (by key) the reader lacks "Schedule tickets" for. */
  cannotApply?: string[];
  /** Drafts on hidden tickets, counted per scenario name. */
  notShown?: Record<string, number>;
  /** Fail reading the list, as a dropped connection would. */
  failList?: boolean;
  /** Readiness as the server would say it, over the defaults. */
  readiness?: Partial<ScheduleReadiness>;
  /** Fail reading readiness, as a dropped connection would. */
  failReadiness?: boolean;
  /** Refuse every run so. */
  refuseSchedule?: {
    code: string;
    fields?: Record<string, string>;
    limit?: number;
    count?: number;
  };
  /** A run that never answers, to see it running. */
  holdSchedule?: boolean;
}

const DAY = '2026-11-01T09:00:00Z';
const PERSON = { id: 7, name: 'Ana Ruiz' };

type Origin = 'person' | 'scheduler';

interface Days {
  startDate?: { was: string | null; draft: string | null; origin?: Origin };
  dueDate?: { was: string | null; draft: string | null; origin?: Origin };
}

/** The fake plan's estimates in points (SHOP-2, SHOP-3, OPS-4) and blocking links. */
const POINTS: Record<string, number> = { 'SHOP-2': 5, 'SHOP-3': 8, 'OPS-4': 3 };
const BLOCKS: [number, number][] = [
  [2, 3],
  [2, 4],
  [4, 5],
];
const TYPES = [
  { id: 1, name: 'Feature' },
  { id: 2, name: 'Chore' },
];
const MS = 86_400_000;
const dayOf = (n: number) => new Date(n * MS).toISOString().slice(0, 10);
const numOf = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / MS);
/** The plan's two-week periods from Monday 2 November, from the one holding `from`. */
export function fakeSchedulePeriods(from: string, count: number) {
  const anchor = numOf('2026-11-02');
  const first = anchor + Math.floor((numOf(from) - anchor) / 14) * 14;
  return Array.from({ length: count }, (_, i) => ({
    start: dayOf(first + i * 14),
    end: dayOf(first + i * 14 + 13),
  }));
}
const zeroes = <K extends string>(keys: readonly K[]) =>
  Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
/** Whether any of a ticket's drafted days is the auto-scheduler's. */
const byScheduler = (days: Days) =>
  days.startDate?.origin === 'scheduler' || days.dueDate?.origin === 'scheduler';
/** Whether a person drafted any of its days. */
const byPerson = (days: Days) =>
  (days.startDate !== undefined && days.startDate.origin !== 'scheduler') ||
  (days.dueDate !== undefined && days.dueDate.origin !== 'scheduler');

interface Held {
  row: ScenarioRow;
  drafts: Map<number, Days>;
  refused: Map<number, ChangeRefusal>;
}

export function fakeScenarioClient(
  plans: ReturnType<typeof fakePlanClient>,
  options: FakeScenarioOptions = {},
): ScenarioClient & {
  /** Each apply's tickets, or `all`. */
  applies: (number[] | 'all')[];
  /** Each draft write, as sent. */
  writes: DraftInput[][];
  discards: (number[] | 'all')[];
  /** Each auto-schedule run, as sent. */
  runs: ScheduleRequest[];
  /** What each readiness read asked for. */
  readinessAsked: { scenario?: number; from?: string; periods?: number }[];
} {
  const editable = options.editable ?? true;
  const held: Held[] = [];
  let nextId = 4;
  const applies: (number[] | 'all')[] = [];
  const writes: DraftInput[][] = [];
  const discards: (number[] | 'all')[] = [];
  const runs: ScheduleRequest[] = [];
  const readinessAsked: { scenario?: number; from?: string; periods?: number }[] = [];
  const live = () => new Map(plans.items().map((i) => [i.id, i]));

  const write = (
    scenario: Held,
    changes: DraftInput[],
    keep = false,
    origin: Origin = 'person',
  ) => {
    const now = live();
    for (const c of changes) {
      const ticket = now.get(c.ticketId);
      if (!ticket) continue;
      const days: Days = scenario.drafts.get(c.ticketId) ?? {};
      for (const [field, value, liveValue] of [
        ['startDate', c.startDate, ticket.start],
        ['dueDate', c.dueDate, ticket.due],
      ] as const) {
        if (value === undefined) continue;
        // A field set back to its live value loses its draft; a new value keeps the value now, as
        // does the same value again only with Keep my draft.
        // The last writer's origin, as `writeDrafts` keeps it.
        if (value === liveValue) delete days[field];
        else if (keep || days[field]?.draft !== value)
          days[field] = { was: liveValue, draft: value, origin };
        else if (days[field]) days[field] = { ...days[field], origin };
      }
      scenario.refused.delete(c.ticketId);
      if (Object.keys(days).length === 0) scenario.drafts.delete(c.ticketId);
      else scenario.drafts.set(c.ticketId, days);
    }
  };

  for (const [i, s] of (options.scenarios ?? []).entries()) {
    const scenario: Held = {
      row: {
        id: i + 1,
        name: s.name,
        main: i === 0,
        drafts: 0,
        notShown: options.notShown?.[s.name] ?? 0,
        applying: false,
        createdBy: PERSON,
        createdAt: DAY,
        updatedAt: DAY,
        version: 1,
      },
      drafts: new Map(),
      refused: new Map(),
    };
    write(scenario, s.proposals ?? [], false, 'scheduler');
    write(scenario, s.drafts ?? []);
    held.push(scenario);
  }

  const counted = (s: Held): ScenarioRow => ({ ...s.row, drafts: s.drafts.size });
  const find = (sid: number) => held.find((s) => s.row.id === sid);
  const sorted = () =>
    [...held].sort(
      (a, b) => Number(b.row.main) - Number(a.row.main) || a.row.name.localeCompare(b.row.name),
    );
  const refusedOutcome = <T>(code: string, fields: Record<string, string> = {}): Outcome<T> => ({
    ok: false,
    code,
    fields,
  });

  /** A ticket's drafts as the views mark them. */
  const markOf = (ticket: PlanTimelineItem, days: Days): DraftMark => ({
    ...(days.startDate ? { startDate: { now: ticket.start } } : {}),
    ...(days.dueDate ? { dueDate: { now: ticket.due } } : {}),
    stale:
      (days.startDate !== undefined && days.startDate.was !== ticket.start) ||
      (days.dueDate !== undefined && days.dueDate.was !== ticket.due),
    origin: byScheduler(days) ? 'scheduler' : 'person',
  });

  plans.attachScenarios({
    info: (sid) => {
      const s = find(sid);
      if (!s) return null;
      const { id, name, main, drafts, notShown } = counted(s);
      return { id, name, main, drafts, notShown };
    },
    overlay: (items, sid) => {
      const s = find(sid);
      if (!s) return items;
      return items.map((i) => {
        const days = s.drafts.get(i.id);
        if (!days) return i;
        return {
          ...i,
          ...(days.startDate ? { start: days.startDate.draft } : {}),
          ...(days.dueDate ? { due: days.dueDate.draft } : {}),
          dated: 'own' as const,
          draft: markOf(i, days),
        };
      });
    },
  });

  const changeOf = (s: Held, ticket: PlanTimelineItem, days: Days): PlanChange => {
    const fields: ChangeField[] = (['startDate', 'dueDate'] as const).flatMap((field) => {
      const d = days[field];
      if (!d) return [];
      const now = field === 'startDate' ? ticket.start : ticket.due;
      return [
        {
          field,
          teamFieldId: null,
          was: d.was,
          now,
          draft: d.draft,
          state: now === d.draft ? 'already' : now !== d.was ? 'changed' : 'ready',
        } satisfies ChangeField,
      ];
    });
    const refusal = s.refused.get(ticket.id) ?? null;
    const cannot = options.cannotApply?.includes(ticket.key) ?? false;
    return {
      ticketId: ticket.id,
      key: ticket.key,
      summary: ticket.summary,
      trackId: ticket.trackId,
      version: 1,
      state: fields.some((f) => f.state === 'changed')
        ? 'changed'
        : refusal
          ? 'refused'
          : fields.every((f) => f.state === 'already')
            ? 'already'
            : 'ready',
      fields,
      mayApply: !cannot,
      needs: cannot ? 'schedule_tickets' : null,
      refusal,
      refusedAt: refusal ? DAY : null,
      origin: byScheduler(days) ? 'scheduler' : 'person',
      updatedBy: PERSON,
      updatedAt: DAY,
    };
  };

  const page = (s: Held, ids?: number[]): ChangePage => {
    const now = live();
    const all = [...s.drafts.entries()]
      .sort(([a], [b]) => a - b)
      .flatMap(([id, days]) => {
        const ticket = now.get(id);
        return ticket ? [changeOf(s, ticket, days)] : [];
      });
    const count = (state: PlanChange['state']) => all.filter((c) => c.state === state).length;
    return {
      changes: ids ? all.filter((c) => ids.includes(c.ticketId)) : all,
      counts: {
        ready: count('ready'),
        already: count('already'),
        changed: count('changed'),
        refused: count('refused'),
      },
      drafts: all.length,
      notShown: s.row.notShown,
      teams: [],
      teamFields: [],
      next: null,
    };
  };

  const list = async (): Promise<ScenarioList> => {
    if (options.failList) throw new Error('offline');
    return structuredClone({
      plan: { id: 12, name: 'Spring launch' },
      editable,
      scenarios: sorted().map(counted),
      limits: { scenarios: 20, draftedTickets: 10_000, perRequest: 200, perApply: 100 },
    });
  };

  const applyTickets = async (s: Held, ids: number[]): Promise<ApplyResult> => {
    const result: ApplyResult = { applied: [], refused: [], next: null, notShown: s.row.notShown };
    const now = live();
    for (const id of ids) {
      const ticket = now.get(id);
      const days = s.drafts.get(id);
      if (!ticket || !days) {
        result.refused.push({ ticketId: id, key: null, reason: 'gone' });
        continue;
      }
      const stale =
        (days.startDate && days.startDate.was !== ticket.start) ||
        (days.dueDate && days.dueDate.was !== ticket.due);
      const refusal: ChangeRefusal | undefined = stale
        ? {
            reason: 'changed_meanwhile',
            now: {
              ...(days.startDate ? { startDate: ticket.start } : {}),
              ...(days.dueDate ? { dueDate: ticket.due } : {}),
            },
          }
        : options.refuse?.[ticket.key];
      if (refusal) {
        s.refused.set(id, refusal);
        result.refused.push({ ticketId: id, key: ticket.key, ...refusal });
        continue;
      }
      await plans.reschedule(ticket.key, {
        startDate: days.startDate ? days.startDate.draft : ticket.start,
        dueDate: days.dueDate ? days.dueDate.draft : ticket.due,
      });
      s.drafts.delete(id);
      result.applied.push({ ticketId: id, key: ticket.key });
    }
    return result;
  };

  const readiness: ScenarioClient['readiness'] = async (_planId, at = {}) => {
    readinessAsked.push(structuredClone(at));
    if (options.failReadiness) throw new Error('offline');
    const open = plans.items().filter((i) => i.level.rank === 0 && i.status.stage !== 'closed');
    const s = at.scenario === undefined ? undefined : find(at.scenario);
    const drafted = s ? [...s.drafts.values()] : [];
    const answer: ScheduleReadiness = {
      unit: 'points',
      pointsField: { id: 30, name: 'Story points' },
      periods: fakeSchedulePeriods(at.from ?? '2026-11-04', at.periods ?? 6),
      teams: [
        { id: 3, name: 'Web', withCapacity: true },
        { id: 4, name: 'Ops', withCapacity: false },
      ],
      people: { withCapacity: 1, without: 2 },
      tickets: {
        open: open.length,
        unestimated: open.filter((i) => POINTS[i.key] === undefined).length,
        unassigned: open.filter((i) => !i.assignee).length,
        noTeam: 0,
      },
      editable,
      limits: { periods: 12, toSchedule: 10_000, leftOut: 20, query: 2_000 },
      types: TYPES,
      releases: [{ id: 5, name: '2.1', date: '2026-12-01' }],
      scenario: s
        ? {
            proposals: drafted.filter(byScheduler).length,
            drafts: drafted.filter(byPerson).length,
          }
        : null,
      ...options.readiness,
    };
    return structuredClone(answer);
  };

  /** A run as the server would make it, by the engine's rules over the fake plan. */
  const schedule = async (planId: number, body: ScheduleRequest): Promise<ScheduleRun> => {
    runs.push(structuredClone(body));
    if (options.holdSchedule) return new Promise<ScheduleRun>(() => {});
    if (options.refuseSchedule) return { ok: false, fields: {}, ...options.refuseSchedule };
    if (!editable) return { ok: false, code: 'forbidden', fields: {}, permission: 'edit_plan' };
    const bad: Record<string, string> = {};
    if (body.keep?.query?.includes('nope')) bad['keep.query'] = 'invalid_query';
    if (body.leaveOut?.query?.includes('nope')) bad['leaveOut.query'] = 'invalid_query';
    if (Object.keys(bad).length > 0) return { ok: false, code: 'invalid_fields', fields: bad };
    let created = false;
    let target: Held | undefined;
    if ('scenarioId' in body.into) target = find(body.into.scenarioId);
    else {
      const made = await self.create(
        planId,
        body.into.newScenario.name,
        body.into.newScenario.from,
      );
      if (!made.ok) return made;
      target = find(made.value.scenario.id);
      created = true;
    }
    if (!target) return { ok: false, code: 'not_found', fields: {} };
    const s = target;
    const from = body.from ?? '2026-11-04';
    const periods = fakeSchedulePeriods(from, body.periods ?? 6);
    const leftTypes = new Set(
      (body.leaveOut?.typeIds ?? []).map((id) => TYPES.find((x) => x.id === id)?.name),
    );
    const counts: ScheduleCounts = {
      placed: 0,
      already: 0,
      unchanged: 0,
      withdrawn: 0,
      changedMeanwhile: 0,
      kept: zeroes(KEPT_REASONS),
      notPlaced: zeroes(NOT_PLACED_REASONS),
      leftOut: zeroes(LEFT_OUT_REASONS),
      warnings: zeroes(SCHEDULE_WARNINGS),
      notShown: 0,
    };
    const entries: ScheduleEntry[] = [];
    const proposals = new Map<number, { start: string; due: string }>();
    const ends = new Map<number, string | null>();
    const load = periods.map(() => ({ points: 0, tickets: 0 }));
    const items = plans
      .items()
      .filter((i) => i.status.stage !== 'closed')
      .sort((a, b) => a.id - b.id);
    for (const i of items) {
      const days = s.drafts.get(i.id);
      const own = (f: 'startDate' | 'dueDate', liveValue: string | null) => {
        const d = days?.[f];
        return d && d.origin !== 'scheduler' ? d.draft : liveValue;
      };
      const now = { start: own('startDate', i.start), due: own('dueDate', i.due) };
      ends.set(i.id, now.due ?? now.start);
      const entry = (e: Pick<ScheduleEntry, 'outcome' | 'reason'> & Partial<ScheduleEntry>) =>
        entries.push({ id: i.id, key: i.key, summary: i.summary, args: {}, warnings: [], ...e });
      if (i.level.rank !== 0) counts.leftOut.level++;
      else if (leftTypes.has(i.type)) counts.leftOut.type++;
      else if (days && byPerson(days)) entry({ outcome: 'kept', reason: 'person_draft' });
      else if ((body.keep?.inProgress ?? true) && i.status.stage === 'active')
        entry({ outcome: 'kept', reason: 'in_progress' });
      else if (POINTS[i.key] === undefined) entry({ outcome: 'not_placed', reason: 'no_estimate' });
      else if (!i.assignee) entry({ outcome: 'not_placed', reason: 'no_assignee' });
      else {
        const estimate = POINTS[i.key] as number;
        let earliest = from;
        let blocker: number | null = null;
        let undated: number | null = null;
        for (const [b, to] of BLOCKS) {
          if (to !== i.id || !ends.has(b)) continue;
          const end = ends.get(b) ?? null;
          if (end === null) undated = b;
          else if (dayOf(numOf(end) + 1) > earliest) {
            earliest = dayOf(numOf(end) + 1);
            blocker = b;
          }
        }
        const p = periods.findIndex(
          (x, n) => x.end >= earliest && (load[n]?.points ?? 0) + estimate <= 20,
        );
        const cell = load[p];
        const period = periods[p];
        if (undated !== null) {
          entry({ outcome: 'not_placed', reason: 'blocker_undated', args: { blockerId: undated } });
        } else if (!cell || !period) {
          entry({
            outcome: 'not_placed',
            reason: 'no_room',
            args: { teamId: 3, until: periods.at(-1)?.end ?? from },
          });
        } else {
          const start = period.start > earliest ? period.start : earliest;
          const due = period.end;
          const args =
            start === now.start && due === now.due
              ? null
              : blocker !== null && start === earliest
                ? { blockerId: blocker, blockerEnd: dayOf(numOf(earliest) - 1) }
                : {
                    teamId: 3,
                    periodStart: period.start,
                    periodEnd: period.end,
                    free: 20 - cell.points,
                    capacity: 20,
                    before: cell.tickets,
                  };
          const warnings =
            i.key === 'SHOP-3' && due > '2026-12-01'
              ? [
                  {
                    kind: 'after_release' as const,
                    args: {
                      releaseId: 5,
                      releaseDate: '2026-12-01',
                      days: numOf(due) - numOf('2026-12-01'),
                    },
                  },
                ]
              : [];
          entry({
            outcome: 'placed',
            reason: args === null ? 'already' : 'blockerId' in args ? 'after_blocker' : 'fits',
            args: args ?? {},
            warnings,
          });
          if (args === null) counts.already = (counts.already ?? 0) + 1;
          cell.points += estimate;
          cell.tickets++;
          proposals.set(i.id, { start, due });
          ends.set(i.id, due);
        }
      }
    }
    for (const e of entries) {
      if (e.outcome === 'placed') counts.placed++;
      else if (e.outcome === 'kept') counts.kept[e.reason as keyof ScheduleCounts['kept']]++;
      else counts.notPlaced[e.reason as keyof ScheduleCounts['notPlaced']]++;
      for (const w of e.warnings) counts.warnings[w.kind]++;
    }
    // The write: earlier proposals not made again go, unless a person drafted the ticket.
    const byId = live();
    for (const [id, days] of [...s.drafts]) {
      if (!byScheduler(days) || byPerson(days) || proposals.has(id)) continue;
      s.drafts.delete(id);
      counts.withdrawn++;
    }
    for (const [id, proposal] of proposals) {
      const ticket = byId.get(id);
      if (!ticket) continue;
      const days: Days = s.drafts.get(id) ?? {};
      let same = true;
      for (const [field, value, liveValue] of [
        ['startDate', proposal.start, ticket.start],
        ['dueDate', proposal.due, ticket.due],
      ] as const) {
        const earlier = days[field];
        if (value === liveValue) {
          if (earlier) {
            delete days[field];
            same = false;
          }
        } else if (earlier?.draft !== value || earlier.was !== liveValue) {
          days[field] = { was: liveValue, draft: value, origin: 'scheduler' };
          same = false;
        }
      }
      if (same && Object.keys(days).length > 0) counts.unchanged++;
      if (Object.keys(days).length === 0) s.drafts.delete(id);
      else s.drafts.set(id, days);
    }
    const rank = (e: ScheduleEntry) =>
      e.outcome === 'not_placed' ? 0 : e.warnings.length > 0 ? 1 : e.outcome === 'kept' ? 2 : 3;
    entries.sort((a, b) => rank(a) - rank(b) || a.id - b.id);
    return {
      ok: true,
      value: structuredClone({
        scenario: { id: s.row.id, name: s.row.name, main: s.row.main, version: s.row.version },
        created,
        from,
        periods,
        counts,
        tickets: entries,
        more: 0,
        names: {
          teams: [
            { id: 3, name: 'Web' },
            { id: 4, name: 'Ops' },
          ],
          people: [
            { id: 7, name: 'Ana Ruiz' },
            { id: 8, name: 'Bo Lindqvist' },
          ],
          releases: [{ id: 5, name: '2.1' }],
          tickets: [],
        },
      }),
    };
  };

  const self: ReturnType<typeof fakeScenarioClient> = {
    applies,
    writes,
    discards,
    runs,
    readinessAsked,
    readiness,
    schedule,
    list,
    create: async (_planId, name, from) => {
      if (held.length >= 20) return refusedOutcome('too_many_scenarios');
      const source = from === undefined ? undefined : find(from);
      if (from !== undefined && !source)
        return refusedOutcome('invalid_fields', { from: 'not_found' });
      const scenario: Held = {
        row: {
          id: nextId++,
          name,
          main: held.length === 0,
          drafts: 0,
          notShown: 0,
          applying: false,
          createdBy: PERSON,
          createdAt: DAY,
          updatedAt: DAY,
          version: 1,
        },
        drafts: new Map(source ? structuredClone([...source.drafts]) : []),
        refused: new Map(),
      };
      held.push(scenario);
      return {
        ok: true,
        value: { scenario: counted(scenario), left: { notShown: source?.row.notShown ?? 0 } },
      };
    },
    rename: async (_planId, sid, name, version) => {
      const s = find(sid);
      if (!s) return refusedOutcome('not_found');
      if (s.row.version !== version) return refusedOutcome('version_conflict');
      s.row = { ...s.row, name, version: version + 1 };
      return { ok: true, value: counted(s) };
    },
    remove: async (_planId, sid, version) => {
      const s = find(sid);
      if (!s) return refusedOutcome('not_found');
      if (s.row.version !== version) return refusedOutcome('version_conflict');
      if (s.row.main && held.length > 1) return refusedOutcome('main_scenario');
      held.splice(held.indexOf(s), 1);
      return { ok: true, value: null };
    },
    promote: async (_planId, sid, version) => {
      const s = find(sid);
      if (!s) return refusedOutcome('not_found');
      if (s.row.version !== version) return refusedOutcome('version_conflict');
      for (const other of held) {
        if (other.row.main && other !== s) {
          other.row = { ...other.row, main: false, version: other.row.version + 1 };
        }
      }
      s.row = { ...s.row, main: true, version: s.row.version + 1 };
      return { ok: true, value: sorted().map(counted) };
    },
    changes: async (_planId, sid) => {
      const s = find(sid);
      if (!s) throw new Error('not_found');
      return structuredClone({
        scenario: { id: s.row.id, name: s.row.name, main: s.row.main },
        editable,
        applying: false,
        ...page(s),
      });
    },
    draft: async (_planId, sid, changes, options = {}) => {
      writes.push(changes);
      const s = find(sid);
      if (!s) return refusedOutcome('not_found');
      if (!editable) return { ok: false, code: 'forbidden', fields: {}, permission: 'edit_plan' };
      const bad: Record<string, string> = {};
      const now = live();
      changes.forEach((c, i) => {
        const ticket = now.get(c.ticketId);
        const days = s.drafts.get(c.ticketId);
        const start =
          c.startDate !== undefined
            ? c.startDate
            : days?.startDate
              ? days.startDate.draft
              : (ticket?.start ?? null);
        const due =
          c.dueDate !== undefined
            ? c.dueDate
            : days?.dueDate
              ? days.dueDate.draft
              : (ticket?.due ?? null);
        if (!ticket) bad[`changes.${i}.ticketId`] = 'not_found';
        else if (start !== null && due !== null && start > due) {
          bad[`changes.${i}.startDate`] = 'start_after_due';
        }
      });
      if (Object.keys(bad).length > 0) return refusedOutcome('invalid_fields', bad);
      write(s, changes, options.keep === true);
      return {
        ok: true,
        value: structuredClone(
          page(
            s,
            changes.map((c) => c.ticketId),
          ),
        ),
      };
    },
    discard: async (_planId, sid, which) => {
      const s = find(sid);
      if (!s) return refusedOutcome('not_found');
      discards.push('all' in which ? 'all' : which.tickets);
      const ids = 'all' in which ? [...s.drafts.keys()] : which.tickets;
      let discarded = 0;
      for (const id of ids) if (s.drafts.delete(id)) discarded++;
      return { ok: true, value: { discarded, notShown: s.row.notShown } };
    },
    apply: async (_planId, sid, which) => {
      const s = find(sid);
      if (!s) return refusedOutcome('not_found');
      if (!s.row.main) return refusedOutcome('not_main');
      if ('all' in which) {
        applies.push('all');
        const after = which.after ?? 0;
        const ids = [...s.drafts.keys()].filter((id) => id > after && !s.refused.has(id)).sort();
        const batch = ids.slice(0, 100);
        const result = await applyTickets(s, batch);
        return {
          ok: true,
          value: { ...result, next: ids.length > 100 ? (batch.at(-1) ?? null) : null },
        };
      }
      applies.push(which.tickets);
      return { ok: true, value: await applyTickets(s, which.tickets) };
    },
    compare: async (_planId, a, b): Promise<Comparison> => {
      const now = plans.items();
      const sideItems = (side: string) => {
        if (side === 'live') return now;
        const s = find(Number(side));
        if (!s) throw new Error('not_found');
        return now.map((i) => {
          const days = s.drafts.get(i.id);
          return days
            ? {
                ...i,
                ...(days.startDate ? { start: days.startDate.draft } : {}),
                ...(days.dueDate ? { due: days.dueDate.draft } : {}),
              }
            : i;
        });
      };
      const sideOf = (side: string) => {
        const items = sideItems(side);
        const open = items.filter((i) => i.status.stage !== 'closed');
        const dated = open
          .filter((i) => i.due !== null)
          .sort((x, y) => (x.due ?? '').localeCompare(y.due ?? ''));
        const last = dated.at(-1);
        const s = side === 'live' ? null : find(Number(side));
        const end = {
          due: last?.due ?? null,
          ticket: last ? { id: last.id, key: last.key, summary: last.summary } : null,
          undated: open.length - dated.length,
        };
        return {
          side,
          scenario: s
            ? {
                id: s.row.id,
                name: s.row.name,
                main: s.row.main,
                drafts: s.drafts.size,
                notShown: s.row.notShown,
              }
            : null,
          end,
          teams: [
            { team: { id: 3, name: 'Web' }, ...end },
            { team: null, due: null, ticket: null, undated: 0 },
          ],
          items,
        };
      };
      const sa = sideOf(a);
      const sb = sideOf(b);
      const differing = sa.items.flatMap((x) => {
        const y = sb.items.find((i) => i.id === x.id);
        if (!y || (x.start === y.start && x.due === y.due)) return [];
        return [
          {
            id: x.id,
            key: x.key,
            summary: x.summary,
            a: { start: x.start, due: x.due, team: null },
            b: { start: y.start, due: y.due, team: null },
          },
        ];
      });
      const strip = ({ items: _items, ...side }: ReturnType<typeof sideOf>) => side;
      return structuredClone({
        plan: { id: 12, name: 'Spring launch' },
        query: 'track IN ("SHOP", "OPS")',
        teamField: { id: 40, name: 'Team' },
        teamFields: [{ id: 40, name: 'Team' }],
        a: strip(sa),
        b: strip(sb),
        later: differing.filter((d) => (d.b.due ?? '') > (d.a.due ?? '')).length,
        earlier: differing.filter((d) => (d.b.due ?? '') < (d.a.due ?? '')).length,
        differing: { count: differing.length, tickets: differing },
      });
    },
  };
  return self;
}
