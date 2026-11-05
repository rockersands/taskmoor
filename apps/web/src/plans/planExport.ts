import type { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { typeName } from '../shell/seededNames';
import { type Blocked, dependenciesOf } from '../timeline/dependencies';
import type {
  CapacityCell,
  CapacityWork,
  PlanCalendar,
  PlanCapacity,
  PlanCount,
  PlanRelease,
  PlanReleases,
  PlanSummary,
  PlanTimeline,
} from './client';

/**
 * The file of each of a plan's views (T-089g; PLN-014; ADR-122 stage 8), built on the page from the
 * view's own answer by one pure function per view, so a file holds what the view shows and nothing
 * else: what is hidden from the person stays numbers, as the view words it. The List's file comes
 * from the server instead (`GET /plans/:id/export`), as it holds every ticket.
 *
 * Headers are in the person's language. RFC 4180 quoting, CRLF, no byte-order mark, like the
 * server's exports.
 */
type T = ReturnType<typeof useT>;
type Cell = string | number | null | undefined;

/**
 * One cell, the same rule as the server's (`audit/query.ts`, tested with the same table): RFC 4180
 * quoting, and text a spreadsheet would run as a formula (starting with =, +, -, @, tab or carriage
 * return) gets a leading apostrophe. A number stays a number, so -3 is not a formula.
 */
export function csvField(value: Cell): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Rows as one file's text. */
export const csvText = (rows: readonly (readonly Cell[])[]): string =>
  rows.map((row) => `${row.map(csvField).join(',')}\r\n`).join('');

const header = (t: T, ids: readonly MessageId[]) => ids.map((id) => t(id));
const trackKeys = (tracks: readonly { id: number; key: string }[]) =>
  new Map(tracks.map((x) => [x.id, x.key]));
const stages: Record<'new' | 'active' | 'closed', MessageId> = {
  new: 'search.stage.new',
  active: 'search.stage.active',
  closed: 'search.stage.closed',
};

/**
 * The Timeline: each listed ticket with its days, where they come from, its roll-up and its
 * blockers. Blockers the view does not list are its two numbers, never named.
 */
export function timelineCsv(
  t: T,
  data: PlanTimeline,
  dependencies: ReadonlyMap<number, Blocked> = dependenciesOf(
    data.items,
    data.links,
    data.blockersElsewhere,
  ),
): string {
  const tracks = trackKeys(data.tracks);
  const rows: Cell[][] = [
    header(t, [
      'plans.csv.key',
      'plans.csv.summary',
      'plans.csv.type',
      'plans.csv.track',
      'plans.csv.status',
      'plans.csv.start',
      'plans.csv.due',
      'plans.csv.datesFrom',
      'plans.csv.rollupStart',
      'plans.csv.rollupDue',
      'plans.csv.rollupClosed',
      'plans.csv.rollupTotal',
      'plans.csv.blockers',
      'plans.csv.late',
      'plans.csv.blockersOutside',
      'plans.csv.blockersUnlisted',
    ]),
  ];
  for (const item of data.items) {
    const blocked = dependencies.get(item.id);
    rows.push([
      item.key,
      item.summary,
      typeName(t, item.type),
      tracks.get(item.trackId) ?? '',
      item.status.name,
      item.start,
      item.due,
      item.dated === 'own'
        ? t('plans.csv.datesFrom.own')
        : item.dated === 'sprint'
          ? t('plans.csv.datesFrom.sprint')
          : '',
      item.rollup?.start,
      item.rollup?.due,
      item.rollup?.closed,
      item.rollup?.total,
      blocked?.blockers.length ?? 0,
      blocked?.late ?? 0,
      blocked?.outside ?? 0,
      blocked?.unlisted ?? 0,
    ]);
  }
  return csvText(rows);
}

/** The Calendar: the entries of the month shown. */
export function calendarCsv(t: T, data: PlanCalendar): string {
  const tracks = trackKeys(data.tracks);
  return csvText([
    header(t, [
      'plans.csv.key',
      'plans.csv.summary',
      'plans.csv.type',
      'plans.csv.track',
      'plans.csv.stage',
      'plans.csv.start',
      'plans.csv.due',
    ]),
    ...data.tickets.map((x) => [
      x.key,
      x.summary,
      typeName(t, x.type),
      tracks.get(x.trackId) ?? '',
      t(stages[x.stage]),
      x.start,
      x.due,
    ]),
  ]);
}

const OVERVIEW: Record<string, MessageId> = {
  open: 'plans.summary.open',
  overdue: 'plans.summary.overdue',
  dueSoon: 'plans.summary.dueSoon',
  unscheduled: 'plans.summary.unscheduled',
  closedRecently: 'plans.summary.closedRecently',
};

/** The Summary: each measure, its number and the search that finds exactly those tickets. */
export function summaryCsv(t: T, data: PlanSummary): string {
  const rows: Cell[][] = [
    header(t, ['plans.csv.section', 'plans.csv.measure', 'plans.csv.number', 'plans.csv.search']),
  ];
  const add = (section: string, items: PlanCount[], label: (i: PlanCount) => string) => {
    for (const i of items) rows.push([section, label(i), i.count, i.query]);
  };
  const overview = t('plans.csv.overview');
  rows.push([overview, t('plans.csv.total'), data.total.count, data.total.query]);
  add(overview, data.overview, (i) => t(OVERVIEW[i.id] ?? 'plans.summary.open'));
  add(t('summary.byStage'), data.stages, (i) =>
    t(stages[i.id as keyof typeof stages] ?? 'search.stage.new'),
  );
  add(t('plans.summary.byTrack'), data.tracks, (i) => i.name ?? '');
  add(t('plans.summary.byAssignee'), data.assignees, (i) => i.name ?? t('summary.unassigned'));
  return csvText(rows);
}

const isCell = (c: CapacityCell | CapacityWork): c is CapacityCell => 'load' in c;

/**
 * Capacity: one line per team or person and period, and one for what is unscheduled. Other work due
 * then stays a count and an amount, never named, and its heading says it is counted by whole weeks.
 * Notes stay on the page: they may say why someone was away, and a file travels.
 */
export function capacityCsv(t: T, data: PlanCapacity): string {
  const rows: Cell[][] = [
    header(t, [
      'plans.csv.team',
      'plans.csv.who',
      'plans.csv.periodStart',
      'plans.csv.periodEnd',
      'plans.csv.tickets',
      'plans.csv.work',
      'plans.csv.unit',
      'plans.csv.capacity',
      'plans.csv.over',
      'plans.csv.unestimated',
      'plans.csv.elsewhereCount',
      'plans.csv.elsewhereAmount',
    ]),
  ];
  const unit = t(data.unit === 'hours' ? 'plans.csv.unit.hours' : 'plans.csv.unit.points');
  const yes = t('plans.csv.yes');
  const no = t('plans.csv.no');
  const line = (
    team: string,
    who: string,
    cells: (CapacityCell | CapacityWork)[],
    unscheduled: CapacityWork,
    capacity?: (number | null)[],
  ) => {
    cells.forEach((cell, i) => {
      const period = data.periods[i];
      const held = isCell(cell);
      rows.push([
        team,
        who,
        period?.start,
        period?.end,
        cell.count,
        cell.amount,
        unit,
        capacity?.[i],
        held && cell.over ? yes : no,
        cell.unestimated,
        held ? cell.elsewhere.count : '',
        held ? cell.elsewhere.amount : '',
      ]);
    });
    rows.push([
      team,
      who,
      t('plans.capacity.unscheduled'),
      '',
      unscheduled.count,
      unscheduled.amount,
      unit,
      '',
      '',
      unscheduled.unestimated,
      '',
      '',
    ]);
  };
  for (const team of data.teams) {
    const amounts = (of: typeof team.capacity) => of.periods.map((p) => p.amount);
    line(team.name, team.name, team.cells, team.unscheduled, amounts(team.capacity));
    for (const m of team.members) {
      const who = m.active ? m.name : t('plans.capacity.inactive', { name: m.name });
      line(team.name, who, m.cells, m.unscheduled, amounts(m.capacity));
    }
  }
  const unassigned = t('plans.capacity.unassigned');
  line('', unassigned, data.unassigned.cells, data.unassigned.unscheduled);
  line('', t('plans.capacity.others'), data.others.cells, data.others.unscheduled);
  return csvText(rows);
}

const releaseState = (t: T, r: PlanRelease) =>
  t(
    r.archived
      ? 'releases.state.archived'
      : r.shipped
        ? 'releases.state.shipped'
        : r.overdue
          ? 'releases.state.overdue'
          : 'releases.state.upcoming',
  );
const CROSS_STATES: Record<PlanReleases['crossTrack'][number]['state'], MessageId> = {
  empty: 'crossTrack.state.empty',
  shipped: 'crossTrack.state.shipped',
  overdue: 'crossTrack.state.overdue',
  ready: 'crossTrack.state.ready',
  upcoming: 'crossTrack.state.upcoming',
};

/**
 * The Releases tab's rows, each release across tracks before those linked to it. What is hidden from
 * the person stays two numbers on its line, as the tab says it.
 */
export function releasesCsv(t: T, data: PlanReleases): string {
  const rows: Cell[][] = [
    header(t, [
      'plans.csv.group',
      'plans.csv.release',
      'plans.csv.track',
      'plans.csv.date',
      'plans.csv.state',
      'plans.csv.outOfStep',
      'plans.csv.tickets',
      'plans.csv.closed',
      'plans.csv.hiddenReleases',
      'plans.csv.hiddenOpen',
    ]),
  ];
  const yes = t('plans.csv.yes');
  const line = (group: string, r: PlanRelease, track: string) => [
    group,
    r.name,
    track,
    r.releaseDate,
    releaseState(t, r),
    r.outOfStep ? yes : '',
    r.progress.tickets,
    r.progress.closed,
    '',
    '',
  ];
  for (const c of data.crossTrack) {
    rows.push([
      c.name,
      c.name,
      '',
      c.date,
      t(CROSS_STATES[c.state]),
      '',
      c.progress.tickets,
      c.progress.closed,
      c.hidden.releases,
      c.hidden.open,
    ]);
    for (const r of c.releases) rows.push(line(c.name, r, r.track?.key ?? ''));
  }
  for (const g of data.tracks) {
    for (const r of g.releases) rows.push(line(g.track.name, r, g.track.key));
  }
  return csvText(rows);
}
