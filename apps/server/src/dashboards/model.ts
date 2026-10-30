import { randomBytes } from 'node:crypto';
import type { DashboardLayout } from '@taskmoor/db';
import { z } from 'zod';

/**
 * Dashboards and their widgets (M1-064; RPT-004, RPT-005; ADR-060): the layouts, the widget
 * kinds and each kind's settings, checked when a dashboard is saved. A widget's data is read as
 * the viewer (`dashboards/widgets.ts`), so its settings never hold a viewer's rights: a query, a
 * field, a board, a period, a number of rows.
 */
const MAX_INT = 2_147_483_647;
export const MAX_WIDGETS = 40;

export const LAYOUTS = ['one', 'two', 'two-wide-left', 'two-wide-right', 'three'] as const;
/** How many columns a layout has. */
export const COLUMNS: Readonly<Record<DashboardLayout, number>> = {
  one: 1,
  two: 2,
  'two-wide-left': 2,
  'two-wide-right': 2,
  three: 3,
};

const query = z.string().max(10_000).default('');
const limit = z.number().int().min(1).max(50).default(10);
const days = z.number().int().min(1).max(731).default(30);
const period = z.enum(['day', 'week', 'month']).default('day');
/** A field to group by: a system field or `cf[<id>]` (the general reports' axes, ADR-059). */
const axis = z.string().regex(/^([a-zA-Z]{1,40}|cf\[\d{1,10}\])$/);
const id = z.number().int().positive().max(MAX_INT);
/** Links go to the web or within the app, never to a script. */
const link = z
  .string()
  .trim()
  .max(2000)
  .refine((url) => /^https?:\/\/[^\s]+$/i.test(url) || /^#\/[^\s]*$/.test(url), 'unsafe_url');

/** Each kind's settings, with their defaults. */
export const WIDGET_SETTINGS = {
  /** Text the owner writes, shown as plain paragraphs. */
  introduction: z.object({ text: z.string().max(10_000).default('') }).strict(),
  'quick-links': z
    .object({
      links: z
        .array(z.object({ label: z.string().trim().min(1).max(255), url: link }).strict())
        .max(30)
        .default([]),
    })
    .strict(),
  /** The first tickets of a query, a saved search's (`filter = "…"`) included. */
  'search-results': z
    .object({ query, limit, columns: z.array(z.string().min(1).max(200)).max(20).optional() })
    .strict(),
  'assigned-to-me': z.object({ limit }).strict(),
  'followed-tickets': z.object({ limit }).strict(),
  'created-vs-closed': z
    .object({ query, days, period, cumulative: z.boolean().default(false) })
    .strict(),
  'recently-created': z.object({ query, days, period }).strict(),
  /** How old the open tickets were, on average, at the end of each period. */
  'average-age': z.object({ query, days, period }).strict(),
  /** How long the tickets closed in each period took, on average. */
  'time-to-close': z.object({ query, days, period }).strict(),
  pie: z.object({ query, field: axis }).strict(),
  'ticket-statistics': z
    .object({ query, field: axis, sort: z.enum(['natural', 'total']).default('natural') })
    .strict(),
  'two-dimensional': z.object({ query, x: axis, y: axis }).strict(),
  /** A Scrum board's sprint: the active one, or a chosen one. */
  'sprint-burndown': z.object({ boardId: id, sprintId: id.nullable().default(null) }).strict(),
  'sprint-health': z.object({ boardId: id }).strict(),
  'days-remaining': z.object({ boardId: id }).strict(),
  'average-time-in-status': z.object({ query, days }).strict(),
} as const;

export type WidgetKind = keyof typeof WIDGET_SETTINGS;
export const WIDGET_KINDS = Object.keys(WIDGET_SETTINGS) as WidgetKind[];
export type WidgetSettings<K extends WidgetKind> = z.infer<(typeof WIDGET_SETTINGS)[K]>;

export interface Widget {
  id: string;
  kind: WidgetKind;
  column: number;
  title: string;
  config: Record<string, unknown>;
}

const itemId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);

export const widgetInput = z
  .object({
    id: itemId.optional(),
    kind: z.enum(WIDGET_KINDS as [WidgetKind, ...WidgetKind[]]),
    column: z.number().int().min(0).max(2).default(0),
    title: z.string().trim().max(255).default(''),
    config: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type WidgetInput = z.infer<typeof widgetInput>;

/**
 * Checks and completes widgets: each kind's settings with their defaults, an id for a new one,
 * unique ids, and columns within the layout (a widget beyond the last column moves to it).
 * Returns the widgets, or the problems by path (`widgets.2.config.query`, …).
 */
export function readWidgets(
  input: readonly WidgetInput[],
  layout: DashboardLayout,
): { widgets: Widget[] } | { fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  const widgets: Widget[] = [];
  const taken = new Set(input.flatMap((w) => (w.id ? [w.id] : [])));
  if (taken.size !== input.filter((w) => w.id).length) fields.widgets = 'duplicate_id';
  const last = COLUMNS[layout] - 1;
  for (const [i, w] of input.entries()) {
    const parsed = WIDGET_SETTINGS[w.kind].safeParse(w.config);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = `widgets.${i}.config${issue.path.length > 0 ? `.${issue.path.join('.')}` : ''}`;
        if (!(path in fields)) fields[path] = issue.message.length < 40 ? issue.message : 'invalid';
      }
      continue;
    }
    let widgetId = w.id;
    while (!widgetId || (widgetId !== w.id && taken.has(widgetId))) {
      widgetId = `w-${randomBytes(4).toString('hex')}`;
    }
    taken.add(widgetId);
    widgets.push({
      id: widgetId,
      kind: w.kind,
      column: Math.min(w.column, last),
      title: w.title,
      config: parsed.data as Record<string, unknown>,
    });
  }
  return Object.keys(fields).length > 0 ? { fields } : { widgets };
}

/** Widgets as stored, read back; anything malformed is left out rather than failing a page. */
export function storedWidgets(value: unknown): Widget[] {
  if (!Array.isArray(value)) return [];
  const out: Widget[] = [];
  for (const raw of value) {
    const w = widgetInput.safeParse(raw);
    if (!w.success || !w.data.id) continue;
    const config = WIDGET_SETTINGS[w.data.kind].safeParse(w.data.config);
    if (!config.success) continue;
    out.push({
      id: w.data.id,
      kind: w.data.kind,
      column: w.data.column,
      title: w.data.title,
      config: config.data as Record<string, unknown>,
    });
  }
  return out;
}
