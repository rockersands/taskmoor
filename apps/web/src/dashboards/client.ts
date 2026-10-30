import { ApiError, api } from '../api/client';

/** Dashboards (M1-064; `/api/v1/dashboards`). */
export const LAYOUTS = ['one', 'two', 'two-wide-left', 'two-wide-right', 'three'] as const;
export type Layout = (typeof LAYOUTS)[number];
export const COLUMNS: Readonly<Record<Layout, number>> = {
  one: 1,
  two: 2,
  'two-wide-left': 2,
  'two-wide-right': 2,
  three: 3,
};

export const WIDGET_KINDS = [
  'introduction',
  'quick-links',
  'search-results',
  'assigned-to-me',
  'followed-tickets',
  'created-vs-closed',
  'recently-created',
  'average-age',
  'time-to-close',
  'pie',
  'ticket-statistics',
  'two-dimensional',
  'sprint-burndown',
  'sprint-health',
  'days-remaining',
  'average-time-in-status',
] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];

export interface Widget {
  id: string;
  kind: WidgetKind;
  column: number;
  title: string;
  config: Record<string, unknown>;
}

export interface DashboardShare {
  scope: 'user' | 'group' | 'track' | 'any_user' | 'public';
  userId?: number;
  groupId?: number;
  trackId?: number;
  roleId?: number | null;
}

export interface DashboardSummary {
  id: number;
  name: string;
  description: string;
  layout: Layout;
  owner: { id: number; name: string };
  isDefault: boolean;
  shares: DashboardShare[];
  editable: boolean;
  version: number;
}

export interface Dashboard extends DashboardSummary {
  widgets: Widget[];
}

/** A widget as saved: an id only for those that exist. */
export type WidgetInput = Omit<Widget, 'id'> & { id?: string };

export interface DashboardPatch {
  name?: string;
  description?: string;
  layout?: Layout;
  widgets?: WidgetInput[];
  shares?: DashboardShare[];
  version?: number;
}

export type UpdateOutcome =
  | { ok: true; dashboard: Dashboard }
  | { ok: false; error: 'version_conflict' | 'invalid'; fields?: Record<string, string> };

export interface DashboardClient {
  list(filter?: 'visible' | 'mine'): Promise<DashboardSummary[]>;
  get(id: number): Promise<Dashboard>;
  create(name: string): Promise<Dashboard>;
  update(id: number, patch: DashboardPatch): Promise<UpdateOutcome>;
  copy(id: number): Promise<Dashboard>;
  remove(id: number): Promise<void>;
  setDefault(id: number | null): Promise<void>;
  /** A widget's data as the viewer sees it; its shape depends on the kind. */
  widget(dashboardId: number, widgetId: string): Promise<unknown>;
  /** Boards for the sprint widgets' settings. */
  boards(): Promise<{ id: number; name: string; kind: 'scrum' | 'kanban' }[]>;
}

export const dashboardClient: DashboardClient = {
  list: async (filter = 'visible') =>
    (await api<{ dashboards: DashboardSummary[] }>(`/dashboards?filter=${filter}`)).dashboards,
  get: async (id) => (await api<{ dashboard: Dashboard }>(`/dashboards/${id}`)).dashboard,
  create: async (name) =>
    (await api<{ dashboard: Dashboard }>('/dashboards', { method: 'POST', body: { name } }))
      .dashboard,
  update: async (id, patch) => {
    try {
      const { dashboard } = await api<{ dashboard: Dashboard }>(`/dashboards/${id}`, {
        method: 'PATCH',
        body: patch,
      });
      return { ok: true, dashboard };
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      const body = error.body as { fields?: Record<string, string> } | null;
      if (error.code === 'version_conflict') return { ok: false, error: 'version_conflict' };
      if (error.code === 'invalid_fields') {
        return { ok: false, error: 'invalid', fields: body?.fields ?? {} };
      }
      throw error;
    }
  },
  copy: async (id) =>
    (
      await api<{ dashboard: Dashboard }>(`/dashboards/${id}/copy`, {
        method: 'POST',
        body: {},
      })
    ).dashboard,
  remove: async (id) => {
    await api(`/dashboards/${id}`, { method: 'DELETE' });
  },
  setDefault: async (id) => {
    await api('/dashboards/default', { method: 'PUT', body: { dashboardId: id } });
  },
  widget: async (dashboardId, widgetId) =>
    (
      await api<{ data: unknown }>(
        `/dashboards/${dashboardId}/widgets/${encodeURIComponent(widgetId)}`,
      )
    ).data,
  boards: async () =>
    (await api<{ boards: { id: number; name: string; kind: 'scrum' | 'kanban' }[] }>('/boards'))
      .boards,
};
