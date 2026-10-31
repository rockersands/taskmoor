import type { DashboardLayout, JsonValue } from '@taskmoor/db';
import type { WidgetKind } from '../dashboards/model';
import { parseCron, ScheduleError } from '../search/schedule';
import { FILTER_PREFIX, PROJECT_PREFIX } from './dc-backup/filter-format';
import type {
  StagedDashboard,
  StagedFilter,
  StagedGadget,
  StagedShare,
  StagedSubscription,
} from './dc-backup/stage-filters';
import type {
  Mapped,
  Ref,
  ShareCommand,
  SubscriptionCommand,
  Warning,
  WidgetCommand,
} from './model';

/**
 * Mapping a Data Center backup's saved filters, filter subscriptions and dashboards (M1-094;
 * IMP-004; ADR-096) to saved searches, search subscriptions and dashboards.
 *
 * - A filter keeps its owner, its shares and the people who made it a favourite (as stars). Its
 *   query was analysed by the stage (`translate/jql.ts`); the loader finishes it. One that cannot
 *   translate is still imported, with the source's text, and flagged with the reason
 *   (`saved_search.import_problem`), and the record warns `query_not_translated` with the code and
 *   the function or field name.
 * - Shares never widen: shared with everyone becomes public, with everyone signed in any user, a
 *   group or a project (with a role) the same; one naming something the backup does not have is
 *   left out, and a share that may also change the filter keeps only the view.
 * - A subscription keeps its person or group and its schedule: the source's cron expression
 *   (seconds first) becomes daily, weekly, monthly or a five-field cron on UTC; one Taskmoor's
 *   cron cannot say (the last day of a month, the n-th weekday) is left out with its reason.
 * - A dashboard keeps its layout and the gadgets that have a widget counterpart, each with its
 *   settings; the rest are reported (`gadget_not_mapped` with the gadget's module).
 */

const ref = (kind: Ref['kind'], id: string): Ref => ({ kind, id });

/** Shares as Taskmoor's scopes, never wider than the source's. */
export function mapShares(shares: readonly StagedShare[], warnings: Warning[]): ShareCommand[] {
  const out: ShareCommand[] = [];
  const seen = new Set<string>();
  const add = (s: ShareCommand, key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };
  for (const s of shares) {
    if (s.edit) warnings.push({ code: 'edit_share_not_imported', detail: s.type });
    if (s.missing !== null) {
      warnings.push({ code: 'share_not_imported', detail: `${s.type} ${s.missing}` });
      continue;
    }
    switch (s.type) {
      case 'global':
        add({ scope: 'public' }, 'public');
        break;
      case 'loggedin':
      case 'authenticated':
        add({ scope: 'any_user' }, 'any_user');
        break;
      case 'group':
        if (s.group) add({ scope: 'group', group: ref('group', s.group) }, `group:${s.group}`);
        break;
      case 'project':
        if (s.project) {
          add(
            {
              scope: 'track',
              track: ref('track', s.project),
              role: s.role === null ? null : ref('role', s.role),
            },
            `track:${s.project}:${s.role ?? '*'}`,
          );
        }
        break;
      default:
        warnings.push({ code: 'share_not_imported', detail: s.type });
    }
  }
  return out;
}

export function mapSavedSearch(f: StagedFilter): Mapped {
  if (f.owner === null) return { fail: 'no_owner' };
  const warnings: Warning[] = [];
  const q = f.query;
  for (const p of q.problems) {
    warnings.push({ code: 'query_not_translated', detail: `${p.code}: ${p.detail}` });
  }
  for (const p of q.flags)
    warnings.push({ code: 'query_flagged', detail: `${p.code}: ${p.detail}` });
  for (const c of q.changes)
    warnings.push({ code: 'query_changed', detail: `${c.code}: ${c.detail}` });
  const shares = mapShares(f.shares, warnings);
  return {
    command: {
      kind: 'saved_search',
      name: f.name.trim(),
      description: f.description.slice(0, 4000),
      owner: ref('user', f.owner),
      query: {
        source: q.text,
        template: q.template as unknown as JsonValue,
        problems: q.problems,
        flags: q.flags,
      },
      shares,
      stars: f.favourites.map((p) => ref('user', p)),
    },
    warnings,
  };
}

// --- Schedules --------------------------------------------------------------------------------

const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

type Schedule = Pick<
  SubscriptionCommand,
  'schedule' | 'hour' | 'minute' | 'weekday' | 'dayOfMonth' | 'cron'
>;

/**
 * A schedule from the source's cron expression: seconds, minutes, hours, day of month, month,
 * day of week (1 is Sunday, or names), an optional year; `?` for no day (Verify). Null, with the
 * reason, when Taskmoor's five-field cron cannot say it.
 */
export function scheduleOf(expression: string): Schedule | { reason: string } {
  const parts = expression.trim().toUpperCase().split(/\s+/);
  if (parts.length < 6 || parts.length > 7) return { reason: 'cron_not_understood' };
  const [seconds, minute, hour, dom, month, dow, year] = parts as string[];
  if (year !== undefined && year !== '*') return { reason: 'cron_year_not_supported' };
  if (seconds !== '0') return { reason: 'cron_seconds_not_supported' };
  if (/[LW#]/.test(`${dom}${dow}`)) return { reason: 'cron_day_rule_not_supported' };
  const words = (field: string, names: string[], base: number) =>
    field.replace(/[A-Z]{3}/g, (w) => {
      const i = names.indexOf(w);
      return i < 0 ? w : String(i + base);
    });
  const day = (dom as string) === '?' ? '*' : (dom as string);
  // Weekdays: the source counts 1 (Sunday) to 7; names first, then shift numbers by one.
  let weekdays = (dow as string) === '?' ? '*' : words(dow as string, DAYS, 1);
  weekdays = weekdays.replace(/\d+/g, (n) => String(Number(n) - 1));
  const months = words(month as string, MONTHS, 1);
  const simple = /^\d{1,2}$/;
  if (simple.test(minute as string) && simple.test(hour as string) && months === '*') {
    const h = Number(hour);
    const m = Number(minute);
    if (day === '*' && weekdays === '*') {
      return { schedule: 'daily', hour: h, minute: m, weekday: null, dayOfMonth: null, cron: null };
    }
    if (day === '*' && simple.test(weekdays)) {
      return {
        schedule: 'weekly',
        hour: h,
        minute: m,
        weekday: Number(weekdays) % 7,
        dayOfMonth: null,
        cron: null,
      };
    }
    if (weekdays === '*' && simple.test(day) && Number(day) >= 1 && Number(day) <= 28) {
      return {
        schedule: 'monthly',
        hour: h,
        minute: m,
        weekday: null,
        dayOfMonth: Number(day),
        cron: null,
      };
    }
  }
  const cron = [minute, hour, day, months, weekdays].join(' ');
  try {
    parseCron(cron);
  } catch (error) {
    if (error instanceof ScheduleError) return { reason: 'cron_not_understood' };
    throw error;
  }
  return { schedule: 'cron', hour: 0, minute: 0, weekday: null, dayOfMonth: null, cron };
}

/** A repeating interval as a cron expression, when it divides an hour or a day. */
function intervalSchedule(ms: number): Schedule | { reason: string } {
  const minutes = ms / 60_000;
  if (Number.isInteger(minutes) && minutes > 0 && minutes < 60 && 60 % minutes === 0) {
    return {
      schedule: 'cron',
      hour: 0,
      minute: 0,
      weekday: null,
      dayOfMonth: null,
      cron: `*/${minutes} * * * *`,
    };
  }
  const hours = minutes / 60;
  if (Number.isInteger(hours) && hours > 0 && hours <= 24 && 24 % hours === 0) {
    if (hours === 24) {
      return { schedule: 'daily', hour: 0, minute: 0, weekday: null, dayOfMonth: null, cron: null };
    }
    return {
      schedule: 'cron',
      hour: 0,
      minute: 0,
      weekday: null,
      dayOfMonth: null,
      cron: `0 */${hours} * * *`,
    };
  }
  return { reason: 'interval_not_supported' };
}

export function mapSubscription(s: StagedSubscription): Mapped {
  if (!s.filterKnown) return { fail: 'saved_search_not_found' };
  if (s.owner === null) return { fail: 'no_owner' };
  if (s.unknownGroup !== null) return { fail: 'group_not_imported' };
  const schedule =
    s.cron !== null
      ? scheduleOf(s.cron)
      : s.intervalMs !== null
        ? intervalSchedule(s.intervalMs)
        : { reason: 'no_schedule' };
  if ('reason' in schedule) {
    // Left out with the reason and the source's expression: no nearby schedule stands in.
    return {
      skip: schedule.reason,
      warnings: [{ code: 'schedule_not_imported', detail: s.cron ?? '' }],
    };
  }
  return {
    command: {
      kind: 'subscription',
      savedSearch: ref('saved_search', s.filter),
      creator: ref('user', s.owner),
      group: s.group === null ? null : ref('group', s.group),
      ...schedule,
      // The backup names no zone for a schedule (Verify): UTC, as times elsewhere (ADR-092).
      timeZone: 'UTC',
      // Mailing on empty results is the opposite of "only if results".
      onlyIfResults: !s.emailOnEmpty,
      lastRunAt: s.lastRun === null ? null : `${s.lastRun.trim().replace(' ', 'T')}Z`,
    },
    warnings: [{ code: 'schedule_time_zone_utc' }],
  };
}

// --- Dashboards -------------------------------------------------------------------------------

/** Layouts by the source's letters: A a narrow column, B a wide one (Verify). */
const LAYOUTS: Readonly<Record<string, DashboardLayout>> = {
  A: 'one',
  AA: 'two',
  AAA: 'three',
  AB: 'two-wide-right',
  BA: 'two-wide-left',
};

/** Statistic types as group-by fields (Verify). */
const AXES: Readonly<Record<string, string>> = {
  assignees: 'assignee',
  reporter: 'requester',
  creator: 'creator',
  statuses: 'status',
  priorities: 'priority',
  issuetype: 'type',
  project: 'track',
  resolution: 'closeReason',
  components: 'area',
  fixfor: 'targetRelease',
  allFixfor: 'targetRelease',
  version: 'foundInRelease',
  allVersion: 'foundInRelease',
  labels: 'labels',
};

const PERIODS: Readonly<Record<string, 'day' | 'week' | 'month'>> = {
  hourly: 'day',
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
  quarterly: 'month',
  yearly: 'month',
};

/** Result columns by the source's names, where the search page has them. */
const COLUMNS: Readonly<Record<string, string>> = {
  issuetype: 'type',
  issuekey: 'key',
  summary: 'summary',
  assignee: 'assignee',
  reporter: 'requester',
  status: 'status',
  priority: 'priority',
  resolution: 'closeReason',
  created: 'created',
  updated: 'updated',
  duedate: 'due',
};

/** The gadget's module, from its URI: `...:<module>/gadgets/...` (Verify). */
export function gadgetModule(uri: string): string {
  return /:([A-Za-z0-9._-]+)\/gadgets\//.exec(uri)?.[1] ?? uri.slice(0, 120);
}

const clampInt = (v: string | undefined, lo: number, hi: number, fallback: number) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

/** Plain text from a text gadget's HTML: paragraphs and breaks kept, tags dropped. */
function plainText(html: string): string {
  return html
    .replace(/<\s*(br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 10_000);
}

type Built = Omit<WidgetCommand, 'column' | 'title'>;

function gadgetWidget(g: StagedGadget, warnings: Warning[]): Built | null {
  const module = gadgetModule(g.uri);
  const p = g.prefs;
  const source = (value: string | undefined): Pick<WidgetCommand, 'query'> | null => {
    if (value?.startsWith(FILTER_PREFIX)) {
      return { query: { savedSearch: ref('saved_search', value.slice(FILTER_PREFIX.length)) } };
    }
    if (value?.startsWith(PROJECT_PREFIX)) {
      return { query: { track: ref('track', value.slice(PROJECT_PREFIX.length)) } };
    }
    return null;
  };
  const axis = (
    stat: string | undefined,
  ): Pick<WidgetCommand, 'field'> | { name: string } | null => {
    if (!stat) return null;
    const custom = /^customfield_(\d+)$/.exec(stat);
    if (custom) return { field: ref('field', custom[1] as string) };
    const name = AXES[stat];
    return name ? { name } : null;
  };
  const period = (name: string | undefined) => {
    const out = PERIODS[name ?? 'daily'] ?? 'day';
    if (name && name !== 'daily' && name !== 'weekly' && name !== 'monthly') {
      warnings.push({ code: 'gadget_period_changed', detail: name });
    }
    return out;
  };
  const chart = (kind: WidgetKind): Built | null => {
    const from = source(p.projectOrFilterId ?? p.filterId);
    if (!from) return missingSetting('projectOrFilterId');
    return {
      kind,
      config: { days: clampInt(p.daysprevious, 1, 731, 30), period: period(p.periodName) },
      ...from,
    };
  };
  const missingSetting = (name: string) => {
    warnings.push({ code: 'gadget_setting_not_imported', detail: `${module} ${name}` });
    return null;
  };
  const withAxis = (
    kind: WidgetKind,
    stat: string | undefined,
    extra: Record<string, JsonValue>,
  ) => {
    const from = source(p.filterId ?? p.projectOrFilterId);
    if (!from) return missingSetting('filterId');
    const a = axis(stat);
    if (!a) return missingSetting(`statType ${stat ?? ''}`);
    return {
      kind,
      config: { ...extra, ...('name' in a ? { field: a.name } : {}) },
      ...from,
      ...('field' in a ? { field: a.field } : {}),
    };
  };
  switch (module) {
    case 'filter-results-gadget': {
      const from = source(p.filterId);
      if (!from) return missingSetting('filterId');
      const columns = (p.columnNames ?? '')
        .split('|')
        .flatMap((c) => (COLUMNS[c] ? [COLUMNS[c] as string] : []));
      return {
        kind: 'search-results',
        config: { limit: clampInt(p.num, 1, 50, 10), ...(columns.length > 0 ? { columns } : {}) },
        ...from,
      };
    }
    case 'assigned-to-me-gadget':
      return { kind: 'assigned-to-me', config: { limit: clampInt(p.num, 1, 50, 10) } };
    case 'watched-gadget':
      return { kind: 'followed-tickets', config: { limit: clampInt(p.num, 1, 50, 10) } };
    case 'pie-chart-gadget':
      return withAxis('pie', p.statType, {});
    case 'stats-gadget':
      return withAxis('ticket-statistics', p.statType, {
        sort: p.sortBy === 'total' ? 'total' : 'natural',
      });
    case 'two-dimensional-stats-gadget': {
      const from = source(p.filterId);
      if (!from) return missingSetting('filterId');
      const x = axis(p.xstattype);
      const y = axis(p.ystattype);
      if (!x || !y || !('name' in x) || !('name' in y)) {
        return missingSetting(`xstattype ${p.xstattype ?? ''} ystattype ${p.ystattype ?? ''}`);
      }
      return { kind: 'two-dimensional', config: { x: x.name, y: y.name }, ...from };
    }
    case 'created-vs-resolved-issues-chart-gadget': {
      const c = chart('created-vs-closed');
      if (c) c.config.cumulative = p.isCumulative === 'true';
      return c;
    }
    case 'recently-created-chart-gadget':
      return chart('recently-created');
    case 'average-age-chart-gadget':
      return chart('average-age');
    case 'resolution-time-gadget':
      return chart('time-to-close');
    case 'text-gadget':
      return { kind: 'introduction', config: { text: plainText(p.html ?? '') } };
    case 'greenhopper-gadget-sprint-burndown':
    case 'greenhopper-gadget-sprint-days-remaining': {
      if (!p.rapidViewId) return missingSetting('rapidViewId');
      return {
        kind: module.endsWith('burndown') ? 'sprint-burndown' : 'days-remaining',
        config: {},
        board: ref('board', p.rapidViewId),
      };
    }
    default:
      warnings.push({ code: 'gadget_not_mapped', detail: module });
      return null;
  }
}

export function mapDashboard(d: StagedDashboard): Mapped {
  if (d.owner === null) return { fail: 'no_owner' };
  const warnings: Warning[] = [];
  let layout = LAYOUTS[d.layout];
  if (!layout) {
    warnings.push({ code: 'layout_not_mapped', detail: d.layout });
    layout = 'two';
  }
  const last = layout === 'one' ? 0 : layout === 'three' ? 2 : 1;
  const widgets: WidgetCommand[] = [];
  for (const g of d.gadgets) {
    const w = gadgetWidget(g, warnings);
    if (!w) continue;
    widgets.push({ ...w, column: Math.min(Math.max(0, g.column), last), title: '' });
  }
  if (widgets.length > 40) {
    warnings.push({ code: 'widgets_left_out', detail: String(widgets.length - 40) });
    widgets.length = 40;
  }
  if (d.favourites.length > 0) warnings.push({ code: 'dashboard_favourites_not_imported' });
  for (const m of d.missing) warnings.push({ code: 'gadget_source_not_found', detail: m });
  return {
    command: {
      kind: 'dashboard',
      name: d.name.trim(),
      description: d.description.slice(0, 4000),
      owner: ref('user', d.owner),
      layout,
      widgets,
      shares: mapShares(d.shares, warnings),
    },
    warnings,
  };
}
