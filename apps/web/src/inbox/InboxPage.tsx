import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { type Translate, useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { routeHref } from '../routing/router';
import { PriorityIcon, TypeIcon } from '../shell/TicketIcons';
import {
  type InboxClient,
  type InboxItem,
  type InboxTrack,
  type InboxView,
  inboxClient,
  snoozeTimes,
  type UnreadCounts,
} from './client';

export interface InboxPageProps {
  client?: InboxClient;
  /** The clock snooze times start from; tests and stories fix it. */
  now?: () => Date;
}

const VIEWS: readonly { id: InboxView; label: MessageId }[] = [
  { id: 'all', label: 'inbox.view.all' },
  { id: 'priority', label: 'inbox.view.priority' },
  { id: 'snoozed', label: 'inbox.view.snoozed' },
];
/** The types the Type filter offers: mentions first, then the policy events. */
const TYPES = [
  'mentioned',
  'ticket_assigned',
  'ticket_commented',
  'ticket_created',
  'ticket_updated',
  'ticket_close_reason_set',
  'ticket_closed',
  'ticket_reopened',
  'ticket_deleted',
  'ticket_moved',
  'time_entry_added',
  'time_entry_updated',
  'time_entry_deleted',
  'work_started',
  'work_stopped',
  'generic',
] as const;
const EMPTY: Record<InboxView, MessageId> = {
  all: 'inbox.empty.all',
  priority: 'inbox.empty.priority',
  snoozed: 'inbox.empty.snoozed',
};
/** The server caps its counts here (COUNT_CAP). */
const COUNT_CAP = 1000;
const CUSTOM = 'custom:';

const ALERT_RULES = new Set([
  'sign_in_failures_account',
  'sign_in_failures_address',
  'access_refusals',
  'bulk_exports',
  'ai_spend',
]);

/** What an alert says (ADR-109): "Failed sign-ins for one account: 12 in 60 minutes". */
function alertText(t: Translate, item: InboxItem): string {
  const alert = item.alert;
  const rule = alert && ALERT_RULES.has(alert.rule) ? alert.rule : 'access_refusals';
  const name = t(`inbox.alert.rule.${rule}` as MessageId);
  if (rule === 'ai_spend') return t('inbox.alert.ai', { name, percent: alert?.percent ?? 0 });
  return t('inbox.alert.count', {
    name,
    count: alert?.count ?? 0,
    minutes: alert?.windowMinutes ?? 0,
  });
}

/** Whom an alert is about: a person, the email typed, a token or an address. */
function alertSubject(t: Translate, item: InboxItem): string {
  const alert = item.alert;
  if (!alert) return '';
  const parts: string[] = [];
  if (alert.userName || alert.userEmail) {
    parts.push(t('inbox.alert.person', { name: alert.userName || alert.userEmail || '' }));
  } else if (alert.email) parts.push(t('inbox.alert.email', { email: alert.email }));
  if (alert.tokenId) parts.push(t('inbox.alert.token', { id: alert.tokenId }));
  if (alert.address) parts.push(t('inbox.alert.address', { address: alert.address }));
  return parts.join(' · ');
}

/** Where an alert leads: the audit log, or the AI usage page for a spend alert. */
const alertLink = (item: InboxItem) =>
  routeHref(item.alert?.rule === 'ai_spend' ? '#/admin/ai-usage' : '#/admin/audit');

/** What happened, in the reader's words: "Alice mentioned you in a comment". */
function whatHappened(t: Translate, item: InboxItem): string {
  if (!item.ticket) return alertText(t, item);
  const actor = item.actor?.name || t('inbox.someone');
  if (item.event === 'mentioned') {
    return item.mentionedIn?.includes('comment')
      ? t('inbox.what.mentionedComment', { actor })
      : t('inbox.what.mentioned', { actor });
  }
  if (item.event === 'ticket_assigned' && item.direct)
    return t('inbox.what.assignedYou', { actor });
  if (item.event.startsWith(CUSTOM)) {
    return t('inbox.what.custom', { actor, name: item.event.slice(CUSTOM.length) });
  }
  const label = `notifications.event.${item.event}`;
  const event = t((isKnownEvent(label) ? label : 'notifications.event.generic') as MessageId);
  return t('inbox.what.event', { actor, event });
}

const KNOWN = new Set([
  'ticket_created',
  'ticket_updated',
  'ticket_assigned',
  'ticket_close_reason_set',
  'ticket_closed',
  'ticket_commented',
  'ticket_reopened',
  'ticket_deleted',
  'ticket_moved',
  'time_entry_added',
  'time_entry_updated',
  'time_entry_deleted',
  'work_started',
  'work_stopped',
  'generic',
]);
const isKnownEvent = (label: string) => KNOWN.has(label.slice('notifications.event.'.length));

/** Where an item leads: its ticket, at the comment when it is about one. */
const linkOf = (item: InboxItem) =>
  item.ticket
    ? routeHref(
        `#/tickets/${encodeURIComponent(item.ticket.key)}${item.comment ? `?comment=${item.comment.id}` : ''}`,
      )
    : alertLink(item);

/**
 * The in-app inbox (M1-058; NTF-003): mentions and changes to the tickets a person follows,
 * newest first, as cards (no sideways scrolling on a phone). Tabs for everything, the Priority
 * tab of direct asks (mentions, tickets assigned to the reader) and what is snoozed; unread
 * only; read, unread, snooze and mark all read. It reads the inbox again whenever the realtime
 * socket says it changed, so a new item shows within a second.
 */
export function InboxPage({ client = inboxClient, now = () => new Date() }: InboxPageProps) {
  const t = useT();
  const intl = useIntl();
  const titleId = useId();
  const [view, setView] = useState<InboxView>('all');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [type, setType] = useState('');
  const [track, setTrack] = useState('');
  const [tracks, setTracks] = useState<InboxTrack[]>([]);
  const [items, setItems] = useState<InboxItem[]>([]);
  const [unread, setUnread] = useState<UnreadCounts>({ all: 0, priority: 0 });
  const [next, setNext] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [snoozeMenu, setSnoozeMenu] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Only the newest read counts: a slow answer for another tab is dropped.
  const generation = useRef(0);
  const filters = {
    ...(type ? { event: type } : {}),
    ...(track ? { track } : {}),
  };

  const load = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const page = await client.list({
        view,
        unread: unreadOnly,
        ...(type ? { event: type } : {}),
        ...(track ? { track } : {}),
      });
      if (mine !== generation.current) return;
      setItems(page.items);
      setUnread(page.unread);
      setNext(page.next);
      setState('loaded');
    } catch {
      if (mine === generation.current) setState((s) => (s === 'loaded' ? s : 'failed'));
    }
  }, [client, view, unreadOnly, type, track]);

  // The tracks to filter by, once; without them the filter offers none.
  useEffect(() => {
    let live = true;
    client.tracks().then(
      (list) => {
        if (live) setTracks(list);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [client]);

  useEffect(() => {
    setState('loading');
    setSnoozeMenu(null);
    void load();
  }, [load]);

  // Realtime: read the inbox again when it changes (a new item, or one read elsewhere).
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(
    () =>
      client.subscribe(() => {
        void loadRef.current();
      }),
    [client],
  );

  const more = async () => {
    if (next === null) return;
    try {
      const page = await client.list({ view, unread: unreadOnly, ...filters, cursor: next });
      setItems((list) => [...list, ...page.items.filter((i) => !list.some((l) => l.id === i.id))]);
      setUnread(page.unread);
      setNext(page.next);
    } catch {
      setProblem(t('inbox.actionFailed'));
    }
  };

  const change = async (
    item: InboxItem,
    what: { read?: boolean; snoozedUntil?: string | null },
  ) => {
    setProblem(null);
    setSnoozeMenu(null);
    try {
      const answer = await client.update(item.id, what);
      setUnread(answer.unread);
      const leaves =
        what.snoozedUntil !== undefined || (unreadOnly && answer.item.read && view !== 'snoozed');
      setItems((list) =>
        leaves
          ? list.filter((i) => i.id !== item.id)
          : list.map((i) => (i.id === item.id ? answer.item : i)),
      );
    } catch {
      setProblem(t('inbox.actionFailed'));
    }
  };

  const markAll = async () => {
    if (view === 'snoozed') return;
    setProblem(null);
    setBusy(true);
    const newest = items
      .map((i) => BigInt(i.id))
      .reduce<bigint | null>((a, b) => (a === null || b > a ? b : a), null);
    try {
      const answer = await client.readAll({
        view,
        ...filters,
        ...(newest !== null ? { upTo: String(newest) } : {}),
      });
      setUnread(answer.unread);
      setNotice(t('inbox.markedAll', { count: answer.marked }));
      await load();
    } catch {
      setProblem(t('inbox.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  const countText = (n: number) =>
    n >= COUNT_CAP ? t('inbox.unreadMore') : t('inbox.unreadCount', { count: n });
  const when = (iso: string) =>
    intl.formatDate(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
  const times = snoozeTimes(now());
  const snoozeOptions: { label: MessageId; at: Date }[] = [
    { label: 'inbox.snooze.hour', at: times.hour },
    { label: 'inbox.snooze.tomorrow', at: times.tomorrow },
    { label: 'inbox.snooze.nextWeek', at: times.nextWeek },
  ];

  return (
    <section aria-labelledby={titleId} className="inbox-page">
      <div className="inbox-header">
        <h1 id={titleId} className="page-title">
          {t('inbox.title')}
        </h1>
        <p className="inbox-count">{countText(unread.all)}</p>
      </div>
      <div className="inbox-toolbar">
        <fieldset className="inbox-views">
          <legend className="visually-hidden">{t('inbox.views')}</legend>
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              className="inbox-view"
              aria-pressed={view === v.id}
              onClick={() => {
                setNotice(null);
                setView(v.id);
              }}
            >
              {t(v.label)}
              {v.id !== 'snoozed' && (unread[v.id] ?? 0) > 0 && (
                <>
                  {' '}
                  <span className="inbox-view-count">
                    {(unread[v.id] ?? 0) >= COUNT_CAP
                      ? '999+'
                      : intl.formatNumber(unread[v.id] ?? 0)}
                  </span>
                </>
              )}
            </button>
          ))}
        </fieldset>
        <label className="inbox-unread-only">
          <input
            type="checkbox"
            checked={unreadOnly}
            onChange={(e) => setUnreadOnly(e.currentTarget.checked)}
          />
          {t('inbox.unreadOnly')}
        </label>
        <label className="inbox-filter">
          <span>{t('inbox.filter.type')}</span>
          <select value={type} onChange={(e) => setType(e.currentTarget.value)}>
            <option value="">{t('inbox.filter.anyType')}</option>
            {TYPES.map((event) => (
              <option key={event} value={event}>
                {t(`notifications.event.${event}` as MessageId)}
              </option>
            ))}
          </select>
        </label>
        <label className="inbox-filter">
          <span>{t('inbox.filter.track')}</span>
          <select value={track} onChange={(e) => setTrack(e.currentTarget.value)}>
            <option value="">{t('inbox.filter.anyTrack')}</option>
            {tracks.map((tr) => (
              <option key={tr.id} value={tr.key}>
                {t('inbox.filter.trackOption', { name: tr.name, key: tr.key })}
              </option>
            ))}
          </select>
        </label>
        {view !== 'snoozed' && (
          <button
            type="button"
            className="button-secondary"
            disabled={busy || unread[view] === 0}
            onClick={() => void markAll()}
          >
            {t('inbox.markAllRead')}
          </button>
        )}
      </div>
      <p role="status" className="form-status">
        {state === 'loading' ? t('inbox.loading') : (notice ?? '')}
      </p>
      {problem && (
        <p role="alert" className="form-error">
          {problem}
        </p>
      )}
      {state === 'failed' && (
        <div role="alert" className="form-error">
          <p>{t('inbox.failed')}</p>
          <button type="button" className="button-secondary" onClick={() => void load()}>
            {t('inbox.retry')}
          </button>
        </div>
      )}
      {state === 'loaded' && items.length === 0 && (
        <p className="page-note">{t(unreadOnly ? 'inbox.empty.unread' : EMPTY[view])}</p>
      )}
      {items.length > 0 && (
        <ul className="inbox-list" aria-labelledby={titleId}>
          {items.map((item) => {
            // An alert has no ticket key: its actions name the alert instead.
            const key = item.ticket?.key ?? t('inbox.alert.label');
            const menuId = `inbox-snooze-${item.id}`;
            return (
              <li key={item.id} className={`inbox-item${item.read ? '' : ' inbox-item-unread'}`}>
                <div className="inbox-body">
                  <p className="inbox-what">
                    {!item.read && (
                      <span className="inbox-dot">
                        <span className="visually-hidden">{t('inbox.unreadMark')}: </span>
                      </span>
                    )}
                    {whatHappened(t, item)}
                  </p>
                  <a
                    className="inbox-ticket"
                    href={linkOf(item)}
                    onClick={() => {
                      if (!item.read) void change(item, { read: true });
                    }}
                  >
                    {item.ticket ? (
                      <>
                        <span className="inbox-key">{key}</span> {item.ticket.summary}
                      </>
                    ) : (
                      alertSubject(t, item) || t('inbox.alert.review')
                    )}
                  </a>
                  {item.comment?.excerpt && (
                    <blockquote className="inbox-quote">{item.comment.excerpt}</blockquote>
                  )}
                  <p className="inbox-meta">
                    {item.ticket && (
                      <span className="ticket-icons">
                        {item.ticket.ticketType && (
                          <TypeIcon
                            name={item.ticket.ticketType.name}
                            icon={item.ticket.ticketType.icon}
                          />
                        )}
                        {item.ticket.priority && (
                          <PriorityIcon
                            name={item.ticket.priority.name}
                            level={item.ticket.priority.level}
                          />
                        )}
                      </span>
                    )}
                    <time dateTime={item.createdAt}>{when(item.createdAt)}</time>
                    {item.direct && <span className="inbox-badge">{t('inbox.direct')}</span>}
                    {item.snoozedUntil && (
                      <span>{t('inbox.snoozedUntil', { time: when(item.snoozedUntil) })}</span>
                    )}
                  </p>
                </div>
                <div className="inbox-actions">
                  <button
                    type="button"
                    className="inbox-action"
                    aria-label={t(item.read ? 'inbox.markUnreadOf' : 'inbox.markReadOf', { key })}
                    onClick={() => void change(item, { read: !item.read })}
                  >
                    {t(item.read ? 'inbox.markUnread' : 'inbox.markRead')}
                  </button>
                  {item.snoozedUntil ? (
                    <button
                      type="button"
                      className="inbox-action"
                      aria-label={t('inbox.unsnoozeOf', { key })}
                      onClick={() => void change(item, { snoozedUntil: null })}
                    >
                      {t('inbox.unsnooze')}
                    </button>
                  ) : (
                    <div className="inbox-snooze">
                      <button
                        type="button"
                        className="inbox-action"
                        aria-label={t('inbox.snoozeOf', { key })}
                        aria-expanded={snoozeMenu === item.id}
                        aria-controls={menuId}
                        onClick={() => setSnoozeMenu((open) => (open === item.id ? null : item.id))}
                      >
                        {t('inbox.snooze')}
                      </button>
                      {snoozeMenu === item.id && (
                        <ul id={menuId} className="inbox-snooze-options">
                          {snoozeOptions.map((option) => (
                            <li key={option.label}>
                              <button
                                type="button"
                                className="inbox-action"
                                onClick={() =>
                                  void change(item, { snoozedUntil: option.at.toISOString() })
                                }
                              >
                                {t(option.label)}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {next !== null && (
        <button type="button" className="button-secondary" onClick={() => void more()}>
          {t('inbox.more')}
        </button>
      )}
    </section>
  );
}
