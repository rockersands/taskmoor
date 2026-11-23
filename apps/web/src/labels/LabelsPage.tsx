import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { useAdminAccess } from '../admin/access';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { DangerAction } from '../shell/DangerAction';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
import {
  LABEL_MAX,
  type LabelsClient,
  type LabelUsage,
  labelsClient,
  MERGE_MAX,
  type MergedLabels,
} from './client';

export interface LabelsPageProps {
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: LabelsClient;
}

/** Labels read at a time; Show more labels reads the next ones. */
const PAGE = 50;

type ListState =
  | { status: 'loading' }
  | {
      status: 'loaded';
      q: string;
      labels: LabelUsage[];
      more: boolean;
      adding: boolean;
      /** The next page could not be read; Show more labels stays to try again. */
      moreFailed: boolean;
    }
  | { status: 'failed' }
  | { status: 'forbidden' };

/**
 * Labels (CORE-017 (2); ADR-114 section 1, T-322), for site and configuration administrators:
 * the site's labels with how many tickets have each, found by how they start, and a merge of the
 * ticked ones into the label typed, which also renames a label. A merge cannot be undone, so it
 * asks first (D13) and says how many tickets change.
 */
export function LabelsPage({ client = labelsClient }: LabelsPageProps) {
  const t = useT();
  const intl = useIntl();
  const expired = useSessionExpiry();
  const titleId = useId();
  const id = useId();
  const mergeHeading = useRef<HTMLHeadingElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const access = useAdminAccess();
  // The list is the site's: only site and configuration administrators read it and merge.
  const notAdmin = access !== null && access !== 'site' && access !== 'setup';
  const [query, setQuery] = useState('');
  const [listState, setState] = useState<ListState>({ status: 'loading' });
  const state: ListState = notAdmin ? { status: 'forbidden' } : listState;
  /** The ticked labels in the order they were ticked, with their counts as read then. */
  const [chosen, setChosen] = useState<LabelUsage[]>([]);
  const [into, setInto] = useState('');
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  /** The row whose box takes the focus once more labels are drawn, by its place in the list. */
  const [focusAt, setFocusAt] = useState<number | null>(null);
  /**
   * Counts the changes to the ticks and the word. The merge's question asks about the merge as it
   * was when it opened, so any change puts it away (it is drawn again under a new key), rather
   * than leaving a question about another merge, or none, whose answer would do nothing. While a
   * merge runs the question stays, waiting, so it cannot be sent twice.
   */
  const [edits, setEdits] = useState(0);
  const running = useRef(false);
  const edited = () => {
    if (!running.current) setEdits((n) => n + 1);
  };
  // Answers that come back after a newer request are dropped.
  const reading = useRef(0);

  const load = useCallback(
    async (q: string) => {
      const mine = ++reading.current;
      try {
        const page = await client.usage({ q, limit: PAGE });
        if (mine !== reading.current) return;
        setState({
          status: 'loaded',
          q,
          labels: page.labels,
          more: page.more,
          adding: false,
          moreFailed: false,
        });
      } catch (error) {
        if (mine !== reading.current || expired(error)) return;
        if (error instanceof ApiError && error.status === 403) setState({ status: 'forbidden' });
        else setState({ status: 'failed' });
      }
    },
    [client, expired],
  );
  useEffect(() => {
    if (notAdmin) return;
    const typed = query.trim();
    const timer = setTimeout(() => void load(typed), typed ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, notAdmin, query]);

  useEffect(() => {
    if (focusAt === null) return;
    setFocusAt(null);
    list.current?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[focusAt]?.focus();
  }, [focusAt]);

  /** The list shown is for another search than the one typed, whose answer is on its way. */
  const stale = state.status === 'loaded' && state.q !== query.trim();

  const showMore = async () => {
    // Paging on would show the old search's labels under the new one: its own answer comes.
    if (state.status !== 'loaded' || state.adding || stale) return;
    const from = state;
    const last = from.labels.at(-1)?.name;
    const mine = ++reading.current;
    setState({ ...from, adding: true, moreFailed: false });
    try {
      const page = await client.usage({
        q: from.q,
        ...(last === undefined ? {} : { after: last }),
        limit: PAGE,
      });
      if (mine !== reading.current) return;
      setState({
        ...from,
        labels: [...from.labels, ...page.labels],
        more: page.more,
        moreFailed: false,
      });
      // The button may be gone: the first label read now takes the focus.
      if (page.labels.length > 0) setFocusAt(from.labels.length);
    } catch (error) {
      if (mine !== reading.current || expired(error)) return;
      // Said beside the button, which stays to try again.
      setState({ ...from, moreFailed: true });
    }
  };

  const choose = (label: LabelUsage, on: boolean) => {
    edited();
    setChosen((now) =>
      on
        ? now.some((c) => c.name === label.name)
          ? now
          : [...now, label]
        : now.filter((c) => c.name !== label.name),
    );
  };

  const target = into.trim();
  // What the server refuses to become, besides nothing: a space or a control character inside,
  // or a word too long.
  const notAWord =
    target !== '' &&
    (/\s/.test(target) ||
      [...target].length > LABEL_MAX ||
      [...target].some((c) => (c.codePointAt(0) as number) < 0x20));
  /** The chosen labels that change: the one they become, if chosen, stays as it is. */
  const merging = chosen.filter((c) => c.name !== target);
  const blocked =
    chosen.length > 0 && target !== '' && merging.length === 0
      ? t('admin.labels.chooseOther', { into: target })
      : merging.length > MERGE_MAX
        ? t('admin.labels.tooMany', { max: MERGE_MAX })
        : null;
  const ready = merging.length > 0 && target !== '' && !notAWord && blocked === null;
  const single = merging.length === 1 ? merging[0] : undefined;
  const names = (labels: readonly string[]) => intl.formatList(labels, { type: 'conjunction' });
  const atMost = merging.reduce((sum, c) => sum + c.ticketCount, 0);

  const refusal = (error: unknown) => {
    if (!(error instanceof ApiError)) return t('admin.labels.problem.other');
    const body = error.body as { error?: string; detail?: string } | null;
    if (error.status === 400 && body?.detail === 'into') return t('admin.labels.oneWord');
    if (error.status === 400) return t('admin.labels.problem.labels', { max: MERGE_MAX });
    if (error.status === 403) return t('admin.labels.forbidden');
    return t('admin.labels.problem.other');
  };

  const merge = async () => {
    // Never asked: a change to the ticks or the word puts the question away (`edits`).
    if (!ready) throw new Error('not ready');
    setProblem(null);
    let done: MergedLabels;
    running.current = true;
    try {
      done = await client.merge(
        merging.map((c) => c.name),
        target,
      );
    } catch (error) {
      if (!expired(error)) {
        setMessage('');
        setProblem(refusal(error));
      }
      throw error;
    } finally {
      running.current = false;
    }
    setChosen([]);
    setInto('');
    setMessage(
      t('admin.labels.done', {
        labels: names(done.labels),
        into: done.into,
        count: done.ticketCount,
      }),
    );
    await load(state.status === 'loaded' ? state.q : query.trim());
  };

  const hint = notAWord ? t('admin.labels.oneWord') : (blocked ?? t('admin.labels.intoHint'));

  return (
    <section aria-labelledby={titleId} className="page admin-page people-page labels-page">
      <PageHeader
        titleId={titleId}
        title={t('admin.labels.title')}
        {...(state.status === 'forbidden'
          ? {}
          : { purpose: t('settings.labelsHint'), about: t('admin.labels.about') })}
      />
      {state.status === 'forbidden' ? (
        <p className="page-note">{t('admin.labels.forbidden')}</p>
      ) : (
        <>
          <section aria-labelledby={`${id}-merge`} className="glass-card people-card">
            <h2 id={`${id}-merge`} ref={mergeHeading} tabIndex={-1} className="facts-title">
              {t('admin.labels.merging')}
            </h2>
            <p className="page-note">{t('admin.labels.mergingNote')}</p>
            <p className="page-note">
              {chosen.length === 0
                ? t('admin.labels.nothingTicked')
                : t('admin.labels.chosen', {
                    labels: names(
                      chosen.map((c) =>
                        t('admin.labels.withCount', { name: c.name, count: c.ticketCount }),
                      ),
                    ),
                  })}
            </p>
            <div className="form-field">
              <label htmlFor={`${id}-into`} className="form-label">
                {t('admin.labels.into')}
              </label>
              <input
                id={`${id}-into`}
                type="text"
                autoComplete="off"
                spellCheck={false}
                maxLength={LABEL_MAX}
                value={into}
                aria-invalid={notAWord || undefined}
                aria-describedby={`${id}-into-hint`}
                onChange={(event) => {
                  edited();
                  setInto(event.target.value);
                }}
              />
              <p id={`${id}-into-hint`} className="form-hint">
                {hint}
              </p>
            </div>
            <div className="form-actions">
              {/* Asks first and says what changes (D13): a merge cannot be undone. */}
              <DangerAction
                key={edits}
                label={single ? t('admin.labels.rename') : t('admin.labels.merge')}
                outcome={
                  single
                    ? t('admin.labels.confirmRename', {
                        label: single.name,
                        into: target,
                        count: single.ticketCount,
                      })
                    : t('admin.labels.confirmMerge', {
                        labels: names(merging.map((c) => c.name)),
                        into: target,
                        count: atMost,
                      })
                }
                confirmLabel={
                  single
                    ? t('admin.labels.renameTo', { label: single.name, into: target })
                    : t('admin.labels.mergeInto', { into: target })
                }
                disabled={!ready}
                onConfirm={merge}
              />
              {chosen.length > 0 && (
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => {
                    edited();
                    setChosen([]);
                    // The button goes with the choice: the card's heading takes the focus.
                    mergeHeading.current?.focus();
                  }}
                >
                  {t('admin.labels.clear')}
                </button>
              )}
            </div>
            <p role="status" className="form-status">
              {message}
            </p>
            {problem && (
              <p role="alert" className="form-error">
                {problem}
              </p>
            )}
          </section>
          <section aria-labelledby={`${id}-list`} className="glass-card people-card">
            <h2 id={`${id}-list`} className="facts-title">
              {t('admin.labels.list')}
            </h2>
            <div className="form-field">
              <label htmlFor={`${id}-search`} className="form-label">
                {t('admin.labels.search')}
              </label>
              <input
                id={`${id}-search`}
                type="search"
                autoComplete="off"
                spellCheck={false}
                maxLength={LABEL_MAX}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            {state.status === 'loading' && <p className="page-note">{t('admin.labels.loading')}</p>}
            {state.status === 'failed' && (
              <p role="alert" className="form-error">
                {t('admin.labels.failed')}
              </p>
            )}
            {state.status === 'loaded' &&
              (state.labels.length === 0 ? (
                state.q === '' ? (
                  <EmptyState compact title={t('admin.labels.emptyTitle')}>
                    {t('admin.labels.empty')}
                  </EmptyState>
                ) : (
                  <EmptyState compact title={t('admin.labels.noneMatchTitle', { q: state.q })}>
                    {t('admin.labels.noneMatch')}
                  </EmptyState>
                )
              ) : (
                <>
                  <ul ref={list} className="people-list">
                    {state.labels.map((label, index) => (
                      <li key={label.name} className="people-item">
                        <label className="form-field form-field-inline people-main">
                          <input
                            type="checkbox"
                            checked={chosen.some((c) => c.name === label.name)}
                            aria-describedby={`${id}-count-${index}`}
                            onChange={(event) => choose(label, event.target.checked)}
                          />
                          <span className="people-name">{label.name}</span>
                        </label>
                        <p id={`${id}-count-${index}`} className="people-meta">
                          {t('admin.labels.count', { count: label.ticketCount })}
                        </p>
                      </li>
                    ))}
                  </ul>
                  {state.more && (
                    <div className="form-actions">
                      <button
                        type="button"
                        className="button-secondary"
                        aria-disabled={state.adding || stale || undefined}
                        onClick={() => void showMore()}
                      >
                        {t('admin.labels.more')}
                      </button>
                    </div>
                  )}
                  {state.moreFailed && (
                    <p role="alert" className="form-error">
                      {t('admin.labels.moreFailed')}
                    </p>
                  )}
                </>
              ))}
          </section>
        </>
      )}
    </section>
  );
}
