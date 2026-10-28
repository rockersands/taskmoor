import { useEffect, useId, useState } from 'react';
import { api } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { useSyncEngine } from '../sync/SyncProvider';
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
 * and its attachments. The ticket view will take the panel over. With the local copy (M1-032)
 * the page shows the ticket from it at once, then from the server.
 */
export function TicketAttachmentsPage({
  ticket,
  load = loadTicket,
  client,
}: TicketAttachmentsPageProps) {
  const t = useT();
  const titleId = useId();
  const engine = useSyncEngine();
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

  // The local copy fills in while the server's answer is on its way, and only then: an engine
  // that starts later must not reset the page (and the panel's uploads) under the person.
  useEffect(() => {
    if (!engine) return;
    let live = true;
    void engine.ticketByKey(ticket).then((local) => {
      if (!live || !local) return;
      const key = ticket.toUpperCase();
      setState((s) =>
        s.status === 'loading'
          ? { status: 'loaded', ticket: { id: local.id, key, summary: local.summary } }
          : s,
      );
    });
    return () => {
      live = false;
    };
  }, [ticket, engine]);

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
