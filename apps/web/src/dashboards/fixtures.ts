import type {
  Dashboard,
  DashboardClient,
  DashboardPatch,
  DashboardSummary,
  UpdateOutcome,
  Widget,
} from './client';

/**
 * Dashboards for stories and tests (M1-064): one with a widget of every kind and the data each
 * shows, made up but consistent, and a fake client that keeps edits in memory as the server
 * would (versions, a default, copies).
 */
const H = 3600;
const PERIODS = [
  '2026-10-23',
  '2026-10-24',
  '2026-10-25',
  '2026-10-26',
  '2026-10-27',
  '2026-10-28',
  '2026-10-29',
];

const widget = (
  id: string,
  kind: Widget['kind'],
  column: number,
  config: Record<string, unknown> = {},
  title = '',
): Widget => ({ id, kind, column, title, config });

export const TEAM_DASHBOARD: Dashboard = {
  id: 5,
  name: 'Checkout team',
  description: 'How checkout work is going',
  layout: 'three',
  owner: { id: 2, name: 'Ada Lovelace' },
  isDefault: false,
  shares: [{ scope: 'any_user' }],
  editable: true,
  version: 3,
  widgets: [
    widget('intro', 'introduction', 0, {
      text: 'Our tickets, sprints and releases.\n\nAsk in #checkout.',
    }),
    widget('links', 'quick-links', 0, {
      links: [
        { label: 'Board', url: '#/boards/7' },
        { label: 'Runbook', url: 'https://example.com/runbook' },
      ],
    }),
    widget('mine', 'assigned-to-me', 0, { limit: 10 }),
    widget('results', 'search-results', 1, { query: 'track = SHOP', limit: 3 }, 'Newest in SHOP'),
    widget('cvc', 'created-vs-closed', 1, {
      query: 'track = SHOP',
      days: 7,
      period: 'day',
      cumulative: false,
    }),
    widget('recent', 'recently-created', 1, { query: 'track = SHOP', days: 7, period: 'day' }),
    widget('pie', 'pie', 2, { query: 'track = SHOP', field: 'priority' }),
    widget('stats', 'ticket-statistics', 2, {
      query: 'track = SHOP',
      field: 'labels',
      sort: 'total',
    }),
    widget('grid', 'two-dimensional', 2, { query: 'track = SHOP', x: 'priority', y: 'status' }),
    widget('burndown', 'sprint-burndown', 0, { boardId: 7, sprintId: null }),
    widget('health', 'sprint-health', 1, { boardId: 7 }),
    widget('days', 'days-remaining', 2, { boardId: 7 }),
    widget('age', 'average-age', 1, { query: 'track = SHOP', days: 7, period: 'day' }),
    widget('close', 'time-to-close', 2, { query: 'track = SHOP', days: 7, period: 'day' }),
    widget('status', 'average-time-in-status', 0, { query: 'track = SHOP', days: 30 }),
    widget('followed', 'followed-tickets', 2, { limit: 10 }),
  ],
};

const ticket = (n: number, summary: string, status: string, priority: string | null) => ({
  id: n,
  key: `SHOP-${n}`,
  summary,
  status,
  priority,
  assignee: 'Ada Lovelace',
  updatedAt: '2026-10-29T10:00:00Z',
});

const value = (id: string | null, name: string | null, total: number, kind = 'value') => ({
  id,
  name,
  kind,
  total,
});

/** Each widget's data, as the server answers it. */
export const WIDGET_DATA: Record<string, unknown> = {
  intro: null,
  links: null,
  mine: {
    tickets: [
      ticket(12, 'Accept card payments', 'Active', 'High'),
      ticket(19, 'Refund a payment', 'New', 'Low'),
    ],
    total: { count: 2, exact: true },
  },
  followed: {
    tickets: [ticket(19, 'Refund a payment', 'New', 'Low')],
    total: { count: 1, exact: true },
  },
  results: {
    tickets: [
      ticket(31, 'Show the order total', 'New', 'Medium'),
      ticket(30, 'Send the receipt', 'Active', 'High'),
      ticket(29, 'Save the address', 'Closed', null),
    ],
    total: { count: 41, exact: true },
  },
  cvc: {
    timeZone: 'UTC',
    periods: PERIODS,
    created: [3, 5, 2, 0, 4, 6, 1],
    closed: [1, 2, 4, 1, 3, 2, 0],
    cumulative: false,
  },
  recent: { timeZone: 'UTC', periods: PERIODS, created: [3, 5, 2, 0, 4, 6, 1] },
  age: {
    timeZone: 'UTC',
    periods: PERIODS,
    age: [50, 52, 49, 53, 55, 51, 54].map((h) => h * H),
    open: [20, 23, 21, 20, 21, 25, 26],
  },
  close: {
    timeZone: 'UTC',
    periods: PERIODS,
    closed: [1, 2, 4, 1, 3, 2, 0],
    average: [30, 41, 26, 70, 33, 48, 0].map((h) => h * H),
  },
  pie: {
    field: 'priority',
    values: [
      value('1', 'Urgent', 2),
      value('2', 'High', 11),
      value('3', 'Medium', 17),
      value('4', 'Low', 8),
      value(null, null, 3, 'none'),
    ],
    total: 41,
  },
  stats: {
    field: 'labels',
    values: [
      value('checkout', 'checkout', 22),
      value('payments', 'payments', 14),
      value('ux', 'ux', 6),
      value(null, null, 9, 'none'),
    ],
    total: 41,
  },
  grid: {
    fields: { x: 'priority', y: 'status' },
    x: [value('2', 'High', 11), value('3', 'Medium', 17), value(null, null, 13, 'none')],
    y: [value('1', 'New', 18), value('2', 'Active', 15), value('4', 'Closed', 8)],
    cells: [
      [4, 5, 2],
      [8, 6, 3],
      [6, 4, 3],
    ],
    total: 41,
  },
  burndown: {
    board: { id: 7, name: 'Checkout board' },
    sprint: { id: 11, name: 'Checkout Sprint 10' },
    statistic: { statistic: 'ticketCount' },
    burnRemaining: false,
    timeZone: 'UTC',
    dates: [
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
    ],
    start: { at: '2026-10-26T09:00:00Z', remaining: 12, scope: 12 },
    guideline: {
      from: { at: '2026-10-26T09:00:00Z', date: '2026-10-26', value: 12 },
      to: { at: '2026-11-01T17:00:00Z', date: '2026-11-01', value: 0 },
    },
    steps: [],
    days: [
      { date: '2026-10-26', remaining: 12, scope: 12, completed: 0 },
      { date: '2026-10-27', remaining: 10, scope: 12, completed: 2 },
      { date: '2026-10-28', remaining: 9, scope: 13, completed: 4 },
      { date: '2026-10-29', remaining: 7, scope: 13, completed: 6 },
    ],
    end: { at: '2026-10-29T12:00:00Z', remaining: 7, scope: 13, completed: 6 },
    tickets: [],
  },
  health: {
    board: { id: 7, name: 'Checkout board' },
    sprint: { id: 11, name: 'Checkout Sprint 10' },
    statistic: { statistic: 'ticketCount' },
    elapsed: 0.55,
    completed: 6 / 13,
    scopeChange: 1 / 12,
    remaining: 7,
    scope: 13,
  },
  days: {
    board: { id: 7, name: 'Checkout board' },
    sprint: { id: 11, name: 'Checkout Sprint 10' },
    timeZone: 'UTC',
    daysRemaining: 3,
  },
  status: {
    timeZone: 'UTC',
    statuses: [
      { status: { id: 1, name: 'New' }, tickets: 30, average: 70 * H, entries: 22 },
      { status: { id: 2, name: 'Active' }, tickets: 24, average: 31 * H, entries: 30 },
      { status: { id: 3, name: 'In Review' }, tickets: 18, average: 9 * H, entries: 21 },
      { status: { id: 4, name: 'Closed' }, tickets: 20, average: 200 * H, entries: 20 },
    ],
  },
};

const summary = (d: Dashboard): DashboardSummary => {
  const { widgets: _widgets, ...rest } = d;
  return rest;
};

/** A copy, as a server answers: the page never holds the fake's own objects. */
const copyOf = (d: Dashboard): Dashboard => ({
  ...d,
  shares: d.shares.map((x) => ({ ...x })),
  widgets: d.widgets.map((w) => ({ ...w, config: { ...w.config } })),
});

export interface FakeDashboardClient extends DashboardClient {
  dashboards: Dashboard[];
  patches: { id: number; patch: DashboardPatch }[];
  defaultId: number | null;
}

export function fakeDashboardClient(
  start: Dashboard[] = [TEAM_DASHBOARD],
  data: Record<string, unknown> = WIDGET_DATA,
): FakeDashboardClient {
  let next = 100;
  const client: FakeDashboardClient = {
    dashboards: start.map((d) => ({ ...d, widgets: d.widgets.map((w) => ({ ...w })) })),
    patches: [],
    defaultId: start.find((d) => d.isDefault)?.id ?? null,
    list: async () => client.dashboards.map(summary),
    get: async (id) => {
      const found = client.dashboards.find((d) => d.id === id);
      if (!found) throw new Error('not_found');
      return copyOf(found);
    },
    create: async (name) => {
      const made: Dashboard = {
        id: ++next,
        name,
        description: '',
        layout: 'two',
        owner: { id: 2, name: 'Ada Lovelace' },
        isDefault: false,
        shares: [],
        editable: true,
        version: 1,
        widgets: [],
      };
      client.dashboards.push(made);
      return made;
    },
    update: async (id, patch): Promise<UpdateOutcome> => {
      client.patches.push({ id, patch });
      const found = client.dashboards.find((d) => d.id === id);
      if (!found) throw new Error('not_found');
      if (patch.version !== undefined && patch.version !== found.version) {
        return { ok: false, error: 'version_conflict' };
      }
      const widgets = (patch.widgets ?? found.widgets).map((w, i) => ({
        ...w,
        id: w.id ?? `w-new${i}`,
      }));
      Object.assign(found, {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.layout !== undefined ? { layout: patch.layout } : {}),
        ...(patch.shares !== undefined ? { shares: patch.shares } : {}),
        widgets,
        version: found.version + 1,
      });
      return { ok: true, dashboard: copyOf(found) };
    },
    copy: async (id) => {
      const source = await client.get(id);
      const made = {
        ...source,
        id: ++next,
        name: `${source.name} (copy)`,
        shares: [],
        isDefault: false,
        editable: true,
        version: 1,
      };
      client.dashboards.push(made);
      return made;
    },
    remove: async (id) => {
      client.dashboards = client.dashboards.filter((d) => d.id !== id);
    },
    setDefault: async (id) => {
      client.defaultId = id;
      for (const d of client.dashboards) d.isDefault = d.id === id;
    },
    widget: async (_dashboard, widgetId) => (widgetId in data ? data[widgetId] : null),
    checkQuery: async (query) => !query.includes('nope'),
    boards: async () => [
      { id: 7, name: 'Checkout board', kind: 'scrum' },
      { id: 8, name: 'Support flow', kind: 'kanban' },
    ],
  };
  return client;
}
