import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { trackKeyOf } from './changeWords';
import type { CapacityUnit } from './client';
import type {
  ScheduleArgs,
  ScheduleEntry,
  ScheduleOverLeft,
  ScheduleReason,
  ScheduleResult,
  ScheduleWarning,
  ScheduleWarningKind,
} from './scenarioClient';

/**
 * The names the words put to a run's ids, from its answer and what the page already holds (the
 * plan's teams, the people its tickets are assigned to). An id it cannot name is said without a
 * name ("a team", "another ticket"), never as a number.
 */
export interface ScheduleLookup {
  team: (id: number) => string | undefined;
  person: (id: number) => string | undefined;
  ticket: (id: number) => string | undefined;
  release: (id: number) => string | undefined;
}

/** The lookup for a run's answer: its names, its listed tickets' keys, then the page's own. */
export function scheduleLookup(
  run: Pick<ScheduleResult, 'tickets' | 'names'> | null,
  page: {
    teams?: { id: number; name: string }[] | undefined;
    people?: { id: number; name: string }[] | undefined;
  } = {},
): ScheduleLookup {
  const named = (lists: ({ id: number; name: string }[] | undefined)[]) => {
    const map = new Map<number, string>();
    for (const list of lists) for (const x of list ?? []) if (!map.has(x.id)) map.set(x.id, x.name);
    return (id: number) => map.get(id);
  };
  const keys = new Map<number, string>();
  for (const x of run?.tickets ?? []) keys.set(x.id, x.key);
  for (const x of run?.names?.tickets ?? []) if (!keys.has(x.id)) keys.set(x.id, x.key);
  return {
    team: named([run?.names?.teams, page.teams]),
    person: named([run?.names?.people, page.people]),
    ticket: (id) => keys.get(id),
    release: named([run?.names?.releases]),
  };
}

/** Each reason's sentence. */
const REASONS: Record<ScheduleReason, MessageId> = {
  fits: 'schedule.reason.fits',
  after_blocker: 'schedule.reason.afterBlocker',
  after_higher_ranked: 'schedule.reason.afterHigherRanked',
  first_for_blocked: 'schedule.reason.firstForBlocked',
  already: 'schedule.reason.already',
  person_draft: 'schedule.reason.personDraft',
  may_not_schedule: 'schedule.reason.mayNotSchedule',
  kept_by_query: 'schedule.reason.keptByQuery',
  in_progress: 'schedule.reason.inProgress',
  in_sprint: 'schedule.reason.inSprint',
  no_estimate: 'schedule.reason.noEstimate',
  no_assignee: 'schedule.reason.noAssignee',
  no_team: 'schedule.reason.noTeam',
  no_capacity: 'schedule.reason.noCapacity',
  too_big: 'schedule.reason.tooBig',
  cycle: 'schedule.reason.cycle',
  hidden_blocker: 'schedule.reason.hiddenBlocker',
  blocker_undated: 'schedule.reason.blockerUndated',
  blocker_not_placed: 'schedule.reason.blockerNotPlaced',
  no_room: 'schedule.reason.noRoom',
  moved_off_over: 'schedule.evenOut.reason.movedOffOver',
  pushed_by_move: 'schedule.evenOut.reason.pushedByMove',
  still_over: 'schedule.evenOut.reason.stillOver',
  would_make_late: 'schedule.evenOut.reason.wouldMakeLate',
};
/** Each warning's sentence, after "Note:". */
const WARNINGS: Record<ScheduleWarningKind, MessageId> = {
  after_release: 'schedule.warning.afterRelease',
  late_against_kept: 'schedule.warning.lateAgainstKept',
  over_where_kept: 'schedule.warning.overWhereKept',
};

/** Every reason and warning a run gives, for the tests that hold both catalogues to them. */
export const SCHEDULE_REASON_WORDS = REASONS;
export const SCHEDULE_WARNING_WORDS = WARNINGS;

/**
 * The words of an auto-schedule run (ADR-122 stage 7): one sentence per reason and warning, for
 * example "Placed in 1 Dec to 14 Dec: Atlas had 8 of 20 points free after 4 higher-ranked
 * tickets." or "Not placed: waits on a ticket this plan does not show you.", and a warning after
 * "Note:", in words, never by colour alone. Evening out's reasons (ADR-122 stage 9) read "Moved 2
 * weeks later, from Dec 1–Dec 14 to Dec 15–Dec 28: Atlas was 6 points over." and "Not moved:
 * moving it would make kept SPA-4 late.", and a cell left over "Atlas is 6 points over in Feb
 * 1–Feb 14: no later period of the run has room."
 */
export function useScheduleWords(unit: CapacityUnit, names: Partial<ScheduleLookup> = {}) {
  const t = useT();
  const intl = useIntl();

  const day = (text: unknown) =>
    typeof text === 'string'
      ? intl.formatDate(new Date(`${text}T00:00:00Z`), {
          day: 'numeric',
          month: 'short',
          timeZone: 'UTC',
        })
      : '';
  const dayAfter = (text: unknown) =>
    typeof text === 'string'
      ? intl.formatDate(new Date(Date.parse(`${text}T00:00:00Z`) + 86_400_000), {
          day: 'numeric',
          month: 'short',
          timeZone: 'UTC',
        })
      : '';
  const num = (value: unknown) => (typeof value === 'number' ? value : 0);
  /** An amount in the plan's unit: "20 points", "7.5 hours". */
  const amount = (value: unknown) =>
    t(unit === 'hours' ? 'plans.capacity.hours' : 'plans.capacity.points', { value: num(value) });
  const ticket = (id: unknown) =>
    (typeof id === 'number' ? names.ticket?.(id) : undefined) ?? t('schedule.name.ticket');
  /** The team or person a reason names. */
  const subject = (args: ScheduleArgs) => {
    if (typeof args.teamId === 'number') {
      return names.team?.(args.teamId) ?? t('schedule.name.team');
    }
    if (typeof args.userId === 'number') {
      return names.person?.(args.userId) ?? t('schedule.name.person');
    }
    return t('schedule.name.someone');
  };
  /** "2 weeks later" for whole weeks, else "3 days later". */
  const later = (value: unknown) => {
    const days = num(value);
    return days > 0 && days % 7 === 0
      ? t('schedule.evenOut.weeksLater', { count: days / 7 })
      : t('schedule.evenOut.daysLater', { count: days });
  };
  /** A period as its first and last day. */
  const span = (start: unknown, end: unknown) =>
    t('schedule.evenOut.span', { start: day(start), end: day(end) });
  /** Keys as a list, "SPA-3 and SPA-4", with how many more it does not name. */
  const tickets = (ids: unknown, total: number) => {
    const list = Array.isArray(ids) ? ids : [];
    const named = list.map((id) => ticket(id));
    const rest = total - named.length;
    if (rest > 0) named.push(t('schedule.name.more', { count: rest }));
    return intl.formatList(named, { type: 'conjunction' });
  };

  /** Why the run placed, kept or left this ticket where it is. */
  const reason = (entry: Pick<ScheduleEntry, 'key' | 'reason' | 'args'>) => {
    const { args } = entry;
    switch (entry.reason) {
      case 'fits':
        return t(num(args.before) > 0 ? 'schedule.reason.fitsAfter' : 'schedule.reason.fits', {
          start: day(args.periodStart),
          end: day(args.periodEnd),
          subject: subject(args),
          free: intl.formatNumber(num(args.free), { maximumFractionDigits: 2 }),
          capacity: amount(args.capacity),
          count: num(args.before),
        });
      case 'after_blocker':
        return t('schedule.reason.afterBlocker', {
          day: dayAfter(args.blockerEnd),
          blocker: ticket(args.blockerId),
        });
      case 'after_higher_ranked':
        return t('schedule.reason.afterHigherRanked', {
          start: day(args.periodStart),
          subject: subject(args),
        });
      case 'first_for_blocked':
        return t('schedule.reason.firstForBlocked', { ticket: ticket(args.ticketId) });
      case 'may_not_schedule':
        return t('schedule.reason.mayNotSchedule', { track: trackKeyOf(entry.key) });
      case 'no_team':
        return t('schedule.reason.noTeam', { person: subject(args) });
      case 'no_capacity': {
        const ids = Array.isArray(args.teamIds) ? args.teamIds : [];
        return t('schedule.reason.noCapacity', {
          teams: intl.formatList(
            ids.map((id) => names.team?.(id) ?? t('schedule.name.team')),
            { type: 'conjunction' },
          ),
          count: Math.max(1, ids.length),
        });
      }
      case 'too_big':
        return t('schedule.reason.tooBig', {
          subject: subject(args),
          capacity: amount(args.capacity),
        });
      case 'cycle': {
        const size = num(args.size);
        const ids = Array.isArray(args.ticketIds) ? args.ticketIds : [];
        return t('schedule.reason.cycle', {
          tickets: tickets(ids, Math.max(ids.length, size - 1)),
        });
      }
      case 'blocker_undated':
      case 'blocker_not_placed':
        return t(REASONS[entry.reason], { blocker: ticket(args.blockerId) });
      case 'no_room':
        return t(
          typeof args.teamId === 'number' || typeof args.userId === 'number'
            ? 'schedule.reason.noRoom'
            : 'schedule.reason.noRoomAnyone',
          { subject: subject(args), until: day(args.until) },
        );
      case 'moved_off_over':
        return t('schedule.evenOut.reason.movedOffOver', {
          later: later(args.days),
          from: span(args.fromPeriod, args.fromPeriodEnd),
          to: span(args.toPeriod, args.toPeriodEnd),
          subject: subject(args),
          over: amount(args.over),
        });
      case 'pushed_by_move':
        return t('schedule.evenOut.reason.pushedByMove', {
          later: later(args.days),
          blocker: ticket(args.blockerId),
        });
      case 'still_over':
        return t('schedule.evenOut.reason.stillOver', {
          subject: subject(args),
          until: day(args.until),
        });
      case 'would_make_late':
        return args.why === 'past_end'
          ? t('schedule.evenOut.reason.wouldPassEnd', {
              ticket: ticket(args.ticketId),
              until: day(args.until),
            })
          : t(
              args.why === 'kept'
                ? 'schedule.evenOut.reason.wouldMakeKeptLate'
                : 'schedule.evenOut.reason.wouldMakeLate',
              { ticket: ticket(args.ticketId) },
            );
      default: {
        // A reason this page does not know yet (a newer server) still says something.
        const id = REASONS[entry.reason] as MessageId | undefined;
        return id ? t(id) : t('schedule.reason.unknown');
      }
    }
  };

  /** A warning on a placed or not placed ticket, after "Note:". */
  const warning = (w: ScheduleWarning) => {
    const { args } = w;
    switch (w.kind) {
      case 'after_release': {
        const name =
          typeof args.releaseId === 'number' ? names.release?.(args.releaseId) : undefined;
        const words = { days: num(args.days), date: day(args.releaseDate) };
        return name
          ? t('schedule.warning.afterRelease', { ...words, release: name })
          : t('schedule.warning.afterTargetRelease', words);
      }
      case 'late_against_kept': {
        const count = num(args.count);
        return t('schedule.warning.lateAgainstKept', {
          tickets: tickets(args.ticketIds, count),
          count,
        });
      }
      case 'over_where_kept':
        return t('schedule.warning.overWhereKept', {
          subject: subject(args),
          start: day(args.periodStart),
        });
      default:
        return t('schedule.warning.unknown');
    }
  };

  /** A cell evening out left over capacity, and why. */
  const overLeft = (cell: ScheduleOverLeft) =>
    t(cell.onlyFixed ? 'schedule.evenOut.overLeftOnlyFixed' : 'schedule.evenOut.overLeftNoRoom', {
      subject: subject({
        ...(cell.teamId === undefined ? {} : { teamId: cell.teamId }),
        ...(cell.userId === undefined ? {} : { userId: cell.userId }),
      }),
      over: amount(cell.over),
      span: span(cell.periodStart, cell.periodEnd),
    });

  /** The reason and its notes, as one line: the change list's "why". */
  const why = (entry: Pick<ScheduleEntry, 'key' | 'reason' | 'args' | 'warnings'>) =>
    [reason(entry), ...entry.warnings.map(warning)].join(' ');

  return { reason, warning, why, day, overLeft };
}
