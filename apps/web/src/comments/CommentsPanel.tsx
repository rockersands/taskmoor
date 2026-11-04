import type { PmJson } from '@taskmoor/richtext';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { useLockText } from '../locks/useLockText';
import type { MentionSource } from '../richtext/mentions';
import { RichTextEditor } from '../richtext/RichTextEditor';
import { RichTextView } from '../richtext/RichTextView';
import { addressRoute, onRouteChange, routeUrl } from '../routing/router';
import {
  type Audiences,
  type Comment,
  type CommentClient,
  type CommentList,
  type CommentVisibility,
  commentClient,
  type MentionWarning,
  type VisibilityChoice,
} from './client';

export interface CommentsPanelProps {
  /** The ticket, by id. */
  ticket: number;
  /** Its key, for links to a comment (#/tickets/<key>?comment=<id>). */
  ticketKey: string;
  /** Stories and tests pass their own endpoints; the panel calls the backend otherwise. */
  client?: CommentClient;
  /** Where "@" finds people. */
  mentions?: MentionSource | undefined;
}

/** The reactions offered in the picker; any emoji others gave shows too. */
const PICKS = ['👍', '👎', '😄', '🎉', '😕', '❤️', '🚀', '👀'];

const choiceOf = (v: CommentVisibility): VisibilityChoice =>
  v === null ? null : 'roleId' in v ? { roleId: v.roleId } : { groupId: v.groupId };
const optionValue = (v: VisibilityChoice): string =>
  v === null ? '' : 'roleId' in v ? `role:${v.roleId}` : `group:${v.groupId}`;
const parseValue = (value: string): VisibilityChoice => {
  const [kind, id] = value.split(':');
  if (kind === 'role') return { roleId: Number(id) };
  if (kind === 'group') return { groupId: Number(id) };
  return null;
};

/** The comment the address points at (#/tickets/<key>?comment=<id>), if any. */
function targetComment(): number | null {
  const match = /[?&]comment=(\d+)/.exec(addressRoute());
  return match ? Number(match[1]) : null;
}

/**
 * A ticket's comments (M1-018, CORE-020): rich text with mentions, oldest first, each with its
 * author and date, an "edited" mark, whom it is restricted to, its reactions, a link to it, and
 * edit and delete where the reader may. The form below adds one, open to everyone who sees the
 * ticket or restricted to a role or group. A status that reserves commenting says so instead.
 * Built to sit in the ticket view (M1-051); cards, so phones never scroll sideways.
 */
export function CommentsPanel({ ticket, ticketKey, client: given, mentions }: CommentsPanelProps) {
  const t = useT();
  const lockText = useLockText();
  const client = useMemo(() => given ?? commentClient(ticket), [given, ticket]);
  const titleId = useId();
  const composerId = useId();
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'failed' } | ({ status: 'loaded' } & CommentList)
  >({ status: 'loading' });
  const [audiences, setAudiences] = useState<Audiences | null>(null);
  const [message, setMessage] = useState('');
  const [target, setTarget] = useState<number | null>(targetComment);

  const load = useCallback(async () => {
    try {
      setState({ status: 'loaded', ...(await client.list()) });
    } catch {
      setState({ status: 'failed' });
    }
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);

  const loaded = state.status === 'loaded' ? state : null;
  const canWrite = Boolean(loaded?.can.add || loaded?.comments.some((c) => c.can.edit));
  useEffect(() => {
    if (!canWrite || audiences) return;
    let live = true;
    client.audiences().then(
      (found) => live && setAudiences(found),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [canWrite, audiences, client]);

  // A link to a comment brings it into view once it is there.
  useEffect(() => {
    return onRouteChange(() => setTarget(targetComment()));
  }, []);
  useEffect(() => {
    if (target === null || !loaded) return;
    const element = document.getElementById(`comment-${target}`);
    element?.scrollIntoView?.({ block: 'center' });
    element?.focus({ preventScroll: true });
  }, [target, loaded]);

  const replace = (comment: Comment) =>
    setState((s) =>
      s.status === 'loaded'
        ? { ...s, comments: s.comments.map((c) => (c.id === comment.id ? comment : c)) }
        : s,
    );

  const more = async () => {
    if (!loaded || loaded.next === null) return;
    try {
      const page = await client.list(loaded.next);
      setState((s) =>
        s.status === 'loaded'
          ? { ...s, comments: [...s.comments, ...page.comments], next: page.next }
          : s,
      );
    } catch {
      setMessage(t('comments.failed'));
    }
  };

  const problemText = useCallback(
    (error: unknown) => {
      if (error instanceof ApiError) {
        const body = error.body as {
          error?: string;
          fields?: Record<string, string>;
          locks?: Parameters<typeof lockText>[0][];
        } | null;
        const lock = body?.locks?.[0];
        if (lock) return lockText(lock, 'comment');
        const field = body?.fields?.body ?? body?.fields?.visibility;
        if (field === 'required') return t('comments.problem.required');
        if (field === 'too_long') return t('comments.problem.tooLong');
        if (field === 'not_a_member') return t('comments.problem.notAMember');
        if (error.status === 403) return t('comments.problem.forbidden');
      }
      return t('comments.problem.other');
    },
    [lockText, t],
  );

  const count = loaded?.comments.length ?? 0;
  return (
    <section aria-labelledby={titleId} className="comment-panel">
      <div className="comment-header">
        <h2 id={titleId} className="comment-title">
          {t('comments.title')}
        </h2>
        {loaded && <span className="comment-count">{t('comments.count', { count })}</span>}
      </div>
      {state.status === 'loading' && (
        <p role="status" className="page-note">
          {t('comments.loading')}
        </p>
      )}
      {state.status === 'failed' && (
        <p role="alert" className="form-error">
          {t('comments.failed')}
        </p>
      )}
      <p role="status" className="form-status">
        {message}
      </p>
      {loaded && (
        <>
          {loaded.comments.length === 0 ? (
            <p className="page-note">{t('comments.empty')}</p>
          ) : (
            <ol className="comment-list">
              {loaded.comments.map((comment) => (
                <CommentItem
                  key={comment.id}
                  comment={comment}
                  ticketKey={ticketKey}
                  targeted={comment.id === target}
                  client={client}
                  canReact={loaded.can.react}
                  audiences={audiences}
                  mentions={mentions}
                  problemText={problemText}
                  onChanged={(changed) => {
                    replace(changed);
                    setMessage(t('comments.saved'));
                  }}
                  onDeleted={() => {
                    setState((s) =>
                      s.status === 'loaded'
                        ? { ...s, comments: s.comments.filter((c) => c.id !== comment.id) }
                        : s,
                    );
                    setMessage(t('comments.deleted'));
                  }}
                  onMessage={setMessage}
                />
              ))}
            </ol>
          )}
          {loaded.next !== null && (
            <button type="button" className="button-secondary" onClick={() => void more()}>
              {t('comments.more')}
            </button>
          )}
          {loaded.can.add ? (
            <Composer
              id={composerId}
              client={client}
              audiences={audiences}
              mentions={mentions}
              problemText={problemText}
              onAdded={(added) => {
                setState((s) =>
                  s.status === 'loaded' ? { ...s, comments: [...s.comments, added] } : s,
                );
                setMessage(t('comments.added'));
              }}
            />
          ) : loaded.lock ? (
            <p className="page-note">{lockText(loaded.lock, 'comment')}</p>
          ) : (
            <p className="page-note">{t('comments.cannotAdd')}</p>
          )}
        </>
      )}
    </section>
  );
}

interface VisibilityPickerProps {
  id: string;
  audiences: Audiences | null;
  value: VisibilityChoice;
  /** The restriction a comment has, kept in the list even when the writer could not give it. */
  current?: CommentVisibility;
  onChange: (value: VisibilityChoice) => void;
}

function VisibilityPicker({ id, audiences, value, current, onChange }: VisibilityPickerProps) {
  const t = useT();
  const roles = audiences?.roles ?? [];
  const groups = audiences?.groups ?? [];
  const keepRole =
    current && 'roleId' in current && !roles.some((r) => r.id === current.roleId) ? current : null;
  const keepGroup =
    current && 'groupId' in current && !groups.some((g) => g.id === current.groupId)
      ? current
      : null;
  return (
    <div className="form-field comment-visibility">
      <label htmlFor={id} className="form-label">
        {t('comments.visibility')}
      </label>
      <select
        id={id}
        value={optionValue(value)}
        onChange={(event) => onChange(parseValue(event.target.value))}
      >
        <option value="">{t('comments.visibility.everyone')}</option>
        {(roles.length > 0 || keepRole) && (
          <optgroup label={t('comments.visibility.roles')}>
            {keepRole && <option value={`role:${keepRole.roleId}`}>{keepRole.name}</option>}
            {roles.map((r) => (
              <option key={r.id} value={`role:${r.id}`}>
                {r.name}
              </option>
            ))}
          </optgroup>
        )}
        {(groups.length > 0 || keepGroup) && (
          <optgroup label={t('comments.visibility.groups')}>
            {keepGroup && <option value={`group:${keepGroup.groupId}`}>{keepGroup.name}</option>}
            {groups.map((g) => (
              <option key={g.id} value={`group:${g.id}`}>
                {g.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </div>
  );
}

/** A mentioned person or team who was not told, in the writer's words. */
function useMentionWarningText(): (warning: MentionWarning) => string {
  const t = useT();
  return (w) => {
    if (w.kind === 'group') {
      return t(
        w.reason === 'cannot_read'
          ? 'comments.mentionWarning.teamRead'
          : 'comments.mentionWarning.teamView',
        { name: w.name, count: w.count ?? 0 },
      );
    }
    if (w.reason === 'unknown') return t('comments.mentionWarning.unknown');
    return t(
      w.reason === 'cannot_read'
        ? 'comments.mentionWarning.cannotRead'
        : 'comments.mentionWarning.cannotView',
      { name: w.name },
    );
  };
}

interface ComposerProps {
  id: string;
  client: CommentClient;
  audiences: Audiences | null;
  mentions?: MentionSource | undefined;
  problemText: (error: unknown) => string;
  onAdded: (comment: Comment) => void;
}

function Composer({ id, client, audiences, mentions, problemText, onAdded }: ComposerProps) {
  const t = useT();
  const [doc, setDoc] = useState<PmJson | null>(null);
  const [visibility, setVisibility] = useState<VisibilityChoice>(null);
  const [round, setRound] = useState(0);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const problemId = `${id}-problem`;
  const warningText = useMentionWarningText();

  const submit = async () => {
    if (!doc) {
      setProblem(t('comments.problem.required'));
      return;
    }
    setSending(true);
    setProblem(null);
    setWarnings([]);
    try {
      const { mentionWarnings, ...added } = await client.add(doc, visibility);
      onAdded(added);
      // Mentioned people the server could not tell (NTF-005 (1)).
      setWarnings((mentionWarnings ?? []).map(warningText));
      setDoc(null);
      setVisibility(null);
      setRound((r) => r + 1);
    } catch (error) {
      setProblem(problemText(error));
    } finally {
      setSending(false);
    }
  };

  return (
    <form
      className="comment-composer"
      data-tutorial="ticket-comment"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h3 id={`${id}-label`} className="comment-composer-title">
        {t('comments.add')}
      </h3>
      <RichTextEditor
        key={round}
        labelledBy={`${id}-label`}
        describedBy={problem ? problemId : undefined}
        invalid={Boolean(problem)}
        onChange={setDoc}
        mentions={mentions}
      />
      <VisibilityPicker
        id={`${id}-visibility`}
        audiences={audiences}
        value={visibility}
        onChange={setVisibility}
      />
      {problem && (
        <p id={problemId} role="alert" className="form-error">
          {problem}
        </p>
      )}
      <div role="status" className="comment-mention-warnings">
        {warnings.length > 0 && (
          <ul>
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={sending}>
          {sending ? t('comments.sending') : t('comments.submit')}
        </button>
      </div>
    </form>
  );
}

interface CommentItemProps {
  comment: Comment;
  ticketKey: string;
  targeted: boolean;
  client: CommentClient;
  canReact: boolean;
  audiences: Audiences | null;
  mentions?: MentionSource | undefined;
  problemText: (error: unknown) => string;
  onChanged: (comment: Comment) => void;
  onDeleted: () => void;
  onMessage: (message: string) => void;
}

function CommentItem({
  comment,
  ticketKey,
  targeted,
  client,
  canReact,
  audiences,
  mentions,
  problemText,
  onChanged,
  onDeleted,
  onMessage,
}: CommentItemProps) {
  const t = useT();
  const intl = useIntl();
  const metaId = useId();
  const editId = useId();
  const [mode, setMode] = useState<'view' | 'edit' | 'confirm'>('view');
  const [doc, setDoc] = useState<PmJson | null>(comment.body);
  const [visibility, setVisibility] = useState<VisibilityChoice>(choiceOf(comment.visibility));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const pickerButton = useRef<HTMLButtonElement>(null);

  const when = (iso: string) =>
    intl.formatDate(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
  const author = comment.author?.name ?? t('comments.someone');
  const date = when(comment.createdAt);
  const named = { author, date };

  const save = async () => {
    if (!doc) {
      setProblem(t('comments.problem.required'));
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      onChanged(await client.edit(comment.id, { body: doc, visibility }));
      setMode('view');
    } catch (error) {
      setProblem(problemText(error));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await client.remove(comment.id);
      onDeleted();
    } catch (error) {
      setProblem(problemText(error));
      setMode('view');
    } finally {
      setBusy(false);
    }
  };
  const react = async (emoji: string, on: boolean) => {
    setPicking(false);
    try {
      onChanged({ ...comment, reactions: await client.react(comment.id, emoji, on) });
    } catch (error) {
      setProblem(problemText(error));
    }
  };
  const copyLink = async () => {
    const link = routeUrl(`#/tickets/${encodeURIComponent(ticketKey)}?comment=${comment.id}`);
    try {
      await navigator.clipboard.writeText(link);
      onMessage(t('comments.linkCopied'));
    } catch {
      onMessage(t('comments.linkIs', { link }));
    }
  };

  return (
    <li
      id={`comment-${comment.id}`}
      className={`comment-item${targeted ? ' comment-target' : ''}`}
      tabIndex={-1}
      aria-labelledby={metaId}
    >
      <p id={metaId} className="comment-meta">
        <span className="comment-author">{author}</span>
        <span className="comment-date">{date}</span>
        {comment.edited && (
          <span className="comment-edited">
            {t('comments.editedAt', { date: when(comment.edited.at) })}
          </span>
        )}
      </p>
      {comment.visibility && (
        <p className="comment-restricted">
          {'roleId' in comment.visibility
            ? t('comments.restricted.role', { name: comment.visibility.name })
            : t('comments.restricted.group', { name: comment.visibility.name })}
        </p>
      )}
      {mode === 'edit' ? (
        <form
          className="comment-editing"
          data-no-draft={doc === comment.body || undefined}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <p id={`${editId}-label`} className="visually-hidden">
            {t('comments.editOf', named)}
          </p>
          <RichTextEditor
            labelledBy={`${editId}-label`}
            initial={comment.body}
            invalid={Boolean(problem)}
            onChange={setDoc}
            mentions={mentions}
          />
          <VisibilityPicker
            id={`${editId}-visibility`}
            audiences={audiences}
            value={visibility}
            current={comment.visibility}
            onChange={setVisibility}
          />
          <div className="form-actions">
            <button type="submit" className="button-primary" disabled={busy}>
              {t('comments.save')}
            </button>
            <button
              type="button"
              className="button-secondary"
              onClick={() => {
                setMode('view');
                setProblem(null);
                setDoc(comment.body);
                setVisibility(choiceOf(comment.visibility));
              }}
            >
              {t('comments.cancel')}
            </button>
          </div>
        </form>
      ) : (
        <RichTextView doc={comment.body} className="comment-body" />
      )}
      {problem && (
        <p role="alert" className="form-error">
          {problem}
        </p>
      )}

      {(comment.reactions.length > 0 || canReact) && (
        <fieldset className="comment-reactions">
          <legend className="visually-hidden">{t('comments.reactionsOf', named)}</legend>
          {comment.reactions.map((r) => (
            <button
              key={r.emoji}
              type="button"
              className="comment-reaction"
              aria-pressed={r.mine}
              aria-label={t('comments.reactionLabel', {
                emoji: r.emoji,
                count: r.count,
                mine: r.mine ? 'yes' : 'no',
              })}
              disabled={!canReact}
              onClick={() => void react(r.emoji, !r.mine)}
            >
              <span aria-hidden="true">{r.emoji}</span>
              <span aria-hidden="true">{intl.formatNumber(r.count)}</span>
            </button>
          ))}
          {canReact && (
            <span className="comment-react">
              <button
                ref={pickerButton}
                type="button"
                className="comment-reaction comment-react-open"
                aria-expanded={picking}
                aria-label={t('comments.react')}
                onClick={() => setPicking((p) => !p)}
              >
                <span aria-hidden="true">+</span>
              </button>
              {picking && (
                <span className="comment-picker">
                  {PICKS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      className="comment-pick"
                      aria-label={t('comments.reactWith', { emoji })}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          // Handled here: nothing else on the page closes or pauses for it.
                          event.preventDefault();
                          setPicking(false);
                          pickerButton.current?.focus();
                        }
                      }}
                      onClick={() =>
                        void react(
                          emoji,
                          !comment.reactions.some((r) => r.emoji === emoji && r.mine),
                        )
                      }
                    >
                      {emoji}
                    </button>
                  ))}
                </span>
              )}
            </span>
          )}
        </fieldset>
      )}

      {mode === 'confirm' ? (
        <div className="comment-actions">
          <span className="comment-confirm">{t('comments.confirmDelete')}</span>
          <button
            type="button"
            className="button-danger"
            disabled={busy}
            onClick={() => void remove()}
          >
            {t('comments.confirmYes')}
          </button>
          <button type="button" className="button-secondary" onClick={() => setMode('view')}>
            {t('comments.confirmNo')}
          </button>
        </div>
      ) : (
        mode === 'view' && (
          <div className="comment-actions">
            <button
              type="button"
              className="button-secondary comment-action"
              aria-label={t('comments.copyLinkOf', named)}
              onClick={() => void copyLink()}
            >
              {t('comments.copyLink')}
            </button>
            {comment.can.edit && (
              <button
                type="button"
                className="button-secondary comment-action"
                aria-label={t('comments.editOf', named)}
                onClick={() => setMode('edit')}
              >
                {t('comments.edit')}
              </button>
            )}
            {comment.can.delete && (
              <button
                type="button"
                className="button-secondary comment-action"
                aria-label={t('comments.deleteOf', named)}
                onClick={() => setMode('confirm')}
              >
                {t('comments.delete')}
              </button>
            )}
          </div>
        )
      )}
    </li>
  );
}
