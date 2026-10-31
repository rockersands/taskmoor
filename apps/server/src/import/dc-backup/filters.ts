import { CORPUS, type CorpusEntry, type Vocabulary } from '../translate/corpus';
import { fieldWorldOf } from './fields';
import {
  EDIT_RIGHTS,
  FILTER_PREFIX,
  GADGETS,
  type GadgetKind,
  PROJECT_PREFIX,
  SUBSCRIPTION_JOB,
  SUBSCRIPTION_RUNNER,
} from './filter-format';
import { customFieldKey, type EntityName, timestamp } from './format';
import { Random } from './random';
import { schemeWorldOf } from './schemes';
import type { RowWriter } from './workflows';
import { FIRST_ID, type Person, type World, walkIssues } from './world';

/**
 * The synthetic instance's saved filters, dashboards and filter subscriptions (M1-094; IMP-004;
 * ADR-096), from general knowledge of the format, each rule marked **Verify** in the format
 * notes (02d) until a design partner's backup confirms it. Saved filters are `SearchRequest`
 * rows (the boards' own filters are written by `generate.ts`); who else may see a filter or a
 * dashboard is a `SharePermissions` row each; a person's favourites are
 * `FavouriteAssociations` rows; a dashboard is a `PortalPage` with `PortletConfiguration` rows
 * (its gadgets) and their `GadgetUserPreference` rows (each gadget's settings); a subscription
 * is a `FilterSubscription` row whose schedule is a `ClusteredJob` row.
 *
 * Each filter's query comes from the translation corpus (`translate/corpus.ts`) with this
 * instance's ids and names, so an import of the backup meets every query the corpus has. This
 * is the format layer, in the format's own vocabulary; names and texts are invented.
 */

export interface ShareDef {
  type: 'global' | 'loggedin' | 'group' | 'project';
  /** A group's name, or a project's id. */
  param1: string | null;
  /** With a project: a role's id. */
  param2: string | null;
  rights: number | null;
}

export interface FilterDef {
  id: number;
  name: string;
  description: string | null;
  owner: Person;
  query: string;
  /** The corpus entry the query comes from. */
  entry: CorpusEntry;
  shares: ShareDef[];
  /** People who made it a favourite (the owner first when they did). */
  favourites: Person[];
}

export interface GadgetDef {
  id: number;
  column: number;
  position: number;
  kind: GadgetKind;
  prefs: [string, string][];
}

export interface DashboardDef {
  id: number;
  name: string;
  description: string | null;
  owner: Person;
  layout: 'A' | 'AA' | 'AAA' | 'AB' | 'BA';
  gadgets: GadgetDef[];
  shares: ShareDef[];
  favourites: Person[];
}

export interface SubscriptionDef {
  id: number;
  filter: FilterDef;
  /** Who made it: the recipient when there is no group. */
  owner: Person;
  group: string | null;
  cron: string;
  emailOnEmpty: boolean;
  lastRun: number | null;
}

export interface FilterWorld {
  filters: FilterDef[];
  dashboards: DashboardDef[];
  subscriptions: SubscriptionDef[];
}

/** Schedules as the source writes them (seconds first; Verify), with what each tests. */
export const SCHEDULES = [
  '0 0 8 * * ?',
  '0 30 9 ? * MON-FRI',
  '0 0 7 ? * MON',
  '0 0 6 1 * ?',
  '0 0/15 * * * ?',
  '0 15 17 ? * FRI',
  // The last day of the month and the first Monday: no five-field counterpart.
  '0 0 18 L * ?',
  '0 0 12 ? * 2#1',
] as const;

/** Filters' ids start well above the boards' filters (one per board, from `FIRST_ID`). */
export const FIRST_FILTER = FIRST_ID + 1000;
const FIRST_DASHBOARD = FIRST_ID;
const FIRST_SUBSCRIPTION = FIRST_ID;

const built = new WeakMap<World, FilterWorld>();

export function filterWorldOf(world: World): FilterWorld {
  let out = built.get(world);
  if (!out) {
    out = buildFilterWorld(world);
    built.set(world, out);
  }
  return out;
}

/** The corpus's vocabulary for the k-th filter: this instance's objects, varied by k. */
function vocabularyFor(world: World, k: number, earlier: FilterDef | undefined): Vocabulary {
  const at = <T>(list: readonly T[], i: number) => list[i % list.length] as T;
  const fw = fieldWorldOf(world);
  const field = (kind: string) => {
    const f = fw.fields.find((x) => x.kind === kind);
    if (!f) throw new Error(`no ${kind} field`);
    return f;
  };
  const option = (kind: string, value?: string) => {
    const f = field(kind);
    const options = f.contexts.flatMap((c) => c.options);
    const o = (value ? options.find((x) => x.value === value) : undefined) ?? options[0];
    if (!o) throw new Error(`no option of ${kind}`);
    return { f, o };
  };
  const select = option('select', 'Major');
  const multi = option('multiselect');
  const cascadeField = field('cascadingselect');
  const cascadeOptions = cascadeField.contexts.flatMap((c) => c.options);
  const parent = cascadeOptions.find((o) => o.parent === null) as (typeof cascadeOptions)[number];
  const child = cascadeOptions.find((o) => o.parent === parent.id) as typeof parent;
  const project = at(world.projects, k);
  const other = at(world.projects, k + 1);
  const open = world.statuses.filter((s) => s.category !== 'done');
  const done = world.statuses.filter((s) => s.category === 'done');
  const active = world.users.filter((p) => p.active);
  const person = at(active, k);
  const otherPerson = at(active, k + 1);
  const level = schemeWorldOf(world).securitySchemes[0]?.levels[0];
  const sprint = world.sprints.length > 0 ? at(world.sprints, k) : { id: 1, name: 'Sprint 1' };
  const issue = firstIssue(world);
  return {
    project: { id: project.id, key: project.key, name: project.name },
    other: { id: other.id, key: other.key },
    status: at(open, k),
    doneStatus: at(done, k),
    priority: at(world.priorities, k),
    resolution: at(world.resolutions, k),
    type: at(
      world.issueTypes.filter((t) => !t.subtask),
      k,
    ),
    person: { username: person.username, key: person.key },
    otherPerson: { username: otherPerson.username, key: otherPerson.key },
    group: at(world.groups, k).name,
    role: at(world.roles, k).name,
    number: field('float'),
    text: field('textfield'),
    date: field('datepicker'),
    select: { id: select.f.id, name: select.f.name, option: select.o },
    multi: { id: multi.f.id, name: multi.f.name, option: multi.o },
    cascade: {
      id: cascadeField.id,
      name: cascadeField.name,
      parent: { id: parent.id, value: parent.value },
      child: { id: child.id, value: child.value },
    },
    userField: field('userpicker'),
    labelsField: field('labels'),
    appField: field('plugin'),
    filter: earlier
      ? { id: earlier.id, name: earlier.name }
      : { id: FIRST_FILTER, name: 'No filter yet' },
    sprint: { id: sprint.id, name: sprint.name },
    level: level ? { id: level.id, name: level.name } : { id: 1, name: 'None' },
    issue,
  };
}

const firstIssues = new WeakMap<World, { id: number; key: string }>();
function firstIssue(world: World): { id: number; key: string } {
  let found = firstIssues.get(world);
  if (!found) {
    const first = walkIssues(world).next().value;
    found = first ? { id: first.id, key: first.key } : { id: FIRST_ID, key: 'NONE-1' };
    firstIssues.set(world, found);
  }
  return found;
}

/** A share of a filter or dashboard, picked from its stream. */
function sharesOf(world: World, r: Random): ShareDef[] {
  const roll = r.next();
  const project = () => world.projects[r.int(0, world.projects.length - 1)];
  if (roll < 0.35) return [];
  if (roll < 0.5) return [{ type: 'global', param1: null, param2: null, rights: null }];
  if (roll < 0.65) return [{ type: 'loggedin', param1: null, param2: null, rights: null }];
  if (roll < 0.8) {
    const g = world.groups[r.int(0, world.groups.length - 1)];
    return [
      {
        type: 'group',
        param1: g?.name ?? null,
        param2: null,
        rights: r.chance(0.3) ? EDIT_RIGHTS : 1,
      },
    ];
  }
  const p = project();
  const role = r.chance(0.5) ? world.roles[r.int(0, world.roles.length - 1)] : undefined;
  const shares: ShareDef[] = [
    { type: 'project', param1: String(p?.id), param2: role ? String(role.id) : null, rights: 1 },
  ];
  if (r.chance(0.3)) {
    const g = world.groups[r.int(0, world.groups.length - 1)];
    shares.push({ type: 'group', param1: g?.name ?? null, param2: null, rights: 1 });
  }
  return shares;
}

function buildFilterWorld(world: World): FilterWorld {
  const seed = world.options.seed;
  const active = world.users.filter((p) => p.active);
  const filters: FilterDef[] = [];
  const count = CORPUS.length + Math.min(300, Math.floor(world.users.length / 10));
  for (let k = 0; k < count; k++) {
    const r = Random.derive(seed, 'filter', k);
    const entry = CORPUS[k % CORPUS.length] as CorpusEntry;
    const pass = Math.floor(k / CORPUS.length);
    // Filters naming another filter name the first one, which everyone may see.
    const earlier = filters[0];
    const v = vocabularyFor(world, k, earlier);
    const owner = active[r.int(0, active.length - 1)] as Person;
    const shares =
      k === 0
        ? [{ type: 'global' as const, param1: null, param2: null, rights: null }]
        : sharesOf(world, r);
    const favourites: Person[] = [];
    if (r.chance(0.4)) favourites.push(owner);
    if (shares.length > 0) {
      for (let f = r.int(0, 2); f > 0; f--) {
        const p = active[r.int(0, active.length - 1)] as Person;
        if (!favourites.includes(p)) favourites.push(p);
      }
    }
    filters.push({
      id: FIRST_FILTER + k,
      name: pass === 0 ? entry.title : `${entry.title} (${pass + 1})`,
      description: r.chance(0.5) ? `Kept for ${entry.title.toLowerCase()}` : null,
      owner,
      query: entry.query(v),
      entry,
      shares,
      favourites,
    });
  }

  const dashboards: DashboardDef[] = [];
  const layouts = ['A', 'AA', 'AAA', 'AB', 'BA'] as const;
  const kinds = Object.keys(GADGETS) as GadgetKind[];
  const dashboardCount = Math.max(kinds.length, Math.min(200, Math.floor(world.users.length / 5)));
  let gadgetId = FIRST_ID;
  for (let k = 0; k < dashboardCount; k++) {
    const r = Random.derive(seed, 'dashboard', k);
    const owner = active[r.int(0, active.length - 1)] as Person;
    const layout = layouts[k % layouts.length] as DashboardDef['layout'];
    const columns = layout.length;
    const gadgets: GadgetDef[] = [];
    const n = r.int(2, 5);
    for (let g = 0; g < n; g++) {
      // Every kind appears: the k-th dashboard starts with the k-th kind.
      const kind = (g === 0 ? kinds[k % kinds.length] : r.pick(kinds)) as GadgetKind;
      const filter = filters[r.int(0, filters.length - 1)] as FilterDef;
      const project = world.projects[r.int(0, world.projects.length - 1)];
      const source = r.chance(0.7)
        ? `${FILTER_PREFIX}${filter.id}`
        : `${PROJECT_PREFIX}${project?.id}`;
      const board =
        world.boards.length > 0 ? world.boards[r.int(0, world.boards.length - 1)] : null;
      gadgets.push({
        id: gadgetId++,
        column: g % columns,
        position: Math.floor(g / columns),
        kind,
        prefs: gadgetPrefs(kind, {
          filter: `${FILTER_PREFIX}${filter.id}`,
          source,
          board: board?.id ?? 1,
          custom: customFieldKey(
            fieldWorldOf(world).fields.find((f) => f.kind === 'select')?.id ?? 0,
          ),
          r,
        }),
      });
    }
    dashboards.push({
      id: FIRST_DASHBOARD + k,
      name: k === 0 ? 'Team overview' : `Dashboard ${k + 1} of ${owner.firstName}`,
      description: r.chance(0.5) ? 'What the team looks at every morning' : null,
      owner,
      layout,
      gadgets,
      shares:
        k === 0
          ? [{ type: 'loggedin', param1: null, param2: null, rights: null }]
          : sharesOf(world, r),
      favourites: r.chance(0.5) ? [owner] : [],
    });
  }

  const subscriptions: SubscriptionDef[] = [];
  for (const [k, filter] of filters.entries()) {
    const r = Random.derive(seed, 'subscription', k);
    if (k % 7 !== 3 && !r.chance(0.08)) continue;
    const toGroup = r.chance(0.3);
    subscriptions.push({
      id: FIRST_SUBSCRIPTION + subscriptions.length,
      filter,
      owner: filter.owner,
      group: toGroup ? (world.groups[r.int(0, world.groups.length - 1)]?.name ?? null) : null,
      cron: SCHEDULES[subscriptions.length % SCHEDULES.length] as string,
      emailOnEmpty: r.chance(0.5),
      lastRun: r.chance(0.6) ? world.end - r.int(1, 30) * 86_400_000 : null,
    });
  }
  return { filters, dashboards, subscriptions };
}

function gadgetPrefs(
  kind: GadgetKind,
  at: { filter: string; source: string; board: number; custom: string; r: Random },
): [string, string][] {
  const period = at.r.pick(['daily', 'weekly', 'monthly']);
  switch (kind) {
    case 'filterResults':
      return [
        ['filterId', at.filter],
        ['num', String(at.r.int(5, 60))],
        ['columnNames', 'issuetype|issuekey|summary|assignee|status'],
      ];
    case 'assignedToMe':
    case 'watched':
      return [['num', String(at.r.int(5, 20))]];
    case 'pie':
      return [
        ['projectOrFilterId', at.source],
        ['statType', at.r.pick(['assignees', 'statuses', 'priorities', 'issuetype', at.custom])],
      ];
    case 'createdVsResolved':
      return [
        ['projectOrFilterId', at.source],
        ['daysprevious', String(at.r.int(7, 90))],
        ['periodName', period],
        ['isCumulative', at.r.chance(0.5) ? 'true' : 'false'],
      ];
    case 'recentlyCreated':
    case 'averageAge':
    case 'resolutionTime':
      return [
        ['projectOrFilterId', at.source],
        ['daysprevious', String(at.r.int(7, 90))],
        ['periodName', period],
      ];
    case 'statistics':
      return [
        ['filterId', at.filter],
        ['statType', at.r.pick(['assignees', 'reporter', 'resolution', 'labels'])],
        ['sortBy', at.r.pick(['natural', 'total'])],
      ];
    case 'twoDimensional':
      return [
        ['filterId', at.filter],
        ['xstattype', 'statuses'],
        ['ystattype', 'assignees'],
      ];
    case 'text':
      return [['html', '<p>Welcome to the <b>team</b> page.</p><p>Ask in the channel.</p>']];
    case 'sprintBurndown':
    case 'daysRemaining':
      return [['rapidViewId', String(at.board)]];
    case 'activity':
      return [['numofentries', '10']];
    case 'calendar':
      return [['displayMonths', '1']];
  }
}

/** The rows of this part's elements, and the saved filters of `SearchRequest`. */
export async function writeFilterEntity(
  world: World,
  w: RowWriter,
  name: EntityName | 'SearchRequest',
): Promise<void> {
  const fw = filterWorldOf(world);
  switch (name) {
    case 'SearchRequest':
      for (const f of fw.filters) {
        await w.row('SearchRequest', {
          id: f.id,
          name: f.name,
          description: f.description,
          author: f.owner.key,
          request: { text: f.query },
          favCount: f.favourites.length,
        });
      }
      return;
    case 'SharePermissions': {
      let rowId = FIRST_ID;
      const things: [string, number, ShareDef[]][] = [
        ...fw.filters.map((f) => ['SearchRequest', f.id, f.shares] as [string, number, ShareDef[]]),
        ...fw.dashboards.map((d) => ['PortalPage', d.id, d.shares] as [string, number, ShareDef[]]),
      ];
      for (const [entityType, entityId, shares] of things) {
        for (const s of shares) {
          if (s.rights === EDIT_RIGHTS) w.note('sharesWithEdit');
          await w.row('SharePermissions', {
            id: rowId++,
            entityId,
            entityType,
            sharetype: s.type,
            param1: s.param1,
            param2: s.param2,
            rights: s.rights,
          });
        }
      }
      return;
    }
    case 'FavouriteAssociations': {
      let rowId = FIRST_ID;
      const things: [string, number, Person[]][] = [
        ...fw.filters.map(
          (f) => ['SearchRequest', f.id, f.favourites] as [string, number, Person[]],
        ),
        ...fw.dashboards.map(
          (d) => ['PortalPage', d.id, d.favourites] as [string, number, Person[]],
        ),
      ];
      for (const [entityType, entityId, people] of things) {
        for (const [k, p] of people.entries()) {
          w.note(entityType === 'PortalPage' ? 'favouriteDashboards' : 'favouriteFilters');
          await w.row('FavouriteAssociations', {
            id: rowId++,
            username: p.key,
            entityType,
            entityId,
            sequence: k,
          });
        }
      }
      return;
    }
    case 'PortalPage':
      for (const [k, d] of fw.dashboards.entries()) {
        await w.row('PortalPage', {
          id: d.id,
          username: d.owner.key,
          pagename: d.name,
          description: d.description,
          sequence: k,
          favCount: d.favourites.length,
          layout: d.layout,
          ppversion: 0,
        });
      }
      return;
    case 'PortletConfiguration':
      for (const d of fw.dashboards) {
        for (const g of d.gadgets) {
          await w.row('PortletConfiguration', {
            id: g.id,
            portalpage: d.id,
            columnNumber: g.column,
            positionSeq: g.position,
            gadgetXml: GADGETS[g.kind],
            color: 'color1',
          });
        }
      }
      return;
    case 'GadgetUserPreference': {
      let rowId = FIRST_ID;
      for (const d of fw.dashboards) {
        for (const g of d.gadgets) {
          for (const [key, value] of g.prefs) {
            if (value.startsWith(FILTER_PREFIX)) w.note('gadgetsNamingFilters');
            await w.row('GadgetUserPreference', {
              id: rowId++,
              portletconfiguration: g.id,
              userprefkey: key,
              userprefvalue: { text: value },
            });
          }
        }
      }
      return;
    }
    case 'FilterSubscription':
      for (const s of fw.subscriptions) {
        if (s.group) w.note('subscriptionsToGroups');
        await w.row('FilterSubscription', {
          id: s.id,
          filterID: s.filter.id,
          username: s.owner.key,
          groupname: s.group,
          lastRun: s.lastRun === null ? null : timestamp(s.lastRun),
          emailOnEmpty: s.emailOnEmpty ? 'true' : 'false',
        });
      }
      return;
    case 'ClusteredJob':
      for (const s of fw.subscriptions) {
        await w.row('ClusteredJob', {
          id: s.id,
          jobId: `${SUBSCRIPTION_JOB}${s.id}`,
          jobRunnerKey: SUBSCRIPTION_RUNNER,
          schedType: 'C',
          cronExpression: s.cron,
          nextRun: world.end + 86_400_000,
        });
      }
      return;
  }
}
