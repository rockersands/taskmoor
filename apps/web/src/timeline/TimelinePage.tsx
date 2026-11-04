import { useCallback, useEffect, useId, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';
import { PageHeader } from '../shell/PageHeader';
import { useTicketChanges } from '../tickets/view/ticketChanges';
import { type Timeline, type TimelineClient, timelineClient } from './client';
import { TimelineView } from './TimelineView';

export interface TimelinePageProps {
  trackKey: string;
  client?: TimelineClient;
  /** Today, for the today line and the default range. */
  now?: () => Date;
}

/**
 * A track's timeline (M1-048; AGL-015): its tickets as bars over the calendar, drawn by
 * `TimelineView` (parents above children, roll-ups, dependencies, sprints and releases,
 * rescheduling by drag, keyboard or side panel). Every change is the ticket's own
 * (`PATCH /tickets/:key`), so its permission and history apply.
 */
export function TimelinePage({
  trackKey,
  client = timelineClient,
  now = () => new Date(),
}: TimelinePageProps) {
  const t = useT();
  const id = useId();
  const [data, setData] = useState<Timeline | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    client.timeline(trackKey).then(
      (d) => {
        setData(d);
        setFailed(false);
      },
      () => setFailed(true),
    );
  }, [client, trackKey]);
  useEffect(load, [load]);
  useTicketChanges(load);

  if (failed) {
    return (
      <section className="page page-full timeline-page" aria-labelledby={`${id}-title`}>
        <PageHeader
          titleId={`${id}-title`}
          title={t('track.section.timeline')}
          purpose={t('purpose.timeline')}
        />
        <p className="board-problem" role="alert">
          {t('timeline.notFound')}
        </p>
      </section>
    );
  }
  if (!data) return <p className="report-loading">{t('reports.loading')}</p>;

  return (
    <section className="page page-full timeline-page" aria-labelledby={`${id}-title`}>
      <PageHeader
        titleId={`${id}-title`}
        title={t('timeline.title', { name: data.track.name })}
        purpose={t('purpose.timeline')}
        actions={
          <a
            className="button-quiet"
            href={routeHref(`#/tracks/${encodeURIComponent(data.track.key)}`)}
          >
            {t('releases.toSummary')}
          </a>
        }
      />
      <TimelineView
        data={data}
        reschedule={client.reschedule}
        reload={load}
        now={now}
        truncatedText={t('timeline.truncated')}
      />
    </section>
  );
}
