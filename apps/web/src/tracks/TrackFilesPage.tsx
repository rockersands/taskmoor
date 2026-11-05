import { useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
import { type TrackClient, type TrackFiles, trackClient } from './client';

export interface TrackFilesPageProps {
  trackKey: string;
  client?: TrackClient;
}

/**
 * The files and web links on a track's tickets, in one place (ADR-116), within the tickets the
 * person may see. Each row leads to its ticket, where the file or link lives.
 */
export function TrackFilesPage({ trackKey, client = trackClient }: TrackFilesPageProps) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const [files, setFiles] = useState<TrackFiles | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    client.files(trackKey).then(
      (found) => {
        if (live) setFiles(found);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [client, trackKey]);

  const ticketLink = (ticket: { key: string; summary: string }) => (
    <a href={routeHref(`#/tickets/${encodeURIComponent(ticket.key)}`)} title={ticket.summary}>
      {ticket.key}
    </a>
  );
  const empty = files && files.attachments.length === 0 && files.links.length === 0;

  return (
    <section aria-labelledby={`${id}-title`} className="page track-files">
      <PageHeader
        titleId={`${id}-title`}
        title={t('track.files.title')}
        purpose={t('track.files.purpose')}
      />
      {failed && (
        <p className="form-error" role="alert">
          {t('track.files.failed')}
        </p>
      )}
      {!files && !failed && <p className="page-note">{t('boards.loading')}</p>}
      {empty && (
        <EmptyState title={t('track.files.emptyTitle')}>{t('track.files.empty')}</EmptyState>
      )}
      {files && files.attachments.length > 0 && (
        <section aria-labelledby={`${id}-files`} className="glass-card track-files-group">
          <h2 id={`${id}-files`} className="ticket-section-title">
            {t('track.files.attachments')}
          </h2>
          <ul>
            {files.attachments.map((file) => (
              <li key={file.id}>
                <span className="track-files-name">{file.name}</span>
                <span className="track-files-meta">
                  {ticketLink(file.ticket)} ·{' '}
                  {intl.formatDate(new Date(file.createdAt), { dateStyle: 'medium' })}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {files && files.links.length > 0 && (
        <section aria-labelledby={`${id}-links`} className="glass-card track-files-group">
          <h2 id={`${id}-links`} className="ticket-section-title">
            {t('track.files.links')}
          </h2>
          <ul>
            {files.links.map((link) => (
              <li key={link.id}>
                <a href={link.url} rel="noopener noreferrer" target="_blank">
                  {link.title || link.url}
                </a>
                <span className="track-files-meta">{ticketLink(link.ticket)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {files?.truncated && <p className="page-note">{t('track.files.truncated')}</p>}
    </section>
  );
}
