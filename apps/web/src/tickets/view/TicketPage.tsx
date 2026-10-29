import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { ApiError } from '../../api/client';
import { AttachmentPanel } from '../../attachments/AttachmentPanel';
import type { AttachmentClient } from '../../attachments/client';
import type { CommentClient } from '../../comments/client';
import { useT } from '../../i18n/I18nProvider';
import { CollaborativeEditor, type Connect } from '../../richtext/CollaborativeEditor';
import { type MentionSource, mentionSource } from '../../richtext/mentions';
import { useSession } from '../../session/SessionProvider';
import { useSyncEngine } from '../../sync/SyncProvider';
import { ActivityPanel, type ActivityTab } from './ActivityPanel';
import {
  type Priority,
  type TicketClient,
  type TicketDetails,
  type TicketEdit,
  type TicketLink,
  type Transition,
  ticketClient,
  type WebLink,
} from './client';

export interface TicketPageProps {
  /** The ticket key or id from the address (#/tickets/<key>). */
  ticket: string;
  /** Stories and tests pass their own endpoints. */
  client?: TicketClient;
  attachments?: AttachmentClient;
  comments?: CommentClient;
  /** How the description's shared document opens (M1-017); stories keep it in the page. */
  connect?: Connect;
  /** Where "@" finds people; the backend's list for the ticket by default. */
  mentions?: (ticketId: number) => MentionSource;
}

/** Layout fields the page can fill in itself when a transition asks for them (WF-006). */
const FILLABLE = ['close-reason', 'priority'];

/** Keys pressed outside a field that act on the ticket (AGL-018 (2)). */
const SHORTCUTS = [
  ['m', 'ticketView.shortcut.comment'],
  ['w', 'ticketView.shortcut.follow'],
  ['a', 'ticketView.shortcut.assign'],
  ['t', 'ticketView.shortcut.transition'],
  ['e', 'ticketView.shortcut.edit'],
  ['?', 'ticketView.shortcut.help'],
] as const;

const typing = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    el.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) ||
    el.closest('[contenteditable="true"], [role="dialog"]') !== null
  );
};

/**
 * The ticket view (M1-051; CORE-022, AGL-018): the ticket's summary and description, its details
 * with the common fields editable in place, the transitions it offers, follow and vote, its links
 * and attachments, and its activity (comments, history, time entries, or all). Keyboard
 * shortcuts act on it (M comment, W follow, A assign to me, T transitions, E edit, ? help).
 * Two columns on wide screens, one on phones. With the local copy (M1-032) the page shows the
 * ticket from it at once, then from the server.
 */
export function TicketPage({
  ticket,
  client = ticketClient,
  attachments,
  comments,
  connect,
  mentions = (ticketId) => mentionSource({ ticket: ticketId }),
}: TicketPageProps) {
  const t = useT();
  const intl = useIntl();
  const titleId = useId();
  const descriptionId = useId();
  const detailsId = useId();
  const engine = useSyncEngine();
  const { session } = useSession();
  const me =
    session.status === 'signed-in'
      ? { id: session.user.id, name: session.user.name }
      : { id: 0, name: '' };
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'missing' }
    | { status: 'loaded'; ticket: TicketDetails; partial?: boolean }
  >({ status: 'loading' });
  const [transitions, setTransitions] = useState<Transition[]>([]);
  const [following, setFollowing] = useState<{ count: number; mine: boolean } | null>(null);
  const [votes, setVotes] = useState<{ count: number; mine: boolean } | null>(null);
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [editingSummary, setEditingSummary] = useState(false);
  const [asking, setAsking] = useState<Transition | null>(null);
  const [helping, setHelping] = useState(false);
  const [tab, setTab] = useState<ActivityTab>('comments');
  const [revision, setRevision] = useState(0);
  const transitionsRef = useRef<HTMLFieldSetElement>(null);
  const helpButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    client.get(ticket).then(
      (found) => live && setState({ status: 'loaded', ticket: found }),
      () => live && setState({ status: 'missing' }),
    );
    return () => {
      live = false;
    };
  }, [ticket, client]);

  // The local copy fills in while the server's answer is on its way, and only then.
  useEffect(() => {
    if (!engine) return;
    let live = true;
    void engine.ticketByKey(ticket).then((local) => {
      if (!live || !local) return;
      setState((s) =>
        s.status === 'loading'
          ? {
              status: 'loaded',
              partial: true,
              ticket: {
                ...placeholder(ticket.toUpperCase()),
                id: local.id,
                summary: local.summary,
              },
            }
          : s,
      );
    });
    return () => {
      live = false;
    };
  }, [ticket, engine]);

  const loaded = state.status === 'loaded' && !state.partial ? state.ticket : null;
  const ticketId = state.status === 'loaded' ? state.ticket.id : null;

  // What the ticket offers this person: transitions, following and votes. Each fails quietly.
  const refreshAround = useCallback(
    async (id: number) => {
      const [offered, follows, voted] = await Promise.allSettled([
        client.transitions(id),
        client.following(id),
        client.votes(id),
      ]);
      setTransitions(offered.status === 'fulfilled' ? offered.value : []);
      setFollowing(follows.status === 'fulfilled' ? follows.value : null);
      setVotes(voted.status === 'fulfilled' ? voted.value : null);
    },
    [client],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: once the server's ticket is in
  useEffect(() => {
    if (loaded) void refreshAround(loaded.id);
  }, [loaded?.id, refreshAround]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: one source per ticket
  const findPeople = useMemo(
    () => (ticketId === null ? undefined : mentions(ticketId)),
    [ticketId],
  );

  const refusal = useCallback(
    (error: unknown) => {
      if (error instanceof ApiError) {
        const body = error.body as {
          error?: string;
          fields?: Record<string, string>;
          locks?: unknown[];
        } | null;
        if (error.status === 403) return t('ticketView.problem.forbidden');
        if (error.status === 409 && body?.error === 'version_conflict') {
          return t('ticketView.problem.stale');
        }
        if (body?.error === 'transition_refused' || body?.error === 'transition_unavailable') {
          return t('ticketView.problem.transition');
        }
        if (body?.fields) {
          return t('ticketView.problem.fields', { fields: Object.keys(body.fields).join(', ') });
        }
      }
      return t('ticketView.problem.other');
    },
    [t],
  );

  const changed = (next: TicketDetails, said: string) => {
    setState({ status: 'loaded', ticket: next });
    setRevision((r) => r + 1);
    setMessage(said);
    setProblem(null);
  };

  const edit = async (change: TicketEdit) => {
    if (!loaded) return false;
    try {
      changed(await client.edit(loaded.id, change), t('ticketView.saved'));
      return true;
    } catch (error) {
      setProblem(refusal(error));
      return false;
    }
  };

  const transition = async (to: Transition, fields: Record<string, unknown> = {}) => {
    if (!loaded) return;
    if (to.layout.some((f) => !(f in fields))) {
      if (to.layout.every((f) => FILLABLE.includes(f))) {
        setAsking(to);
        return;
      }
      setProblem(t('ticketView.problem.layout', { fields: to.layout.join(', ') }));
      return;
    }
    try {
      const next = await client.transition(loaded.id, to.id, fields);
      setAsking(null);
      changed(next, t('ticketView.moved', { status: next.status.name }));
      void refreshAround(next.id);
    } catch (error) {
      setProblem(refusal(error));
    }
  };

  const toggleFollow = async () => {
    if (!loaded || !following) return;
    try {
      await client.follow(loaded.id, !following.mine);
      setFollowing(await client.following(loaded.id));
      setMessage(t(following.mine ? 'ticketView.unfollowed' : 'ticketView.followed'));
    } catch (error) {
      setProblem(refusal(error));
    }
  };
  const toggleVote = async () => {
    if (!loaded || !votes) return;
    try {
      await client.vote(loaded.id, !votes.mine);
      setVotes(await client.votes(loaded.id));
    } catch (error) {
      setProblem(refusal(error));
    }
  };
  const assignToMe = () => {
    if (loaded && me.id && loaded.assignee?.id !== me.id) {
      void edit({ assigneeId: me.id }).then(
        (ok) => ok && setMessage(t('ticketView.assignedToYou')),
      );
    }
  };

  // Shortcuts, outside fields and dialogs, without modifier keys.
  const keys = useRef<(event: KeyboardEvent) => void>(() => {});
  keys.current = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey || typing(event.target)) return;
    const key = event.key.toLowerCase();
    if (key === '?') {
      event.preventDefault();
      setHelping(true);
    } else if (key === 'm') {
      event.preventDefault();
      setTab('comments');
      // The comment editor, once the tab shows it.
      window.setTimeout(() => {
        const editor = document.querySelector<HTMLElement>('.comment-composer [contenteditable]');
        editor?.focus();
      }, 0);
    } else if (key === 'w') {
      event.preventDefault();
      void toggleFollow();
    } else if (key === 'a') {
      event.preventDefault();
      assignToMe();
    } else if (key === 't') {
      event.preventDefault();
      transitionsRef.current?.querySelector('button')?.focus();
    } else if (key === 'e') {
      event.preventDefault();
      setEditingSummary(true);
    }
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keys.current(event);
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, []);

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
  const shown = state.ticket;
  const when = (iso: string) =>
    intl.formatDate(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <article aria-labelledby={titleId} className="ticket-page ticket-view">
      <header className="ticket-header">
        <p className="ticket-crumbs">
          {shown.track.name ? `${shown.track.name} · ${shown.ticketType.name}` : ''}
        </p>
        {editingSummary && loaded ? (
          <SummaryForm
            value={loaded.summary}
            onSave={async (summary) => {
              if (await edit({ summary })) setEditingSummary(false);
            }}
            onCancel={() => setEditingSummary(false)}
          />
        ) : (
          <div className="ticket-title-row">
            <h1 id={titleId} className="page-title">
              {t('ticketPage.title', { key: shown.key, summary: shown.summary })}
            </h1>
            {loaded && (
              <button
                type="button"
                className="button-secondary ticket-action"
                onClick={() => setEditingSummary(true)}
              >
                {t('ticketView.editSummary')}
              </button>
            )}
          </div>
        )}
        {loaded && (
          <div className="ticket-toolbar">
            <span className="ticket-status" data-stage={loaded.status.stage}>
              {loaded.status.name}
            </span>
            {transitions.length > 0 && (
              <fieldset ref={transitionsRef} className="ticket-transitions">
                <legend className="visually-hidden">{t('ticketView.transitions')}</legend>
                {transitions.map((to) => (
                  <button
                    key={to.id}
                    type="button"
                    className="button-secondary ticket-action"
                    aria-label={t('ticketView.transitionTo', { name: to.name, status: to.to.name })}
                    onClick={() => void transition(to)}
                  >
                    {to.name}
                  </button>
                ))}
              </fieldset>
            )}
            {following && (
              <button
                type="button"
                className="button-secondary ticket-action"
                aria-pressed={following.mine}
                onClick={() => void toggleFollow()}
              >
                {t('ticketView.follow', { count: following.count })}
              </button>
            )}
            {votes && (
              <button
                type="button"
                className="button-secondary ticket-action"
                aria-pressed={votes.mine}
                onClick={() => void toggleVote()}
              >
                {t('ticketView.vote', { count: votes.count })}
              </button>
            )}
            <button
              ref={helpButton}
              type="button"
              className="button-secondary ticket-action"
              onClick={() => setHelping(true)}
            >
              {t('ticketView.shortcuts')}
            </button>
          </div>
        )}
        {asking && loaded && (
          <TransitionForm
            transition={asking}
            client={client}
            onRun={(fields) => void transition(asking, fields)}
            onCancel={() => setAsking(null)}
          />
        )}
        <p role="status" className="form-status">
          {message}
        </p>
        {problem && (
          <p role="alert" className="form-error">
            {problem}
          </p>
        )}
      </header>

      <div className="ticket-columns">
        <div className="ticket-main">
          <section aria-labelledby={descriptionId} className="ticket-text">
            <h2 id={descriptionId} className="facts-title">
              {t('ticketPage.description')}
            </h2>
            <CollaborativeEditor
              ticketId={shown.id}
              field="description"
              labelledBy={descriptionId}
              fallback={shown.description ?? null}
              user={me}
              {...(findPeople ? { mentions: findPeople } : {})}
              {...(connect ? { connect } : {})}
            />
          </section>
          {loaded && <LinksPanel ticketId={loaded.id} client={client} revision={revision} />}
          <AttachmentPanel ticket={shown.id} {...(attachments ? { client: attachments } : {})} />
          <ActivityPanel
            ticket={{ id: shown.id, key: shown.key }}
            client={client}
            comments={comments}
            mentions={findPeople}
            tab={tab}
            onTab={setTab}
            revision={revision}
          />
        </div>
        {loaded && (
          <section aria-labelledby={detailsId} className="ticket-details">
            <h2 id={detailsId} className="ticket-section-title">
              {t('ticketView.details')}
            </h2>
            <Details
              ticket={loaded}
              me={me}
              client={client}
              when={when}
              onEdit={edit}
              onAssignToMe={assignToMe}
            />
          </section>
        )}
      </div>
      {helping && (
        <ShortcutsDialog
          onClose={() => {
            setHelping(false);
            helpButton.current?.focus();
          }}
        />
      )}
    </article>
  );
}

/** A ticket known only from the local copy, until the server answers. */
function placeholder(key: string): TicketDetails {
  return {
    id: 0,
    key,
    track: { id: 0, key: '', name: '' },
    ticketType: { id: 0, name: '' },
    parent: null,
    status: { id: 0, name: '', stage: 'new' },
    summary: '',
    assignee: null,
    requester: null,
    startDate: null,
    dueDate: null,
    priority: null,
    closeReason: null,
    visibilityLevel: null,
    labels: [],
    targetReleases: [],
    foundInReleases: [],
    areas: [],
    followerCount: 0,
    voteCount: 0,
    timeTracking: { originalEstimate: null, remainingEstimate: null, timeSpent: 0 },
    version: 0,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function SummaryForm({
  value,
  onSave,
  onCancel,
}: {
  value: string;
  onSave: (summary: string) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const id = useId();
  const [text, setText] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  return (
    <form
      className="ticket-summary-form"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(text.trim());
      }}
    >
      <label htmlFor={id} className="form-label">
        {t('workflow.field.summary')}
      </label>
      <input
        ref={input}
        id={id}
        type="text"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel();
        }}
      />
      <div className="form-actions">
        <button type="submit" className="button-primary">
          {t('ticketView.save')}
        </button>
        <button type="button" className="button-secondary" onClick={onCancel}>
          {t('ticketView.cancel')}
        </button>
      </div>
    </form>
  );
}

/** The fields a transition asks for that the page can fill in: a close reason, a priority. */
function TransitionForm({
  transition,
  client,
  onRun,
  onCancel,
}: {
  transition: Transition;
  client: TicketClient;
  onRun: (fields: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const id = useId();
  const [options, setOptions] = useState<Record<string, Priority[]>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    void Promise.all(
      transition.layout.map(async (field) => {
        const list =
          field === 'close-reason' ? await client.closeReasons() : await client.priorities();
        return [field, list] as const;
      }),
    ).then(
      (pairs) => {
        if (!live) return;
        setOptions(Object.fromEntries(pairs));
        setValues(Object.fromEntries(pairs.map(([f, list]) => [f, String(list[0]?.id ?? '')])));
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [transition, client]);
  const labels: Record<string, Parameters<typeof t>[0]> = {
    'close-reason': 'workflow.field.closeReason',
    priority: 'workflow.field.priority',
  };
  return (
    <form
      className="ticket-transition-form"
      aria-label={t('ticketView.transitionForm', { name: transition.name })}
      onSubmit={(event) => {
        event.preventDefault();
        onRun(
          Object.fromEntries(
            Object.entries(values).map(([field, value]) => [field, value ? Number(value) : null]),
          ),
        );
      }}
    >
      {transition.layout.map((field) => (
        <div key={field} className="form-field">
          <label htmlFor={`${id}-${field}`} className="form-label">
            {t(labels[field] ?? 'workflow.field.closeReason')}
          </label>
          <select
            id={`${id}-${field}`}
            value={values[field] ?? ''}
            onChange={(event) => setValues((v) => ({ ...v, [field]: event.target.value }))}
          >
            {(options[field] ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
      ))}
      <div className="form-actions">
        <button type="submit" className="button-primary">
          {transition.name}
        </button>
        <button type="button" className="button-secondary" onClick={onCancel}>
          {t('ticketView.cancel')}
        </button>
      </div>
    </form>
  );
}

function Details({
  ticket,
  me,
  client,
  when,
  onEdit,
  onAssignToMe,
}: {
  ticket: TicketDetails;
  me: { id: number; name: string };
  client: TicketClient;
  when: (iso: string) => string;
  onEdit: (change: TicketEdit) => Promise<boolean>;
  onAssignToMe: () => void;
}) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const [priorities, setPriorities] = useState<Priority[] | null>(null);
  const [labels, setLabels] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    client.priorities().then(
      (list) => live && setPriorities(list),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [client]);
  const none = t('ticketView.none');
  const hours = (seconds: number | null) =>
    seconds === null
      ? none
      : t('ticketView.time.hours', {
          hours: intl.formatNumber(seconds / 3600, { maximumFractionDigits: 2 }),
        });
  const names = (list: { name: string }[]) =>
    list.length ? list.map((v) => v.name).join(', ') : none;

  return (
    <dl className="ticket-facts">
      <div>
        <dt>{t('ticketView.field.status')}</dt>
        <dd>
          {ticket.status.name}
          {ticket.closeReason ? ` · ${ticket.closeReason.name}` : ''}
        </dd>
      </div>
      <div>
        <dt>{t('workflow.field.assignee')}</dt>
        <dd>
          <span>{ticket.assignee?.name ?? t('ticketView.unassigned')}</span>
          <span className="ticket-fact-actions">
            {me.id !== 0 && ticket.assignee?.id !== me.id && (
              <button
                type="button"
                className="button-secondary ticket-action"
                onClick={onAssignToMe}
              >
                {t('ticketView.assignToMe')}
              </button>
            )}
            {ticket.assignee && (
              <button
                type="button"
                className="button-secondary ticket-action"
                onClick={() => void onEdit({ assigneeId: null })}
              >
                {t('ticketView.unassign')}
              </button>
            )}
          </span>
        </dd>
      </div>
      <div>
        <dt>{t('workflow.field.requester')}</dt>
        <dd>{ticket.requester?.name ?? none}</dd>
      </div>
      <div>
        <dt>
          <label htmlFor={`${id}-priority`}>{t('workflow.field.priority')}</label>
        </dt>
        <dd>
          <select
            id={`${id}-priority`}
            value={ticket.priority?.id ?? ''}
            onChange={(event) =>
              void onEdit({ priorityId: event.target.value ? Number(event.target.value) : null })
            }
          >
            <option value="">{none}</option>
            {(priorities ?? (ticket.priority ? [ticket.priority] : [])).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </dd>
      </div>
      <div>
        <dt>
          <label htmlFor={`${id}-labels`}>{t('workflow.field.labels')}</label>
        </dt>
        <dd>
          {labels === null ? (
            <span className="ticket-fact-actions">
              <span>{ticket.labels.length ? ticket.labels.join(', ') : none}</span>
              <button
                type="button"
                className="button-secondary ticket-action"
                aria-label={t('ticketView.editLabels')}
                onClick={() => setLabels(ticket.labels.join(', '))}
              >
                {t('ticketView.edit')}
              </button>
            </span>
          ) : (
            <form
              className="ticket-inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                const next = labels
                  .split(',')
                  .map((l) => l.trim())
                  .filter(Boolean);
                void onEdit({ labels: next }).then((ok) => ok && setLabels(null));
              }}
            >
              <input
                id={`${id}-labels`}
                type="text"
                value={labels}
                aria-describedby={`${id}-labels-hint`}
                onChange={(event) => setLabels(event.target.value)}
              />
              <p id={`${id}-labels-hint`} className="form-hint">
                {t('ticketView.labelsHint')}
              </p>
              <span className="ticket-fact-actions">
                <button type="submit" className="button-primary ticket-action">
                  {t('ticketView.save')}
                </button>
                <button
                  type="button"
                  className="button-secondary ticket-action"
                  onClick={() => setLabels(null)}
                >
                  {t('ticketView.cancel')}
                </button>
              </span>
            </form>
          )}
        </dd>
      </div>
      {(['startDate', 'dueDate'] as const).map((field) => (
        <div key={field}>
          <dt>
            <label htmlFor={`${id}-${field}`}>{t(`workflow.field.${field}`)}</label>
          </dt>
          <dd>
            <input
              id={`${id}-${field}`}
              type="date"
              value={ticket[field] ?? ''}
              onChange={(event) => void onEdit({ [field]: event.target.value || null })}
            />
          </dd>
        </div>
      ))}
      <div>
        <dt>{t('workflow.field.originalEstimate')}</dt>
        <dd>{hours(ticket.timeTracking.originalEstimate)}</dd>
      </div>
      <div>
        <dt>{t('workflow.field.timeSpent')}</dt>
        <dd>{hours(ticket.timeTracking.timeSpent)}</dd>
      </div>
      <div>
        <dt>{t('workflow.field.remainingEstimate')}</dt>
        <dd>{hours(ticket.timeTracking.remainingEstimate)}</dd>
      </div>
      <div>
        <dt>{t('workflow.field.targetRelease')}</dt>
        <dd>{names(ticket.targetReleases)}</dd>
      </div>
      <div>
        <dt>{t('workflow.field.area')}</dt>
        <dd>{names(ticket.areas)}</dd>
      </div>
      <div>
        <dt>{t('ticketView.field.visibilityLevel')}</dt>
        <dd>{ticket.visibilityLevel?.name ?? t('ticketView.everyone')}</dd>
      </div>
      {ticket.parent && (
        <div>
          <dt>{t('workflow.field.parent')}</dt>
          <dd>
            {ticket.parent.key ? (
              <a href={`#/tickets/${encodeURIComponent(ticket.parent.key)}`}>
                {ticket.parent.key} {ticket.parent.summary}
              </a>
            ) : (
              t('ticketView.hiddenParent')
            )}
          </dd>
        </div>
      )}
      <div>
        <dt>{t('ticketView.field.created')}</dt>
        <dd>{when(ticket.createdAt)}</dd>
      </div>
      <div>
        <dt>{t('ticketView.field.updated')}</dt>
        <dd>{when(ticket.updatedAt)}</dd>
      </div>
    </dl>
  );
}

function LinksPanel({
  ticketId,
  client,
  revision,
}: {
  ticketId: number;
  client: TicketClient;
  revision: number;
}) {
  const t = useT();
  const titleId = useId();
  const [links, setLinks] = useState<{ links: TicketLink[]; webLinks: WebLink[] } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again when the ticket changes
  useEffect(() => {
    let live = true;
    client.links(ticketId).then(
      (found) => live && setLinks(found),
      () => live && setLinks({ links: [], webLinks: [] }),
    );
    return () => {
      live = false;
    };
  }, [client, ticketId, revision]);
  if (!links || (links.links.length === 0 && links.webLinks.length === 0)) return null;
  return (
    <section aria-labelledby={titleId} className="ticket-links">
      <h2 id={titleId} className="ticket-section-title">
        {t('ticketView.links')}
      </h2>
      <ul className="ticket-link-list">
        {links.links.map((l) => (
          <li key={`t${l.id}`}>
            <span className="ticket-link-phrase">{l.phrase}</span>{' '}
            <a
              href={`#/tickets/${encodeURIComponent(l.ticket.key)}`}
              className={l.ticket.closed ? 'ticket-link-closed' : undefined}
            >
              {l.ticket.key}
            </a>{' '}
            {l.ticket.summary}
          </li>
        ))}
        {links.webLinks.map((w) => (
          <li key={`w${w.id}`}>
            <a href={w.url} target="_blank" rel="noopener noreferrer nofollow">
              {w.title || w.url}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const titleId = useId();
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
  }, []);
  return (
    <div className="ticket-dialog-backdrop">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="ticket-dialog"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
          // Focus stays in the dialog: its one control.
          if (event.key === 'Tab') {
            event.preventDefault();
            close.current?.focus();
          }
        }}
      >
        <h2 id={titleId} className="ticket-section-title">
          {t('ticketView.shortcuts')}
        </h2>
        <dl className="ticket-shortcuts">
          {SHORTCUTS.map(([key, label]) => (
            <div key={key}>
              <dt>
                <kbd>{key.toUpperCase()}</kbd>
              </dt>
              <dd>{t(label)}</dd>
            </div>
          ))}
        </dl>
        <div className="form-actions">
          <button ref={close} type="button" className="button-primary" onClick={onClose}>
            {t('ticketView.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
