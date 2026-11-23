import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { routeHref } from '../../routing/router';
import { DangerAction } from '../../shell/DangerAction';
import { EmptyState } from '../../shell/EmptyState';
import type { TicketLink } from '../view/client';
import {
  type LinkCategory,
  linkCategories,
  pickerQuery,
  type TicketLinks,
  type TicketToolsClient,
  ticketToolsClient,
} from './client';
import { TicketPicker } from './TicketPicker';

export interface LinksPanelProps {
  ticket: { id: number; key: string; track: { key: string } };
  client?: TicketToolsClient;
  /** Bumped when the ticket changed elsewhere: its links read again. */
  revision: number;
  /** Tells the page something changed, so history reads again. */
  onChanged?: () => void;
}

/** A ticket's links under the phrase they read from this side, in the order they came. */
function grouped(links: readonly TicketLink[]): { phrase: string; links: TicketLink[] }[] {
  const groups = new Map<string, TicketLink[]>();
  for (const link of links) {
    const name = link.phrase.toLowerCase();
    groups.set(name, [...(groups.get(name) ?? []), link]);
  }
  return [...groups.values()].map((list) => ({
    phrase: (list[0] as TicketLink).phrase,
    links: list,
  }));
}

/** The track key a ticket key starts with: `WEB` of `WEB-12`. */
const trackOf = (key: string) => key.slice(0, key.lastIndexOf('-'));

/**
 * A ticket's links on its page (CORE-031; M1-015): grouped under what they say from this side,
 * whichever side they were made from, and open to change. The form takes several in a row: a
 * category, then tickets of this track found by number or name. Links that reach another track
 * (imports, the API) show and can be removed too, but the form cannot make them again, so
 * removing one asks first (D13, T-267); a link inside the track goes at once. Web links show as
 * they were.
 */
export function LinksPanel({
  ticket,
  client = ticketToolsClient,
  revision,
  onChanged,
}: LinksPanelProps) {
  const t = useT();
  const titleId = useId();
  const categoryId = useId();
  const [data, setData] = useState<TicketLinks | null>(null);
  const [categories, setCategories] = useState<LinkCategory[] | null>(null);
  const [category, setCategory] = useState<string>('');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  /** Counts removals: after each, the focus finds a place in the panel once it is drawn. */
  const [removals, setRemovals] = useState(0);
  const panel = useRef<HTMLElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const doneButton = useRef<HTMLButtonElement>(null);

  const read = useRef(0);
  const load = () => {
    const ask = ++read.current;
    return client.links(ticket.id).then(
      (found) => {
        if (ask === read.current) setData(found);
      },
      () => {
        if (ask === read.current) setData((now) => now ?? { links: [], webLinks: [] });
      },
    );
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again when the ticket changes
  useEffect(() => {
    void load();
    return () => {
      read.current++;
    };
  }, [client, ticket.id, revision]);

  const mayLink = data?.mayLink !== false && data?.enabled !== false;
  useEffect(() => {
    if (!adding || categories) return;
    let live = true;
    client.linkTypes().then(
      ({ linkTypes }) => {
        if (!live) return;
        const list = linkCategories(linkTypes);
        setCategories(list);
        setCategory((now) => now || (list[0]?.id ?? ''));
      },
      () => {
        if (live) setCategories([]);
      },
    );
    return () => {
      live = false;
    };
  }, [client, adding, categories]);

  // The removed row's button is gone. With the form open, its picker takes the focus back once
  // it is free again; without one that can, the add button or the form's Done button does.
  useEffect(() => {
    if (removals === 0) return;
    const now = document.activeElement;
    if (now && now !== document.body && panel.current?.contains(now)) return;
    (addButton.current ?? doneButton.current)?.focus();
  }, [removals]);

  const refusal = (error: unknown) => {
    if (error instanceof ApiError) {
      if (error.status === 403) return t('ticketView.problem.forbidden');
      if (error.code === 'link_exists') return t('ticketTools.links.exists');
      if (error.code === 'links_disabled') return t('ticketTools.links.disabled');
      if (error.code === 'track_archived') return t('ticketTools.links.archived');
    }
    return t('ticketView.problem.other');
  };

  const linked = useMemo(() => new Set(data?.links.map((l) => l.ticket.id)), [data]);
  const choice = categories?.find((c) => c.id === category) ?? categories?.[0] ?? null;

  const add = async (other: { id: number; key: string }) => {
    if (!choice) return;
    setBusy(true);
    setProblem(null);
    try {
      await client.addLink(ticket.id, {
        linkTypeId: choice.linkTypeId,
        direction: choice.direction,
        ticket: other.id,
      });
      setSaid(t('ticketTools.links.added', { key: other.key, phrase: choice.phrase }));
      await load();
      onChanged?.();
    } catch (error) {
      setProblem(refusal(error));
    } finally {
      setBusy(false);
    }
  };

  /** Whether it went: a refusal says why in the panel. */
  const remove = async (link: TicketLink) => {
    setBusy(true);
    setProblem(null);
    try {
      await client.removeLink(ticket.id, link.id);
      setSaid(t('ticketTools.links.removed', { key: link.ticket.key, phrase: link.phrase }));
      await load();
      onChanged?.();
      addButton.current?.focus();
      setRemovals((n) => n + 1);
      return true;
    } catch (error) {
      setProblem(refusal(error));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!data) return null;
  const nothing = data.links.length === 0 && data.webLinks.length === 0;
  // Nothing to show and nothing this person may do here: the section stays out of the way.
  if (nothing && !mayLink) return null;
  const closeForm = () => {
    setAdding(false);
    window.setTimeout(() => addButton.current?.focus(), 0);
  };

  return (
    <section ref={panel} aria-labelledby={titleId} className="ticket-links ticket-tool">
      <div className="ticket-tool-head">
        <h2 id={titleId} className="ticket-section-title">
          {t('ticketView.links')}
        </h2>
        {mayLink && !adding && (
          <button
            ref={addButton}
            type="button"
            className="button-secondary ticket-action"
            onClick={() => setAdding(true)}
          >
            {t('ticketTools.links.add')}
          </button>
        )}
      </div>
      {nothing && !adding && <EmptyState compact title={t('ticketTools.links.empty')} />}
      {grouped(data.links).map((group) => (
        <div key={group.phrase} className="ticket-link-group">
          <h3 className="ticket-link-phrase">{group.phrase}</h3>
          <ul className="ticket-link-list">
            {group.links.map((link) => (
              <li key={link.id} className="ticket-link-row">
                <span className="ticket-link-text">
                  <a
                    href={routeHref(`#/tickets/${encodeURIComponent(link.ticket.key)}`)}
                    className={link.ticket.closed ? 'ticket-link-closed' : undefined}
                  >
                    {link.ticket.key}
                  </a>{' '}
                  {link.ticket.summary}
                </span>
                {mayLink &&
                  (trackOf(link.ticket.key) !== ticket.track.key ? (
                    <DangerAction
                      label={t('ticketTools.remove')}
                      name={t('ticketTools.links.remove', {
                        key: link.ticket.key,
                        phrase: link.phrase,
                      })}
                      outcome={t('ticketTools.links.removeOutcome', { key: link.ticket.key })}
                      confirmLabel={t('ticketTools.links.remove', {
                        key: link.ticket.key,
                        phrase: link.phrase,
                      })}
                      busy={busy}
                      onConfirm={async () => {
                        if (!(await remove(link))) throw new Error('refused');
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="button-secondary ticket-action"
                      disabled={busy}
                      aria-label={t('ticketTools.links.remove', {
                        key: link.ticket.key,
                        phrase: link.phrase,
                      })}
                      onClick={() => void remove(link)}
                    >
                      {t('ticketTools.remove')}
                    </button>
                  ))}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {data.webLinks.length > 0 && (
        <ul className="ticket-link-list">
          {data.webLinks.map((web) => (
            <li key={web.id}>
              <a href={web.url} target="_blank" rel="noopener noreferrer nofollow">
                {web.title || web.url}
              </a>
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <div className="ticket-link-form">
          <div className="ticket-link-category">
            <label htmlFor={categoryId} className="form-label">
              {t('ticketTools.links.category')}
            </label>
            <select
              id={categoryId}
              value={choice?.id ?? ''}
              onChange={(event) => setCategory(event.target.value)}
            >
              {(categories ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.phrase}
                </option>
              ))}
            </select>
          </div>
          <TicketPicker
            label={t('ticketTools.links.ticket')}
            hint={t('ticketTools.links.hint', { track: ticket.track.key })}
            autoFocus
            disabled={busy || !choice}
            exclude={linked}
            search={(typed) => {
              const query = pickerQuery(typed, {
                trackKey: ticket.track.key,
                exclude: ticket.key,
              });
              return query ? client.pick(query) : Promise.resolve([]);
            }}
            onPick={(other) => void add(other)}
            onCancel={closeForm}
          />
          <div className="form-actions">
            <button ref={doneButton} type="button" className="button-secondary" onClick={closeForm}>
              {t('ticketTools.done')}
            </button>
          </div>
        </div>
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
