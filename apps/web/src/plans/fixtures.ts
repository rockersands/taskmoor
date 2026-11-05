import { ApiError } from '../api/client';
import { dayNumber, isoDay, type Refusal } from '../timeline/client';
import { fakeCapacity, PLAN_PERIOD, PLAN_TEAMS } from './capacityFixtures';
import {
  type CapacityEntry,
  type CapacitySettings,
  type CapacityUnit,
  filterParams,
  type Plan,
  type PlanCalendar,
  type PlanClient,
  type PlanFilters,
  type PlanInput,
  type PlanPeriod,
  type PlanRow,
  type PlanSummary,
  type PlanTimeline,
  type PlanTimelineItem,
} from './client';

/**
 * A Multi-track plan in memory for stories and tests (ADR-122): "Spring launch" over the tracks
 * SHOP and OPS and the saved search "Billing due", with an outcome in SHOP rolled up from two
 * features, an OPS ticket, and a saved search that no longer runs. Dependencies (PLN-006): SHOP-2
 * blocks SHOP-3, which starts before SHOP-2 ends (late), and OPS-4 across the tracks; OPS-4
 * blocks OPS-5, which has no dates, and is itself blocked by two tickets outside the plan, only
 * counted. Filters narrow the tickets as the server would, and a blocker they leave out is
 * counted as the plan's own; rescheduling changes them; `refuse` answers the code the ticket
 * route would, and `hidden` hides sources from the viewer.
 */
const item = (
  id: number,
  key: string,
  summary: string,
  extra: Partial<PlanTimelineItem>,
): PlanTimelineItem => ({
  id,
  key,
  summary,
  type: 'Feature',
  level: { rank: 0, kind: 'standard' },
  parentId: null,
  status: { name: 'New', stage: 'new' },
  start: null,
  due: null,
  dated: null,
  rollup: null,
  trackId: 1,
  assignee: null,
  priority: 'Medium',
  ...extra,
});

const ANA = { id: 7, name: 'Ana Ruiz' };
const BO = { id: 8, name: 'Bo Lindqvist' };

export const planItems = (): PlanTimelineItem[] => [
  item(1, 'SHOP-1', 'Spring launch', { type: 'Outcome', level: { rank: 1, kind: 'outcome' } }),
  item(2, 'SHOP-2', 'Build the shop page', {
    parentId: 1,
    start: '2026-11-02',
    due: '2026-11-10',
    dated: 'own',
    status: { name: 'Active', stage: 'active' },
    assignee: ANA,
    priority: 'High',
  }),
  item(3, 'SHOP-3', 'Take payments', {
    parentId: 1,
    start: '2026-11-09',
    due: '2026-11-20',
    dated: 'own',
    assignee: BO,
  }),
  item(4, 'OPS-4', 'Scale the servers', {
    trackId: 2,
    start: '2026-11-12',
    due: '2026-11-18',
    dated: 'own',
    assignee: ANA,
  }),
  item(5, 'OPS-5', 'Write the runbook', { trackId: 2, type: 'Chore' }),
];

/** The roll-ups the server gives, from the listed children. */
function rolled(items: PlanTimelineItem[]): PlanTimelineItem[] {
  return items.map((i) => {
    const children = items.filter((c) => c.parentId === i.id);
    if (children.length === 0) return { ...i, rollup: null };
    const starts = children.flatMap((c) => (c.start ? [c.start] : [])).sort();
    const dues = children.flatMap((c) => (c.due ? [c.due] : [])).sort();
    return {
      ...i,
      rollup: {
        start: starts[0] ?? null,
        due: dues.at(-1) ?? null,
        total: children.length,
        closed: children.filter((c) => c.status.stage === 'closed').length,
      },
    };
  });
}

const TRACKS = [
  { id: 1, key: 'SHOP', name: 'Shop' },
  { id: 2, key: 'OPS', name: 'Operations' },
];

/** The clauses the server adds for the filters. */
function passes(i: PlanTimelineItem, filters: PlanFilters, me: number): boolean {
  if (filters.track && TRACKS.find((x) => x.id === i.trackId)?.key !== filters.track) return false;
  if (filters.assignee === 'me' && i.assignee?.id !== me) return false;
  if (filters.assignee === 'none' && i.assignee) return false;
  if (
    filters.assignee &&
    /^\d+$/.test(filters.assignee) &&
    String(i.assignee?.id) !== filters.assignee
  )
    return false;
  if (filters.type && i.type !== filters.type) return false;
  if (filters.stage && i.status.stage !== filters.stage) return false;
  return true;
}

const filterText = (filters: PlanFilters) =>
  [
    filters.track ? `track = "${filters.track}"` : null,
    filters.assignee === 'me'
      ? 'assignee = currentUser()'
      : filters.assignee === 'none'
        ? 'assignee IS EMPTY'
        : filters.assignee
          ? `assignee = ${filters.assignee}`
          : null,
    filters.type ? `type = "${filters.type}"` : null,
    filters.stage ? `stage = ${filters.stage}` : null,
  ]
    .filter(Boolean)
    .join(' AND ');

const BASE = 'track IN ("SHOP", "OPS") OR (track = PLB AND due IS NOT EMPTY)';

/** Blocking links between the plan's tickets: `from` blocks `to`. */
const LINKS = [
  { from: 2, to: 3 },
  { from: 2, to: 4 },
  { from: 4, to: 5 },
];
/** Blockers outside the plan (or hidden from the viewer), by the ticket they block. */
const OUTSIDE = new Map([[4, 2]]);

export interface FakePlanOptions {
  /** Answer reschedules with this code (or this refusal) instead of saving them. */
  refuse?: string | Omit<Refusal, 'ok'>;
  /** Fail reading the plan for these filters, as a dropped connection or a 503 would. */
  failOn?: (filters: PlanFilters) => boolean;
  /** Its one source an archived track: seen, but nothing to search. */
  archivedOnly?: boolean;
  /** How many sources the viewer cannot see; with every one hidden, the plan finds nothing. */
  hidden?: number | 'all';
  /** Other items instead of the default ones (a large plan). */
  items?: PlanTimelineItem[];
  editable?: boolean;
  /** The person viewing (for `assignee = me`). */
  me?: number;
  /** A plan that plans with no teams yet. */
  noTeams?: boolean;
  /** Answer capacity changes with this code instead of saving them. */
  refuseCapacity?: string;
}

const refusal = (r: string | Omit<Refusal, 'ok'>): Refusal =>
  typeof r === 'string' ? { ok: false, code: r } : { ok: false, ...r };

export function fakePlanClient(options: FakePlanOptions = {}): PlanClient & {
  items: () => PlanTimelineItem[];
  saved: PlanInput[];
  removed: number[];
  capacitySaved: CapacityEntry[][];
  /** The unit and periods each change of capacity said it was typed for. */
  capacitySettings: (CapacitySettings | undefined)[];
  /** The name each copy was asked for (PLN-014). */
  duplicated: string[];
  /** How many reads were for a file: the Timeline's and the Calendar's. */
  exportReads: () => number;
  /** How many times the plan itself was read. */
  planReads: () => number;
} {
  const capacity = fakeCapacity();
  let teams = options.noTeams ? [] : PLAN_TEAMS;
  let unit: CapacityUnit = 'points';
  let period: PlanPeriod = PLAN_PERIOD;
  let items = rolled(options.items ?? planItems());
  const me = options.me ?? ANA.id;
  const nothing = options.hidden === 'all';
  const saved: PlanInput[] = [];
  const removed: number[] = [];
  const capacitySettings: (CapacitySettings | undefined)[] = [];
  const duplicated: string[] = [];
  let exportReads = 0;
  let planReads = 0;
  let version = 1;
  let name = 'Spring launch';
  const plan = (filters: PlanFilters = {}): Plan => ({
    id: 12,
    name,
    description: 'The shop and the servers it needs.',
    owner: { id: ANA.id, name: ANA.name },
    shares: [],
    editable: options.editable ?? true,
    sources: nothing
      ? []
      : options.archivedOnly
        ? [{ kind: 'track', id: 1, key: 'SHOP', name: 'Shop', state: 'archived' }]
        : [
            { kind: 'track', id: 1, key: 'SHOP', name: 'Shop', state: 'visible' },
            { kind: 'track', id: 2, key: 'OPS', name: 'Operations', state: 'visible' },
            { kind: 'savedSearch', id: 30, name: 'Billing due', state: 'visible' },
            { kind: 'savedSearch', id: 31, name: 'Old import', state: 'broken' },
          ],
    hiddenSources: options.hidden === 'all' ? 4 : (options.hidden ?? 0),
    query:
      nothing || options.archivedOnly
        ? null
        : filterText(filters)
          ? `(${BASE}) AND ${filterText(filters)}`
          : BASE,
    version,
    capacityUnit: unit,
    period,
    teams,
  });
  const shown = (filters: PlanFilters) =>
    nothing ? [] : items.filter((i) => passes(i, filters, me));
  const query = (filters: PlanFilters) => plan(filters).query;
  return {
    items: () => items,
    saved,
    removed,
    capacitySaved: capacity.saved,
    duplicated,
    exportReads: () => exportReads,
    planReads: () => planReads,
    capacitySettings,
    list: async (): Promise<PlanRow[]> => [
      {
        id: 12,
        name,
        description: '',
        owner: { id: ANA.id, name: ANA.name },
        shares: [],
        editable: true,
        sourceCount: 4,
      },
      {
        id: 13,
        name: 'Data centre move',
        description: '',
        owner: { id: BO.id, name: BO.name },
        shares: [{ scope: 'any_user' }],
        editable: false,
        sourceCount: 3,
      },
    ],
    duplicate: async (_id, copy) => {
      if (copy === 'Refused') return { ok: false, error: 'not_found', fields: {} };
      duplicated.push(copy);
      return {
        ok: true,
        plan: { ...plan(), id: 99, name: copy, shares: [], hiddenSources: 0 },
        left: { hiddenSources: nothing ? 4 : ((options.hidden as number | undefined) ?? 0) },
      };
    },
    exportHref: (id, file) =>
      `/api/v1/plans/${id}/export?${new URLSearchParams({
        ...Object.fromEntries(filterParams(file.filters)),
        columns: ['key', ...file.columns].join(','),
        sort: file.sort,
      })}`,
    get: async (id, filters = {}) => {
      planReads++;
      if (id !== 12) throw new ApiError(404, { error: 'not_found' });
      if (filters.track === 'NOPE') throw new ApiError(400, { error: 'invalid_query' });
      if (options.failOn?.(filters)) throw new ApiError(503, { error: 'query_timeout' });
      return plan(filters);
    },
    create: async (input) => {
      saved.push(input);
      if (input.sources?.some((s) => s.kind === 'track' && s.trackId === 99)) {
        return { ok: false, error: 'invalid_fields', fields: { 'sources.0.trackId': 'not_found' } };
      }
      return { ok: true, plan: { ...plan(), id: 14, name: input.name } };
    },
    update: async (_id, input) => {
      saved.push({ name: input.name ?? name, ...input });
      if (input.version !== version) {
        return { ok: false, error: 'version_conflict', fields: {} };
      }
      version++;
      if (input.name) name = input.name;
      if (input.teams) teams = PLAN_TEAMS.filter((x) => input.teams?.includes(x.id));
      if (input.capacityUnit) unit = input.capacityUnit;
      if (input.period) period = input.period;
      return { ok: true, plan: plan() };
    },
    remove: async (id) => {
      removed.push(id);
    },
    releases: async (_id, track) => {
      const shop = { id: 1, key: 'SHOP', name: 'Shop' };
      const ops = { id: 2, key: 'OPS', name: 'Operations' };
      const progress = { tickets: 4, closed: 1, open: 3 };
      const plain = { shipped: false, archived: false, overdue: false, progress };
      const gathered = track
        ? []
        : [
            {
              id: 5,
              name: 'Launch across tracks',
              endRule: 'fixed_date' as const,
              date: '2026-12-01',
              state: 'upcoming' as const,
              progress: { tickets: 8, closed: 2, open: 6 },
              hidden: { releases: 1, open: 4 },
              releases: [
                {
                  id: 21,
                  name: '2.0',
                  track: shop,
                  releaseDate: '2026-12-01',
                  outOfStep: false,
                  ...plain,
                },
                {
                  id: 22,
                  name: '1.4',
                  track: ops,
                  releaseDate: '2026-12-08',
                  outOfStep: true,
                  ...plain,
                },
              ],
            },
          ];
      return {
        crossTrack: gathered,
        tracks: [
          {
            track: ops,
            releases: [{ id: 23, name: 'Ops 1.5', releaseDate: '2027-01-15', ...plain }],
          },
        ],
        truncated: false,
      };
    },
    choices: async () => ({
      tracks: TRACKS.map((x) => ({ ...x, count: items.filter((i) => i.trackId === x.id).length })),
      types: [...new Set(items.map((i) => i.type))].sort().map((type) => ({
        name: type,
        count: items.filter((i) => i.type === type).length,
      })),
      assignees: [ANA, BO].map((p) => ({
        ...p,
        count: items.filter((i) => i.assignee?.id === p.id).length,
      })),
      unassigned: items.filter((i) => !i.assignee).length,
    }),
    summary: async (_id, filters): Promise<PlanSummary> => {
      const list = shown(filters);
      const q = query(filters);
      const open = list.filter((i) => i.status.stage !== 'closed');
      const count = (id: string, name: string | null, clause: string | null, n: number) => ({
        id,
        name,
        query: clause ? `(${q}) AND ${clause}` : (q ?? ''),
        count: n,
      });
      return {
        query: q,
        total: count('total', null, null, list.length),
        overview: [
          count('open', null, 'stage != closed', open.length),
          count('overdue', null, 'stage != closed AND due < startOfDay()', 0),
          count('dueSoon', null, 'stage != closed AND due >= startOfDay() AND due <= 7d', 1),
          count(
            'unscheduled',
            null,
            'stage != closed AND start IS EMPTY AND due IS EMPTY',
            open.filter((i) => !i.start && !i.due).length,
          ),
          count('closedRecently', null, 'closed >= -7d', 0),
        ],
        stages: (['new', 'active', 'closed'] as const).map((s) =>
          count(s, s, `stage = ${s}`, list.filter((i) => i.status.stage === s).length),
        ),
        tracks: TRACKS.filter((x) => list.some((i) => i.trackId === x.id)).map((x) =>
          count(
            String(x.id),
            x.key,
            `track = "${x.key}"`,
            list.filter((i) => i.trackId === x.id).length,
          ),
        ),
        assignees: [ANA, BO].map((p) =>
          count(
            String(p.id),
            p.name,
            `stage != closed AND assignee = ${p.id}`,
            open.filter((i) => i.assignee?.id === p.id).length,
          ),
        ),
      };
    },
    timeline: async (_id, filters, exporting): Promise<PlanTimeline> => {
      if (exporting) exportReads++;
      const list = shown(filters);
      const listed = list.slice(0, 10_000);
      const ids = new Set(listed.map((i) => i.id));
      const links = nothing ? [] : LINKS.filter((l) => ids.has(l.from) && ids.has(l.to));
      const blockersElsewhere = nothing
        ? []
        : listed.flatMap((i) => {
            const outside = OUTSIDE.get(i.id) ?? 0;
            const unlisted = LINKS.filter((l) => l.to === i.id && !ids.has(l.from)).length;
            return outside + unlisted > 0 ? [{ id: i.id, outside, unlisted }] : [];
          });
      return structuredClone({
        query: query(filters),
        items: listed,
        links,
        blockersElsewhere,
        tracks: TRACKS,
        markers: {
          sprints: nothing
            ? []
            : [
                {
                  id: 9,
                  name: 'Shop Sprint 4',
                  state: 'active',
                  start: '2026-11-09',
                  end: '2026-11-20',
                },
              ],
          releases: nothing
            ? []
            : [{ id: 7, name: 'Shop 2.0', date: '2026-11-21', shipped: false }],
        },
        truncated: list.length > listed.length,
      });
    },
    calendar: async (_id, filters, from, to, exporting): Promise<PlanCalendar> => {
      if (exporting) exportReads++;
      const inRange = (d: string | null) => d !== null && d >= from && d <= to;
      const list = shown(filters).filter((i) => inRange(i.start) || inRange(i.due));
      return structuredClone({
        query: query(filters),
        tickets: list.slice(0, 10_000).map((i) => ({
          id: i.id,
          key: i.key,
          summary: i.summary,
          type: i.type,
          stage: i.status.stage,
          start: i.start,
          due: i.due,
          trackId: i.trackId,
        })),
        tracks: TRACKS,
        sprints: [],
        releases: [],
        truncated: list.length > 10_000,
      });
    },
    reschedule: async (key, dates) => {
      if (options.refuse) return refusal(options.refuse);
      items = rolled(
        items.map((i) =>
          i.key === key ? { ...i, start: dates.startDate, due: dates.dueDate, dated: 'own' } : i,
        ),
      );
      return { ok: true };
    },
    move: async (key, days) => {
      if (options.refuse) return refusal(options.refuse);
      items = rolled(
        items.map((i) =>
          i.key === key
            ? {
                ...i,
                ...(days.startDate !== undefined ? { start: days.startDate } : {}),
                ...(days.dueDate !== undefined ? { due: days.dueDate } : {}),
                dated: 'own',
              }
            : i,
        ),
      );
      return { ok: true };
    },
    capacity: async (_id, filters, from, periods) => {
      const answer = capacity.answer(
        shown(filters),
        query(filters),
        filters,
        from,
        periods,
        options.editable ?? true,
        unit,
      );
      return teams.length === 0 ? { ...answer, teams: [] } : answer;
    },
    setCapacity: async (_id, entries, settings) => {
      capacitySettings.push(settings);
      if (options.refuseCapacity) return options.refuseCapacity;
      // As the server does: amounts typed for another unit or other periods are refused.
      if (
        settings &&
        (settings.unit !== unit || JSON.stringify(settings.period) !== JSON.stringify(period))
      ) {
        return 'settings_changed';
      }
      return capacity.setCapacity(entries);
    },
    teamOptions: async () => [
      { id: 3, name: 'Web', memberCount: 2 },
      { id: 4, name: 'Ops', memberCount: 1 },
      { id: 5, name: 'Data', memberCount: 4 },
    ],
    sourceOptions: async () => ({
      tracks: [...TRACKS, { id: 3, key: 'DATA', name: 'Data' }],
      savedSearches: [
        { id: 30, name: 'Billing due' },
        { id: 31, name: 'Old import' },
      ],
    }),
  };
}

/** A plan of `n` dated tickets over 20 tracks, for the render budget of 10,000 rows. */
export function manyPlanItems(n: number): PlanTimelineItem[] {
  const base = dayNumber('2026-11-02');
  return Array.from({ length: n }, (_, k) => {
    const i = k + 1;
    const start = base + (i % 150);
    return item(i, `T${(i % 20) + 1}-${i}`, `Ticket number ${i}`, {
      trackId: (i % 2) + 1,
      start: isoDay(start),
      due: isoDay(start + 5),
      dated: 'own',
    });
  });
}
