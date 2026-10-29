import { z } from 'zod';

/**
 * Sprints on a Scrum board (M1-044; AGL-007, AGL-010, AGL-011; spec 01b sections 3.1 and 3.2;
 * ADR-054).
 *
 * - **Sprint settings** sit on the board (`board.sprint_settings`): the estimation statistic
 *   (ticket count, the original time estimate, or a number field such as story points), the
 *   time tracking (none, or remaining estimate and time spent) and whether several sprints may
 *   be active at once (parallel sprints, AGL-011).
 * - **States** future, active, closed. Future sprints are created, edited, reordered, started
 *   and deleted; an active one is edited and completed; a closed one is renamed or deleted
 *   (it then leaves reports, AGL-010 (3)).
 * - **Completing** moves the board's unfinished tickets to the backlog, a future sprint or a
 *   new sprint; tickets of the sprint that the completing board does not show go to the
 *   backlog (a shared sprint, AGL-011 (2)). Done means a status of the rightmost column.
 */
const MAX_INT = 2_147_483_647;
const id = z.number().int().positive().max(MAX_INT);
const name = z.string().trim().min(1).max(255);
const goal = z.string().max(10_000);
const when = z.string().datetime({ offset: true });

export const ESTIMATION_STATISTICS = ['ticketCount', 'originalEstimate', 'field'] as const;
export const TIME_TRACKING_MODES = ['none', 'remainingEstimate'] as const;

export const sprintSettingsInput = z
  .object({
    estimation: z
      .object({
        statistic: z.enum(ESTIMATION_STATISTICS),
        /** The number field read as the estimate when `statistic` is `field`. */
        fieldId: id.optional(),
      })
      .strict()
      .refine((e) => (e.statistic === 'field') === (e.fieldId !== undefined), {
        message: 'fieldId with field, only',
        path: ['fieldId'],
      }),
    timeTracking: z.enum(TIME_TRACKING_MODES),
    parallelSprints: z.boolean(),
  })
  .strict();
export type SprintSettings = z.infer<typeof sprintSettingsInput>;

export const DEFAULT_SPRINT_SETTINGS: SprintSettings = {
  estimation: { statistic: 'originalEstimate' },
  timeTracking: 'remainingEstimate',
  parallelSprints: false,
};

/** Stored settings, read leniently: anything unreadable falls back to the defaults. */
export function readSprintSettings(value: unknown): SprintSettings {
  const parsed = sprintSettingsInput.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_SPRINT_SETTINGS;
}

export const createSprintBody = z
  .object({
    name: name.optional(),
    goal: goal.optional(),
    startAt: when.nullable().optional(),
    endAt: when.nullable().optional(),
  })
  .strict();

export const updateSprintBody = z
  .object({
    version: z.number().int().positive().optional(),
    name: name.optional(),
    goal: goal.optional(),
    startAt: when.nullable().optional(),
    endAt: when.nullable().optional(),
  })
  .strict();

export const rankSprintBody = z
  .object({ before: id.optional(), after: id.optional() })
  .strict()
  .refine((b) => (b.before === undefined) !== (b.after === undefined), 'before or after');

export const startSprintBody = z
  .object({
    name: name.optional(),
    goal: goal.optional(),
    /** Defaults to now. */
    startAt: when.optional(),
    /** Required unless the sprint has an end date already. */
    endAt: when.optional(),
  })
  .strict();

export const completeSprintBody = z
  .object({
    /** Where unfinished tickets go: the backlog, a future sprint of the board, or a new one. */
    moveTo: z.discriminatedUnion('type', [
      z.object({ type: z.literal('backlog') }).strict(),
      z.object({ type: z.literal('sprint'), sprintId: id }).strict(),
      z.object({ type: z.literal('new'), name: name.optional() }).strict(),
    ]),
  })
  .strict();

const ticketRef = z.union([id, z.string().min(1).max(100)]);
export const MAX_TICKETS_PER_CHANGE = 500;
export const sprintTicketsBody = z
  .object({ tickets: z.array(ticketRef).min(1).max(MAX_TICKETS_PER_CHANGE) })
  .strict();

/** Checks the dates of a sprint: an end after its start. */
export function datesInOrder(startAt: Date | null, endAt: Date | null): boolean {
  return startAt === null || endAt === null || endAt.getTime() > startAt.getTime();
}
