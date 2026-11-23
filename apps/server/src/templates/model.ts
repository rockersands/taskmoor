import type { JsonValue } from '@taskmoor/db';
import { z } from 'zod';
import { canonicalJson, isCalendarDay, SUMMARY_MAX } from '../tickets/model';

/**
 * Ticket templates (CORE-029, CORE-030; ADR-113): what a template holds, and the values it
 * starts a ticket with. Pure: the routes read and write the rows and run the create route.
 *
 * - The summary is a pattern: `{date}` is today on the creator's own clock (the routes pass
 *   `viewerDay`: their account's zone, else their device's, else UTC; T-280), `{track}` the
 *   track's key, `{user}` the creator's name. Any other text stays as written.
 * - Dates are offsets in days from today, so a template made in March still means "in 7 days".
 * - Default values are named as the ticket create route names them (`priorityId`, `labels`,
 *   `assigneeId`, `areaIds`, `targetReleaseIds`, `foundInReleaseIds`, `fields`), so a template's
 *   values go through exactly the checks a ticket's do.
 */
const MAX_INT = 2_147_483_647;
const id = z.number().int().positive().max(MAX_INT);
const ids = (max: number) =>
  z
    .array(id)
    .max(max)
    .refine((list) => new Set(list).size === list.length, 'each id once');
/** Days from today, either way: a date up to ten years off. */
const offset = z.number().int().min(-3650).max(3650);

export const MAX_SUBTICKETS = 50;
export const PLACEHOLDERS = ['date', 'track', 'user'] as const;

export const templateDefaults = z
  .object({
    priorityId: id.optional(),
    labels: z.array(z.string().trim().min(1).max(255)).max(100).optional(),
    assigneeId: id.optional(),
    areaIds: ids(100).optional(),
    targetReleaseIds: ids(100).optional(),
    foundInReleaseIds: ids(100).optional(),
    dueInDays: offset.optional(),
    startInDays: offset.optional(),
    /** Custom field values by field id, as the create route takes them. */
    fields: z.record(z.string().regex(/^[1-9][0-9]{0,9}$/), z.unknown()).optional(),
  })
  .strict();
export type TemplateDefaults = z.infer<typeof templateDefaults>;

export const templateSubticket = z
  .object({
    summary: z.string().trim().min(1).max(SUMMARY_MAX),
    /** The track's first subticket type when null or left out. */
    ticketTypeId: id.nullable().optional(),
  })
  .strict();
export type TemplateSubticket = z.infer<typeof templateSubticket>;

const fields = {
  name: z.string().trim().min(1).max(255),
  purpose: z.string().trim().max(2000),
  ticketTypeIds: ids(150),
  summary: z
    .string()
    .max(SUMMARY_MAX)
    .refine((s) => !/[\r\n]/.test(s), 'one line'),
  /** A document in the request's `?format=`; null for none. */
  description: z.unknown(),
  defaults: templateDefaults,
  subtickets: z.array(templateSubticket).max(MAX_SUBTICKETS),
};
export const createTemplateBody = z
  .object({
    /** A track's id or key; null or left out for every track. */
    track: z
      .union([id, z.string().trim().min(1).max(300)])
      .nullable()
      .optional(),
    name: fields.name,
    purpose: fields.purpose.optional(),
    ticketTypeIds: fields.ticketTypeIds.optional(),
    summary: fields.summary.optional(),
    description: fields.description.optional(),
    defaults: fields.defaults.optional(),
    subtickets: fields.subtickets.optional(),
  })
  .strict();
export const updateTemplateBody = z
  .object({
    name: fields.name.optional(),
    purpose: fields.purpose.optional(),
    ticketTypeIds: fields.ticketTypeIds.optional(),
    summary: fields.summary.optional(),
    description: fields.description.optional(),
    defaults: fields.defaults.optional(),
    subtickets: fields.subtickets.optional(),
    version: id.optional(),
  })
  .strict();

/** Today as YYYY-MM-DD in a time zone; UTC when there is none or it is unknown. */
export function todayIn(timeZone: string | null, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone ?? 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** A calendar day `days` after `day` (before it when negative). */
export function addDays(day: string, days: number): string {
  if (!isCalendarDay(day)) throw new Error(`not a calendar day: ${day}`);
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

export interface PatternValues {
  date: string;
  track: string;
  user: string;
}

/**
 * The summary a pattern gives: each known placeholder filled in, the rest as written, cut to the
 * summary's length.
 */
export function expandSummary(pattern: string, values: PatternValues): string {
  const out = pattern.replace(/\{(date|track|user)\}/g, (_, name: keyof PatternValues) =>
    values[name].replace(/[\r\n]+/g, ' '),
  );
  return [...out].slice(0, SUMMARY_MAX).join('');
}

export interface TemplateRowLike {
  summary: string;
  description: JsonValue | null;
  defaults: JsonValue;
}

/**
 * A ticket's create body from a template, for one track and person: what the template gives,
 * named as the create route names it. The caller adds the track and type.
 */
export function startValues(
  template: TemplateRowLike,
  context: PatternValues,
): Record<string, unknown> {
  const defaults = templateDefaults.parse(template.defaults);
  const out: Record<string, unknown> = {};
  const summary = expandSummary(template.summary, context);
  if (summary.trim() !== '') out.summary = summary;
  if (template.description !== null) out.description = template.description;
  if (defaults.priorityId !== undefined) out.priorityId = defaults.priorityId;
  if (defaults.labels && defaults.labels.length > 0) out.labels = defaults.labels;
  if (defaults.assigneeId !== undefined) out.assigneeId = defaults.assigneeId;
  if (defaults.areaIds && defaults.areaIds.length > 0) out.areaIds = defaults.areaIds;
  if (defaults.targetReleaseIds && defaults.targetReleaseIds.length > 0) {
    out.targetReleaseIds = defaults.targetReleaseIds;
  }
  if (defaults.foundInReleaseIds && defaults.foundInReleaseIds.length > 0) {
    out.foundInReleaseIds = defaults.foundInReleaseIds;
  }
  if (defaults.dueInDays !== undefined) out.dueDate = addDays(context.date, defaults.dueInDays);
  if (defaults.startInDays !== undefined) {
    out.startDate = addDays(context.date, defaults.startInDays);
  }
  const custom = Object.entries(defaults.fields ?? {}).filter(
    ([, v]) => v !== null && v !== undefined,
  );
  if (custom.length > 0) out.fields = Object.fromEntries(custom);
  return out;
}

/** Body keys the person always decides: never taken from a template or left out. */
const OWN_KEYS = new Set(['track', 'ticketTypeId', 'parent', 'visibilityLevelId']);

/**
 * The create body of a ticket from a template, and which of its keys are the template's own.
 *
 * - A key the person's body leaves out takes the template's value, unless `omit` names it.
 * - A key the person's body gives with the template's own value still counts as the
 *   template's: the create form starts from the template, and a value left as it was is not
 *   the person's choice.
 *
 * Template keys may be left out when the create route refuses them (a value this person may not
 * set, a field a rule hides); the person's own values never are.
 */
export function mergeBody(
  start: Record<string, unknown>,
  given: Record<string, unknown>,
  omit: ReadonlySet<string>,
): { body: Record<string, unknown>; fromTemplate: Set<string> } {
  const body: Record<string, unknown> = { ...given };
  const fromTemplate = new Set<string>();
  const same = (a: unknown, b: unknown) =>
    canonicalJson(a as JsonValue) === canonicalJson(b as JsonValue);
  for (const [key, value] of Object.entries(start)) {
    if (OWN_KEYS.has(key)) continue;
    if (key === 'fields') {
      const theirs = (given.fields ?? {}) as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...theirs };
      for (const [fieldId, v] of Object.entries(value as Record<string, unknown>)) {
        const name = `fields.${fieldId}`;
        if (omit.has(name)) continue;
        if (!(fieldId in theirs)) merged[fieldId] = v;
        else if (!same(theirs[fieldId], v)) continue;
        fromTemplate.add(name);
      }
      if (Object.keys(merged).length > 0) body.fields = merged;
      continue;
    }
    if (omit.has(key)) continue;
    if (!(key in given)) body[key] = value;
    else if (!same(given[key], value)) continue;
    fromTemplate.add(key);
  }
  return { body, fromTemplate };
}
