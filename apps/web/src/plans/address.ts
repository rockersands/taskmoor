import type { MessageId } from '../i18n/messages.en';
import type { PlanFilters } from './client';

/** A plan's sections, in the order of their tab bar (ADR-122). */
export const PLAN_SECTIONS = [
  { id: 'summary', path: '', labelId: 'plans.section.summary' },
  { id: 'timeline', path: '/timeline', labelId: 'plans.section.timeline' },
  { id: 'list', path: '/list', labelId: 'plans.section.list' },
  { id: 'calendar', path: '/calendar', labelId: 'plans.section.calendar' },
  { id: 'capacity', path: '/capacity', labelId: 'plans.section.capacity' },
  { id: 'releases', path: '/releases', labelId: 'plans.section.releases' },
  { id: 'boards', path: '/boards', labelId: 'plans.section.boards' },
  { id: 'changes', path: '/changes', labelId: 'plans.section.changes' },
  { id: 'scenarios', path: '/scenarios', labelId: 'plans.section.scenarios' },
  { id: 'baselines', path: '/baselines', labelId: 'plans.section.baselines' },
  { id: 'settings', path: '/settings', labelId: 'plans.section.settings' },
] as const satisfies readonly { id: string; path: string; labelId: MessageId }[];

export type PlanSection = (typeof PLAN_SECTIONS)[number]['id'];

/** What the Timeline and the List group by (PLN-012). */
export const PLAN_GROUPS = ['track', 'assignee', 'status', 'type', 'priority'] as const;
export type PlanGroup = (typeof PLAN_GROUPS)[number];

/** The words of each grouping, on the filter bar and in a Timeline's image. */
export const GROUP_LABELS: Record<PlanGroup | 'none', MessageId> = {
  none: 'plans.group.none',
  track: 'plans.group.track',
  assignee: 'plans.group.assignee',
  status: 'plans.group.status',
  type: 'plans.group.type',
  priority: 'plans.group.priority',
};

export const PLAN_ZOOMS = ['weeks', 'months', 'quarters'] as const;
export type PlanZoom = (typeof PLAN_ZOOMS)[number];
export const PLAN_SORTS = ['created', 'updated', 'due', 'priority'] as const;
export type PlanSort = (typeof PLAN_SORTS)[number];

/**
 * Where a view stands (PLN-014): the Timeline's zoom, the Calendar's month (`2026-11`), the first
 * day Capacity asks for and the List's order. A link holds them, but moving through them reads
 * nothing again, so they are kept apart from the filters and the grouping.
 */
export interface PlanPosition {
  zoom?: PlanZoom | undefined;
  month?: string | undefined;
  from?: string | undefined;
  sort?: PlanSort | undefined;
  /** The Timeline marks the critical path (PLN-011). */
  critical?: '1' | undefined;
}

/**
 * The view in the page's address: the filters, the grouping, where the view stands, the scenario
 * read (ADR-122 stage 6; none is Live) and the two sides the Scenarios tab compares (`live` or a
 * scenario's id).
 */
export interface PlanView {
  filters: PlanFilters;
  group: PlanGroup | null;
  position?: PlanPosition;
  scenario?: number | undefined;
  compare?: { a?: string | undefined; b?: string | undefined } | undefined;
  /** The baseline the Baselines tab compares with (ADR-122 stage 9). */
  baseline?: number | undefined;
}

/** `#/plans/12`, `#/plans/12/timeline` and the like, with or without a query. */
export const PLAN_ROUTE =
  /^#\/plans\/(\d{1,10})(?:\/(timeline|list|calendar|capacity|releases|boards|changes|scenarios|baselines|settings))?(?:[/?]|$)/;

/** One program board of a plan (PLN-008): `#/plans/12/boards/5`, with or without a query. */
export const PLAN_BOARD_ROUTE = /^#\/plans\/(\d{1,10})\/boards\/(\d{1,10})(?:[/?]|$)/;

const STAGES = ['new', 'active', 'closed'] as const;
/** The largest id a route takes. */
const MAX_ID = 2_147_483_647;

/** A day that exists, as `YYYY-MM-DD`. */
function isDay(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const when = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(when.getTime()) && when.toISOString().slice(0, 10) === text;
}

/** One of the allowed values, or nothing. */
const oneOf = <T extends string>(values: readonly T[], text: string | null): T | undefined =>
  text !== null && (values as readonly string[]).includes(text) ? (text as T) : undefined;

/** Where the view stands; values that could not be meant are left out. */
function readPosition(params: URLSearchParams): PlanPosition {
  const position: PlanPosition = {};
  const zoom = oneOf(PLAN_ZOOMS, params.get('zoom'));
  if (zoom) position.zoom = zoom;
  const month = params.get('month');
  if (month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month)) position.month = month;
  const from = params.get('from');
  if (from && isDay(from)) position.from = from;
  const sort = oneOf(PLAN_SORTS, params.get('sort'));
  if (sort) position.sort = sort;
  if (params.get('critical') === '1') position.critical = '1';
  return position;
}

/** The view an address holds; values that could not be meant are left out. */
export function readView(route: string): PlanView {
  const at = route.indexOf('?');
  const params = new URLSearchParams(at < 0 ? '' : route.slice(at + 1));
  const filters: PlanFilters = {};
  const track = params.get('track');
  if (track && /^[A-Za-z][A-Za-z0-9_]{0,29}$/.test(track)) filters.track = track;
  const assignee = params.get('assignee');
  if (assignee && /^(me|none|[1-9]\d{0,9})$/.test(assignee)) filters.assignee = assignee;
  const type = params.get('type')?.trim();
  if (type && type.length <= 255) filters.type = type;
  const stage = params.get('stage');
  if (stage && (STAGES as readonly string[]).includes(stage)) {
    filters.stage = stage as (typeof STAGES)[number];
  }
  const group = params.get('group');
  const view: PlanView = {
    filters,
    group:
      group && (PLAN_GROUPS as readonly string[]).includes(group) ? (group as PlanGroup) : null,
    position: readPosition(params),
  };
  const scenario = params.get('scenario');
  if (scenario && /^[1-9]\d{0,9}$/.test(scenario) && Number(scenario) <= MAX_ID) {
    view.scenario = Number(scenario);
  }
  const side = (text: string | null) =>
    text === 'live' || (text && /^[1-9]\d{0,9}$/.test(text) && Number(text) <= MAX_ID)
      ? (text as string)
      : undefined;
  const a = side(params.get('a'));
  const b = side(params.get('b'));
  if (a || b) view.compare = { ...(a ? { a } : {}), ...(b ? { b } : {}) };
  const baseline = params.get('baseline');
  if (baseline && /^[1-9]\d{0,9}$/.test(baseline) && Number(baseline) <= MAX_ID) {
    view.baseline = Number(baseline);
  }
  return view;
}

/** The address of a plan's section with a view; the view stays when the section changes. */
export function planHref(id: number, section: PlanSection = 'summary', view?: PlanView): string {
  const path = `#/plans/${id}${PLAN_SECTIONS.find((s) => s.id === section)?.path ?? ''}`;
  if (!view) return path;
  const params = new URLSearchParams();
  for (const key of ['track', 'assignee', 'type', 'stage'] as const) {
    const value = view.filters[key];
    if (value) params.set(key, value);
  }
  if (view.group) params.set('group', view.group);
  for (const key of ['zoom', 'month', 'from', 'sort', 'critical'] as const) {
    const value = view.position?.[key];
    if (value) params.set(key, value);
  }
  if (view.scenario) params.set('scenario', String(view.scenario));
  // Only the Scenarios tab compares, so only its address keeps the two sides.
  if (section === 'scenarios') {
    if (view.compare?.a) params.set('a', view.compare.a);
    if (view.compare?.b) params.set('b', view.compare.b);
  }
  // Only the Baselines tab compares with a baseline.
  if (section === 'baselines' && view.baseline) params.set('baseline', String(view.baseline));
  const text = params.toString();
  return text ? `${path}?${text}` : path;
}

/** The address of one program board, with the view's filters when given. */
export function boardHref(id: number, boardId: number, view?: PlanView): string {
  const list = planHref(id, 'boards', view);
  const at = list.indexOf('?');
  return at < 0 ? `${list}/${boardId}` : `${list.slice(0, at)}/${boardId}${list.slice(at)}`;
}

/**
 * What decides whether a plan is read again: the filters, the grouping and the scenario, never
 * where the view stands, so moving a month or changing the zoom reads nothing more than its own
 * view does.
 */
export const planViewKey = (id: number, view: PlanView): string =>
  planHref(id, 'summary', { filters: view.filters, group: view.group, scenario: view.scenario });
