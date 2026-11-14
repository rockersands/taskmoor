import { useDayText } from '../i18n/days';
import { useT } from '../i18n/I18nProvider';
import type { PlanCriticalPath } from '../plans/client';
import { routeHref } from '../routing/router';
import { EmptyState } from '../shell/EmptyState';

export interface CriticalPathListProps {
  /** The path, or null while it is read. */
  path: PlanCriticalPath | null;
  /** Reading it failed. */
  failed?: boolean;
  /** The id of its heading, which takes focus when a control moves there. */
  headingId: string;
}

const ticketHref = (key: string) => routeHref(`#/tickets/${encodeURIComponent(key)}`);

/**
 * The critical path in words (PLN-011; ADR-122 stage 9): what the Timeline's outlines show, for
 * the keyboard, screen readers and phones. A sentence first (how many tickets are on the path and
 * when the plan ends), that it covers the tickets the plan shows this viewer, then each chain from
 * its first ticket to its last: "SPA-3 starts 1 Dec, ends 4 Dec, then SPA-7 starts 5 Dec, ends 12
 * Feb, the plan's end." Tickets in a circle or without dates are only counted, never named, and so
 * is work outside the plan or not shown to the viewer that a ticket waits for (the ticket waiting
 * is named where it is on the path). With a plan end and no chain, the sentence and its notes
 * still say why.
 */
export function CriticalPathList({ path, failed = false, headingId }: CriticalPathListProps) {
  const t = useT();
  const day = useDayText();

  const body = () => {
    if (failed) {
      return (
        <p className="board-problem" role="alert">
          {t('critical.failed')}
        </p>
      );
    }
    if (!path) return <p className="report-loading">{t('critical.loading')}</p>;
    // No open ticket has dates. With a plan end and no chain (the latest work is in a circle, say),
    // the sentence and its notes still say why.
    if (path.planEnd === null) return <EmptyState compact title={t('critical.noPath')} />;
    const planEnd = path.planEnd;
    const notes = [
      ...(path.more > 0 ? [t('critical.more', { count: path.more })] : []),
      ...(path.counts.cycles > 0 ? [t('critical.cycles', { count: path.counts.cycles })] : []),
      ...(path.counts.waitsElsewhere > 0
        ? [t('critical.waitsElsewhere', { count: path.counts.waitsElsewhere })]
        : []),
      ...(path.counts.undated > 0 ? [t('critical.undated', { count: path.counts.undated })] : []),
    ];
    return (
      <>
        <p className="critical-path-summary">
          {t('critical.summary', { count: path.counts.critical, end: day(planEnd) })}
        </p>
        <p className="board-hint">{t('critical.covers')}</p>
        {notes.map((note) => (
          <p key={note} className="board-hint">
            {note}
          </p>
        ))}
        {path.chains.length > 0 && (
          <ol className="dependency-entries critical-chains">
            {path.chains.map((chain, index) => {
              const first = chain.tickets[0]?.id ?? index;
              return (
                <li key={first} className="dependency-entry">
                  <p className="dependency-by">{t('critical.chain', { number: index + 1 })}</p>
                  <ol className="critical-steps">
                    {chain.tickets.map((ticket, at) => {
                      const ends = at === chain.tickets.length - 1 && ticket.end === planEnd;
                      const words = { start: day(ticket.start), end: day(ticket.end) };
                      const step =
                        at === 0
                          ? t(ends ? 'critical.step.firstEnd' : 'critical.step.first', words)
                          : t(ends ? 'critical.step.thenEnd' : 'critical.step.then', words);
                      return (
                        <li key={ticket.id}>
                          <a href={ticketHref(ticket.key)}>
                            <span className="dependency-key">{ticket.key}</span>{' '}
                            <span className="dependency-summary">{ticket.summary}</span>
                          </a>{' '}
                          {step}
                          {ticket.slack < 0 && (
                            <>
                              {' '}
                              <span className="dependency-state is-late">
                                {t('critical.step.late', { days: -ticket.slack })}
                              </span>
                            </>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                </li>
              );
            })}
          </ol>
        )}
      </>
    );
  };

  return (
    <section className="glass-card dependency-list critical-path-list" aria-labelledby={headingId}>
      <h2 id={headingId} tabIndex={-1}>
        {t('critical.title')}
      </h2>
      {body()}
    </section>
  );
}
