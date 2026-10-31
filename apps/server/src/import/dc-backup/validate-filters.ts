import {
  EDIT_RIGHTS,
  FILTER_PREFIX,
  PROJECT_PREFIX,
  SUBSCRIPTION_JOB,
  SUBSCRIPTION_RUNNER,
} from './filter-format';

/**
 * The validator's checks of saved filters, dashboards and subscriptions (M1-094): every share
 * and favourite names a filter or dashboard that has a row, a group or project share names one
 * (and its role), a filter's favourite count equals its favourite rows, a gadget setting that
 * names a filter or a project names one with a row, and every subscription has its schedule job
 * with a cron expression of six or seven fields. It counts the cases the manifest lists.
 */
interface Ids {
  has(id: number): boolean;
}

export interface FilterCheckContext {
  ids: (entity: string) => Ids | undefined;
  groupNames: ReadonlySet<string>;
}

type Problem = (message: string) => void;
type Row = Record<string, string>;

export class FilterChecks {
  private readonly shares: Row[] = [];
  private readonly favourites: Row[] = [];
  private readonly favCounts = new Map<string, number>();
  private readonly prefs: Row[] = [];
  private readonly subscriptions: Row[] = [];
  private readonly jobs = new Map<string, Row>();

  /** Called for every row; reads the ones of this part. */
  row(name: string, v: Row, note: (key: string, by?: number) => void): void {
    switch (name) {
      case 'SearchRequest':
        if (v.favCount !== undefined) this.favCounts.set(v.id ?? '', Number(v.favCount));
        return;
      case 'SharePermissions':
        this.shares.push(v);
        if (Number(v.rights) === EDIT_RIGHTS) note('sharesWithEdit');
        return;
      case 'FavouriteAssociations':
        this.favourites.push(v);
        note(v.entityType === 'PortalPage' ? 'favouriteDashboards' : 'favouriteFilters');
        return;
      case 'GadgetUserPreference':
        this.prefs.push(v);
        if ((v.userprefvalue ?? '').startsWith(FILTER_PREFIX)) note('gadgetsNamingFilters');
        return;
      case 'FilterSubscription':
        this.subscriptions.push(v);
        if (v.groupname) note('subscriptionsToGroups');
        return;
      case 'ClusteredJob':
        this.jobs.set(v.jobId ?? '', v);
        return;
    }
  }

  check(ctx: FilterCheckContext, problem: Problem): void {
    const entity = (type: string | undefined, id: string | undefined) =>
      ctx.ids(type === 'PortalPage' ? 'PortalPage' : 'SearchRequest')?.has(Number(id)) === true;
    for (const s of this.shares) {
      if (!entity(s.entityType, s.entityId)) {
        problem(`SharePermissions ${s.id}: ${s.entityType} ${s.entityId} has no row`);
      }
      if (s.sharetype === 'group' && !ctx.groupNames.has(s.param1 ?? '')) {
        problem(`SharePermissions ${s.id}: group ${(s.param1 ?? '').slice(0, 60)} has no row`);
      }
      if (s.sharetype === 'project') {
        if (!ctx.ids('Project')?.has(Number(s.param1))) {
          problem(`SharePermissions ${s.id}: project ${s.param1} has no row`);
        }
        if (s.param2 && !ctx.ids('ProjectRole')?.has(Number(s.param2))) {
          problem(`SharePermissions ${s.id}: role ${s.param2} has no row`);
        }
      }
    }
    const counted = new Map<string, number>();
    for (const f of this.favourites) {
      if (!entity(f.entityType, f.entityId)) {
        problem(`FavouriteAssociations ${f.id}: ${f.entityType} ${f.entityId} has no row`);
      }
      if (f.entityType === 'SearchRequest') {
        counted.set(f.entityId ?? '', (counted.get(f.entityId ?? '') ?? 0) + 1);
      }
    }
    for (const [id, count] of this.favCounts) {
      if ((counted.get(id) ?? 0) !== count) {
        problem(`SearchRequest ${id}: favCount ${count}, ${counted.get(id) ?? 0} favourite rows`);
      }
    }
    for (const p of this.prefs) {
      const value = p.userprefvalue ?? '';
      if (value.startsWith(FILTER_PREFIX)) {
        if (!ctx.ids('SearchRequest')?.has(Number(value.slice(FILTER_PREFIX.length)))) {
          problem(`GadgetUserPreference ${p.id}: ${value} has no SearchRequest row`);
        }
      } else if (value.startsWith(PROJECT_PREFIX)) {
        if (!ctx.ids('Project')?.has(Number(value.slice(PROJECT_PREFIX.length)))) {
          problem(`GadgetUserPreference ${p.id}: ${value} has no Project row`);
        }
      }
    }
    for (const s of this.subscriptions) {
      const job = this.jobs.get(`${SUBSCRIPTION_JOB}${s.id}`);
      if (!job) {
        problem(`FilterSubscription ${s.id}: no ClusteredJob ${SUBSCRIPTION_JOB}${s.id}`);
        continue;
      }
      if (job.jobRunnerKey !== SUBSCRIPTION_RUNNER) {
        problem(`ClusteredJob ${job.id}: not a subscription's runner`);
      }
      const fields = (job.cronExpression ?? '').trim().split(/\s+/).length;
      if (job.schedType === 'C' && (fields < 6 || fields > 7)) {
        problem(`ClusteredJob ${job.id}: the cron expression has ${fields} fields`);
      }
    }
  }
}
