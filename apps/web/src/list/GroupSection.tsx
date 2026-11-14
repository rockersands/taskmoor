import { type ReactNode, useCallback, useEffect, useId, useState } from 'react';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import type { SearchClient, SearchField, SearchTicket } from '../search/client';
import { sortOfQuery } from '../search/columns';
import { ResultTable, type RowFormat } from '../search/ResultTable';
import { EmptyState } from '../shell/EmptyState';
import { readShownPages, useTicketChanges } from '../tickets/view/ticketChanges';

/**
 * A group's tickets (or all of them): fifty at a time, in the list's order; a track's list and a
 * Multi-track plan's (ADR-122), which stops at `cap` rows and says so.
 */
export function GroupSection({
  sectionKey,
  title,
  count,
  other,
  query,
  search,
  columns,
  fields,
  format,
  onTickets,
  cap,
  emptyBody,
  readOnly = false,
}: {
  sectionKey: string;
  title: string | null;
  count: number | null;
  /** The rest gathered as other: counted, not listed. */
  other: boolean;
  query: string;
  search: SearchClient;
  columns: string[];
  fields: SearchField[];
  format: ((ticket: SearchTicket) => RowFormat | null) | undefined;
  onTickets: (key: string, tickets: SearchTicket[]) => void;
  /** At most this many rows, and the words that say so when there are more. */
  cap?: { rows: number; text: string };
  /** What an empty list tells the person; a track's list by default. */
  emptyBody?: ReactNode;
  /** No cell edits in place (a plan's List in a scenario). */
  readOnly?: boolean;
}) {
  const t = useT();
  const id = useId();
  const [tickets, setTickets] = useState<SearchTicket[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'invalid' | 'failed'>('loading');

  const load = useCallback(
    (after?: string) => {
      search.search(query, after).then(
        (page) => {
          setTickets((current) => {
            const next = after ? [...current, ...page.tickets] : page.tickets;
            onTickets(sectionKey, next);
            return next;
          });
          setCursor(page.next);
          setState('ready');
        },
        (error) =>
          setState(error instanceof ApiError && error.status === 400 ? 'invalid' : 'failed'),
      );
    },
    [search, query, sectionKey, onTickets],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per query (the key remounts it)
  useEffect(() => {
    if (!other) load();
  }, []);
  // An edit in the ticket pop-up over this list: the rows shown, read again where they stand.
  useTicketChanges(() => {
    if (other) return;
    readShownPages((after) => search.search(query, after), tickets.length).then(
      (page) => {
        setTickets(page.tickets);
        onTickets(sectionKey, page.tickets);
        setCursor(page.next);
      },
      () => {},
    );
  });

  const body =
    state === 'invalid' ? (
      <p className="board-problem" role="alert">
        {t('list.invalidFilter')}
      </p>
    ) : state === 'failed' ? (
      <p className="board-problem" role="alert">
        {t('list.failed')}
      </p>
    ) : state === 'loading' ? (
      <p className="report-loading">{t('reports.loading')}</p>
    ) : tickets.length === 0 ? (
      // A group's heading already says what it holds, so a group has the words alone.
      <EmptyState title={t('list.empty')} compact={title !== null}>
        {emptyBody ?? t('empty.list.body')}
      </EmptyState>
    ) : (
      <>
        <ResultTable
          tickets={tickets}
          columns={columns}
          fields={fields}
          client={search}
          sort={sortOfQuery(query)}
          readOnly={readOnly}
          {...(format ? { format } : {})}
          onSaved={(saved) =>
            setTickets((current) => current.map((x) => (x.id === saved.id ? saved : x)))
          }
        />
        {cursor && (!cap || tickets.length < cap.rows) && (
          <button type="button" className="button-secondary" onClick={() => load(cursor)}>
            {t('list.more')}
          </button>
        )}
        {cursor && cap && tickets.length >= cap.rows && <p className="board-hint">{cap.text}</p>}
      </>
    );
  if (title === null)
    return (
      <section className="list-group" aria-label={t('list.tickets')}>
        {body}
      </section>
    );
  return (
    <section className="list-group" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{t('list.groupTitle', { name: title, count: count ?? 0 })}</h2>
      {other ? <p className="board-hint">{t('list.otherHint')}</p> : body}
    </section>
  );
}
