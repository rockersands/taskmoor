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
  { id: 'settings', path: '/settings', labelId: 'plans.section.settings' },
] as const satisfies readonly { id: string; path: string; labelId: MessageId }[];

export type PlanSection = (typeof PLAN_SECTIONS)[number]['id'];

/** What the Timeline and the List group by (PLN-012). */
export const PLAN_GROUPS = ['track', 'assignee', 'status', 'type', 'priority'] as const;
export type PlanGroup = (typeof PLAN_GROUPS)[number];

/** The view in the page's address: the filters and the grouping. */
export interface PlanView {
  filters: PlanFilters;
  group: PlanGroup | null;
}

/** `#/plans/12`, `#/plans/12/timeline` and the like, with or without a query. */
export const PLAN_ROUTE =
  /^#\/plans\/(\d{1,10})(?:\/(timeline|list|calendar|capacity|releases|settings))?(?:[/?]|$)/;

const STAGES = ['new', 'active', 'closed'] as const;

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
  return {
    filters,
    group:
      group && (PLAN_GROUPS as readonly string[]).includes(group) ? (group as PlanGroup) : null,
  };
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
  const text = params.toString();
  return text ? `${path}?${text}` : path;
}
