import { useEffect, useId, useState } from 'react';
import { api } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { AttachmentPanel } from './AttachmentPanel';
import type { AttachmentClient } from './client';

export interface TicketSummary {
  id: number;
  key: string;
  summary: string;
}

export interface TicketAttachmentsPageProps {
  /** The ticket key or id from the address (#/tickets/<key>). */
  ticket: string;
  /** Stories and tests pass their own endpoints. */
  load?: (ticket: string) => Promise<TicketSummary>;
  client?: AttachmentClient;
}

const loadTicket = async (ticket: string) =>
  (await api<{ ticket: TicketSummary }>(`/tickets/${encodeURIComponent(ticket)}`)).ticket;

/**
 * A ticket's page as far as it exists before the ticket view (M1-051): its key and summary,
 * and its attachments. The ticket view will take the panel over.
 */
export function TicketAttachmentsPage({
  ticket,
  load = loadTicket,
  client,
}: TicketAttachmentsPageProps) {
  const t = useT();
  const titleId = useId();
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'missing' } | { status: 'loaded'; ticket: TicketSummary }
  >({ status: 'loading' });

  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    load(ticket).then(
      (found) => live && setState({ status: 'loaded', ticket: found }),
      () => live && setState({ status: 'missing' }),
    );
    return () => {
      live = false;
    };
  }, [ticket, load]);

  if (state.status === 'loading') {
    return (
      <p role="status" className="page-note">
        {t('ticketPage.loading')}
      </p>
    );
  }
  if (state.status === 'missing') {
    return (
      <p role="alert" className="form-error">
        {t('ticketPage.notFound')}
      </p>
    );
  }
  return (
    <article aria-labelledby={titleId} className="ticket-page">
      <h1 id={titleId} className="page-title">
        {t('ticketPage.title', { key: state.ticket.key, summary: state.ticket.summary })}
      </h1>
      <AttachmentPanel ticket={state.ticket.id} {...(client ? { client } : {})} />
    </article>
  );
}
