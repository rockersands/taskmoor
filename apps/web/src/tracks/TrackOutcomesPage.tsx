import { useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';
import { EmptyState } from '../shell/EmptyState';
import { OutcomeIcon } from '../shell/icons';
import { PageHeader } from '../shell/PageHeader';
import { typeName } from '../shell/seededNames';
import { TypeIcon } from '../shell/TicketIcons';
import { ProgressBar, percentOf } from '../tickets/tools/Progress';
import { type TrackClient, type TrackOutcome, type TrackOutcomes, trackClient } from './client';

export interface TrackOutcomesPageProps {
  trackKey: string;
  client?: TrackClient;
}

/**
 * A track's outcomes and how far along each is (AGL-024): the closed tickets under it of all those
 * the person may see, as a bar and in numbers, with its status and dates. Open ones come first, in
 * their planned order; a page holds 100 and the next comes on asking. Each leads to its ticket,
 * which opens over the page. The same on Scrum and Kanban tracks: it only lists.
 */
export function TrackOutcomesPage({ trackKey, client = trackClient }: TrackOutcomesPageProps) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const [read, setRead] = useState<TrackOutcomes | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);

  useEffect(() => {
    let live = true;
    client.outcomes(trackKey).then(
      (found) => {
        if (live) setRead(found);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [client, trackKey]);

  const more = async () => {
    if (!read?.next || busy) return;
    setBusy(true);
    setMoreFailed(false);
    try {
      const page = await client.outcomes(trackKey, read.next);
      setRead({ ...page, outcomes: [...read.outcomes, ...page.outcomes] });
    } catch {
      setMoreFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const day = (date: string) =>
    intl.formatDate(new Date(`${date}T00:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' });
  const types = read?.outcomeTypes ?? [];

  return (
    <section aria-labelledby={`${id}-title`} className="track-outcomes">
      <PageHeader
        titleId={`${id}-title`}
        title={t('track.outcomes.title')}
        purpose={t('track.outcomes.purpose')}
      />
      {failed && (
        <p className="form-error" role="alert">
          {t('track.outcomes.failed')}
        </p>
      )}
      {!read && !failed && <p className="page-note">{t('boards.loading')}</p>}
      {read && read.outcomes.length === 0 && (
        <EmptyState
          icon={OutcomeIcon}
          title={t('track.outcomes.emptyTitle')}
          action={
            types.length > 0 && (
              <a className="button-secondary" href={routeHref('#/create')}>
                {t('track.outcomes.create')}
              </a>
            )
          }
        >
          {t('track.outcomes.empty')}{' '}
          {types.length > 0
            ? t('track.outcomes.howTo', {
                types: intl.formatList(
                  types.map((name) => typeName(t, name)),
                  { type: 'disjunction' },
                ),
              })
            : t('track.outcomes.howToNone')}
        </EmptyState>
      )}
      {read && read.outcomes.length > 0 && (
        <ul className="glass-card track-outcomes-list" aria-labelledby={`${id}-title`}>
          {read.outcomes.map((outcome) => (
            <OutcomeRow key={outcome.id} outcome={outcome} day={day} />
          ))}
        </ul>
      )}
      {moreFailed && (
        <p className="form-error" role="alert">
          {t('track.outcomes.moreFailed')}
        </p>
      )}
      {read?.next && (
        <button
          type="button"
          className="button-secondary track-outcomes-more"
          aria-disabled={busy || undefined}
          onClick={() => void more()}
        >
          {t('track.outcomes.more')}
        </button>
      )}
    </section>
  );
}

function OutcomeRow({ outcome, day }: { outcome: TrackOutcome; day: (date: string) => string }) {
  const t = useT();
  const { closed, total } = outcome.progress;
  const percent = percentOf(closed, total);
  return (
    <li className="track-outcome" data-stage={outcome.status.stage}>
      <div className="track-outcome-head">
        <TypeIcon name={outcome.type} />
        <a href={routeHref(`#/tickets/${encodeURIComponent(outcome.key)}`)}>
          <span className="track-outcome-key">{outcome.key}</span> {outcome.summary}
        </a>
        <span className={`stage-badge stage-${outcome.status.stage}`}>{outcome.status.name}</span>
      </div>
      <div className="track-outcome-progress">
        {total > 0 ? (
          <>
            <ProgressBar
              percent={percent}
              label={t('track.outcomes.progress', { closed, total, percent })}
            />
            <span aria-hidden="true">{t('track.outcomes.count', { closed, total })}</span>
          </>
        ) : (
          <span>{t('track.outcomes.noTickets')}</span>
        )}
      </div>
      {(outcome.startDate || outcome.dueDate) && (
        <p className="track-outcome-dates">
          {outcome.startDate && t('track.outcomes.start', { date: day(outcome.startDate) })}
          {outcome.startDate && outcome.dueDate && ' · '}
          {outcome.dueDate && t('track.outcomes.due', { date: day(outcome.dueDate) })}
        </p>
      )}
    </li>
  );
}
