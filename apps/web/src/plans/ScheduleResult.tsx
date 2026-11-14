import { useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { routeHref } from '../routing/router';
import { EmptyState } from '../shell/EmptyState';
import type { CapacityUnit } from './client';
import type { ScheduleResult as RunAnswer, ScheduleEntry, ScheduleOutcome } from './scenarioClient';
import { type ScheduleLookup, useScheduleWords } from './scheduleWords';

/**
 * What a run was asked to keep and leave out, by name, for "Its choices": the answer echoes only
 * the first day and the periods, so the page that ran it keeps the rest.
 */
export interface ScheduleChoices {
  keep: { inProgress: boolean; inActiveSprint: boolean; query?: string | undefined };
  /**
   * Types and releases by name where the page knows them; else only how many (`typeCount`,
   * `releaseCount`), said as a number.
   */
  leaveOut: {
    types: string[];
    typeCount?: number | undefined;
    releases: string[];
    releaseCount?: number | undefined;
    query?: string | undefined;
  };
}

/** A run's answer as the page holds it while the plan stays open (ADR-122 stage 7, question 18). */
export interface HeldRun {
  result: RunAnswer;
  choices?: ScheduleChoices | undefined;
}

export interface ScheduleResultProps {
  run: HeldRun;
  unit: CapacityUnit;
  /** The names of the ids its reasons give. */
  names: Partial<ScheduleLookup>;
  /** The Scenarios tab comparing this scenario with main, or with Live. */
  compareHref: string;
  compareWith: 'main' | 'live';
  /** Opens the dialog again, for the plan's editors; none hides Run again. */
  onRunAgain?: (() => void) | undefined;
}

const FILTERS: { id: ScheduleOutcome; label: MessageId }[] = [
  { id: 'placed', label: 'schedule.result.placed' },
  { id: 'not_placed', label: 'schedule.result.notPlaced' },
  { id: 'kept', label: 'schedule.result.kept' },
];
/** An even-out run's filters (ADR-122 stage 9): what it moved, did not move, and kept. */
const EVEN_OUT_FILTERS: { id: ScheduleOutcome; label: MessageId }[] = [
  { id: 'placed', label: 'schedule.evenOut.moved' },
  { id: 'not_placed', label: 'schedule.evenOut.notMoved' },
  { id: 'kept', label: 'schedule.result.kept' },
];

/** Runs whose panel has had the focus once, so going back to the tab does not take it again. */
const focused = new WeakSet<RunAnswer>();

const total = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0);

/**
 * The result of an auto-schedule run (T-089f; PLN-004; ADR-122 stage 7), on top of the scenario's
 * Changes tab: what it placed, kept and did not place in words ("180 placed, 14 kept, 9 not placed,
 * 22 earlier proposals removed."), filters for Placed, Not placed and Kept with each ticket's key
 * and summary as a link and its reason in words, a link comparing the scenario with main (or with
 * Live), Run again for the plan's editors, and the run's choices in sentences. It takes the focus
 * once, when the run has answered. After a run that evened out load (ADR-122 stage 9) it says what
 * moved later ("3 tickets moved later, 1 kept, 2 not moved, …"), lists only the tickets moved,
 * not moved and kept, never those left where they are, and lists every cell still over capacity
 * with why.
 */
export function ScheduleResult({
  run,
  unit,
  names,
  compareHref,
  compareWith,
  onRunAgain,
}: ScheduleResultProps) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const words = useScheduleWords(unit, names);
  const { result, choices } = run;
  const { counts } = result;
  const evenOut = result.mode === 'even_out';
  const filters = evenOut ? EVEN_OUT_FILTERS : FILTERS;
  // A proposal left out of the write because it changed meanwhile stands nowhere: it is listed
  // apart, never among the placed, whose count leaves it out too. Evening out "places" every
  // ticket it leaves where it is: only those it moved are listed.
  const listed = (outcome: ScheduleOutcome) =>
    result.tickets.filter(
      (x) =>
        x.outcome === outcome &&
        !(outcome === 'placed' && x.changedMeanwhile) &&
        !(evenOut && x.reason === 'already'),
    );
  const meanwhile = result.tickets.filter((x) => x.changedMeanwhile);
  const sizes: Record<ScheduleOutcome, number> = {
    placed: evenOut ? listed('placed').length : counts.placed,
    not_placed: total(counts.notPlaced),
    kept: total(counts.kept),
  };
  const overLeft = result.overLeft ?? [];
  // The first filter with something in it, the tickets not placed first: they need a person.
  const [shown, setShown] = useState<ScheduleOutcome>(() =>
    sizes.not_placed > 0 ? 'not_placed' : sizes.placed > 0 || sizes.kept === 0 ? 'placed' : 'kept',
  );
  // "Its choices", a disclosure.
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (focused.has(result)) return;
    focused.add(result);
    heading.current?.focus();
  }, [result]);

  const rows = listed(shown);
  const leftOut = total(counts.leftOut);
  const peoples = counts.kept.person_draft ?? 0;
  const day = (text: string) =>
    intl.formatDate(new Date(`${text}T00:00:00Z`), {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    });
  const list = (items: string[]) => intl.formatList(items, { type: 'conjunction' });
  const filterLabel = (f: (typeof FILTERS)[number]) => t(f.label, { count: sizes[f.id] });
  const current = filters.find((f) => f.id === shown) ?? (filters[0] as (typeof FILTERS)[number]);

  const chosen = choices
    ? [
        t('schedule.choices.from', { day: day(result.from), count: result.periods.length }),
        choices.keep.inProgress && t('schedule.choices.inProgress'),
        choices.keep.inActiveSprint && t('schedule.choices.inSprint'),
        !choices.keep.inProgress && !choices.keep.inActiveSprint && t('schedule.choices.moveAll'),
        choices.keep.query && t('schedule.choices.keepQuery', { query: choices.keep.query }),
        choices.leaveOut.types.length > 0
          ? t('schedule.choices.types', { types: list(choices.leaveOut.types) })
          : (choices.leaveOut.typeCount ?? 0) > 0 &&
            t('schedule.choices.typeCount', { count: choices.leaveOut.typeCount ?? 0 }),
        choices.leaveOut.releases.length > 0
          ? t('schedule.choices.releases', { releases: list(choices.leaveOut.releases) })
          : (choices.leaveOut.releaseCount ?? 0) > 0 &&
            t('schedule.choices.releaseCount', { count: choices.leaveOut.releaseCount ?? 0 }),
        choices.leaveOut.query &&
          t('schedule.choices.leaveQuery', { query: choices.leaveOut.query }),
      ].filter((x): x is string => typeof x === 'string' && x !== '')
    : [t('schedule.choices.from', { day: day(result.from), count: result.periods.length })];

  const link = (entry: ScheduleEntry) => (
    <a href={routeHref(`#/tickets/${encodeURIComponent(entry.key)}`)}>
      <span className="scenario-key">{entry.key}</span>
      {entry.summary ? ` ${entry.summary}` : ''}
    </a>
  );
  const row = (entry: ScheduleEntry) => (
    <li key={entry.id}>
      {link(entry)}
      <span className="scenario-state">{words.reason(entry)}</span>
      {entry.warnings.map((w) => (
        <span key={w.kind} className="scenario-state is-changed">
          {words.warning(w)}
        </span>
      ))}
    </li>
  );

  return (
    <section className="glass-card scenario-item schedule-result" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} ref={heading} tabIndex={-1}>
        {t(evenOut ? 'schedule.evenOut.title' : 'schedule.result.title')}
      </h2>
      <p>
        {evenOut
          ? t('schedule.evenOut.counts', {
              moved: sizes.placed,
              kept: sizes.kept,
              notMoved: sizes.not_placed,
              withdrawn: counts.withdrawn,
            })
          : t('schedule.result.counts', {
              placed: counts.placed,
              kept: sizes.kept,
              notPlaced: sizes.not_placed,
              withdrawn: counts.withdrawn,
            })}
        {peoples > 0 && ` ${t('schedule.result.peopleDrafts', { count: peoples })}`}
      </p>
      <p className="scenario-meta">
        {t(result.created ? 'schedule.result.made' : 'schedule.result.in', {
          scenario: result.scenario.name,
        })}
        {leftOut > 0 && ` ${t('schedule.result.leftOut', { count: leftOut })}`}
        {counts.notShown > 0 && ` ${t('schedule.result.notShown', { count: counts.notShown })}`}
      </p>
      {counts.changedMeanwhile > 0 && (
        <p className="scenario-state is-changed">
          {t('schedule.result.changedMeanwhile', { count: counts.changedMeanwhile })}
        </p>
      )}
      {meanwhile.length > 0 && (
        <ul className="scenario-differing" aria-label={t('schedule.result.meanwhileList')}>
          {meanwhile.map((entry) => (
            <li key={entry.id}>{link(entry)}</li>
          ))}
        </ul>
      )}
      <fieldset className="filter-chips">
        <legend className="visually-hidden">{t('schedule.result.show')}</legend>
        {filters.map((f) => (
          <button
            key={f.id}
            type="button"
            className="filter-chip"
            aria-pressed={shown === f.id}
            onClick={() => setShown(f.id)}
          >
            {filterLabel(f)}
          </button>
        ))}
      </fieldset>
      {rows.length === 0 ? (
        <EmptyState compact title={t('schedule.result.none')} />
      ) : (
        <ul
          className="scenario-differing"
          aria-label={t('schedule.result.list', { which: filterLabel(current) })}
        >
          {rows.map(row)}
        </ul>
      )}
      {result.more > 0 && (
        <p className="scenario-meta">{t('schedule.result.more', { count: result.more })}</p>
      )}
      {evenOut && (
        <section aria-labelledby={`${id}-over`}>
          <h3 id={`${id}-over`}>{t('schedule.evenOut.overLeft')}</h3>
          {overLeft.length > 0 ? (
            <ul className="scenario-differing">
              {overLeft.map((cell) => (
                <li key={`${cell.teamId ?? ''}:${cell.userId ?? ''}:${cell.periodStart}`}>
                  <span className="scenario-state is-changed">{words.overLeft(cell)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="scenario-meta">{t('schedule.evenOut.allWithin')}</p>
          )}
        </section>
      )}
      <div className="scenario-item-actions">
        <a className="button-secondary" href={routeHref(compareHref)}>
          {t(
            compareWith === 'main' ? 'schedule.result.compareMain' : 'schedule.result.compareLive',
          )}
        </a>
        {onRunAgain && (
          <button type="button" className="button-secondary" onClick={onRunAgain}>
            {t('schedule.result.again')}
          </button>
        )}
        <button
          type="button"
          className="button-quiet"
          aria-expanded={open}
          aria-controls={`${id}-choices`}
          onClick={() => setOpen((was) => !was)}
        >
          {t('schedule.result.choices')}
        </button>
      </div>
      <p id={`${id}-choices`} hidden={!open}>
        {chosen.join(' ')}
      </p>
    </section>
  );
}
