import type { CustomType } from '@taskmoor/query';
import {
  type Analysis,
  analyseQuery,
  type SourceCatalogue,
  type SourceField,
} from '../translate/jql';
import {
  EDIT_RIGHTS,
  FILTER_ELEMENTS,
  FILTER_PREFIX,
  PROJECT_PREFIX,
  SUBSCRIPTION_JOB,
} from './filter-format';
import type { StagedField } from './stage-fields';

/**
 * The saved filters, dashboards and subscriptions part of the stage (M1-094; IMP-004; ADR-096).
 * Filters, their shares and favourites, dashboards with their gadgets and settings, and
 * subscriptions with their schedules are small: kept, and resolved after the file. Each filter's
 * query is analysed here (`translate/jql.ts`, step 1), because only the stage knows the source's
 * custom fields, people, projects and filters by their ids and names; the record carries the
 * query with references the import resolves, or the reasons it cannot translate.
 */
export { FILTER_ELEMENTS };

/** Who else may see a filter or dashboard, resolved against the backup. */
export interface StagedShare {
  type: string;
  /** A group (staged id) or a project (id), when the type names one that has a row. */
  group: string | null;
  project: string | null;
  role: string | null;
  /** The share may also change it (Verify). */
  edit: boolean;
  /** What it names, as written, when that has no row. */
  missing: string | null;
}

export interface StagedFilter {
  id: string;
  name: string;
  description: string;
  /** The owner (staged person id), null when the row names nobody. */
  owner: string | null;
  query: { text: string } & Analysis;
  shares: StagedShare[];
  /** People who made it a favourite (staged ids). */
  favourites: string[];
}

export interface StagedGadget {
  id: string;
  column: number;
  position: number;
  uri: string;
  prefs: Record<string, string>;
}

export interface StagedDashboard {
  id: string;
  name: string;
  description: string;
  owner: string | null;
  layout: string;
  gadgets: StagedGadget[];
  shares: StagedShare[];
  favourites: string[];
  /** Filters and projects the gadgets name that have no row. */
  missing: string[];
}

export interface StagedSubscription {
  id: string;
  filter: string;
  /** Whether the filter has a row. */
  filterKnown: boolean;
  owner: string | null;
  /** The group it goes to (staged id), null for the owner alone. */
  group: string | null;
  /** The group named, when it has no row. */
  unknownGroup: string | null;
  /** The schedule's cron expression as the source writes it; null without one. */
  cron: string | null;
  /** An interval in milliseconds, for a schedule that repeats instead. */
  intervalMs: number | null;
  emailOnEmpty: boolean;
  lastRun: string | null;
}

export interface FilterResolveContext {
  fields: ReadonlyMap<string, StagedField>;
  /** A custom field's type as the query language will read its imported field; null when not imported. */
  fieldType: (typeKey: string) => CustomType | null;
  /** A person named by key or user name: their staged id, undefined when the backup has nobody. */
  person: (raw: string) => string | undefined;
  group: (raw: string) => string | null;
  projects: readonly { id: string; key: string; originalKey: string | null; name: string }[];
  role: (id: string) => boolean;
}

const int = (v: string | undefined): number | null =>
  v !== undefined && /^-?\d+$/.test(v) ? Number(v) : null;
const byId = <T extends { id: string }>(rows: Iterable<T>) =>
  [...rows].sort(
    (a, b) => Number(a.id) - Number(b.id) || String(a.id ?? '').localeCompare(String(b.id ?? '')),
  );

type Row = Record<string, string>;
const withId = (rows: readonly Row[]) =>
  rows.map((r) => ({ ...r, id: r.id ?? '' }) as Row & { id: string });

export class FilterCollector {
  readonly filters = new Map<string, Row>();
  private readonly shares: Row[] = [];
  private readonly favourites: Row[] = [];
  private readonly pages = new Map<string, Row>();
  private readonly portlets: Row[] = [];
  private readonly prefs: Row[] = [];
  private readonly subscriptions: Row[] = [];
  private readonly jobs: Row[] = [];

  /** `SearchRequest` and this part's elements. */
  row(name: string, v: Row): void {
    switch (name) {
      case 'SearchRequest':
        this.filters.set(v.id ?? '', v);
        return;
      case 'SharePermissions':
        this.shares.push(v);
        return;
      case 'FavouriteAssociations':
        this.favourites.push(v);
        return;
      case 'PortalPage':
        this.pages.set(v.id ?? '', v);
        return;
      case 'PortletConfiguration':
        this.portlets.push(v);
        return;
      case 'GadgetUserPreference':
        this.prefs.push(v);
        return;
      case 'FilterSubscription':
        this.subscriptions.push(v);
        return;
      case 'ClusteredJob':
        this.jobs.push(v);
        return;
    }
  }

  /** Jobs that are not subscriptions' schedules: left out. */
  otherJobs(): number {
    return this.jobs.filter((j) => !(j.jobId ?? '').startsWith(SUBSCRIPTION_JOB)).length;
  }

  resolve(ctx: FilterResolveContext): {
    saved_search: { id: string; label: string; data: StagedFilter }[];
    dashboard: { id: string; label: string; data: StagedDashboard }[];
    subscription: { id: string; label: string; data: StagedSubscription }[];
  } {
    const projectById = new Map(ctx.projects.map((p) => [p.id, p]));
    const share = (s: Row): StagedShare => {
      const type = s.sharetype ?? '';
      const edit = int(s.rights) === EDIT_RIGHTS;
      const out: StagedShare = {
        type,
        group: null,
        project: null,
        role: null,
        edit,
        missing: null,
      };
      if (type === 'group') {
        out.group = ctx.group(s.param1 ?? '');
        if (out.group === null) out.missing = s.param1 ?? '';
      } else if (type === 'project') {
        out.project = projectById.has(s.param1 ?? '') ? (s.param1 as string) : null;
        if (out.project === null) out.missing = s.param1 ?? '';
        if (s.param2) {
          out.role = ctx.role(s.param2) ? s.param2 : null;
          if (out.role === null) out.missing = `role ${s.param2}`;
        }
      }
      return out;
    };
    const sharesOf = (entity: string) => {
      const out = new Map<string, StagedShare[]>();
      for (const s of byId(withId(this.shares))) {
        if (s.entityType !== entity) continue;
        const list = out.get(s.entityId ?? '') ?? [];
        out.set(s.entityId ?? '', list);
        list.push(share(s));
      }
      return out;
    };
    const favouritesOf = (entity: string) => {
      const out = new Map<string, string[]>();
      const rows = [...this.favourites].sort(
        (a, b) => (int(a.sequence) ?? 0) - (int(b.sequence) ?? 0) || Number(a.id) - Number(b.id),
      );
      for (const f of rows) {
        if (f.entityType !== entity) continue;
        const person = ctx.person(f.username ?? '');
        if (person === undefined) continue;
        const list = out.get(f.entityId ?? '') ?? [];
        out.set(f.entityId ?? '', list);
        if (!list.includes(person)) list.push(person);
      }
      return out;
    };

    // The source as step 1 of the translation reads it.
    const fields: SourceField[] = [...ctx.fields.values()].map((f) => ({
      id: f.id,
      name: f.name,
      type: ctx.fieldType(f.typeKey),
    }));
    const projectsByWord = new Map<string, { id: string; key: string }>();
    for (const p of byId(ctx.projects)) {
      for (const word of [p.id, p.key, p.originalKey, p.name]) {
        if (word && !projectsByWord.has(word.toLowerCase())) {
          projectsByWord.set(word.toLowerCase(), { id: p.id, key: p.key });
        }
      }
    }
    const filtersByName = new Map<string, string[]>();
    for (const f of byId(this.filters.values() as Iterable<Row & { id: string }>)) {
      const key = (f.name ?? '').toLowerCase();
      filtersByName.set(key, [...(filtersByName.get(key) ?? []), f.id]);
    }
    const source: SourceCatalogue = {
      field: (id) => fields.find((f) => f.id === id),
      fieldsNamed: (name) => fields.filter((f) => f.name.toLowerCase() === name.toLowerCase()),
      person: ctx.person,
      project: (raw) => projectsByWord.get(raw.toLowerCase()),
      savedSearches: (raw) =>
        this.filters.has(raw) ? [raw] : (filtersByName.get(raw.toLowerCase()) ?? []),
    };

    const filterShares = sharesOf('SearchRequest');
    const filterFavourites = favouritesOf('SearchRequest');
    const filters = byId(this.filters.values() as Iterable<Row & { id: string }>).map((f) => {
      const text = f.request ?? '';
      const data: StagedFilter = {
        id: f.id,
        name: f.name ?? '',
        description: f.description ?? '',
        owner: f.author ? (ctx.person(f.author) ?? null) : null,
        query: { text, ...analyseQuery(text, source) },
        shares: filterShares.get(f.id) ?? [],
        favourites: filterFavourites.get(f.id) ?? [],
      };
      return { id: f.id, label: data.name, data };
    });

    const prefsOf = new Map<string, Record<string, string>>();
    for (const p of byId(withId(this.prefs))) {
      const owner = p.portletconfiguration ?? '';
      const prefs = prefsOf.get(owner) ?? {};
      prefsOf.set(owner, prefs);
      prefs[p.userprefkey ?? ''] = p.userprefvalue ?? '';
    }
    const dashboardShares = sharesOf('PortalPage');
    const dashboardFavourites = favouritesOf('PortalPage');
    const dashboards = byId(this.pages.values() as Iterable<Row & { id: string }>).map((d) => {
      const missing = new Set<string>();
      const gadgets = this.portlets
        .filter((g) => g.portalpage === d.id)
        .map((g) => {
          const prefs = prefsOf.get(g.id ?? '') ?? {};
          for (const value of Object.values(prefs)) {
            if (
              value.startsWith(FILTER_PREFIX) &&
              !this.filters.has(value.slice(FILTER_PREFIX.length))
            )
              missing.add(value);
            if (
              value.startsWith(PROJECT_PREFIX) &&
              !projectById.has(value.slice(PROJECT_PREFIX.length))
            )
              missing.add(value);
          }
          return {
            id: g.id ?? '',
            column: int(g.columnNumber) ?? 0,
            position: int(g.positionSeq) ?? 0,
            uri: g.gadgetXml ?? '',
            prefs,
          };
        })
        .sort(
          (a, b) => a.column - b.column || a.position - b.position || Number(a.id) - Number(b.id),
        );
      const data: StagedDashboard = {
        id: d.id,
        name: d.pagename ?? '',
        description: d.description ?? '',
        owner: d.username ? (ctx.person(d.username) ?? null) : null,
        layout: d.layout ?? 'AA',
        gadgets,
        shares: dashboardShares.get(d.id) ?? [],
        favourites: dashboardFavourites.get(d.id) ?? [],
        missing: [...missing].sort(),
      };
      return { id: d.id, label: data.name, data };
    });

    const jobs = new Map<string, Row>();
    for (const j of this.jobs) {
      const jobId = j.jobId ?? '';
      if (jobId.startsWith(SUBSCRIPTION_JOB)) jobs.set(jobId.slice(SUBSCRIPTION_JOB.length), j);
    }
    const names = new Map(filters.map((f) => [f.id, f.data.name]));
    const subscriptions = byId(withId(this.subscriptions)).map((s) => {
      const job = jobs.get(s.id);
      const group = s.groupname ? ctx.group(s.groupname) : null;
      const data: StagedSubscription = {
        id: s.id,
        filter: s.filterID ?? '',
        filterKnown: this.filters.has(s.filterID ?? ''),
        owner: s.username ? (ctx.person(s.username) ?? null) : null,
        group,
        unknownGroup: s.groupname && group === null ? s.groupname : null,
        cron: job?.schedType === 'C' ? (job.cronExpression ?? null) : null,
        intervalMs: job?.schedType === 'I' ? int(job.intervalMillis) : null,
        emailOnEmpty: s.emailOnEmpty === 'true' || s.emailOnEmpty === '1',
        lastRun: s.lastRun ?? null,
      };
      const of = names.get(data.filter) ?? data.filter;
      return { id: s.id, label: `${of}${s.groupname ? ` to ${s.groupname}` : ''}`, data };
    });

    return {
      saved_search: inDependencyOrder(filters),
      dashboard: dashboards,
      subscription: subscriptions,
    };
  }
}

/**
 * Filters that name other filters come after them, so the import has a target for each
 * reference when it gets there; a cycle keeps the backup's order (the target refuses it).
 */
function inDependencyOrder<T extends { id: string; data: StagedFilter }>(filters: T[]): T[] {
  const byIdMap = new Map(filters.map((f) => [f.id, f]));
  const out: T[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (f: T) => {
    if (state.get(f.id)) return;
    state.set(f.id, 'visiting');
    for (const ref of f.data.query.refs) {
      if (ref.kind !== 'saved_search') continue;
      const next = byIdMap.get(ref.id);
      if (next && !state.get(next.id)) visit(next);
    }
    state.set(f.id, 'done');
    out.push(f);
  };
  for (const f of filters) visit(f);
  return out;
}
