import { useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../../i18n/I18nProvider';
import type { TicketClient, TicketInfo } from './client';

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A ticket's read-only info fields (M1-125; CORE-012): the date of the first response, the days
 * since the last comment, the participants and the time spent in each status, all computed by
 * the server from comments and the change history. Comments restricted to a role or a group do
 * not count, so the panel says nothing of comments a reader cannot see.
 */
export function InfoPanel({
  ticketId,
  client,
  revision,
}: {
  ticketId: number;
  client: Pick<TicketClient, 'info'>;
  revision: number;
}) {
  const t = useT();
  const intl = useIntl();
  const titleId = useId();
  const statusesId = useId();
  const [info, setInfo] = useState<TicketInfo | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again when the ticket changes
  useEffect(() => {
    if (!client.info) return;
    let live = true;
    client.info(ticketId).then(
      (found) => live && setInfo(found),
      () => live && setInfo(null),
    );
    return () => {
      live = false;
    };
  }, [client, ticketId, revision]);
  if (!info) return null;

  /** The largest two units of a span: "3 d 4 h", "5 h 20 min", "42 min", "under a minute". */
  const span = (seconds: number) => {
    const days = Math.floor(seconds / DAY);
    const hours = Math.floor((seconds % DAY) / HOUR);
    const minutes = Math.floor((seconds % HOUR) / MINUTE);
    if (days > 0) return t('ticketInfo.spanDays', { days, hours });
    if (hours > 0) return t('ticketInfo.spanHours', { hours, minutes });
    if (minutes > 0) return t('ticketInfo.spanMinutes', { minutes });
    return t('ticketInfo.spanUnderMinute');
  };

  return (
    <section aria-labelledby={titleId} className="ticket-info">
      <h2 id={titleId} className="ticket-section-title">
        {t('ticketInfo.title')}
      </h2>
      <dl className="ticket-facts">
        <div>
          <dt>{t('ticketInfo.firstResponse')}</dt>
          <dd>
            {info.firstResponse
              ? intl.formatDate(new Date(info.firstResponse), {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })
              : t('ticketInfo.noResponse')}
          </dd>
        </div>
        <div>
          <dt>{t('ticketInfo.daysSinceLastComment')}</dt>
          <dd>
            {info.daysSinceLastComment === null
              ? t('ticketInfo.noComments')
              : t('ticketInfo.days', { count: info.daysSinceLastComment })}
          </dd>
        </div>
        <div>
          <dt>{t('ticketInfo.participants')}</dt>
          <dd>
            {info.participants.length === 0
              ? t('ticketView.none')
              : intl.formatList(
                  info.participants.map((p) => p.name),
                  { type: 'conjunction' },
                )}
          </dd>
        </div>
      </dl>
      {info.timeInStatus.length > 0 && (
        <table className="ticket-info-statuses" aria-labelledby={statusesId}>
          <caption id={statusesId}>{t('ticketInfo.timeInStatus')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('ticketView.field.status')}</th>
              <th scope="col">{t('ticketInfo.time')}</th>
              <th scope="col">{t('ticketInfo.visits')}</th>
            </tr>
          </thead>
          <tbody>
            {info.timeInStatus.map((s) => (
              <tr key={s.status.id}>
                <th scope="row">{s.status.name}</th>
                <td>{span(s.seconds)}</td>
                <td>{intl.formatNumber(s.visits)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
