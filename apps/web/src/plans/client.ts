import { API_BASE, ApiError, api } from '../api/client';
import { type CalendarClient, type CalendarTicket, calendarClient } from '../calendar/client';
import type {
  CrossTrackEndRule,
  CrossTrackStateName,
  HiddenWork,
  Progress,
} from '../releases/crossTrackClient';
import {
  type Timeline,
  type TimelineClient,
  type TimelineItem,
  timelineClient,
} from '../timeline/client';
import type { BlockersElsewhere } from '../timeline/dependencies';
import type { ReleaseMarker } from '../timeline/markers';

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

/** What a plan counts work and capacity in (PLN-005). */
export type CapacityUnit = 'points' | 'hours';

/** A plan's periods: every 1 to 6 weeks from a first day, or each calendar month. */
export type PlanPeriod = { kind: 'weeks'; weeks: number; anchor: string } | { kind: 'month' };

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
  capacityUnit: CapacityUnit;
  period: PlanPeriod;
  /** The site teams it plans with, in order (PLN-005). */
  teams: { id: number; name: string }[];
  /**
   * The link types it counts as dependencies beside blocking links, and whether it marks those
   * within one sprint (PLN-013).
   */
  dependencies?: { linkTypes: LinkTypeOption[]; sameSprint: boolean };
}

/** A link type as a plan's dependency options name it (PLN-013): `A outward B`, B waits for A. */
export interface LinkTypeOption {
  id: number;
  name: string;
  outward: string;
  inward: string;
}

/** Tickets of the plan as the viewer sees them: how many, their estimates summed, and unestimated. */
export interface CapacityWork {
  count: number;
  amount: number;
  unestimated: number;
}

/** A row's work in one period against its capacity (PLN-005, PLN-009). */
export interface CapacityCell extends CapacityWork {
  /** Their other work due then: outside the plan, filtered out or hidden; never named. */
  elsewhere: { count: number; amount: number };
  /** The work here and elsewhere. */
  load: number;
  over: boolean;
}

/** A capacity in one period: that period's own, every period's, or a team's members' summed. */
export interface PeriodCapacity {
  amount: number | null;
  note: string;
  from: 'period' | 'default' | 'members' | null;
}

export interface CapacityOf {
  /** The capacity set for every period. */
  default: { amount: number; note: string } | null;
  periods: PeriodCapacity[];
}

export interface CapacityPerson {
  id: number;
  name: string;
  active: boolean;
  /** Its condition, ANDed to the plan's query and a period's: the search behind a number. */
  clause: string;
  capacity: CapacityOf;
  cells: CapacityCell[];
  unscheduled: CapacityWork;
}

export interface CapacityTeam extends Omit<CapacityPerson, 'active'> {
  members: CapacityPerson[];
}

/** `GET /api/v1/plans/:id/capacity`. */
export interface PlanCapacity {
  query: string | null;
  editable: boolean;
  unit: CapacityUnit;
  /** The field points are read from; null when the workspace has none. */
  pointsField: { id: number; name: string } | null;
  period: PlanPeriod;
  periods: { start: string; end: string; clause: string }[];
  /** `from` for the periods before and after these. */
  previous: string;
  next: string;
  unscheduledClause: string;
  teams: CapacityTeam[];
  unassigned: { clause: string; cells: CapacityWork[]; unscheduled: CapacityWork };
  others: { clause: string; cells: CapacityWork[]; unscheduled: CapacityWork };
}

/** One capacity to set: a team's or a person's, every period (null) or one; null removes it. */
export interface CapacityEntry {
  teamId?: number;
  userId?: number;
  period: string | null;
  amount: number | null;
  note?: string;
}

/** The unit and periods capacities were typed for; the server refuses them for others. */
export interface CapacitySettings {
  unit: CapacityUnit;
  period: PlanPeriod;
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
  /** The link types of the dependencies drawn (PLN-013). */
  linkTypes?: LinkTypeOption[];
  /** Whether the plan marks dependencies within one sprint. */
  sameSprint?: boolean;
}

export interface PlanCalendar {
  query: string | null;
  tickets: (CalendarTicket & { trackId: number })[];
  tracks: PlanTrack[];
  sprints: { id: number; name: string; state: string; start: string; end: string }[];
  releases: ReleaseMarker[];
  truncated: boolean;
}

/** A row of a plan's Releases tab (PLN-007), a track's release or a linked one. */
export interface PlanRelease {
  id: number;
  name: string;
  /** A linked release says its track; a track's own are already under its name. */
  track?: { id: number; key: string; name: string };
  releaseDate: string | null;
  shipped: boolean;
  archived: boolean;
  overdue: boolean;
  outOfStep?: boolean;
  progress: Progress;
}

/** `GET /api/v1/plans/:id/releases`: those of a release across tracks first, then by track. */
export interface PlanReleases {
  crossTrack: {
    id: number;
    name: string;
    endRule: CrossTrackEndRule;
    date: string | null;
    state: CrossTrackStateName;
    progress: Progress;
    hidden: HiddenWork;
    releases: PlanRelease[];
  }[];
  tracks: { track: { id: number; key: string; name: string }; releases: PlanRelease[] }[];
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
  /** Team ids, in order. */
  teams?: number[];
  capacityUnit?: CapacityUnit;
  period?: PlanPeriod;
  /** Link types counted beside blocking links, and the same-sprint flag (PLN-013). */
  dependencies?: { linkTypeIds: number[]; sameSprint: boolean };
}

export type PlanSaved =
  | { ok: true; plan: Plan }
  | { ok: false; error: string; fields: Record<string, string> };

/** What a person may choose as a source: the tracks and saved searches they see. */
export interface SourceOptions {
  tracks: { id: number; key: string; name: string }[];
  savedSearches: { id: number; name: string }[];
}

/** What a copy answers (PLN-014): the copy, and how many sources stayed behind. */
export type PlanDuplicated =
  | { ok: true; plan: Plan; left: { hiddenSources: number } }
  | { ok: false; error: string; fields: Record<string, string> };

/** The List's file: its columns and its order (PLN-014). */
export interface PlanListFile {
  filters: PlanFilters;
  columns: readonly string[];
  sort: 'created' | 'updated' | 'due' | 'priority';
}

export interface PlanClient {
  list(): Promise<PlanRow[]>;
  get(id: number, filters?: PlanFilters): Promise<Plan>;
  create(input: PlanInput): Promise<PlanSaved>;
  update(id: number, input: Partial<PlanInput> & { version: number }): Promise<PlanSaved>;
  remove(id: number): Promise<void>;
  /** A private copy for the person, of what they may see of the plan (PLN-014). */
  duplicate(id: number, name: string): Promise<PlanDuplicated>;
  /** The address of the List's file: every ticket of the plan the person sees (PLN-014). */
  exportHref(id: number, file: PlanListFile): string;
  choices(id: number): Promise<PlanChoices>;
  /** The Releases tab; of the filters only the track applies. */
  releases(id: number, track?: string): Promise<PlanReleases>;
  summary(id: number, filters: PlanFilters): Promise<PlanSummary>;
  /** With `exporting`, read fresh for a file: the same answer, counted as a bulk export. */
  timeline(id: number, filters: PlanFilters, exporting?: boolean): Promise<PlanTimeline>;
  calendar(
    id: number,
    filters: PlanFilters,
    from: string,
    to: string,
    exporting?: boolean,
  ): Promise<PlanCalendar>;
  /** Work per team and person in `periods` periods from the one holding `from` (PLN-005). */
  capacity(id: number, filters: PlanFilters, from: string, periods: number): Promise<PlanCapacity>;
  /**
   * Sets capacities typed for `settings`; true when saved, else the refusal's code
   * (`settings_changed` when the plan's unit or periods are no longer those).
   */
  setCapacity(
    id: number,
    entries: CapacityEntry[],
    settings?: CapacitySettings,
  ): Promise<true | string>;
  /** Rescheduling is the ticket's own change, as on a track. */
  reschedule: TimelineClient['reschedule'];
  move: CalendarClient['move'];
  sourceOptions(): Promise<SourceOptions>;
  /** The site's teams, for a plan's settings. */
  teamOptions(): Promise<{ id: number; name: string; memberCount: number }[]>;
  /** The site's link types, for a plan's dependency options (PLN-013). */
  linkTypeOptions(): Promise<LinkTypeOption[]>;
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
  duplicate: async (id, name) => {
    try {
      const answer = await api<{ plan: Plan; left: { hiddenSources: number } }>(
        `/plans/${id}/duplicate`,
        { method: 'POST', body: { name } },
      );
      return { ok: true, plan: answer.plan, left: answer.left };
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      const body = error.body as { fields?: Record<string, string> } | null;
      return { ok: false, error: error.code ?? String(error.status), fields: body?.fields ?? {} };
    }
  },
  exportHref: (id, { filters, columns, sort }) => {
    const params = filterParams(filters);
    params.set('format', 'csv');
    params.set('columns', ['key', ...columns].join(','));
    params.set('sort', sort);
    return `${API_BASE}/plans/${id}/export?${params}`;
  },
  choices: (id) => api<PlanChoices>(`/plans/${id}/choices`),
  releases: (id, track) =>
    api<PlanReleases>(`/plans/${id}/releases${track ? `?track=${encodeURIComponent(track)}` : ''}`),
  summary: (id, filters) => api<PlanSummary>(withFilters(`/plans/${id}/summary`, filters)),
  timeline: (id, filters, exporting) =>
    api<PlanTimeline>(
      withFilters(`/plans/${id}/timeline`, filters, exporting ? { export: 'true' } : {}),
    ),
  calendar: (id, filters, from, to, exporting) =>
    api<PlanCalendar>(
      withFilters(`/plans/${id}/calendar`, filters, {
        from,
        to,
        ...(exporting ? { export: 'true' } : {}),
      }),
    ),
  capacity: (id, filters, from, periods) =>
    api<PlanCapacity>(
      withFilters(`/plans/${id}/capacity`, filters, { from, periods: String(periods) }),
    ),
  setCapacity: async (id, entries, settings) => {
    try {
      await api(`/plans/${id}/capacity`, { method: 'PUT', body: { entries, ...settings } });
      return true;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return error.code ?? String(error.status);
    }
  },
  teamOptions: async () =>
    (await api<{ teams: { id: number; name: string; memberCount: number }[] }>('/teams')).teams.map(
      (t) => ({ id: t.id, name: t.name, memberCount: t.memberCount }),
    ),
  linkTypeOptions: async () =>
    (await api<{ linkTypes: LinkTypeOption[] }>('/link-types')).linkTypes.map((l) => ({
      id: l.id,
      name: l.name,
      outward: l.outward,
      inward: l.inward,
    })),
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
