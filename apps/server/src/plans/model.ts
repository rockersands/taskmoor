import { z } from 'zod';
import { shareInput } from '../sharing/shares';
import { isCalendarDay } from '../tickets/model';

/**
 * Multi-track plans (T-088; PLN-001, PLN-012; ADR-122): what the routes accept.
 *
 * - A plan has a name, a description, up to `MAX_SOURCES` sources (tracks and saved searches,
 *   never boards) and the shares of a dashboard except `public`.
 * - Every view takes the filters, one value each (the user's decision of 2026-11-03): one track,
 *   one assignee (`me`, `none` or a person's id), one ticket type and one stage.
 * - Each view lists at most `LISTED` tickets and says so.
 */
const MAX_INT = 2_147_483_647;
const idNum = z.number().int().positive().max(MAX_INT);

/** How many sources a plan holds. */
export const MAX_SOURCES = 500;
/** How many tickets a view lists at most (PLN-012). */
export const LISTED = 10_000;

export const idParam = z.object({ id: z.coerce.number().int().positive().max(MAX_INT) }).strict();

export const sourceInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('track'), trackId: idNum }).strict(),
  z.object({ kind: z.literal('savedSearch'), savedSearchId: idNum }).strict(),
]);
export type SourceInput = z.infer<typeof sourceInput>;

/** A source as events and comparisons name it. */
export const sourceKey = (s: SourceInput) =>
  s.kind === 'track' ? `track:${s.trackId}` : `saved_search:${s.savedSearchId}`;

/** A dashboard's share scopes, except `public`: every view of a plan needs a signed-in person. */
export const planShareInput = shareInput.refine((s) => s.scope !== 'public', {
  message: 'not_shareable',
  path: ['scope'],
});

const name = z.string().trim().min(1).max(255);
const description = z.string().max(4000);

export const createBody = z
  .object({
    name,
    description: description.optional(),
    sources: z.array(sourceInput).max(MAX_SOURCES).default([]),
    shares: z.array(planShareInput).max(100).optional(),
  })
  .strict();

/** How many teams a plan plans with (PLN-005). */
export const MAX_TEAMS = 50;

/** What a plan counts work and capacity in (PLN-005; ADR-122 stage 3). */
export const CAPACITY_UNITS = ['points', 'hours'] as const;

/** A plan's periods: every 1 to 6 weeks from a first day, or each calendar month. */
export const periodInput = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('weeks'),
      weeks: z.number().int().min(1).max(6),
      anchor: z.string().refine(isCalendarDay, 'a calendar day as YYYY-MM-DD'),
    })
    .strict(),
  z.object({ kind: z.literal('month') }).strict(),
]);

export const updateBody = z
  .object({
    name: name.optional(),
    description: description.optional(),
    /** The sources the editor sees, in order; those hidden from them are kept. */
    sources: z.array(sourceInput).max(MAX_SOURCES).optional(),
    shares: z.array(planShareInput).max(100).optional(),
    /** The site teams the plan plans with, in order (PLN-005). */
    teams: z.array(idNum).max(MAX_TEAMS).optional(),
    /** Changing it clears every capacity set: amounts in one unit mean nothing in another. */
    capacityUnit: z.enum(CAPACITY_UNITS).optional(),
    /** Changing it clears the capacity set for single periods; that for every period stays. */
    period: periodInput.optional(),
    /**
     * Link types counted as dependencies beside blocking links, and whether dependencies within
     * one sprint are marked (PLN-013).
     */
    dependencies: z
      .object({ linkTypeIds: z.array(idNum).max(20), sameSprint: z.boolean() })
      .strict()
      .optional(),
    version: z.number().int().positive().optional(),
  })
  .strict();

export const listQuery = z
  .object({ filter: z.enum(['visible', 'mine']).default('visible') })
  .strict();

/** The filters every view takes, one value each. */
export const filterShape = {
  track: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_]{0,29}$/)
    .optional(),
  // A person's id is an int4, as route ids are: a larger one answers 400, not a database error.
  assignee: z
    .union([
      z.enum(['me', 'none']),
      z
        .string()
        .regex(/^[1-9]\d{0,9}$/)
        .refine((v) => Number(v) <= MAX_INT, 'too_large'),
    ])
    .optional(),
  type: z.string().trim().min(1).max(255).optional(),
  stage: z.enum(['new', 'active', 'closed']).optional(),
};
export const filterQuery = z.object(filterShape).strict();
export type PlanFilters = z.infer<typeof filterQuery>;

/**
 * `scenario=`: the Timeline, the Calendar, Capacity and program boards read with that scenario's
 * drafts (ADR-122 stage 6); without it they read the tickets as they are.
 */
export const scenarioShape = {
  scenario: z
    .string()
    .regex(/^[1-9]\d{0,9}$/)
    .refine((v) => Number(v) <= MAX_INT, 'too_large')
    .optional(),
};

/** Reading a view for a file (PLN-014): the same answer, and it counts as a bulk export. */
const exporting = { export: z.literal('true').optional() };
export const timelineQuery = z.object({ ...filterShape, ...scenarioShape, ...exporting }).strict();

/** A copy of a plan (PLN-014): only its name is asked for. */
export const duplicateBody = z.object({ name }).strict();

/** The orders the List offers, and so its file (PLN-014), as the query language says them. */
export const EXPORT_SORTS = {
  created: 'created DESC',
  updated: 'updated DESC',
  due: 'due ASC',
  priority: 'priority DESC',
} as const;

/** `GET /plans/:id/export`: the views' filters, the columns and the order of the List's file. */
export const exportQuery = z
  .object({
    ...filterShape,
    format: z.literal('csv').default('csv'),
    columns: z.string().max(4000).optional(),
    sort: z.enum(['created', 'updated', 'due', 'priority']).default('created'),
  })
  .strict();

const day = z.string().refine(isCalendarDay, 'a calendar day as YYYY-MM-DD');
export const calendarQuery = z
  .object({ ...filterShape, ...scenarioShape, ...exporting, from: day, to: day })
  .strict();
/** The longest range a calendar asks for: the six weeks a month shows, and some room. */
export const MAX_CALENDAR_DAYS = 100;

/** How many periods the capacity view shows at most (PLN-005). */
export const MAX_PERIODS = 12;
/** The capacity view: the filters, the day whose period comes first, and how many periods. */
export const capacityQuery = z
  .object({
    ...filterShape,
    ...scenarioShape,
    from: day.optional(),
    periods: z.coerce.number().int().min(1).max(MAX_PERIODS).optional(),
  })
  .strict();

/** A capacity in the plan's unit: from 0 to 100,000, in hundredths at most. */
const amount = z
  .number()
  .min(0)
  .max(100_000)
  .refine((v) => Math.abs(Math.round(v * 100) - v * 100) < 1e-6, 'at most two decimals');

/**
 * One capacity to set (PLN-005, PLN-009): a team's or a person's, for every period (`period`
 * null) or for the period starting that day; `amount` null removes it.
 */
export const capacityEntry = z
  .object({
    teamId: idNum.optional(),
    userId: idNum.optional(),
    period: day.nullable(),
    amount: amount.nullable(),
    note: z.string().trim().max(200).optional(),
  })
  .strict()
  .refine((e) => (e.teamId === undefined) !== (e.userId === undefined), {
    message: 'team_or_person',
    path: ['teamId'],
  });
export type CapacityEntry = z.infer<typeof capacityEntry>;

/** How many capacities one change sets at most: a row's every period, and some. */
export const MAX_CAPACITY_ENTRIES = 200;
export const capacityBody = z
  .object({
    entries: z.array(capacityEntry).min(1).max(MAX_CAPACITY_ENTRIES),
    /**
     * The unit and periods the amounts were typed for: when the plan's are no longer these,
     * nothing is set (`settings_changed`), since 30 points are not 30 hours.
     */
    unit: z.enum(CAPACITY_UNITS).optional(),
    period: periodInput.optional(),
  })
  .strict();
