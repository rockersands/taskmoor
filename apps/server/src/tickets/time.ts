import type { Database } from '@taskmoor/db';
import type { Kysely, Transaction } from 'kysely';
import {
  type DisplayFormat,
  type DurationProblem,
  type DurationUnit,
  MAX_DURATION_SECONDS,
  parseDuration,
} from './duration';

/**
 * The workspace's time tracking settings and the rules for estimates (M1-019; TIM-001; spec
 * 03 section 3). The routes are `routes/time.ts`; ticket create and edit take estimates
 * through `durationValue`.
 */
type Db = Kysely<Database> | Transaction<Database>;

export interface TimeSettings {
  enabled: boolean;
  hoursPerDay: number;
  daysPerWeek: number;
  displayFormat: DisplayFormat;
  defaultUnit: DurationUnit;
  copyTransitionComments: boolean;
}

export const DEFAULT_TIME_SETTINGS: TimeSettings = {
  enabled: true,
  hoursPerDay: 8,
  daysPerWeek: 5,
  displayFormat: 'pretty',
  defaultUnit: 'minute',
  copyTransitionComments: false,
};

export async function timeSettings(db: Db, workspaceId: number): Promise<TimeSettings> {
  const row = await db
    .selectFrom('time_tracking_setting')
    .selectAll()
    .where('workspace_id', '=', workspaceId)
    .executeTakeFirst();
  if (!row) return DEFAULT_TIME_SETTINGS;
  return {
    enabled: row.enabled,
    hoursPerDay: Number(row.hours_per_day),
    daysPerWeek: Number(row.days_per_week),
    displayFormat: row.display_format,
    defaultUnit: row.default_unit,
    copyTransitionComments: row.copy_transition_comments,
  };
}

/** A duration given as seconds or as text such as "1w 2d"; null clears an estimate. */
export function durationValue(
  input: string | number | null,
  settings: TimeSettings,
): { ok: true; seconds: number | null } | { ok: false; problem: DurationProblem } {
  if (input === null) return { ok: true, seconds: null };
  if (typeof input === 'number') {
    if (!Number.isInteger(input) || input < 0) return { ok: false, problem: 'invalid' };
    if (input > MAX_DURATION_SECONDS) return { ok: false, problem: 'too_long' };
    return { ok: true, seconds: input };
  }
  return parseDuration(input, settings, settings.defaultUnit);
}

/** How a time entry moves the remaining estimate (spec 03 section 3). */
export type RemainingMode =
  | { mode: 'auto' }
  | { mode: 'leave' }
  | { mode: 'set'; seconds: number }
  | { mode: 'reduce'; seconds: number };

/**
 * The remaining estimate after time is recorded (`delta` > 0), changed or removed (`delta`
 * < 0): "auto" reduces it by the time added and gives back time removed, never below zero;
 * no estimate stays none.
 */
export function nextRemaining(
  remaining: number | null,
  delta: number,
  how: RemainingMode,
): number | null {
  switch (how.mode) {
    case 'leave':
      return remaining;
    case 'set':
      return how.seconds;
    case 'reduce':
      return remaining === null ? null : Math.max(0, remaining - how.seconds);
    case 'auto':
      return remaining === null ? null : Math.max(0, remaining - delta);
  }
}
