import { ApiError, api } from '../api/client';
import { type CalendarClient, type CalendarTicket, calendarClient } from '../calendar/client';
import {
  type Timeline,
  type TimelineClient,
  type TimelineItem,
  timelineClient,
} from '../timeline/client';
import type { BlockersElsewhere } from '../timeline/dependencies';

/** A source of a plan as one viewer sees it (ADR-122); those hidden from them are only counted. */
export type PlanSource =
  | { kind: 'track'; id: number; key: string; name: string; state: 'visible' | 'archived' }
  | { kind: 'savedSearch'; id: number; name: string; state: 'visible' | 'broken' };

export type PlanSourceInput =
  | { kind: 'track'; trackId: number }
  | { kind: 'savedSearch'; savedSearchId: number };

/** Who besides its owner sees a plan: a dashboard's scopes except the public. */
export interface PlanShare {
  scope: 'user' | 'group' | 'track' | 'any_user';
  userId?: number;
  userName?: string;
  groupId?: number;
  groupName?: string;
  trackId?: number;
  trackKey?: string;
  roleId?: number | null;
  roleName?: string | null;
}

/** `GET /api/v1/plans/:id`. */
export interface Plan {
  id: number;
  name: string;
  description: string;
  owner: { id: number; name: string };
  shares: PlanShare[];
  editable: boolean;
  sources: PlanSource[];
  hiddenSources: number;
  /** The plan's query with the filters asked for: the List's search; null finds nothing. */
  query: string | null;
  version: number;
}

/** One row of `GET /api/v1/plans`. */
export interface PlanRow {
  id: number;
  name: string;
  description: string;
  owner: { id: number; name: string };
  shares: PlanShare[];
  editable: boolean;
  sourceCount: number;
}

/** The filters every view takes, one value each (PLN-012). */
export interface PlanFilters {
  track?: string;
  /** `me`, `none` or a person's id. */
  assignee?: string;
  type?: string;
  stage?: 'new' | 'active' | 'closed';
}

/** A number of the Summary with the search that finds exactly those tickets. */
export interface PlanCount {
  id: string;
  name: string | null;
  query: string;
  count: number;
}

export interface PlanSummary {
  query: string | null;
  total: PlanCount;
  overview: PlanCount[];
  stages: PlanCount[];
  tracks: PlanCount[];
  assignees: PlanCount[];
}

export interface PlanTrack {
  id: number;
  key: string;
  /** Null for a track seen only through tickets a ticket-level grant shows: its key alone. */
  name: string | null;
}

export interface PlanTimelineItem extends TimelineItem {
  trackId: number;
  assignee: { id: number; name: string } | null;
  priority: string | null;
}

export interface PlanTimeline extends Omit<Timeline, 'track' | 'items'> {
  query: string | null;
  items: PlanTimelineItem[];
  /**
   * The blockers of listed tickets that the timeline does not list, only counted (PLN-006):
   * outside the plan or hidden from the viewer, and the plan's own left out by filters or the
   * first 10,000.
   */
  blockersElsewhere: BlockersElsewhere[];
  tracks: PlanTrack[];
}

export interface PlanCalendar {
  query: string | null;
  tickets: (CalendarTicket & { trackId: number })[];
  tracks: PlanTrack[];
  sprints: { id: number; name: string; state: string; start: string; end: string }[];
  releases: { id: number; name: string; date: string; shipped: boolean }[];
  truncated: boolean;
}

export interface PlanChoices {
  tracks: (PlanTrack & { count: number })[];
  types: { name: string; count: number }[];
  assignees: { id: number; name: string; count: number }[];
  unassigned: number;
}

export interface PlanInput {
  name: string;
  description?: string;
  sources?: PlanSourceInput[];
  shares?: PlanShare[];
}

export type PlanSaved =
  | { ok: true; plan: Plan }
  | { ok: false; error: string; fields: Record<string, string> };

/** What a person may choose as a source: the tracks and saved searches they see. */
export interface SourceOptions {
  tracks: { id: number; key: string; name: string }[];
  savedSearches: { id: number; name: string }[];
}

export interface PlanClient {
  list(): Promise<PlanRow[]>;
  get(id: number, filters?: PlanFilters): Promise<Plan>;
  create(input: PlanInput): Promise<PlanSaved>;
  update(id: number, input: Partial<PlanInput> & { version: number }): Promise<PlanSaved>;
  remove(id: number): Promise<void>;
  choices(id: number): Promise<PlanChoices>;
  summary(id: number, filters: PlanFilters): Promise<PlanSummary>;
  timeline(id: number, filters: PlanFilters): Promise<PlanTimeline>;
  calendar(id: number, filters: PlanFilters, from: string, to: string): Promise<PlanCalendar>;
  /** Rescheduling is the ticket's own change, as on a track. */
  reschedule: TimelineClient['reschedule'];
  move: CalendarClient['move'];
  sourceOptions(): Promise<SourceOptions>;
}

/** The filters as query parameters, in a fixed order. */
export function filterParams(filters: PlanFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of ['track', 'assignee', 'type', 'stage'] as const) {
    const value = filters[key];
    if (value) params.set(key, value);
  }
  return params;
}

const withFilters = (path: string, filters: PlanFilters, extra: Record<string, string> = {}) => {
  const params = filterParams(filters);
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  const text = params.toString();
  return text ? `${path}?${text}` : path;
};

async function saved(call: () => Promise<{ plan: Plan }>): Promise<PlanSaved> {
  try {
    return { ok: true, plan: (await call()).plan };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const body = error.body as { fields?: Record<string, string> } | null;
    return { ok: false, error: error.code ?? String(error.status), fields: body?.fields ?? {} };
  }
}

export const planClient: PlanClient = {
  list: async () => (await api<{ plans: PlanRow[] }>('/plans')).plans,
  get: async (id, filters = {}) =>
    (await api<{ plan: Plan }>(withFilters(`/plans/${id}`, filters))).plan,
  create: (input) => saved(() => api<{ plan: Plan }>('/plans', { method: 'POST', body: input })),
  update: (id, input) =>
    saved(() => api<{ plan: Plan }>(`/plans/${id}`, { method: 'PATCH', body: input })),
  remove: async (id) => {
    await api(`/plans/${id}`, { method: 'DELETE' });
  },
  choices: (id) => api<PlanChoices>(`/plans/${id}/choices`),
  summary: (id, filters) => api<PlanSummary>(withFilters(`/plans/${id}/summary`, filters)),
  timeline: (id, filters) => api<PlanTimeline>(withFilters(`/plans/${id}/timeline`, filters)),
  calendar: (id, filters, from, to) =>
    api<PlanCalendar>(withFilters(`/plans/${id}/calendar`, filters, { from, to })),
  reschedule: timelineClient.reschedule,
  move: calendarClient.move,
  sourceOptions: async () => {
    const searches = api<{ savedSearches: { id: number; name: string }[] }>('/saved-searches');
    // Every track the person sees, a page of 500 at a time, up to a plan's 500 sources twice.
    const tracks: SourceOptions['tracks'] = [];
    let after: string | null = null;
    do {
      const page: { tracks: SourceOptions['tracks']; next: string | null } = await api(
        `/tracks?limit=500${after ? `&after=${encodeURIComponent(after)}` : ''}`,
      );
      tracks.push(...page.tracks.map((t) => ({ id: t.id, key: t.key, name: t.name })));
      after = page.next;
    } while (after && tracks.length < 1000);
    return {
      tracks,
      savedSearches: (await searches).savedSearches.map((s) => ({ id: s.id, name: s.name })),
    };
  },
};
