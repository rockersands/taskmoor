import type { CrossTrackEndRule } from '@taskmoor/db';
import { z } from 'zod';
import { isCalendarDay } from '../tickets/model';

/**
 * Releases across tracks (T-089c; PLN-007; ADR-122 stage 4): what the routes accept and the two
 * pure rules everything else reads, the state and what a move does to one linked release.
 */
const MAX_INT = 2_147_483_647;
const idNum = z.number().int().positive().max(MAX_INT);
const name = z.string().trim().min(1).max(255);
const description = z.string().max(4000);
const day = z.string().refine(isCalendarDay, 'a calendar day as YYYY-MM-DD');

/** How many releases one holds. */
export const MAX_MEMBERS = 100;
/** How many a page of the list holds. */
export const LIST_PAGE = 100;
/** How many upcoming releases a person's `candidates` lists. */
export const MAX_CANDIDATES = 500;
/** How many rows a plan's Releases tab lists; it says so when there are more. */
export const PLAN_RELEASES = 200;

export const idParam = z.object({ id: z.coerce.number().int().positive().max(MAX_INT) }).strict();
export const memberParam = z
  .object({
    id: z.coerce.number().int().positive().max(MAX_INT),
    releaseId: z.coerce.number().int().positive().max(MAX_INT),
  })
  .strict();

export const createBody = z
  .object({
    name,
    description: description.optional(),
    endRule: z.enum(['fixed_date', 'work_complete']),
    date: day.optional(),
    releaseIds: z.array(idNum).min(1).max(MAX_MEMBERS),
  })
  .strict();

export const updateBody = z
  .object({
    name: name.optional(),
    description: description.optional(),
    /** A fixed date comes only from a move; this clears the day and moves nothing. */
    endRule: z.literal('work_complete').optional(),
    version: z.number().int().positive(),
  })
  .strict();

export const listQuery = z
  .object({
    state: z.enum(['upcoming', 'shipped']).default('upcoming'),
    cursor: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}_[1-9]\d{0,9}$/)
      .optional(),
  })
  .strict();

export const moveQuery = z.object({ date: day }).strict();
export const moveBody = z.object({ date: day, version: z.number().int().positive() }).strict();
export const memberBody = z.object({ releaseId: idNum }).strict();

/** A plan's Releases tab takes only the track filter; the others do not apply to a release. */
export const planReleasesQuery = z
  .object({
    track: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_]{0,29}$/)
      .optional(),
  })
  .strict();

export type CrossTrackState = 'empty' | 'shipped' | 'overdue' | 'ready' | 'upcoming';

/**
 * The state, computed on each read over all its work, hidden work too, so it says the same to
 * everyone. `releases` and `shipped` count linked releases that are neither archived nor in the
 * trash, and whose track is not archived; `tickets` and `open` their target tickets. Nothing ships
 * by itself: `ready` is an announcement.
 */
export function crossTrackState(input: {
  endRule: CrossTrackEndRule;
  date: string | null;
  today: string;
  releases: number;
  shipped: number;
  tickets: number;
  open: number;
}): CrossTrackState {
  const { endRule, date, today, releases, shipped, tickets, open } = input;
  if (releases === 0) return 'empty';
  if (shipped === releases) return 'shipped';
  if (endRule === 'fixed_date' && date !== null && date < today) return 'overdue';
  if (tickets > 0 && open === 0) return 'ready';
  return 'upcoming';
}

export type MoveReason =
  | 'no_permission'
  | 'shipped'
  | 'archived'
  | 'track_archived'
  | 'start_after_date';

/** What a move to `date` does to a linked release the mover sees. */
export type MoveOutcome =
  | { outcome: 'moves' }
  | { outcome: 'same' }
  | { outcome: 'stays'; reason: MoveReason };

/**
 * A release moves only if the mover could move it through `PATCH /releases/:id`: upcoming, not
 * archived, its track not archived, the mover administers that track, and its start date not after
 * the new day. Otherwise it stays, with the reason.
 */
export function moveOutcome(
  release: {
    releaseDate: string | null;
    startDate: string | null;
    shipped: boolean;
    archived: boolean;
    trackArchived: boolean;
    mayChange: boolean;
  },
  date: string,
): MoveOutcome {
  const stays = (reason: MoveReason): MoveOutcome => ({ outcome: 'stays', reason });
  if (release.trackArchived) return stays('track_archived');
  if (!release.mayChange) return stays('no_permission');
  if (release.archived) return stays('archived');
  if (release.shipped) return stays('shipped');
  if (release.releaseDate === date) return { outcome: 'same' };
  if (release.startDate !== null && release.startDate > date) return stays('start_after_date');
  return { outcome: 'moves' };
}
