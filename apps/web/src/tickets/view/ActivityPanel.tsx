import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useIntl } from 'react-intl';
import { ApiError } from '../../api/client';
import { CommentsPanel } from '../../comments/CommentsPanel';
import { type CommentClient, commentClient } from '../../comments/client';
import { useT } from '../../i18n/I18nProvider';
import type { MessageId } from '../../i18n/messages.en';
import type { MentionSource } from '../../richtext/mentions';
import { useMotionOnChange } from '../../shell/motion';
import { ITEM_STATE_LABELS, type ItemState } from '../tools/checklistStates';
import type { HistoryEntry, TicketClient, TimeEntry } from './client';

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
      <div role="tablist" aria-labelledby={titleId} className="ticket-tabs">
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
        {tab === 'all' && <AllActivity ticket={ticket} client={client} comments={comments} />}
      </div>
    </section>
  );
}

function useWhen() {
  const intl = useIntl();
  return (iso: string) =>
    intl.formatDate(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
}

/** What one history row says, in the reader's words. */
function useChangeText() {
  const t = useT();
  return (c: HistoryEntry) => {
    const id = FIELDS[c.field];
    const field = id
      ? t(id)
      : c.field.startsWith('cf[')
        ? t('ticketView.history.customField')
        : c.field;
    const from = c.from.display ?? c.from.value;
    const to = c.to.display ?? c.to.value;
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
  if (rows.length === 0) return <p className="page-note">{t('ticketView.history.empty')}</p>;
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
        <p className="page-note">{t('ticketView.time.empty')}</p>
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

/** Comments, history and time entries in one stream, newest first (CORE-022 "All"). */
function AllActivity({
  ticket,
  client,
  comments,
}: {
  ticket: { id: number };
  client: TicketClient;
  comments?: CommentClient | undefined;
}) {
  const t = useT();
  const when = useWhen();
  const text = useChangeText();
  const intl = useIntl();
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const said = useMemo(() => comments ?? commentClient(ticket.id), [comments, ticket.id]);

  // Read once per ticket; the words are the reader's, whatever renders meanwhile.
  // biome-ignore lint/correctness/useExhaustiveDependencies: t, text and intl only word the rows
  useEffect(() => {
    let live = true;
    const someone = t('ticketView.someone');
    void Promise.allSettled([
      client.history(ticket.id),
      client.timeEntries(ticket.id),
      said.list(),
    ]).then(([history, time, said]) => {
      if (!live) return;
      const out: FeedItem[] = [];
      if (history.status === 'fulfilled') {
        for (const c of history.value.changes) {
          // Comments and time entries show as themselves below.
          if (c.field === 'comment' || c.field === 'timeEntry') continue;
          out.push({ key: `h${c.id}`, at: c.at, actor: c.actor?.name ?? someone, text: text(c) });
        }
      }
      if (time.status === 'fulfilled') {
        for (const e of time.value) {
          out.push({
            key: `t${e.id}`,
            at: e.startedAt,
            actor: e.author.name,
            text: t('ticketView.all.time', {
              hours: intl.formatNumber(e.duration / 3600, { maximumFractionDigits: 2 }),
            }),
          });
        }
      }
      if (said.status === 'fulfilled') {
        for (const c of said.value.comments) {
          out.push({
            key: `c${c.id}`,
            at: c.createdAt,
            actor: c.author?.name ?? someone,
            text: t('ticketView.all.comment'),
          });
        }
      }
      out.sort((a, b) => b.at.localeCompare(a.at));
      setItems(out);
    });
    return () => {
      live = false;
    };
  }, [client, said, ticket.id]);

  if (items === null) return <p className="page-note">{t('ticketView.loading')}</p>;
  if (items.length === 0) return <p className="page-note">{t('ticketView.history.empty')}</p>;
  return (
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
  );
}
