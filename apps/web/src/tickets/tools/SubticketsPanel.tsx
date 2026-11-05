import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { ApiError } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { navigate, openOverlay, overlayRoute, routeHref } from '../../routing/router';
import { EmptyState } from '../../shell/EmptyState';
import { fieldName as seededFieldName } from '../../shell/seededNames';
import { refusalMessage, type TransitionRefusal } from '../../workflow/refusal';
import { customId, fieldErrors, SYSTEM_FIELDS } from '../form';
import type { Transition } from '../view/client';
import { FILLABLE_FIELDS, TransitionForm } from '../view/TransitionForm';
import { ChildStatusMenu } from './ChildStatusMenu';
import type { ChildTicket, ChildType, SubticketProgress, TicketToolsClient } from './client';
import { ticketToolsClient } from './client';
import { ProgressBar, percentOf } from './Progress';

/** Custom field names by id, as a type's create form gives them. */
type FieldNames = ReadonlyMap<number, string>;
const NO_NAMES: FieldNames = new Map();

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
 * follow the track's workflow, and each status is a menu of where that ticket can go (TT-6), the
 * ticket page's own routes, so the same conditions and rights apply. A move that asks for a close
 * reason or a priority asks for it here; one that asks for more sends the person to the ticket.
 * A subticket has nothing under it, so it shows no such section.
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
  const [loadingMore, setLoadingMore] = useState(false);
  /** The row whose link takes the focus once the last page is drawn and its button gone. */
  const [focusRow, setFocusRow] = useState<number | null>(null);
  /** A move that asks for a close reason or a priority first (TT-6). */
  const [asking, setAsking] = useState<{ child: ChildTicket; to: Transition } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  /** Holds the form a move asks with, under the list. */
  const askingSlot = useRef<HTMLDivElement>(null);
  const read = useRef(0);
  const readingMore = useRef(false);
  /** Each type's create form fields, asked for once (by track and type). */
  const formFields = useRef(new Map<string, Promise<FieldNames>>());
  const hasChildren = rank >= 0;
  const writing = summary.trim() !== '';

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

  /**
   * The custom fields on a type's create form, by name: what the create form reads. A refusal
   * names them from here, so it never asks for them itself; one that could not be read is asked
   * for again next time, and meanwhile a field goes by its number.
   */
  const fieldsOf = useCallback(
    (typeId: number): Promise<FieldNames> => {
      const key = `${ticket.track.key}/${typeId}`;
      const known = formFields.current.get(key);
      if (known) return known;
      const asked = (client.childFields?.(ticket.track.key, typeId) ?? Promise.resolve([])).then(
        (fields): FieldNames => new Map(fields.map((field) => [field.id, field.name])),
        () => {
          formFields.current.delete(key);
          return NO_NAMES;
        },
      );
      formFields.current.set(key, asked);
      return asked;
    },
    [client, ticket.track.key],
  );

  // Read once a subticket is being written, so a refusal can name the fields straight away.
  useEffect(() => {
    if (writing && type !== null) void fieldsOf(type);
  }, [writing, type, fieldsOf]);

  useEffect(() => {
    if (focusRow === null) return;
    const rows = list.current?.querySelectorAll('li');
    (rows?.[focusRow] ?? rows?.[rows.length - 1])?.querySelector('a')?.focus();
    setFocusRow(null);
  }, [focusRow]);

  // The form a move asks with opens under the whole list, away from the status chosen: the focus
  // goes to its first field, so a keyboard or a screen reader finds it, named for the ticket and
  // the move.
  useEffect(() => {
    if (!asking) return;
    askingSlot.current?.querySelector<HTMLElement>('select, [role="combobox"]')?.focus();
  }, [asking]);

  if (!hasChildren) return null;

  /**
   * A field by the name the person knows it by, a custom one as its type's create form names it
   * (a seeded one in their language); null for one this panel cannot name.
   */
  const fieldName = (key: string, known: FieldNames): string | null => {
    const system = SYSTEM_FIELDS[key];
    if (system) return t(system.label);
    const id = customId(key);
    if (id === null) return null;
    const name = known.get(id);
    return name === undefined
      ? t('tickets.templates.fieldNumber', { id })
      : seededFieldName(t, name);
  };
  /** A field refusal: where the ticket cannot go, else the fields by name and what was wrong. */
  const fieldRefusal = (fields: Record<string, string>, known: FieldNames) => {
    if (fields.parent === 'not_found') return t('ticketTools.subtickets.parentGone');
    if (fields.parent !== undefined) return t('ticketTools.subtickets.wrongPlace');
    if (fields.ticketTypeId !== undefined) return t('ticketTools.subtickets.typeGone');
    const named = Object.entries(fieldErrors(fields)).map(([key, why]) => ({
      name: fieldName(key, known),
      why,
    }));
    if (named.length === 0 || named.some((field) => field.name === null)) {
      return t('ticketView.problem.other');
    }
    const required = named.filter((field) => field.why === 'required');
    const names = (rows: typeof named) => rows.map((field) => field.name).join(', ');
    return required.length > 0
      ? t('ticketTools.subtickets.fields', { fields: names(required) })
      : t('ticketTools.subtickets.refused', { fields: names(named) });
  };
  const refusal = (error: unknown, known: FieldNames) => {
    if (error instanceof ApiError) {
      const body = error.body as { fields?: Record<string, string> } | null;
      if (error.status === 403) return t('ticketTools.subtickets.forbidden');
      if (error.code === 'invalid_fields' && body?.fields) return fieldRefusal(body.fields, known);
    }
    return t('ticketView.problem.other');
  };

  const add = async (open: boolean) => {
    const text = summary.trim();
    if (text === '' || type === null || busy) return;
    setBusy(true);
    setProblem(null);
    let stays = true;
    try {
      const made = await client.createChild({
        track: ticket.track.key,
        parent: ticket.key,
        ticketTypeId: type,
        summary: text,
      });
      setSummary('');
      if (open) {
        stays = false;
        const route = `#/tickets/${encodeURIComponent(made.key)}`;
        // In the pop-up the new ticket opens there, as a link inside it does: the page beneath
        // stays and hears of it, and Back returns to this ticket.
        const over = overlayRoute() !== null;
        if (over) {
          onChanged?.();
        } else {
          // The full page may ask about another draft first; if the person stays, the list
          // already shows the new subticket.
          setSaid(t('ticketTools.subtickets.added', { key: made.key }));
          void load();
          onChanged?.();
        }
        // The summary is saved: its field is empty before the pop-up, or the full page as it
        // is left, looks for drafts (NFR-005), so neither asks about it.
        flushSync(() => setSummary(''));
        if (over) openOverlay(route);
        else navigate(route);
        return;
      }
      setSaid(t('ticketTools.subtickets.added', { key: made.key }));
      await load();
      onChanged?.();
    } catch (error) {
      // Read as the summary was written; this waits only for an answer still on its way.
      const fieldsRefused = error instanceof ApiError && error.code === 'invalid_fields';
      setProblem(refusal(error, fieldsRefused ? await fieldsOf(type) : NO_NAMES));
    } finally {
      setBusy(false);
      if (stays) input.current?.focus();
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void add(false);
  };
  /** What the form a move needs can ask for: the lists of close reasons and priorities. */
  const formLists =
    client.closeReasons && client.priorities
      ? { closeReasons: client.closeReasons, priorities: client.priorities }
      : null;
  /** A subticket's status control takes the focus again after a move or a form. */
  const focusStatus = (id: number) =>
    list.current
      ?.querySelector<HTMLButtonElement>(`[data-child="${id}"] .ticket-child-status`)
      ?.focus();
  const moveRefusal = (error: unknown, key: string) => {
    let why = t('ticketView.problem.other');
    if (error instanceof ApiError) {
      const body = error.body as { error?: string; fields?: Record<string, string> } | null;
      if (error.status === 403) why = t('ticketView.problem.forbidden');
      else if (body?.error === 'transition_refused' && (body as Partial<TransitionRefusal>).by) {
        why = refusalMessage(t, body as unknown as TransitionRefusal);
      } else if (body?.error === 'transition_refused' || body?.error === 'transition_unavailable') {
        why = t('ticketView.problem.transition');
      } else if (body?.fields) {
        return t('ticketTools.subtickets.moveOnPage', { key });
      }
    }
    return t('ticketTools.subtickets.moveRefused', { key, why });
  };
  /** Moves a subticket through its workflow, asking first for what the move needs (TT-6). */
  const move = async (child: ChildTicket, to: Transition, fields: Record<string, unknown> = {}) => {
    const run = client.moveChild;
    if (!run) return;
    setProblem(null);
    if (to.layout.some((field) => !(field in fields))) {
      if (formLists && to.layout.every((field) => FILLABLE_FIELDS.includes(field))) {
        setAsking({ child, to });
      } else {
        setProblem(t('ticketTools.subtickets.moveOnPage', { key: child.key }));
      }
      return;
    }
    try {
      const moved = await run(child.id, to.id, fields);
      setAsking(null);
      setSaid(t('ticketTools.subtickets.moved', { key: moved.key, status: moved.status.name }));
      await load();
      onChanged?.();
    } catch (error) {
      setProblem(moveRefusal(error, child.key));
    }
    focusStatus(child.id);
  };

  const more = async () => {
    // One page at a time: a second press while it loads would add the same page again.
    if (!next || readingMore.current) return;
    readingMore.current = true;
    setLoadingMore(true);
    const from = children?.length ?? 0;
    try {
      const page = await client.children(ticket.key, next);
      setChildren((now) => [...(now ?? []), ...page.tickets]);
      setNext(page.next);
      // The last page takes the button away: the focus goes to the first ticket it brought.
      if (page.next === null) setFocusRow(from);
    } catch {
      setProblem(t('ticketView.problem.other'));
    } finally {
      readingMore.current = false;
      setLoadingMore(false);
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
        <EmptyState compact title={t('ticketTools.subtickets.empty')} />
      )}
      {children && children.length > 0 && (
        <ul ref={list} className="ticket-child-list">
          {children.map((child) => (
            <li key={child.id} className="ticket-child" data-child={child.id}>
              <a
                href={routeHref(`#/tickets/${encodeURIComponent(child.key)}`)}
                className={child.status.stage === 'closed' ? 'ticket-link-closed' : undefined}
              >
                {child.key}
              </a>
              <span className="ticket-child-summary">{child.summary}</span>
              {client.childTransitions && client.moveChild ? (
                <ChildStatusMenu
                  child={child}
                  load={client.childTransitions}
                  onChoose={(which, to) => void move(which, to)}
                />
              ) : (
                <span className="ticket-child-status" data-stage={child.status.stage}>
                  {child.status.name}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {asking && formLists && (
        // biome-ignore lint/a11y/noStaticElementInteractions: Escape from any of its fields
        <div
          ref={askingSlot}
          onKeyDown={(event) => {
            // As Cancel; taken here, so a pop-up the panel is in stays open.
            if (event.key !== 'Escape' || event.defaultPrevented) return;
            event.preventDefault();
            event.stopPropagation();
            setAsking(null);
            focusStatus(asking.child.id);
          }}
        >
          <TransitionForm
            key={`${asking.child.id}-${asking.to.id}`}
            transition={{
              name: t('ticketTools.subtickets.moveForm', {
                key: asking.child.key,
                name: asking.to.name,
              }),
              layout: asking.to.layout,
            }}
            client={formLists}
            onRun={(fields) => void move(asking.child, asking.to, fields)}
            onCancel={() => {
              setAsking(null);
              focusStatus(asking.child.id);
            }}
          />
        </div>
      )}
      {next && (
        <button
          type="button"
          className="button-secondary"
          // Not disabled: the focus stays on it while the page loads.
          aria-disabled={loadingMore || undefined}
          onClick={() => void more()}
        >
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
              {t(rank === 0 ? 'ticketTools.subtickets.summary' : 'ticketTools.children.new')}
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
