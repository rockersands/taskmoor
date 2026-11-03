import { ApiError, api } from '../api/client';
import type { Board } from '../boards/client';
import type { Layout, Widget, WidgetInput } from '../dashboards/client';

/** One number of a track's summary and the query that finds its tickets (M1-064). */
export interface SummaryItem {
  id: string;
  /** A stage, priority, type or person; null for none. */
  name: string | null;
  query: string;
  count: number;
  /** False when the count reached the search's cap. */
  exact: boolean;
}

export interface TrackSummary {
  track: { id: number; key: string; name: string };
  overview: SummaryItem[];
  stages: SummaryItem[];
  priorities: SummaryItem[];
  types: SummaryItem[];
  assignees: SummaryItem[];
}

/** A track's Summary as saved: nothing customized until someone customizes it (ADR-116). */
export interface TrackSummaryLayout {
  track: { id: number; key: string; name: string };
  /** The track's owner and administrators; the server holds them to it. */
  mayCustomize: boolean;
  custom: { layout: Layout; widgets: Widget[]; version: number } | null;
}

export type SaveSummaryOutcome =
  | { ok: true; read: TrackSummaryLayout }
  | { ok: false; error: 'version_conflict' | 'forbidden' | 'invalid' };

/** The reports of a track's tickets, read like the dashboard widgets of those names. */
export const STATISTIC_KINDS = [
  'created-vs-closed',
  'recently-created',
  'average-age',
  'time-to-close',
  'ticket-statistics',
  'two-dimensional',
  'pie',
  'time-since',
  'group-by',
  'workload',
  'time-tracking',
] as const;
export type StatisticKind = (typeof STATISTIC_KINDS)[number];
export type StatisticSettings = Record<string, string | number | boolean>;

/** What a track has that depends on its board being Scrum (ADR-116); the server decides. */
export interface TrackSections {
  backlog: boolean;
  sprints: boolean;
}

export interface TrackClient {
  /** Whether the track has a backlog and sprints, for its tabs and reports. */
  sections(key: string): Promise<TrackSections>;
  summary(key: string): Promise<TrackSummary>;
  /** The customized Summary, if any, and whether the person may change it. */
  summaryLayout(key: string): Promise<TrackSummaryLayout>;
  saveSummaryLayout(
    key: string,
    layout: { layout: Layout; widgets: WidgetInput[]; version?: number },
  ): Promise<SaveSummaryOutcome>;
  /** Goes back to the default Summary. */
  resetSummaryLayout(key: string): Promise<void>;
  /** A widget of the customized Summary as the viewer sees it; its shape depends on the kind. */
  summaryWidget(key: string, widgetId: string): Promise<unknown>;
  /** A report of the track's tickets; always the track, always as the viewer sees it. */
  statistics(key: string, kind: StatisticKind, settings: StatisticSettings): Promise<unknown>;
  /** The track's custom fields as things a report can group by. */
  groupFields(key: string): Promise<{ id: string; name: string }[]>;
  /** The tracks the person can see. */
  list(): Promise<TrackListItem[]>;
  /** The track's one board, made the first time anyone opens it (ADR-116). */
  board(key: string): Promise<Board>;
  /** The files and web links on the track's tickets the person may see. */
  files(key: string): Promise<TrackFiles>;
  /** A page of the track's outcomes with their progress; the next page after `cursor`. */
  outcomes(key: string, cursor?: string): Promise<TrackOutcomes>;
}

/** An outcome of a track and how far along the tickets under it are (AGL-024). */
export interface TrackOutcome {
  id: number;
  key: string;
  summary: string;
  type: string;
  status: { name: string; stage: 'new' | 'active' | 'closed' };
  /** Days as `2026-11-02`; null when not set. */
  startDate: string | null;
  dueDate: string | null;
  /** The tickets under it the person may see, and those of them closed. */
  progress: { total: number; closed: number };
}

export interface TrackOutcomes {
  track: { id: number; key: string; name: string };
  /** The track's ticket types at the outcome level, which make an outcome. */
  outcomeTypes: string[];
  /** Open ones first, then closed ones, each in rank order. */
  outcomes: TrackOutcome[];
  /** The cursor of the next page, or null on the last. */
  next: string | null;
}

export interface TrackFiles {
  attachments: {
    id: number;
    name: string;
    size: number;
    createdAt: string;
    ticket: { key: string; summary: string };
  }[];
  links: { id: number; url: string; title: string; ticket: { key: string; summary: string } }[];
  truncated: boolean;
}

/** A track in the directory and the sidebar. */
export interface TrackListItem {
  key: string;
  name: string;
  owner: { id: number; name: string } | null;
}

const trackPath = (key: string) => `/tracks/${encodeURIComponent(key)}`;

export const trackClient: TrackClient = {
  sections: async (key) =>
    (await api<{ track: { sections: TrackSections } }>(trackPath(key))).track.sections,
  summary: (key) => api<TrackSummary>(`/tracks/${encodeURIComponent(key)}/summary`),
  summaryLayout: (key) => api<TrackSummaryLayout>(`${trackPath(key)}/summary-layout`),
  saveSummaryLayout: async (key, layout) => {
    try {
      const read = await api<TrackSummaryLayout>(`${trackPath(key)}/summary-layout`, {
        method: 'PUT',
        body: layout,
      });
      return { ok: true, read };
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.code === 'version_conflict') return { ok: false, error: 'version_conflict' };
      if (error.code === 'forbidden') return { ok: false, error: 'forbidden' };
      if (error.code === 'invalid_fields') return { ok: false, error: 'invalid' };
      throw error;
    }
  },
  resetSummaryLayout: async (key) => {
    await api(`${trackPath(key)}/summary-layout`, { method: 'DELETE' });
  },
  summaryWidget: async (key, widgetId) =>
    (
      await api<{ data: unknown }>(
        `${trackPath(key)}/summary-layout/widgets/${encodeURIComponent(widgetId)}`,
      )
    ).data,
  statistics: async (key, kind, settings) => {
    const query = new URLSearchParams(
      Object.entries(settings).map(([name, value]) => [name, String(value)]),
    ).toString();
    return (
      await api<{ data: unknown }>(
        `${trackPath(key)}/statistics/${kind}${query ? `?${query}` : ''}`,
      )
    ).data;
  },
  groupFields: async (key) =>
    (await api<{ fields: { id: number; name: string }[] }>(`${trackPath(key)}/fields`)).fields.map(
      (f) => ({ id: `cf[${f.id}]`, name: f.name }),
    ),
  list: async () =>
    (await api<{ tracks: TrackListItem[] }>('/tracks?limit=200')).tracks.filter((t) => t.key),
  files: (key) => api<TrackFiles>(`/tracks/${encodeURIComponent(key)}/files`),
  outcomes: (key, cursor) =>
    api<TrackOutcomes>(
      `${trackPath(key)}/outcomes${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),
  board: async (key) =>
    (await api<{ board: Board }>(`/tracks/${encodeURIComponent(key)}/board`)).board,
};
