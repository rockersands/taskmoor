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

export const updateBody = z
  .object({
    name: name.optional(),
    description: description.optional(),
    /** The sources the editor sees, in order; those hidden from them are kept. */
    sources: z.array(sourceInput).max(MAX_SOURCES).optional(),
    shares: z.array(planShareInput).max(100).optional(),
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
  assignee: z.union([z.enum(['me', 'none']), z.string().regex(/^[1-9]\d{0,9}$/)]).optional(),
  type: z.string().trim().min(1).max(255).optional(),
  stage: z.enum(['new', 'active', 'closed']).optional(),
};
export const filterQuery = z.object(filterShape).strict();
export type PlanFilters = z.infer<typeof filterQuery>;

const day = z.string().refine(isCalendarDay, 'a calendar day as YYYY-MM-DD');
export const calendarQuery = z.object({ ...filterShape, from: day, to: day }).strict();
/** The longest range a calendar asks for: the six weeks a month shows, and some room. */
export const MAX_CALENDAR_DAYS = 100;
