import { BOARD } from '../boards/fixtures';
import type { Widget } from '../dashboards/client';
import type { NamedField } from '../tickets/customFieldNames';
import type { Transition } from '../tickets/view/client';
import type {
  OutcomeRights,
  SummaryItem,
  TrackClient,
  TrackOutcome,
  TrackOutcomes,
  TrackSections,
  TrackSummary,
  TrackSummaryLayout,
} from './client';
import type { OutcomeManager } from './outcomeManager';

/** A track's summary for stories and tests (M1-064): made up, its parts adding up. */
const item = (id: string, name: string | null, query: string, count: number): SummaryItem => ({
  id,
  name,
  query,
  count,
  exact: true,
});

export const SHOP_SUMMARY: TrackSummary = {
  track: { id: 1, key: 'SHOP', name: 'Shop' },
  overview: [
    item('open', null, 'track = SHOP AND closeReason IS EMPTY', 26),
    item('created', null, 'track = SHOP AND created >= -7d', 9),
    item('closed', null, 'track = SHOP AND closed >= -7d', 7),
    item('updated', null, 'track = SHOP AND updated >= -7d', 15),
    item('due', null, 'track = SHOP AND closeReason IS EMPTY AND due <= 7d', 4),
  ],
  stages: [
    item('new', 'new', 'track = SHOP AND stage = new', 14),
    item('active', 'active', 'track = SHOP AND stage = active', 12),
    item('closed', 'closed', 'track = SHOP AND stage = closed', 120),
  ],
  priorities: [
    item('High', 'High', 'track = SHOP AND closeReason IS EMPTY AND priority = "High"', 8),
    item('Medium', 'Medium', 'track = SHOP AND closeReason IS EMPTY AND priority = "Medium"', 12),
    item('none', null, 'track = SHOP AND closeReason IS EMPTY AND priority IS EMPTY', 6),
  ],
  types: [
    item('Bug', 'Bug', 'track = SHOP AND closeReason IS EMPTY AND type = "Bug"', 11),
    item('Feature', 'Feature', 'track = SHOP AND closeReason IS EMPTY AND type = "Feature"', 15),
  ],
  assignees: [
    item('2', 'Ada Lovelace', 'track = SHOP AND closeReason IS EMPTY AND assignee = 2', 10),
    item('3', 'Grace Hopper', 'track = SHOP AND closeReason IS EMPTY AND assignee = 3', 9),
    item('unassigned', null, 'track = SHOP AND closeReason IS EMPTY AND assignee IS EMPTY', 7),
  ],
};

/** What the widgets of a customized Summary and the track's reports read, for stories and tests. */
const WIDGET_DATA: Record<string, unknown> = {
  'w-open': {
    tickets: [
      {
        id: 41,
        key: 'SHOP-41',
        summary: 'Checkout fails for expired cards',
        status: 'Active',
        priority: 'High',
        assignee: 'Ada Lovelace',
      },
    ],
    total: { count: 1, exact: true },
  },
};
export const CREATED_VS_CLOSED = {
  timeZone: 'UTC',
  periods: ['2026-10-26', '2026-10-27', '2026-10-28'],
  created: [3, 1, 2],
  closed: [1, 2, 0],
  cumulative: false,
};
export const TWO_DIMENSIONAL = {
  fields: { x: 'status', y: 'priority' },
  x: [
    { id: '1', name: 'New', kind: 'value', total: 3 },
    { id: '2', name: 'Active', kind: 'value', total: 2 },
  ],
  y: [
    { id: '1', name: 'High', kind: 'value', total: 4 },
    { id: null, name: null, kind: 'none', total: 1 },
  ],
  cells: [
    [2, 1],
    [2, 0],
  ],
  total: 5,
};

export const TIME_SINCE = {
  timeZone: 'UTC',
  field: 'due',
  periods: ['2026-10-26', '2026-10-27', '2026-10-28'],
  counts: [2, 0, 4],
  cumulative: false,
};
export const PIE = {
  field: 'assignee',
  values: [
    { id: '2', name: 'Ada Lovelace', kind: 'value', total: 4 },
    { id: '3', name: 'Grace Hopper', kind: 'value', total: 3 },
    { id: null, name: null, kind: 'none', total: 1 },
  ],
  total: 8,
};
const listed = (n: number, summary: string, closed: boolean) => ({
  id: n,
  key: `SHOP-${n}`,
  summary,
  status: closed ? 'Closed' : 'Active',
  closed,
  assignee: 'Ada Lovelace',
});
export const GROUP_BY = {
  field: 'assignee',
  values: [
    {
      id: '2',
      name: 'Ada Lovelace',
      kind: 'value',
      total: 3,
      closed: 1,
      tickets: [
        listed(41, 'Checkout fails for expired cards', false),
        listed(40, 'Card payments', true),
      ],
    },
    {
      id: null,
      name: null,
      kind: 'none',
      total: 1,
      closed: 0,
      tickets: [listed(44, 'Gift cards', false)],
    },
  ],
  total: 4,
  closed: 1,
};
export const WORKLOAD = {
  field: 'assignee',
  statistic: 'remainingEstimate',
  open: true,
  release: null,
  values: [
    { id: '2', name: 'Ada Lovelace', kind: 'value', total: 3, seconds: 10_800, unestimated: 1 },
    { id: '3', name: 'Grace Hopper', kind: 'value', total: 2, seconds: 5400, unestimated: 0 },
  ],
  total: 5,
  seconds: 16_200,
  unestimated: 1,
};
export const TIME_TRACKING = {
  release: null,
  tickets: 6,
  estimated: 4,
  original: 36_000,
  remaining: 7200,
  spent: 25_200,
  rows: [
    {
      ...listed(41, 'Checkout fails for expired cards', false),
      original: 14_400,
      remaining: 3600,
      spent: 12_600,
    },
    { ...listed(40, 'Card payments', true), original: 21_600, remaining: 0, spent: 12_600 },
  ],
};
/** What each kind of the track's reports answers here. */
const STATISTICS: Record<string, unknown> = {
  'two-dimensional': TWO_DIMENSIONAL,
  'time-since': TIME_SINCE,
  pie: PIE,
  'ticket-statistics': PIE,
  'group-by': GROUP_BY,
  workload: WORKLOAD,
  'time-tracking': TIME_TRACKING,
};

/** A customized Summary: the numbers, a list and a note. */
export const CUSTOM_WIDGETS: Widget[] = [
  { id: 'w-numbers', kind: 'track-summary', column: 0, title: '', config: {} },
  {
    id: 'w-open',
    kind: 'search-results',
    column: 1,
    title: 'Open bugs',
    config: { query: '', limit: 10 },
  },
  {
    id: 'w-note',
    kind: 'introduction',
    column: 1,
    title: '',
    config: { text: 'Releases go out on Thursdays.' },
  },
];

/** A track's outcomes for stories and tests (AGL-024): open ones first, one closed. */
export const SHOP_OUTCOMES: TrackOutcome[] = [
  {
    id: 50,
    key: 'SHOP-50',
    summary: 'Card payments in every market',
    type: 'Outcome',
    status: { name: 'Active', stage: 'active' },
    startDate: '2026-10-05',
    dueDate: '2026-12-18',
    progress: { total: 8, closed: 5 },
  },
  {
    id: 51,
    key: 'SHOP-51',
    summary: 'A faster checkout',
    type: 'Outcome',
    status: { name: 'New', stage: 'new' },
    startDate: null,
    dueDate: '2027-01-29',
    progress: { total: 3, closed: 0 },
  },
  {
    id: 52,
    key: 'SHOP-52',
    summary: 'Gift cards',
    type: 'Outcome',
    status: { name: 'New', stage: 'new' },
    startDate: null,
    dueDate: null,
    progress: { total: 0, closed: 0 },
  },
  {
    id: 47,
    key: 'SHOP-47',
    summary: 'Saved addresses',
    type: 'Outcome',
    status: { name: 'Closed', stage: 'closed' },
    startDate: '2026-08-03',
    dueDate: '2026-09-25',
    progress: { total: 6, closed: 6 },
  },
];

/** Everything the Outcomes section offers to manage, with the seeded type (T-082). */
export const ALL_RIGHTS: OutcomeRights = {
  create: true,
  edit: true,
  schedule: true,
  close: true,
  types: [{ id: 9, name: 'Outcome' }],
};
/** What a viewer may manage there: nothing. */
export const NO_RIGHTS: OutcomeRights = {
  create: false,
  edit: false,
  schedule: false,
  close: false,
  types: [{ id: 9, name: 'Outcome' }],
};

/** Outcomes as the server pages them, `size` a page, for stories and tests. */
export function outcomePages(
  outcomes: TrackOutcome[],
  size = 100,
  outcomeTypes = ['Outcome'],
  manage: OutcomeRights = NO_RIGHTS,
): (key: string, cursor?: string) => Promise<TrackOutcomes> {
  return async (_key, cursor) => {
    const from = cursor ? Number(cursor) : 0;
    const next = from + size < outcomes.length ? String(from + size) : null;
    return {
      track: { id: 1, key: 'SHOP', name: 'Shop' },
      outcomeTypes,
      manage,
      outcomes: outcomes.slice(from, from + size),
      next,
    };
  };
}

/** The workflow's ways out of an open outcome, for stories and tests. */
export const OUTCOME_WAYS: Transition[] = [
  { id: 1, name: 'Start', to: { id: 2, name: 'Active', stage: 'active' }, layout: [] },
  { id: 2, name: 'Done', to: { id: 3, name: 'Closed', stage: 'closed' }, layout: [] },
];

/**
 * Outcomes that the manage panel changes, for stories and tests (T-082): the list and the manager
 * share one array, ordered as the server orders it (open first, each in rank order), and every
 * call is recorded. `ways` are the transitions every outcome offers; `refuse` answers each change
 * with that error instead.
 */
export function managedOutcomes(
  start: TrackOutcome[] = SHOP_OUTCOMES,
  options: {
    rights?: OutcomeRights;
    ways?: Transition[];
    refuse?: Error;
    /** The track's custom fields in the field catalogue, or the error reading them answers. */
    fields?: NamedField[] | Error;
  } = {},
) {
  const list = start.map((o) => ({ ...o }));
  const calls: unknown[][] = [];
  let next = 60;
  const ordered = () => [
    ...list.filter((o) => o.status.stage !== 'closed'),
    ...list.filter((o) => o.status.stage === 'closed'),
  ];
  const at = (id: number) => list.findIndex((o) => o.id === id);
  const refused = async () => {
    if (options.refuse) throw options.refuse;
  };
  const manager: OutcomeManager = {
    create: async (trackKey, ticketTypeId, summary) => {
      calls.push(['create', trackKey, ticketTypeId, summary]);
      await refused();
      const made: TrackOutcome = {
        id: next,
        key: `SHOP-${next++}`,
        summary,
        type: 'Outcome',
        status: { name: 'New', stage: 'new' },
        startDate: null,
        dueDate: null,
        progress: { total: 0, closed: 0 },
      };
      list.push(made);
      return { key: made.key };
    },
    edit: async (id, change) => {
      calls.push(['edit', id, change]);
      await refused();
      Object.assign(list[at(id)] as TrackOutcome, change);
    },
    rank: async (id, place) => {
      calls.push(['rank', id, place]);
      await refused();
      const [moved] = list.splice(at(id), 1);
      const anchor = 'before' in place ? place.before : place.after;
      list.splice(at(anchor) + ('before' in place ? 0 : 1), 0, moved as TrackOutcome);
    },
    transitions: async (id) => {
      calls.push(['transitions', id]);
      return options.ways ?? OUTCOME_WAYS;
    },
    transition: async (id, transitionId, fields) => {
      calls.push(['transition', id, transitionId, ...(fields ? [fields] : [])]);
      await refused();
      const way = (options.ways ?? OUTCOME_WAYS).find((w) => w.id === transitionId);
      const outcome = list[at(id)] as TrackOutcome;
      if (way) outcome.status = { name: way.to.name, stage: way.to.stage as 'closed' };
    },
    closeReasons: async () => [
      { id: 1, name: 'Done' },
      { id: 2, name: "Won't do" },
    ],
    priorities: async () => [],
    fieldNames: async (trackId) => {
      calls.push(['fieldNames', trackId]);
      const fields = options.fields ?? [{ id: 12, name: 'Customer tier' }];
      if (fields instanceof Error) throw fields;
      return fields.map((f) => ({ ...f }));
    },
  };
  return {
    calls,
    manager,
    outcomes: (key: string, cursor?: string) =>
      outcomePages(ordered(), 100, ['Outcome'], options.rights ?? ALL_RIGHTS)(key, cursor),
  };
}

export interface FakeTrackOptions {
  /** Which sections the track has; a Scrum track's by default. */
  sections?: TrackSections;
  /** Whether the person may customize; a viewer otherwise. */
  mayCustomize?: boolean;
  /** Starts customized. */
  custom?: TrackSummaryLayout['custom'];
  /** What a save answers instead of saving. */
  saveError?: 'version_conflict' | 'forbidden' | 'invalid';
}

export type FakeTrackClient = TrackClient & {
  saved: unknown[];
  /** The filters the numbers and the widgets were read with, in order ('' for none; T-075a). */
  filters: string[];
  statisticCalls: { kind: string; settings: unknown }[];
  /** The track ids the custom fields to group by were asked for. */
  groupFieldCalls: number[];
};

export function fakeTrackClient(
  summary: TrackSummary | null = SHOP_SUMMARY,
  options: FakeTrackOptions = {},
): FakeTrackClient {
  let custom = options.custom ?? null;
  const read = (): TrackSummaryLayout => {
    if (!summary) throw new Error('not_found');
    return {
      track: summary.track,
      mayCustomize: options.mayCustomize ?? false,
      custom,
    };
  };
  const saved: unknown[] = [];
  const statisticCalls: { kind: string; settings: unknown }[] = [];
  const groupFieldCalls: number[] = [];
  const filters: string[] = [];
  return {
    saved,
    filters,
    statisticCalls,
    groupFieldCalls,
    summaryLayout: async () => read(),
    saveSummaryLayout: async (_key, layout) => {
      saved.push(layout);
      if (options.saveError) return { ok: false, error: options.saveError };
      custom = {
        layout: layout.layout,
        version: (custom?.version ?? 0) + 1,
        widgets: layout.widgets.map((w, i) => ({ ...w, id: w.id ?? `w-saved-${i}` })),
      };
      return { ok: true, read: read() };
    },
    resetSummaryLayout: async () => {
      custom = null;
    },
    summaryWidget: async (_key, id, filter) => {
      filters.push(filter ?? '');
      return WIDGET_DATA[id] ?? null;
    },
    statistics: async (_key, kind, settings) => {
      statisticCalls.push({ kind, settings });
      return STATISTICS[kind] ?? CREATED_VS_CLOSED;
    },
    groupFields: async (trackId) => {
      groupFieldCalls.push(trackId);
      return [{ id: 'cf[9]', name: 'Team' }];
    },
    list: async () => [
      { id: 1, key: 'SHOP', name: 'Shop', owner: { id: 1, name: 'Ada Lovelace' } },
      { id: 2, key: 'WEB', name: 'Web', owner: null },
    ],
    sections: async () => options.sections ?? { backlog: true, sprints: true },
    board: async () => BOARD,
    files: async () => ({
      attachments: [
        {
          id: 1,
          name: 'invoice.pdf',
          size: 2048,
          createdAt: '2026-10-01T10:00:00Z',
          ticket: { key: 'SHOP-41', summary: 'Checkout fails for expired cards' },
        },
      ],
      links: [
        {
          id: 1,
          url: 'https://example.com/design',
          title: 'Design',
          ticket: { key: 'SHOP-40', summary: 'Card payments' },
        },
      ],
      truncated: false,
    }),
    outcomes: outcomePages(SHOP_OUTCOMES),
    summary: async (_key, filter) => {
      filters.push(filter ?? '');
      if (!summary) throw new Error('not_found');
      return filter ? filteredSummary(summary, filter) : summary;
    },
  };
}

/**
 * The numbers as a filter narrows them (T-075a), for stories and tests: each query gains the
 * filter after the track, as the server writes it, and each count drops to a third.
 */
export function filteredSummary(summary: TrackSummary, filter: string): TrackSummary {
  const narrow = (i: SummaryItem): SummaryItem => ({
    ...i,
    query: i.query.replace(/^track = (\w+)/, `track = $1 AND ${filter}`),
    count: Math.floor(i.count / 3),
  });
  return {
    ...summary,
    overview: summary.overview.map(narrow),
    stages: summary.stages.map(narrow),
    priorities: summary.priorities.map(narrow),
    types: summary.types.map(narrow),
    assignees: summary.assignees.map(narrow),
  };
}
