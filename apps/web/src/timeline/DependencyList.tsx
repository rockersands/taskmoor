import { useState } from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { routeHref } from '../routing/router';
import { EmptyState } from '../shell/EmptyState';
import type { TimelineItem } from './client';
import { type Blocked, barOf, type DependencyState } from './dependencies';

export interface DependencyListProps {
  /** Each blocked ticket's blockers (`dependenciesOf`), in the timeline's order. */
  dependencies: ReadonlyMap<number, Blocked>;
  /** The id of its heading, which takes focus when a control moves there. */
  headingId: string;
  /** The link types a plan counts beside blocking ones (PLN-013), to say a link's phrase. */
  linkTypes?: readonly { id: number; outward: string }[];
}

/** How many tickets the list shows at first, and adds at each "Show more". */
const STEP = 100;

const LABELS: Record<DependencyState, MessageId> = {
  late: 'dependencies.state.late',
  onTime: 'dependencies.state.onTime',
  closed: 'dependencies.state.closed',
  undated: 'dependencies.state.undated',
};

const ticketHref = (key: string) => routeHref(`#/tickets/${encodeURIComponent(key)}`);

/**
 * A timeline's dependencies as a list (PLN-006; ADR-122): what the lines and badges show, for the
 * keyboard and screen readers, and for anyone who would rather read than follow lines. Each
 * blocked ticket, in the timeline's order, with its blockers: the listed ones with whether each is
 * late, in words beside the colour, and the others only counted, never named, since some may be
 * hidden from the viewer. "Only late ones" narrows it to the tickets with a late blocker; long
 * lists show 100 tickets at a time.
 */
export function DependencyList({ dependencies, headingId, linkTypes = [] }: DependencyListProps) {
  const t = useT();
  const intl = useIntl();
  const [onlyLate, setOnlyLate] = useState(false);
  const [shown, setShown] = useState(STEP);
  const all = [...dependencies.values()];
  const withLate = all.filter((b) => b.late > 0);
  const lateCount = withLate.reduce((sum, b) => sum + b.late, 0);
  // The button goes once nothing is late (a move, a filter, someone else's edit), so the narrowing
  // goes with it: the list never stands empty with nothing to undo it, and comes back unpressed.
  if (onlyLate && withLate.length === 0) {
    setOnlyLate(false);
    setShown(STEP);
  }
  const entries = onlyLate && withLate.length > 0 ? withLate : all;
  // A chosen link type's phrase, so a "precedes" link never reads as "blocks".
  const phrase = (linkTypeId: number | undefined) => {
    const type = linkTypes.find((l) => l.id === linkTypeId);
    return type && type.outward.trim().toLowerCase() !== 'blocks' ? type.outward : null;
  };

  const dayText = (day: number) =>
    intl.formatDate(new Date(day * 86_400_000), {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });

  /** Why a dependency stands as it does, with the days that decide it. */
  const detail = (blocker: TimelineItem, blocked: TimelineItem, state: DependencyState) => {
    const a = barOf(blocker);
    const b = barOf(blocked);
    if (state === 'closed') return t('dependencies.detail.closed', { key: blocked.key });
    if (state === 'undated' || !a || !b) return t('dependencies.detail.undated');
    if (blocked.status.stage === 'closed') {
      return t('dependencies.detail.blockedClosed', { key: blocked.key });
    }
    const days = { due: dayText(a.due), key: blocked.key, start: dayText(b.start) };
    return state === 'late'
      ? t('dependencies.detail.late', days)
      : t('dependencies.detail.onTime', days);
  };

  return (
    <section className="glass-card dependency-list" aria-labelledby={headingId}>
      <h2 id={headingId} tabIndex={-1}>
        {t('dependencies.title')}
      </h2>
      {all.length === 0 ? (
        <EmptyState compact title={t('dependencies.none')} />
      ) : (
        <>
          <div className="dependency-tools">
            <p className="board-hint">
              {t('dependencies.summary', { tickets: all.length, late: lateCount })}
            </p>
            {withLate.length > 0 && (
              <button
                type="button"
                className="filter-chip"
                aria-pressed={onlyLate}
                onClick={() => {
                  setOnlyLate((v) => !v);
                  setShown(STEP);
                }}
              >
                {t('dependencies.onlyLate')}
              </button>
            )}
          </div>
          <ul className="dependency-entries">
            {entries.slice(0, shown).map(({ item, blockers, outside, unlisted, late }) => (
              <li key={item.id} className={`dependency-entry${late > 0 ? ' is-late' : ''}`}>
                <p className="dependency-ticket">
                  <a href={ticketHref(item.key)}>
                    <span className="dependency-key">{item.key}</span>{' '}
                    <span className="dependency-summary">{item.summary}</span>
                  </a>
                </p>
                <p className="dependency-by">{t('dependencies.blockedBy')}</p>
                <ul className="dependency-blockers">
                  {blockers.map(({ item: blocker, state, linkTypeId, sameSprint }) => {
                    const via = phrase(linkTypeId);
                    return (
                      <li key={blocker.id} data-state={state}>
                        <a href={ticketHref(blocker.key)}>
                          <span className="dependency-key">{blocker.key}</span>{' '}
                          <span className="dependency-summary">{blocker.summary}</span>
                        </a>{' '}
                        {via && (
                          <span className="dependency-via">
                            {t('dependencies.via', { phrase: via })}{' '}
                          </span>
                        )}
                        <span className={`dependency-state is-${state}`}>{t(LABELS[state])}</span>{' '}
                        {detail(blocker, item, state)}
                        {sameSprint && (
                          <>
                            {' '}
                            <span className="dependency-state is-same-sprint">
                              {t('dependencies.sameSprint')}
                            </span>
                          </>
                        )}
                      </li>
                    );
                  })}
                  {outside > 0 && (
                    <li data-state="outside">
                      {t('dependencies.outsideCount', { count: outside })}
                    </li>
                  )}
                  {unlisted > 0 && (
                    <li data-state="unlisted">
                      {t('dependencies.unlistedCount', { count: unlisted })}
                    </li>
                  )}
                </ul>
              </li>
            ))}
          </ul>
          {entries.length > shown && (
            <button
              type="button"
              className="button-secondary"
              onClick={() => setShown((n) => n + STEP)}
            >
              {t('dependencies.more', { count: Math.min(STEP, entries.length - shown) })}
            </button>
          )}
        </>
      )}
    </section>
  );
}
