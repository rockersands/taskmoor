import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { navigate, routeHref } from '../../routing/router';
import type { ChildTicket, ChildType, SubticketProgress, TicketToolsClient } from './client';
import { ticketToolsClient } from './client';
import { ProgressBar, percentOf } from './Progress';

export interface SubticketsPanelProps {
  ticket: {
    id: number;
    key: string;
    track: { key: string };
    ticketType: { level?: { rank: number } };
  };
  client?: TicketToolsClient;
  /** Bumped when the ticket changed elsewhere. */
  revision: number;
  /** Tells the page something changed, so history reads again. */
  onChanged?: () => void;
}

/**
 * What sits under a ticket, on its page (CORE-032; M1-007): the tickets one level down with their
 * status, how many are in a closed stage as a percentage, a bar and the numbers, and a form that
 * makes another from a summary, then stays or opens it. They are ordinary tickets: their statuses
 * follow the track's workflow. A subticket has nothing under it, so it shows no such section.
 */
export function SubticketsPanel({
  ticket,
  client = ticketToolsClient,
  revision,
  onChanged,
}: SubticketsPanelProps) {
  const t = useT();
  const titleId = useId();
  const summaryId = useId();
  const typeId = useId();
  const rank = ticket.ticketType.level?.rank ?? 0;
  const [children, setChildren] = useState<ChildTicket[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [progress, setProgress] = useState<SubticketProgress | null>(null);
  const [types, setTypes] = useState<ChildType[]>([]);
  const [type, setType] = useState<number | null>(null);
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const read = useRef(0);
  const hasChildren = rank >= 0;

  const load = useCallback(() => {
    const ask = ++read.current;
    return Promise.allSettled([
      client.children(ticket.key),
      client.subticketProgress([ticket.id]),
    ]).then(([list, counts]) => {
      if (ask !== read.current) return;
      if (list.status === 'fulfilled') {
        setChildren(list.value.tickets);
        setNext(list.value.next);
      } else {
        setChildren((now) => now ?? []);
      }
      if (counts.status === 'fulfilled') setProgress(counts.value[String(ticket.id)] ?? null);
    });
  }, [client, ticket.key, ticket.id]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: read again when the ticket changes
  useEffect(() => {
    if (!hasChildren) return;
    void load();
    return () => {
      read.current++;
    };
  }, [hasChildren, load, revision]);

  useEffect(() => {
    if (!hasChildren) return;
    let live = true;
    client.childTypes(ticket.track.key, rank).then(
      (list) => {
        if (!live) return;
        setTypes(list);
        setType((now) => now ?? list[0]?.id ?? null);
      },
      () => {
        if (live) setTypes([]);
      },
    );
    return () => {
      live = false;
    };
  }, [client, hasChildren, ticket.track.key, rank]);

  if (!hasChildren) return null;

  const refusal = (error: unknown) => {
    if (error instanceof ApiError) {
      const body = error.body as { fields?: Record<string, string> } | null;
      if (error.status === 403) return t('ticketTools.subtickets.forbidden');
      if (body?.fields) {
        return t('ticketTools.subtickets.fields', { fields: Object.keys(body.fields).join(', ') });
      }
    }
    return t('ticketView.problem.other');
  };

  const add = async (open: boolean) => {
    const text = summary.trim();
    if (text === '' || type === null || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const made = await client.createChild({
        track: ticket.track.key,
        parent: ticket.key,
        ticketTypeId: type,
        summary: text,
      });
      setSummary('');
      if (open) {
        navigate(`#/tickets/${encodeURIComponent(made.key)}`);
        return;
      }
      setSaid(t('ticketTools.subtickets.added', { key: made.key }));
      await load();
      onChanged?.();
    } catch (error) {
      setProblem(refusal(error));
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void add(false);
  };

  const more = async () => {
    if (!next) return;
    try {
      const page = await client.children(ticket.key, next);
      setChildren((now) => [...(now ?? []), ...page.tickets]);
      setNext(page.next);
    } catch {
      setProblem(t('ticketView.problem.other'));
    }
  };

  const percent = progress ? percentOf(progress.closed, progress.total) : 0;
  const numbers = progress
    ? t('ticketTools.subtickets.progress', {
        closed: progress.closed,
        total: progress.total,
        percent,
      })
    : '';
  const title = rank === 0 ? t('ticketTools.subtickets.title') : t('ticketTools.children.title');

  return (
    <section aria-labelledby={titleId} className="ticket-links ticket-tool">
      <div className="ticket-tool-head">
        <h2 id={titleId} className="ticket-section-title">
          {title}
        </h2>
      </div>
      {progress && (
        <div className="tool-progress">
          <ProgressBar percent={percent} label={numbers} />
          <p className="tool-progress-text">{numbers}</p>
        </div>
      )}
      {children && children.length === 0 && (
        <p className="ticket-tool-empty">{t('ticketTools.subtickets.empty')}</p>
      )}
      {children && children.length > 0 && (
        <ul className="ticket-child-list">
          {children.map((child) => (
            <li key={child.id} className="ticket-child">
              <a
                href={routeHref(`#/tickets/${encodeURIComponent(child.key)}`)}
                className={child.status.stage === 'closed' ? 'ticket-link-closed' : undefined}
              >
                {child.key}
              </a>
              <span className="ticket-child-summary">{child.summary}</span>
              <span className="ticket-child-status" data-stage={child.status.stage}>
                {child.status.name}
              </span>
            </li>
          ))}
        </ul>
      )}
      {next && (
        <button type="button" className="button-secondary" onClick={() => void more()}>
          {t('ticketTools.subtickets.more')}
        </button>
      )}
      {types.length > 0 ? (
        <form className="ticket-child-form" onSubmit={submit}>
          {types.length > 1 && (
            <div className="ticket-child-field">
              <label htmlFor={typeId} className="form-label">
                {t('workflow.field.ticketType')}
              </label>
              <select
                id={typeId}
                value={type ?? ''}
                onChange={(event) => setType(Number(event.target.value))}
              >
                {types.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="ticket-child-field ticket-child-summary-field">
            <label htmlFor={summaryId} className="form-label">
              {t('ticketTools.subtickets.summary')}
            </label>
            <input
              ref={input}
              id={summaryId}
              type="text"
              value={summary}
              maxLength={255}
              onChange={(event) => setSummary(event.target.value)}
            />
          </div>
          <div className="form-actions">
            <button
              type="submit"
              className="button-primary"
              disabled={busy || summary.trim() === ''}
            >
              {t('ticketTools.subtickets.add')}
            </button>
            <button
              type="button"
              className="button-secondary"
              disabled={busy || summary.trim() === ''}
              onClick={() => void add(true)}
            >
              {t('ticketTools.subtickets.addOpen')}
            </button>
          </div>
        </form>
      ) : (
        children !== null && (
          <p className="ticket-tool-empty">{t('ticketTools.subtickets.noType')}</p>
        )
      )}
      <p role="status" className="form-status">
        {said}
      </p>
      {problem && (
        <p role="alert" className="form-error">
          {problem}
        </p>
      )}
    </section>
  );
}
