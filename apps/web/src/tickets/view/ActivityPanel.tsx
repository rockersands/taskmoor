import { type KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { type IntlShape, useIntl } from 'react-intl';
import { ApiError } from '../../api/client';
import { CommentsPanel } from '../../comments/CommentsPanel';
import type { CommentClient } from '../../comments/client';
import { dayText, isCalendarDay, isInstant, momentText } from '../../i18n/days';
import { useT } from '../../i18n/I18nProvider';
import type { MessageId } from '../../i18n/messages.en';
import type { MentionSource } from '../../richtext/mentions';
import { EmptyState } from '../../shell/EmptyState';
import { useMoreSides } from '../../shell/moreSides';
import { useMotionOnChange } from '../../shell/motion';
import { ITEM_STATE_LABELS, type ItemState } from '../tools/checklistStates';
import type { ActivityPage, HistoryEntry, TicketClient, TimeEntry } from './client';

export type ActivityTab = 'comments' | 'history' | 'time' | 'all';
const TABS: { id: ActivityTab; label: MessageId }[] = [
  { id: 'comments', label: 'ticketView.activity.comments' },
  { id: 'history', label: 'ticketView.activity.history' },
  { id: 'time', label: 'ticketView.activity.time' },
  { id: 'all', label: 'ticketView.activity.all' },
];

const FIELDS: Record<string, MessageId> = {
  summary: 'workflow.field.summary',
  description: 'workflow.field.description',
  environment: 'workflow.field.environment',
  assignee: 'workflow.field.assignee',
  requester: 'workflow.field.requester',
  priority: 'workflow.field.priority',
  labels: 'workflow.field.labels',
  startDate: 'workflow.field.startDate',
  dueDate: 'workflow.field.dueDate',
  originalEstimate: 'workflow.field.originalEstimate',
  remainingEstimate: 'workflow.field.remainingEstimate',
  timeSpent: 'workflow.field.timeSpent',
  closeReason: 'workflow.field.closeReason',
  targetRelease: 'workflow.field.targetRelease',
  foundInRelease: 'workflow.field.foundInRelease',
  area: 'workflow.field.area',
  parent: 'workflow.field.parent',
  type: 'workflow.field.ticketType',
  status: 'ticketView.field.status',
  visibilityLevel: 'ticketView.field.visibilityLevel',
  track: 'ticketView.field.track',
  key: 'ticketView.field.key',
  comment: 'ticketView.history.comment',
  attachment: 'ticketView.history.attachment',
  link: 'ticketView.history.link',
  webLink: 'ticketView.history.webLink',
  checklist: 'ticketTools.history.checklist',
  checklistItem: 'ticketTools.history.item',
  checklistOrder: 'ticketTools.history.order',
  timeEntry: 'ticketView.history.timeEntry',
  trash: 'ticketView.history.trash',
  rank: 'ticketView.history.rank',
};

export interface ActivityPanelProps {
  ticket: { id: number; key: string };
  client: TicketClient;
  comments?: CommentClient | undefined;
  mentions?: MentionSource | undefined;
  /** Asked to show a tab from outside (the comment shortcut). */
  tab?: ActivityTab;
  onTab?: (tab: ActivityTab) => void;
  /** Bumped when the ticket changed, so history reads again. */
  revision: number;
}

/**
 * A ticket's activity (CORE-022): comments, its change history, its time entries, or all of them
 * in one stream, newest first. Tabs follow the ARIA pattern: arrow keys move between them.
 */
export function ActivityPanel({
  ticket,
  client,
  comments,
  mentions,
  tab: asked,
  onTab,
  revision,
}: ActivityPanelProps) {
  const t = useT();
  const baseId = useId();
  const titleId = useId();
  const [own, setOwn] = useState<ActivityTab>('comments');
  const tab = asked ?? own;
  const panel = useMotionOnChange<HTMLDivElement>('motion-rise', tab);
  const select = (next: ActivityTab) => {
    setOwn(next);
    onTab?.(next);
  };
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  // The tabs keep one row: where a language's words do not fit, the row scrolls and fades at the
  // edge with more beyond it, as a track's tabs do.
  const strip = useRef<HTMLDivElement>(null);
  const more = useMoreSides(strip, TABS.map((item) => t(item.label)).join());
  const onKey = (event: KeyboardEvent, index: number) => {
    const step =
      event.key === 'ArrowRight'
        ? 1
        : event.key === 'ArrowLeft'
          ? -1
          : event.key === 'Home'
            ? -index
            : event.key === 'End'
              ? TABS.length - 1 - index
              : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = TABS[(index + step + TABS.length) % TABS.length] as (typeof TABS)[number];
    select(next.id);
    refs.current[next.id]?.focus();
  };

  return (
    <section aria-labelledby={titleId} className="ticket-activity">
      <h2 id={titleId} className="ticket-section-title">
        {t('ticketView.activity')}
      </h2>
      <div
        ref={strip}
        role="tablist"
        aria-labelledby={titleId}
        className="ticket-tabs"
        data-more={more}
      >
        {TABS.map((item, index) => (
          <button
            key={item.id}
            ref={(el) => {
              refs.current[item.id] = el;
            }}
            id={`${baseId}-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            aria-controls={`${baseId}-panel-${item.id}`}
            tabIndex={tab === item.id ? 0 : -1}
            className="ticket-tab"
            onClick={() => select(item.id)}
            onKeyDown={(event) => onKey(event, index)}
          >
            {t(item.label)}
          </button>
        ))}
      </div>
      <div
        ref={panel}
        id={`${baseId}-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`${baseId}-tab-${tab}`}
        className="ticket-tabpanel"
      >
        {tab === 'comments' && (
          <CommentsPanel
            ticket={ticket.id}
            ticketKey={ticket.key}
            mentions={mentions}
            {...(comments ? { client: comments } : {})}
          />
        )}
        {tab === 'history' && <HistoryList ticket={ticket} client={client} revision={revision} />}
        {tab === 'time' && <TimeEntries ticket={ticket} client={client} />}
        {tab === 'all' && <AllActivity ticket={ticket} client={client} revision={revision} />}
      </div>
    </section>
  );
}

function useWhen() {
  const intl = useIntl();
  return (iso: string) => momentText(intl, iso);
}

/** What a history row or an activity entry says changed. */
type Change = Pick<HistoryEntry, 'field' | 'fieldName' | 'valueType' | 'from' | 'to'>;

/** The fields whose values are calendar days (`YYYY-MM-DD`), read in the reader's locale. */
const DAY_FIELDS = new Set(['startDate', 'dueDate']);

/**
 * How a history row's value reads: a name the server gave; else a calendar day (a start or due
 * date, a custom date field) or a moment (a custom date-and-time field, T-277) in the reader's
 * locale; else as recorded.
 */
function sideText(intl: IntlShape, c: Change, side: Change['from']): string | null {
  if (side.display !== null) return side.display;
  const day = DAY_FIELDS.has(c.field) || c.valueType === 'date';
  if (day && isCalendarDay(side.value)) return dayText(intl, side.value);
  if (c.valueType === 'datetime' && isInstant(side.value)) return momentText(intl, side.value);
  return side.value;
}

/** What one history row says, in the reader's words. */
function useChangeText() {
  const t = useT();
  const intl = useIntl();
  return (c: Change) => {
    const id = FIELDS[c.field];
    // A custom field by its name where the reader sees it on the ticket (T-277).
    const field = id
      ? t(id)
      : c.field.startsWith('cf[')
        ? (c.fieldName ?? t('ticketView.history.customField'))
        : c.field;
    const from = sideText(intl, c, c.from);
    const to = sideText(intl, c, c.to);
    if (c.field === 'checklistItemState') {
      const stateName = (value: string | null) =>
        t(ITEM_STATE_LABELS[value as ItemState] ?? 'ticketTools.state.open');
      return t('ticketTools.history.state', {
        item: c.to.display ?? '',
        from: stateName(c.from.value),
        to: stateName(c.to.value),
      });
    }
    if (c.field === 'comment') {
      return t(
        to === null ? 'ticketView.history.commentDeleted' : 'ticketView.history.commentAdded',
      );
    }
    if (c.field === 'timeEntry') {
      return t(to === null ? 'ticketView.history.timeDeleted' : 'ticketView.history.timeLogged');
    }
    if (from === null || from === '') return t('ticketView.history.set', { field, to: to ?? '' });
    if (to === null || to === '') return t('ticketView.history.cleared', { field, from });
    return t('ticketView.history.changed', { field, from, to });
  };
}

function HistoryList({
  ticket,
  client,
  revision,
}: {
  ticket: { id: number };
  client: TicketClient;
  revision: number;
}) {
  const t = useT();
  const when = useWhen();
  const text = useChangeText();
  const [rows, setRows] = useState<HistoryEntry[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: read again when the ticket changes
  useEffect(() => {
    let live = true;
    client.history(ticket.id).then(
      (page) => {
        if (!live) return;
        setRows(page.changes);
        setNext(page.next);
      },
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [client, ticket.id, revision]);

  const more = async () => {
    if (next === null) return;
    const page = await client.history(ticket.id, next);
    setRows((r) => [...(r ?? []), ...page.changes]);
    setNext(page.next);
  };

  if (failed) return <p className="page-note">{t('ticketView.history.failed')}</p>;
  if (rows === null) return <p className="page-note">{t('ticketView.loading')}</p>;
  if (rows.length === 0) return <EmptyState compact title={t('ticketView.history.empty')} />;
  return (
    <>
      <ol className="ticket-feed">
        {rows.map((c) => (
          <li key={c.id} className="ticket-feed-item">
            <p className="ticket-feed-meta">
              <span className="ticket-feed-actor">{c.actor?.name ?? t('ticketView.someone')}</span>
              <span className="ticket-feed-date">{when(c.at)}</span>
            </p>
            <p className="ticket-feed-text">{text(c)}</p>
          </li>
        ))}
      </ol>
      {next !== null && (
        <button type="button" className="button-secondary" onClick={() => void more()}>
          {t('ticketView.history.more')}
        </button>
      )}
    </>
  );
}

function TimeEntries({ ticket, client }: { ticket: { id: number }; client: TicketClient }) {
  const t = useT();
  const when = useWhen();
  const intl = useIntl();
  const durationId = useId();
  const noteId = useId();
  const [entries, setEntries] = useState<TimeEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [duration, setDuration] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    try {
      setEntries(await client.timeEntries(ticket.id));
    } catch {
      setFailed(true);
    }
  }, [client, ticket.id]);
  useEffect(() => {
    void load();
  }, [load]);

  const hours = (seconds: number) =>
    t('ticketView.time.hours', {
      hours: intl.formatNumber(seconds / 3600, { maximumFractionDigits: 2 }),
    });

  const log = async () => {
    setProblem(null);
    if (duration.trim() === '') {
      setProblem(t('ticketView.time.required'));
      return;
    }
    try {
      const entry = await client.logTime(ticket.id, { duration, description: note });
      setEntries((e) => [...(e ?? []), entry]);
      setDuration('');
      setNote('');
      setMessage(t('ticketView.time.logged'));
    } catch (error) {
      const body =
        error instanceof ApiError
          ? (error.body as { error?: string; fields?: Record<string, string> })
          : null;
      setProblem(
        body?.error === 'time_tracking_disabled'
          ? t('ticketView.time.disabled')
          : body?.error === 'forbidden'
            ? t('ticketView.time.forbidden')
            : body?.fields?.duration
              ? t('ticketView.time.invalid')
              : t('ticketView.problem.other'),
      );
    }
  };

  return (
    <div className="ticket-time">
      {failed ? (
        <p className="page-note">{t('ticketView.time.failed')}</p>
      ) : entries === null ? (
        <p className="page-note">{t('ticketView.loading')}</p>
      ) : entries.length === 0 ? (
        <EmptyState compact title={t('ticketView.time.empty')} />
      ) : (
        <ol className="ticket-feed">
          {entries.map((e) => (
            <li key={e.id} className="ticket-feed-item">
              <p className="ticket-feed-meta">
                <span className="ticket-feed-actor">{e.author.name}</span>
                <span className="ticket-feed-date">{when(e.startedAt)}</span>
              </p>
              <p className="ticket-feed-text">
                {hours(e.duration)}
                {e.description ? ` · ${e.description}` : ''}
              </p>
            </li>
          ))}
        </ol>
      )}
      <form
        className="ticket-time-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void log();
        }}
      >
        <div className="form-field">
          <label htmlFor={durationId} className="form-label">
            {t('ticketView.time.duration')}
          </label>
          <input
            id={durationId}
            type="text"
            value={duration}
            aria-describedby={`${durationId}-hint`}
            onChange={(event) => setDuration(event.target.value)}
          />
          <p id={`${durationId}-hint`} className="form-hint">
            {t('ticketView.time.durationHint')}
          </p>
        </div>
        <div className="form-field">
          <label htmlFor={noteId} className="form-label">
            {t('ticketView.time.note')}
          </label>
          <input
            id={noteId}
            type="text"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
        {problem && (
          <p role="alert" className="form-error">
            {problem}
          </p>
        )}
        <p role="status" className="form-status">
          {message}
        </p>
        <div className="form-actions">
          <button type="submit" className="button-primary">
            {t('ticketView.time.log')}
          </button>
        </div>
      </form>
    </div>
  );
}

interface FeedItem {
  key: string;
  at: string;
  actor: string;
  text: string;
}

/**
 * Comments, history and time entries in one stream, newest first (CORE-022 "All"), read from the
 * ticket's activity a page at a time (T-309): a busy ticket's newest comments and its oldest
 * changes are all there, the older ones behind "Show older activity". A page carries the time
 * entries that started in the stretch of time its changes cover, so the stream stays in order
 * as pages are added. Read again when the ticket changes, live updates included.
 */
function AllActivity({
  ticket,
  client,
  revision,
}: {
  ticket: { id: number };
  client: TicketClient;
  revision: number;
}) {
  const t = useT();
  const when = useWhen();
  const text = useChangeText();
  const intl = useIntl();
  const [pages, setPages] = useState<ActivityPage[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const [reading, setReading] = useState(false);
  /** Bumped by every fresh read, so a page asked for before it is dropped. */
  const reads = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: read again when the ticket changes
  useEffect(() => {
    let live = true;
    const read = ++reads.current;
    setFailed(false);
    setMoreFailed(false);
    client.activity(ticket.id).then(
      (page) => {
        if (!live || read !== reads.current) return;
        setPages([page]);
        setNext(page.next);
      },
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [client, ticket.id, revision]);

  const more = async () => {
    if (next === null || reading) return;
    const read = reads.current;
    setReading(true);
    setMoreFailed(false);
    try {
      const page = await client.activity(ticket.id, next);
      if (read !== reads.current) return;
      setPages((p) => [...(p ?? []), page]);
      setNext(page.next);
    } catch {
      if (read === reads.current) setMoreFailed(true);
    } finally {
      setReading(false);
    }
  };

  const someone = t('ticketView.someone');
  const items: FeedItem[] = [];
  const timeSeen = new Set<number>();
  for (const page of pages ?? []) {
    for (const entry of page.activity) {
      entry.changes.forEach((c, index) => {
        const key = `h${entry.changeSet}-${index}`;
        const actor = entry.actor?.name ?? someone;
        if (c.field === 'comment') {
          // A comment shows while it is there; its deletion and deleted ones do not.
          if (c.to.value !== null && entry.comment && entry.comment.excerpt !== null) {
            items.push({ key, at: entry.at, actor, text: t('ticketView.all.comment') });
          }
          return;
        }
        // Time entries show as themselves, below.
        if (c.field === 'timeEntry') return;
        items.push({ key, at: entry.at, actor, text: text(c) });
      });
    }
    for (const e of page.timeEntries) {
      if (timeSeen.has(e.id)) continue;
      timeSeen.add(e.id);
      items.push({
        key: `t${e.id}`,
        at: e.startedAt,
        actor: e.author.name,
        text: t('ticketView.all.time', {
          hours: intl.formatNumber(e.duration / 3600, { maximumFractionDigits: 2 }),
        }),
      });
    }
  }
  items.sort((a, b) => b.at.localeCompare(a.at));

  if (failed) return <p className="page-note">{t('ticketView.all.failed')}</p>;
  if (pages === null) return <p className="page-note">{t('ticketView.loading')}</p>;
  if (items.length === 0 && next === null) {
    return <EmptyState compact title={t('ticketView.history.empty')} />;
  }
  return (
    <>
      {items.length > 0 && (
        <ol className="ticket-feed">
          {items.map((item) => (
            <li key={item.key} className="ticket-feed-item">
              <p className="ticket-feed-meta">
                <span className="ticket-feed-actor">{item.actor}</span>
                <span className="ticket-feed-date">{when(item.at)}</span>
              </p>
              <p className="ticket-feed-text">{item.text}</p>
            </li>
          ))}
        </ol>
      )}
      {moreFailed && (
        <p role="alert" className="form-error">
          {t('ticketView.all.failed')}
        </p>
      )}
      {next !== null && (
        <button
          type="button"
          className="button-secondary"
          aria-busy={reading}
          onClick={() => void more()}
        >
          {t('ticketView.all.more')}
        </button>
      )}
    </>
  );
}
