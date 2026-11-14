import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import type { ScheduleArgs, ScheduleReason, ScheduleWarningKind } from './scenarioClient';
import {
  SCHEDULE_REASON_WORDS,
  SCHEDULE_WARNING_WORDS,
  scheduleLookup,
  useScheduleWords,
} from './scheduleWords';

/** Args as the engine gives them for each reason and warning (`apps/server/src/plans/scheduler.ts`). */
const REASON_ARGS: Record<ScheduleReason, ScheduleArgs> = {
  fits: {
    teamId: 1,
    periodStart: '2026-12-01',
    periodEnd: '2026-12-14',
    free: 8,
    capacity: 20,
    before: 4,
  },
  after_blocker: { blockerId: 10, blockerEnd: '2026-12-08' },
  after_higher_ranked: { teamId: 1, periodStart: '2026-12-15' },
  first_for_blocked: { ticketId: 3 },
  already: {},
  person_draft: {},
  may_not_schedule: {},
  kept_by_query: {},
  in_progress: {},
  in_sprint: {},
  no_estimate: {},
  no_assignee: {},
  no_team: { userId: 7 },
  no_capacity: { teamIds: [3] },
  too_big: { teamId: 1, capacity: 20 },
  cycle: { ticketIds: [3, 4], size: 3 },
  hidden_blocker: {},
  blocker_undated: { blockerId: 10 },
  blocker_not_placed: { blockerId: 10 },
  no_room: { teamId: 1, until: '2027-02-08' },
};
const WARNING_ARGS: Record<ScheduleWarningKind, ScheduleArgs> = {
  after_release: { releaseId: 21, releaseDate: '2026-12-01', days: 9 },
  late_against_kept: { ticketIds: [3], count: 1 },
  over_where_kept: { userId: 7, periodStart: '2026-12-01' },
};

const NAMES = scheduleLookup(
  {
    tickets: [
      { id: 3, key: 'SPA-3', outcome: 'placed', reason: 'fits', args: {}, warnings: [] },
      { id: 4, key: 'SPA-4', outcome: 'placed', reason: 'fits', args: {}, warnings: [] },
    ],
    names: {
      teams: [],
      people: [{ id: 7, name: 'Ana Ruiz' }],
      releases: [{ id: 21, name: '2.1' }],
      tickets: [{ id: 10, key: 'SPA-10' }],
    },
  },
  {
    teams: [
      { id: 1, name: 'Atlas' },
      { id: 3, name: 'Cirrus' },
    ],
  },
);

function words(locale: Locale, names = NAMES) {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(I18nProvider, { locale, children });
  return renderHook(() => useScheduleWords('points', names), { wrapper }).result.current;
}

const entry = (reason: ScheduleReason, args: ScheduleArgs = REASON_ARGS[reason]) => ({
  key: 'OPS-7',
  reason,
  args,
});

describe('the words of an auto-schedule run (PLN-004)', () => {
  it('[PLN-004] says every reason and warning in both catalogues, with every value filled in', () => {
    for (const locale of ['en', 'es'] as const) {
      const said = words(locale);
      for (const reason of Object.keys(SCHEDULE_REASON_WORDS) as ScheduleReason[]) {
        const text = said.reason(entry(reason));
        expect(text, `${locale} ${reason}`).not.toMatch(/[{}]|undefined|NaN/);
        expect(text, `${locale} ${reason}`).not.toBe(
          said.reason({ ...entry(reason), reason: 'x' as ScheduleReason }),
        );
      }
      for (const kind of Object.keys(SCHEDULE_WARNING_WORDS) as ScheduleWarningKind[]) {
        const text = said.warning({ kind, args: WARNING_ARGS[kind] });
        expect(text, `${locale} ${kind}`).not.toMatch(/[{}]|undefined|NaN/);
        expect(text, `${locale} ${kind}`).toMatch(/^(Note|Nota):/);
      }
    }
  });

  it('[PLN-004] names teams, people, tickets and releases, as the ADR words them', () => {
    const said = words('en');
    expect(said.reason(entry('fits'))).toBe(
      'Placed in Dec 1 to Dec 14: Atlas had 8 of 20 points free after 4 higher-ranked tickets.',
    );
    expect(said.reason(entry('fits', { ...REASON_ARGS.fits, before: 0 }))).toBe(
      'Placed in Dec 1 to Dec 14: Atlas had 8 of 20 points free.',
    );
    expect(said.reason(entry('after_blocker'))).toBe(
      'Starts Dec 9, the day after SPA-10 ends; SPA-10 blocks it.',
    );
    expect(said.reason(entry('first_for_blocked'))).toBe('Placed early because it blocks SPA-3.');
    // Anyone's draft, not only the runner's: scenarios are shared.
    expect(said.reason(entry('person_draft'))).toBe(
      'Kept: a person drafted its days in this scenario.',
    );
    expect(said.reason(entry('may_not_schedule'))).toBe(
      'Kept: you may not schedule tickets in OPS.',
    );
    expect(said.reason(entry('no_estimate'))).toBe('Not placed: no estimate.');
    expect(said.reason(entry('no_team'))).toBe(
      'Not placed: Ana Ruiz is in none of the plan’s teams.',
    );
    expect(said.reason(entry('no_capacity'))).toBe('Not placed: Cirrus has no capacity set.');
    expect(said.reason(entry('too_big'))).toBe(
      'Not placed: bigger than Atlas’s 20 points in any period.',
    );
    expect(said.reason(entry('cycle'))).toBe('Not placed: in a circle with SPA-3 and SPA-4.');
    expect(said.reason(entry('cycle', { ticketIds: [3], size: 4 }))).toBe(
      'Not placed: in a circle with SPA-3 and 2 more.',
    );
    expect(said.reason(entry('hidden_blocker'))).toBe(
      'Not placed: waits on a ticket this plan does not show you.',
    );
    expect(said.reason(entry('no_room'))).toBe('Not placed: no room for Atlas up to Feb 8.');
    expect(said.reason(entry('no_room', { until: '2027-02-08' }))).toBe(
      'Not placed: no room up to Feb 8.',
    );
    expect(said.warning({ kind: 'after_release', args: WARNING_ARGS.after_release })).toBe(
      'Note: due 9 days after its release 2.1 (Dec 1).',
    );
    expect(
      said.why({
        ...entry('fits'),
        warnings: [{ kind: 'after_release', args: WARNING_ARGS.after_release }],
      }),
    ).toBe(
      'Placed in Dec 1 to Dec 14: Atlas had 8 of 20 points free after 4 higher-ranked tickets. Note: due 9 days after its release 2.1 (Dec 1).',
    );
  });

  it('[PLN-004] [QRY-008] says an id it cannot name without its name, never as a number', () => {
    const said = words('en', scheduleLookup(null));
    expect(said.reason(entry('after_blocker'))).toBe(
      'Starts Dec 9, the day after another ticket ends; another ticket blocks it.',
    );
    expect(said.reason(entry('fits'))).toMatch(/: a team had 8 of 20 points free/);
    expect(said.warning({ kind: 'after_release', args: WARNING_ARGS.after_release })).toBe(
      'Note: due 9 days after its target release (Dec 1).',
    );
    for (const reason of Object.keys(SCHEDULE_REASON_WORDS) as ScheduleReason[]) {
      // The blocker's id is 10 and the release's 21: neither shows, nor any key.
      expect(said.reason(entry(reason))).not.toMatch(/\b(10|21)\b|SPA-/);
    }
  });

  it('[PLN-004] says amounts in hours on a plan counted in hours', () => {
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(I18nProvider, { locale: 'en', children });
    const said = renderHook(() => useScheduleWords('hours', NAMES), { wrapper }).result.current;
    expect(said.reason(entry('too_big', { teamId: 1, capacity: 7.5 }))).toBe(
      'Not placed: bigger than Atlas’s 7.5 hours in any period.',
    );
  });
});
