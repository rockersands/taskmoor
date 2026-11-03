import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import type { AiFeatures } from '../../ai/AiFeature';
import type { AiNoticeClient } from '../../ai/AiNotice';
import { BreakdownAction } from '../../ai/BreakdownAction';
import type { AiClient } from '../../ai/client';
import { SummaryPanel } from '../../ai/SummaryPanel';
import { ApiError } from '../../api/client';
import { AttachmentPanel } from '../../attachments/AttachmentPanel';
import { type AttachmentClient, attachmentClient } from '../../attachments/client';
import type { CommentClient } from '../../comments/client';
import { useT } from '../../i18n/I18nProvider';
import { CollaborativeEditor, type Connect } from '../../richtext/CollaborativeEditor';
import { type EditorTools, EditorToolsProvider } from '../../richtext/EditorTools';
import { type MentionSource, mentionSource } from '../../richtext/mentions';
import { boardBehind } from '../../routing/cameFrom';
import {
  navigate,
  openOverlay,
  replaceOverlay,
  replaceRoute,
  routeHref,
  routeUrl,
  useOverlayRoute,
} from '../../routing/router';
import { useSession } from '../../session/SessionProvider';
import type { Command } from '../../shell/CommandPalette';
import { HelpTip } from '../../shell/HelpTip';
import { IconSelect } from '../../shell/IconSelect';
import { leaveMotion } from '../../shell/motion';
import { usePaletteCommands } from '../../shell/paletteCommands';
import { priorityName } from '../../shell/priorityName';
import { fieldName, typeName } from '../../shell/seededNames';
import { PriorityGlyph, TypeGlyph } from '../../shell/TicketIcons';
import { useSyncEngine } from '../../sync/SyncProvider';
import { refusalMessage, type TransitionRefusal } from '../../workflow/refusal';
import { CloneDialog } from '../clone/CloneDialog';
import type { CloneClient } from '../clone/client';
import { splitLabels } from '../form';
import { ChecklistsPanel } from '../tools/ChecklistsPanel';
import { pickerQuery, type TicketToolsClient, ticketToolsClient } from '../tools/client';
import { LinksPanel } from '../tools/LinksPanel';
import { SubticketsPanel } from '../tools/SubticketsPanel';
import { ActivityPanel, type ActivityTab } from './ActivityPanel';
import {
  type NumberField,
  type Priority,
  type TicketClient,
  type TicketDetails,
  type TicketEdit,
  type Transition,
  ticketClient,
} from './client';
import { InfoPanel } from './InfoPanel';
import { StatusMenu } from './StatusMenu';
import { TICKET_SHORTCUTS } from './shortcuts';
import { TransitionForm } from './TransitionForm';
import { announceTicketChange } from './ticketChanges';

export interface TicketPageProps {
  /** The ticket key or id from the address (#/tickets/<key>). */
  ticket: string;
  /** Stories and tests pass their own endpoints. */
  client?: TicketClient;
  attachments?: AttachmentClient;
  comments?: CommentClient;
  /** Where the Clone action starts its copies (M1-124). */
  clone?: CloneClient;
  /** Links, subtickets and checklists (CORE-031 to CORE-033). */
  tools?: TicketToolsClient;
  /** How the description's shared document opens (M1-017); stories keep it in the page. */
  connect?: Connect;
  /** Where "@" finds people; the backend's list for the ticket by default. */
  mentions?: (ticketId: number) => MentionSource;
  /** The AI features (M1-079): their endpoints, the first-use notice and what is available. */
  ai?: {
    client?: AiClient;
    notice?: AiNoticeClient;
    features?: (trackId?: number) => Promise<AiFeatures>;
  };
}

export interface TicketViewProps extends TicketPageProps {
  /** Shown in the ticket pop-up (TicketPopup.tsx), which is told what to call itself. */
  popup?: { onTicket: (ticket: { key: string; summary: string }) => void };
}

/** Layout fields the page can fill in itself when a transition asks for them (WF-006). */
const FILLABLE = ['close-reason', 'priority'];

/** The dialog the ticket pop-up is: it is the view's own, not one over it. */
export const TICKET_POPUP_CLASS = 'ticket-popup';

const NO_COMMANDS: Command[] = [];

const typing = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    el.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) ||
    el.closest('[contenteditable="true"]') !== null ||
    el.closest(`[role="dialog"]:not(.${TICKET_POPUP_CLASS})`) !== null
  );
};

/** The ticket page: the ticket view, filling the page. */
export function TicketPage(props: TicketPageProps) {
  return <TicketView {...props} />;
}

/**
 * The ticket view (M1-051; CORE-022, AGL-018): the ticket's summary and description, its details
 * with the common fields editable in place, the transitions it offers, follow and vote, its links
 * and attachments, and its activity (comments, history, time entries, or all). Keyboard
 * shortcuts act on it (M comment, W follow, A assign to me, T transitions, E edit, ? help).
 * Two columns on wide screens, one on phones. With the local copy (M1-032) the page shows the
 * ticket from it at once, then from the server. The ticket page and the ticket pop-up both show
 * this one view, so whatever joins it here shows in both.
 */
export function TicketView({
  ticket,
  client = ticketClient,
  attachments,
  comments,
  clone,
  tools,
  connect,
  mentions = (ticketId) => mentionSource({ ticket: ticketId }),
  ai = {},
  popup,
}: TicketViewProps) {
  const t = useT();
  const intl = useIntl();
  const titleId = useId();
  const descriptionId = useId();
  const detailsId = useId();
  const engine = useSyncEngine();
  // The page's own client reads a ticket's links; stories and tests pass one or both.
  const toolsClient = useMemo(
    () => tools ?? { ...ticketToolsClient, links: client.links },
    [tools, client],
  );
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
  const [cloning, setCloning] = useState(false);
  const [tab, setTab] = useState<ActivityTab>('comments');
  const [revision, setRevision] = useState(0);
  const statusMenu = useRef<{ focus: () => void }>(null);
  const helpButton = useRef<HTMLButtonElement>(null);
  const article = useRef<HTMLElement>(null);
  const overOverlay = useOverlayRoute() !== null;

  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    // A dialog belongs to the ticket it was opened on.
    setCloning(false);
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

  // The pop-up is named after its ticket, whatever the view is showing or editing at the time.
  const shownKey = state.status === 'loaded' ? state.ticket.key : null;
  const shownSummary = state.status === 'loaded' ? state.ticket.summary : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: told when the name changes
  useEffect(() => {
    if (shownKey !== null && shownSummary !== null) {
      popup?.onTicket({ key: shownKey, summary: shownSummary });
    }
  }, [shownKey, shownSummary]);

  // What the blocks of its description and comments reach (NTF-013, NTF-014): the ticket's files,
  // read once per page unless the menu asks again, and tickets through search.
  const editorTools = useMemo<EditorTools>(() => {
    if (ticketId === null) return {};
    const files = attachments ?? attachmentClient(ticketId);
    let read: ReturnType<NonNullable<EditorTools['attachments']>> | null = null;
    return {
      attachments: (fresh) => {
        if (fresh || !read) {
          read = files.list().then(({ attachments: list }) =>
            list.map((file) => ({
              name: file.name,
              image: file.kind === 'image',
              href: files.urls.content(file),
              thumbnail: file.thumbnail ? files.urls.thumbnail(file) : null,
            })),
          );
        }
        return read;
      },
      tickets: (typed) => {
        const query = pickerQuery(typed);
        return query ? toolsClient.pick(query) : Promise.resolve([]);
      },
    };
  }, [ticketId, attachments, toolsClient]);

  // A change made elsewhere reaches the local copy through the socket (NTF-008): when this
  // ticket's row there moves on, the page reads the ticket again, so the open view follows
  // without a reload. Its own edits come back the same way, which changes nothing.
  useEffect(() => {
    if (!engine || ticketId === null) return;
    let live = true;
    let seen: string | null = null;
    const print = (row: Record<string, unknown> | null) => (row ? JSON.stringify(row) : '');
    void engine.ticketByKey(ticket).then((row) => {
      if (live) seen = print(row);
    });
    const unsubscribe = engine.subscribe(() => {
      void engine.ticketByKey(ticket).then((row) => {
        const now = print(row);
        if (!live || seen === null || now === seen) return;
        seen = now;
        client.get(ticket).then(
          (found) => {
            if (!live) return;
            setState((s) => (s.status === 'loaded' ? { status: 'loaded', ticket: found } : s));
            setRevision((r) => r + 1);
          },
          () => {},
        );
      });
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [engine, ticket, ticketId, client]);

  // What the ticket offers this person: transitions, following and votes. Each fails quietly.
  // A follow or vote made while a refresh is on its way wins over that refresh's older answer.
  const followSeq = useRef(0);
  const voteSeq = useRef(0);
  const refreshAround = useCallback(
    async (id: number) => {
      const seen = { follow: followSeq.current, vote: voteSeq.current };
      const [offered, follows, voted] = await Promise.allSettled([
        client.transitions(id),
        client.following(id),
        client.votes(id),
      ]);
      setTransitions(offered.status === 'fulfilled' ? offered.value : []);
      if (seen.follow === followSeq.current) {
        setFollowing(follows.status === 'fulfilled' ? follows.value : null);
      }
      if (seen.vote === voteSeq.current) {
        setVotes(voted.status === 'fulfilled' ? voted.value : null);
      }
    },
    [client],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: once the server's ticket is in
  useEffect(() => {
    if (loaded) void refreshAround(loaded.id);
  }, [loaded?.id, refreshAround]);
  // Opened: the home page's Recent list remembers it (M1-052). A failure costs nothing here.
  useEffect(() => {
    if (ticketId !== null) client.visit?.(ticketId).catch(() => {});
  }, [client, ticketId]);

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
        if (body?.error === 'transition_refused' && (body as Partial<TransitionRefusal>).by) {
          return refusalMessage(t, body as unknown as TransitionRefusal);
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
    // The page beneath the pop-up shows it at once.
    if (popup) announceTicketChange();
  };

  // A link, subticket or checklist changed: history reads again, and so does the page beneath.
  const toolChanged = () => {
    setRevision((r) => r + 1);
    if (popup) announceTicketChange();
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
    followSeq.current += 1;
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
    voteSeq.current += 1;
    try {
      await client.vote(loaded.id, !votes.mine);
      setVotes(await client.votes(loaded.id));
    } catch (error) {
      setProblem(refusal(error));
    }
  };
  /** The ticket's full address, for the clipboard; refused, the page shows it to copy by hand. */
  const copyLink = async (key: string) => {
    const link = routeUrl(`#/tickets/${encodeURIComponent(key)}`);
    setProblem(null);
    try {
      await navigator.clipboard.writeText(link);
      setMessage(t('ticketView.linkCopied', { key }));
    } catch {
      setMessage(t('ticketView.linkIs', { link }));
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
    // The keys are the top view's: the pop-up's, unless a dialog is over it, and never the page's.
    const over = document.querySelector(`.${TICKET_POPUP_CLASS}`);
    if (popup ? over?.querySelector('[role="dialog"], [role="alertdialog"]') : over) return;
    const key = event.key.toLowerCase();
    if (key === '?') {
      event.preventDefault();
      setHelping(true);
    } else if (key === 'm') {
      event.preventDefault();
      setTab('comments');
      // The comment editor, once the tab shows it: it may take a few frames to mount.
      let tries = 0;
      const focusEditor = () => {
        const editor = article.current?.querySelector<HTMLElement>(
          '.comment-composer [contenteditable]',
        );
        if (editor) editor.focus();
        else if (++tries < 40) window.setTimeout(focusEditor, 25);
      };
      window.setTimeout(focusEditor, 0);
    } else if (key === 'w') {
      event.preventDefault();
      void toggleFollow();
    } else if (key === 'a') {
      event.preventDefault();
      assignToMe();
    } else if (key === 't') {
      event.preventDefault();
      statusMenu.current?.focus();
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

  // Every action of the view is in the command palette too (AGL-018 (1)). The commands call
  // the latest handlers through a ref, so they change only when what they offer changes.
  const actions = useRef({ transition, toggleFollow, toggleVote, assignToMe, edit, copyLink });
  actions.current = { transition, toggleFollow, toggleVote, assignToMe, edit, copyLink };
  const key = loaded?.key ?? null;
  // Opened by an earlier key (a moved ticket, a renamed track; M1-128): the address shows the
  // current one, without a new history entry.
  useEffect(() => {
    if (key !== null && !/^\d+$/.test(ticket) && key.toUpperCase() !== ticket.toUpperCase()) {
      (popup ? replaceOverlay : replaceRoute)(`#/tickets/${encodeURIComponent(key)}`);
    }
  }, [key, ticket, popup]);
  const assigneeId = loaded?.assignee?.id ?? null;
  const commands = useMemo<Command[]>(() => {
    if (key === null) return [];
    const values = { key };
    const list: Command[] = transitions.map((to) => ({
      id: `ticket-transition-${to.id}`,
      labelId: 'palette.ticket.transition',
      values: { key, transition: to.name },
      keywords: ['transition', 'move', 'status'],
      run: () => void actions.current.transition(to),
    }));
    if (me.id && assigneeId !== me.id) {
      list.push({
        id: 'ticket-assign-to-me',
        labelId: 'palette.ticket.assignToMe',
        values,
        keywords: ['assign', 'take'],
        run: () => actions.current.assignToMe(),
      });
    }
    if (assigneeId !== null) {
      list.push({
        id: 'ticket-unassign',
        labelId: 'palette.ticket.unassign',
        values,
        keywords: ['assign'],
        run: () => void actions.current.edit({ assigneeId: null }),
      });
    }
    if (following) {
      list.push({
        id: 'ticket-follow',
        labelId: following.mine ? 'palette.ticket.unfollow' : 'palette.ticket.follow',
        values,
        keywords: ['watch', 'follow'],
        run: () => void actions.current.toggleFollow(),
      });
    }
    if (votes) {
      list.push({
        id: 'ticket-vote',
        labelId: votes.mine ? 'palette.ticket.unvote' : 'palette.ticket.vote',
        values,
        keywords: ['vote'],
        run: () => void actions.current.toggleVote(),
      });
    }
    const showTab = (id: string, tab: ActivityTab, labelId: Command['labelId']) =>
      list.push({ id, labelId, values, keywords: ['activity'], run: () => setTab(tab) });
    list.push({
      id: 'ticket-comment',
      labelId: 'palette.ticket.comment',
      values,
      keywords: ['comment', 'reply'],
      run: () => {
        setTab('comments');
        window.setTimeout(() => {
          article.current
            ?.querySelector<HTMLElement>('.comment-composer [contenteditable]')
            ?.focus();
        }, 0);
      },
    });
    list.push({
      id: 'ticket-edit-summary',
      labelId: 'palette.ticket.editSummary',
      values,
      keywords: ['edit', 'rename', 'title'],
      run: () => setEditingSummary(true),
    });
    showTab('ticket-history', 'history', 'palette.ticket.history');
    showTab('ticket-time', 'time', 'palette.ticket.time');
    showTab('ticket-all-activity', 'all', 'palette.ticket.all');
    list.push({
      id: 'ticket-copy-link',
      labelId: 'palette.ticket.copyLink',
      values,
      keywords: ['link', 'url', 'share'],
      run: () => void actions.current.copyLink(key),
    });
    list.push({
      id: 'ticket-shortcuts',
      labelId: 'palette.ticket.shortcuts',
      keywords: ['keyboard', 'help', 'keys'],
      run: () => setHelping(true),
    });
    return list;
  }, [key, assigneeId, me.id, transitions, following, votes]);
  // Under a pop-up the palette offers the pop-up's ticket, not this one's too.
  usePaletteCommands(
    popup ? 'ticket-popup' : 'ticket-view',
    popup || !overOverlay ? commands : NO_COMMANDS,
  );

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
  // A pop-up leaves its page where it is; the full page opened from one has the way back.
  const behind = popup ? null : boardBehind(ticket);
  const when = (iso: string) =>
    intl.formatDate(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <article ref={article} aria-labelledby={titleId} className="ticket-page ticket-view">
      <header className="ticket-header">
        {behind && (
          <a
            className="ticket-back"
            href={routeHref(
              `#/boards/${behind.id}${behind.people ? `?people=${behind.people}` : ''}`,
            )}
          >
            {t('ticketPage.backToBoard', { name: behind.name })}
          </a>
        )}
        <p className="ticket-crumbs page-eyebrow">
          {shown.track.name && (
            <TypeGlyph name={shown.ticketType.name} icon={shown.ticketType.icon} />
          )}
          <span>
            {shown.track.name ? `${shown.track.name} · ${typeName(t, shown.ticketType.name)}` : ''}
          </span>
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
            <HelpTip name={shown.key}>{t('about.ticket')}</HelpTip>
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
            <StatusMenu
              ref={statusMenu}
              status={loaded.status}
              transitions={transitions}
              onChoose={(to) => void transition(to)}
            />
            <span className="ticket-toolbar-gap" aria-hidden="true" />
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
              type="button"
              className="button-secondary ticket-action"
              onClick={() => setCloning(true)}
            >
              {t('clone.action')}
            </button>
            <button
              type="button"
              className="button-secondary ticket-action"
              onClick={() => void copyLink(loaded.key)}
            >
              {t('ticketView.copyLink')}
            </button>
            <BreakdownAction
              ticket={{ id: loaded.id, key: loaded.key }}
              trackId={loaded.track.id}
              {...(ai.client ? { client: ai.client } : {})}
              {...(ai.notice ? { notice: ai.notice } : {})}
              {...(ai.features ? { features: ai.features } : {})}
              onCreated={() => {
                setRevision((r) => r + 1);
                if (popup) announceTicketChange();
              }}
            />
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

      <EditorToolsProvider value={editorTools}>
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
            {loaded && (
              <SummaryPanel
                ticket={{ id: loaded.id, key: loaded.key }}
                trackId={loaded.track.id}
                {...(ai.client ? { client: ai.client } : {})}
                {...(ai.notice ? { notice: ai.notice } : {})}
                {...(ai.features ? { features: ai.features } : {})}
              />
            )}
            {loaded && (
              <ChecklistsPanel
                ticket={loaded}
                client={toolsClient}
                revision={revision}
                onChanged={toolChanged}
              />
            )}
            {loaded && (
              <SubticketsPanel
                ticket={loaded}
                client={toolsClient}
                revision={revision}
                onChanged={toolChanged}
              />
            )}
            {loaded && (
              <LinksPanel
                ticket={loaded}
                client={toolsClient}
                revision={revision}
                onChanged={toolChanged}
              />
            )}
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
            <div className="ticket-side">
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
              <InfoPanel ticketId={loaded.id} client={client} revision={revision} />
            </div>
          )}
        </div>
      </EditorToolsProvider>
      {cloning && loaded && (
        <CloneDialog
          ticket={{
            id: loaded.id,
            key: loaded.key,
            summary: loaded.summary,
            track: loaded.track,
            level: loaded.ticketType.level?.rank ?? 0,
          }}
          {...(clone ? { client: clone } : {})}
          onClose={() => setCloning(false)}
          onCloned={(key) => {
            setCloning(false);
            const copy = `#/tickets/${encodeURIComponent(key)}`;
            // In the pop-up the copy opens there, and Back returns to the ticket it came from.
            if (popup) {
              announceTicketChange();
              openOverlay(copy);
            } else {
              navigate(copy);
            }
          }}
        />
      )}
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
      data-no-draft={text === value || undefined}
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
  const [numberFields, setNumberFields] = useState<NumberField[]>([]);
  // The form depends on the ticket's type and its status's edit lock.
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked again when either changes
  useEffect(() => {
    let live = true;
    client.numberFields?.(ticket.id).then(
      (list) => live && setNumberFields(list),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [client, ticket.id, ticket.ticketType.id, ticket.status.id]);

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
          {ticket.mayEdit === false ? (
            t('workflow.field.priority')
          ) : (
            <label htmlFor={`${id}-priority`}>{t('workflow.field.priority')}</label>
          )}
        </dt>
        <dd>
          {ticket.mayEdit === false ? (
            // Someone who may not edit sees the value, not a control.
            <span className="ticket-fact-value">
              {ticket.priority ? (
                <>
                  <PriorityGlyph level={ticket.priority.level} />
                  {priorityName(t, ticket.priority.name)}
                </>
              ) : (
                none
              )}
            </span>
          ) : (
            <IconSelect
              id={`${id}-priority`}
              value={String(ticket.priority?.id ?? '')}
              // Only an imported ticket can have none; once chosen there is no going back.
              placeholder={t('priority.choose')}
              options={(priorities ?? (ticket.priority ? [ticket.priority] : [])).map((p) => ({
                value: String(p.id),
                label: priorityName(t, p.name),
                icon: <PriorityGlyph level={p.level} />,
              }))}
              onChange={(next) => void onEdit({ priorityId: Number(next) })}
            />
          )}
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
                onClick={() => setLabels(ticket.labels.join(' '))}
              >
                {t('ticketView.edit')}
              </button>
            </span>
          ) : (
            <form
              className="ticket-inline-form"
              data-no-draft={labels === ticket.labels.join(' ') || undefined}
              onSubmit={(event) => {
                event.preventDefault();
                const next = splitLabels(labels);
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
      {numberFields.map((field) => (
        <NumberFact
          key={field.id}
          field={field}
          value={ticket.fields?.[String(field.id)]}
          readOnly={ticket.mayEdit === false || field.locked}
          onEdit={onEdit}
        />
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
              <a href={routeHref(`#/tickets/${encodeURIComponent(ticket.parent.key)}`)}>
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

/**
 * A number field on the details, such as Points (AGL-007): typed in place, saved on Enter or on
 * leaving the box, Escape puts back what is saved. Someone who may not change it reads the value.
 */
function NumberFact({
  field,
  value,
  readOnly,
  onEdit,
}: {
  field: NumberField;
  value: unknown;
  readOnly: boolean;
  onEdit: (change: TicketEdit) => Promise<boolean>;
}) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const saved = typeof value === 'number' ? String(value) : '';
  const [draft, setDraft] = useState<string | null>(null);
  const name = fieldName(t, field.name);
  const save = () => {
    if (draft === null || draft === saved) {
      setDraft(null);
      return;
    }
    const next = draft === '' ? null : Number(draft);
    void onEdit({ fields: { [field.id]: next } }).then((ok) => ok && setDraft(null));
  };
  if (readOnly) {
    return (
      <div>
        <dt>{name}</dt>
        <dd>{typeof value === 'number' ? intl.formatNumber(value) : t('ticketView.none')}</dd>
      </div>
    );
  }
  return (
    <div>
      <dt>
        <label htmlFor={id}>{name}</label>
      </dt>
      <dd>
        <form
          className="ticket-inline-form"
          data-no-draft={draft === null || draft === saved || undefined}
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <input
            id={id}
            type="number"
            step="any"
            value={draft ?? saved}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={save}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                save();
              }
              if (event.key === 'Escape' && draft !== null) {
                event.stopPropagation();
                setDraft(null);
              }
            }}
          />
        </form>
      </dd>
    </div>
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
        ref={leaveMotion}
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
          {TICKET_SHORTCUTS.map(([key, label]) => (
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
