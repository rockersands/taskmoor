import type { DraftMark } from '../timeline/client';
import type { PlanTimelineItem } from './client';
import type { fakePlanClient } from './fixtures';
import type {
  ApplyResult,
  ChangeField,
  ChangePage,
  ChangeRefusal,
  Comparison,
  DraftInput,
  Outcome,
  PlanChange,
  ScenarioClient,
  ScenarioList,
  ScenarioRow,
} from './scenarioClient';

/**
 * Scenarios of the fake plan "Spring launch" in memory, for stories and tests (ADR-122 stage 6):
 * drafts of start and due days over the plan's tickets, read by the plan's views through
 * `attachScenarios`, listed as changes, applied through the plan's own `reschedule` (so the
 * tickets change only then), discarded, compared and made main. `refuse` answers an apply of a
 * ticket with a refusal, `cannotApply` lists the tickets the reader may not schedule, and
 * `notShown` counts drafts on tickets hidden from the reader in each scenario.
 */
export interface FakeScenarioOptions {
  editable?: boolean;
  /** Scenarios to start with, the first main, each with its drafts. */
  scenarios?: { name: string; drafts?: DraftInput[] }[];
  /** An apply of these tickets (by key) is refused so. */
  refuse?: Record<string, ChangeRefusal>;
  /** Tickets (by key) the reader lacks "Schedule tickets" for. */
  cannotApply?: string[];
  /** Drafts on hidden tickets, counted per scenario name. */
  notShown?: Record<string, number>;
  /** Fail reading the list, as a dropped connection would. */
  failList?: boolean;
}

const DAY = '2026-11-01T09:00:00Z';
const PERSON = { id: 7, name: 'Ana Ruiz' };

interface Days {
  startDate?: { was: string | null; draft: string | null };
  dueDate?: { was: string | null; draft: string | null };
}

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
} {
  const editable = options.editable ?? true;
  const held: Held[] = [];
  let nextId = 4;
  const applies: (number[] | 'all')[] = [];
  const writes: DraftInput[][] = [];
  const discards: (number[] | 'all')[] = [];
  const live = () => new Map(plans.items().map((i) => [i.id, i]));

  const write = (scenario: Held, changes: DraftInput[], keep = false) => {
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
        if (value === liveValue) delete days[field];
        else if (keep || days[field]?.draft !== value)
          days[field] = { was: liveValue, draft: value };
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
      origin: 'person',
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

  return {
    applies,
    writes,
    discards,
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
}
