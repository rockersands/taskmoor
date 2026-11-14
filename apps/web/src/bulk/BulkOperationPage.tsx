import { useCallback, useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import { type Translate, useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { type LockAction, useLockText } from '../locks/useLockText';
import { routeHref } from '../routing/router';
import { NotFoundPage } from '../shell/NotFoundPage';
import { PageHeader } from '../shell/PageHeader';
import { priorityName } from '../shell/priorityName';
import { placementRefusal, SYSTEM_FIELDS } from '../tickets/form';
import {
  type BulkClient,
  type BulkError,
  type BulkItem,
  type BulkOperation,
  bulkClient,
} from './client';

export interface BulkOperationPageProps {
  /** The operation's id from the address (#/bulk/<id>). */
  id: string;
  client?: BulkClient;
  /** How often to read progress while the operation runs (ms). */
  pollMs?: number;
}

const TITLES: Record<BulkOperation['action'], MessageId> = {
  edit: 'bulk.title.edit',
  move: 'bulk.title.move',
  transition: 'bulk.title.transition',
  delete: 'bulk.title.delete',
  clone: 'bulk.title.clone',
};
const STATUSES: Record<BulkOperation['status'], MessageId> = {
  queued: 'bulk.status.queued',
  running: 'bulk.status.running',
  done: 'bulk.status.done',
  cancelled: 'bulk.status.cancelled',
};
const REASONS: Record<string, MessageId> = {
  not_found: 'bulk.reason.notFound',
  forbidden: 'bulk.reason.forbidden',
  invalid_fields: 'bulk.reason.invalidFields',
  transition_unavailable: 'bulk.reason.transitionUnavailable',
  no_transition_to_status: 'bulk.reason.noTransition',
  track_archived: 'bulk.reason.trackArchived',
  in_trash: 'bulk.reason.inTrash',
  moved_meanwhile: 'bulk.reason.movedMeanwhile',
  requester_deactivated: 'bulk.reason.requesterDeactivated',
  parent_not_cloned: 'bulk.reason.parentNotCloned',
  copy_gone: 'bulk.reason.copyGone',
  internal: 'bulk.reason.internal',
};
const LOCK_ACTIONS: readonly string[] = ['edit', 'comment', 'attach', 'assign', 'transition'];

/** Why one ticket was not changed, in the reader's words. */
export function useReason(): (error: BulkError | null) => string {
  const t = useT();
  const lockText = useLockText();
  return (error) => {
    const lock = error?.locks?.[0];
    if (lock) {
      const action = LOCK_ACTIONS.includes(error?.permission ?? '')
        ? (error?.permission as LockAction)
        : 'edit';
      return lockText(lock, action);
    }
    const code = error?.error ?? '';
    if (code === 'transition_refused') {
      return t(error?.by === 'check' ? 'bulk.reason.checkRefused' : 'bulk.reason.ruleRefused');
    }
    // A choice the ticket's track does not offer, or an archived one, as the create form says it.
    const placement = code === 'invalid_fields' ? placementRefusal(error?.fields) : null;
    if (placement) return t(placement);
    const id = REASONS[code];
    return id ? t(id) : t('bulk.reason.other', { code: code || '?' });
  };
}

const finished = (op: BulkOperation) => op.status === 'done' || op.status === 'cancelled';

/** An edit's fields by the names the ticket route takes them, with their labels. */
const EDITED: Record<string, MessageId> = {
  ...Object.fromEntries(Object.values(SYSTEM_FIELDS).map((field) => [field.body, field.label])),
  ticketTypeId: 'tickets.create.type',
  statusId: 'ticketView.field.status',
  visibilityLevelId: 'ticketView.field.visibilityLevel',
};
const DAYS = new Set(['startDate', 'dueDate']);

type Named = { id: number; name: string }[];
/** The site's lists that name the ids a change set, as far as they have been read. */
interface Names {
  priorities: Named;
  statuses: Named;
  closeReasons: Named;
}
const NO_NAMES: Names = { priorities: [], statuses: [], closeReasons: [] };

/**
 * What the change was, in words (D14): each field an edit set and its new value, the track a
 * move went to, or the status a transition took the tickets to. Ids name what they can (a
 * priority, a status, a close reason); otherwise the field alone is named.
 */
function useChangeText(op: BulkOperation | null, names: Names) {
  const t = useT();
  const intl = useIntl();
  if (!op?.params) return null;
  const parts: string[] = [];
  const named = (key: string, value: unknown): string | null => {
    const find = (list: Named) => list.find((item) => item.id === value)?.name ?? null;
    if (key === 'priorityId') {
      const name = find(names.priorities);
      return name === null ? null : priorityName(t, name);
    }
    if (key === 'statusId') return find(names.statuses);
    if (key === 'closeReasonId') return find(names.closeReasons);
    return null;
  };
  const edit = op.action === 'edit' ? op.params.edit : undefined;
  for (const [key, value] of Object.entries(edit ?? {})) {
    if (key === 'fields' && value && typeof value === 'object') {
      const count = Object.keys(value).length;
      if (count > 0) parts.push(t('bulk.change.customFields', { count }));
      continue;
    }
    const label = EDITED[key];
    if (!label) continue;
    const field = t(label);
    if (value === null) {
      parts.push(t('bulk.change.cleared', { field }));
    } else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      const shown = value.length > 0 ? intl.formatList(value) : t('bulk.change.none');
      parts.push(t('bulk.change.set', { field, value: shown }));
    } else if (typeof value === 'string' && DAYS.has(key)) {
      const day = intl.formatDate(value, { dateStyle: 'medium', timeZone: 'UTC' });
      parts.push(t('bulk.change.set', { field, value: day }));
    } else if (typeof value === 'string') {
      parts.push(t('bulk.change.set', { field, value }));
    } else {
      const name = named(key, value);
      parts.push(
        name === null
          ? t('bulk.change.changed', { field })
          : t('bulk.change.set', { field, value: name }),
      );
    }
  }
  const track = op.action === 'move' ? op.params.move?.track : undefined;
  if (typeof track === 'string') parts.push(t('bulk.change.moved', { track }));
  else if (track !== undefined) parts.push(t('bulk.change.movedElsewhere'));
  const transition = op.action === 'transition' ? op.params.transition : undefined;
  if (transition) {
    const status = named('statusId', transition.statusId);
    parts.push(
      status === null
        ? t('bulk.change.transitionedElsewhere')
        : t('bulk.change.transitioned', { status }),
    );
    const count = Object.keys(transition.fields ?? {}).length;
    if (count > 0) parts.push(t('bulk.change.transitionFields', { count }));
  }
  return parts.length > 0 ? t('bulk.change', { change: intl.formatList(parts) }) : null;
}

function statusText(t: Translate, op: BulkOperation): string {
  if (op.cancelRequested && !finished(op)) return t('bulk.status.cancelling');
  return t(STATUSES[op.status]);
}

/**
 * A bulk change's progress (M1-021; CORE-024): how many tickets are done, failed, skipped and
 * waiting, a cancel while it runs, and every ticket that was not changed with the reason its
 * own checks gave. It reads the operation again every couple of seconds until it finishes.
 */
export function BulkOperationPage({
  id,
  client = bulkClient,
  pollMs = 2000,
}: BulkOperationPageProps) {
  const t = useT();
  const intl = useIntl();
  const reason = useReason();
  const titleId = useId();
  const progressId = useId();
  const failuresId = useId();
  const opId = Number(id);
  const [op, setOp] = useState<BulkOperation | null>(null);
  const [state, setState] = useState<'loading' | 'missing' | 'loaded'>('loading');
  const [failures, setFailures] = useState<BulkItem[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(async () => {
    try {
      const got = await client.get(opId);
      setOp(got);
      setState('loaded');
      return got;
    } catch {
      setState((s) => (s === 'loaded' ? s : 'missing'));
      return null;
    }
  }, [client, opId]);

  // Progress, read again while the operation runs.
  useEffect(() => {
    if (!Number.isSafeInteger(opId) || opId < 1) {
      setState('missing');
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const got = await load();
      if (live && got && !finished(got)) timer = setTimeout(() => void tick(), pollMs);
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [load, opId, pollMs]);

  // The first page of failures, read again when their count changes.
  const failedCount = op?.failed ?? 0;
  useEffect(() => {
    if (failedCount === 0) return;
    let live = true;
    client.failures(opId).then(
      (page) => {
        if (!live) return;
        setFailures(page.items);
        setNext(page.next);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [client, opId, failedCount]);

  const more = async () => {
    if (next === null) return;
    const page = await client.failures(opId, next);
    setFailures((f) => [...f, ...page.items]);
    setNext(page.next);
  };

  // The tickets the change reached, linked (D14), read once it has finished.
  const [changed, setChanged] = useState<BulkItem[]>([]);
  const [nextChanged, setNextChanged] = useState<number | null>(null);
  const succeededCount = op && finished(op) ? op.succeeded : 0;
  useEffect(() => {
    if (succeededCount === 0 || !client.changed) return;
    let live = true;
    client.changed(opId).then(
      (page) => {
        if (!live) return;
        setChanged(page.items);
        setNextChanged(page.next);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [client, opId, succeededCount]);

  const moreChanged = async () => {
    if (nextChanged === null || !client.changed) return;
    const page = await client.changed(opId, nextChanged);
    setChanged((c) => [...c, ...page.items]);
    setNextChanged(page.next);
  };

  // A priority, status or close reason the change set is named, not shown as a number.
  const [names, setNames] = useState<Names>(NO_NAMES);
  const edit = op?.params?.edit;
  const wantsPriority = typeof edit?.priorityId === 'number';
  const wantsStatus =
    typeof edit?.statusId === 'number' || typeof op?.params?.transition?.statusId === 'number';
  const wantsReason = typeof edit?.closeReasonId === 'number';
  useEffect(() => {
    let live = true;
    const read = (key: keyof Names, wanted: boolean, list?: () => Promise<Named>) => {
      if (!wanted || !list) return;
      list().then(
        (got) => live && setNames((now) => ({ ...now, [key]: got })),
        () => {},
      );
    };
    read('priorities', wantsPriority, client.priorities);
    read('statuses', wantsStatus, client.statuses);
    read('closeReasons', wantsReason, client.closeReasons);
    return () => {
      live = false;
    };
  }, [client, wantsPriority, wantsStatus, wantsReason]);
  const change = useChangeText(op, names);
  const changedId = useId();

  const cancel = async () => {
    setCancelling(true);
    setProblem(null);
    try {
      setOp(await client.cancel(opId));
    } catch {
      setProblem(t('bulk.cancelFailed'));
    } finally {
      setCancelling(false);
    }
  };

  if (state === 'loading') {
    return (
      <p role="status" className="page-note">
        {t('bulk.loading')}
      </p>
    );
  }
  if (state === 'missing' || !op) {
    return <NotFoundPage title={t('notFound.bulk')}>{t('bulk.notFound')}</NotFoundPage>;
  }
  const done = op.total - op.pending;
  const number = (n: number) => intl.formatNumber(n);
  const cloning = op.action === 'clone';
  return (
    <section aria-labelledby={titleId} className="page bulk-page">
      <PageHeader
        titleId={titleId}
        title={t(TITLES[op.action], { count: op.total })}
        purpose={t('purpose.bulk')}
        about={t('about.bulk')}
      />
      {finished(op) && op.failed > 0 ? (
        // Some tickets failed: a warning, never a green "Done." (PL-23, D14).
        <p role="alert" className="bulk-warning">
          {t('bulk.warning', {
            action: op.action,
            cancelled: op.status === 'cancelled' ? 'yes' : 'no',
            succeeded: op.succeeded,
            failed: op.failed,
            skipped: op.skipped,
          })}
        </p>
      ) : (
        <p role="status" className="form-status">
          {statusText(t, op)}
        </p>
      )}
      {change && <p className="bulk-change">{change}</p>}
      <div className="bulk-progress">
        <label id={progressId} htmlFor={`${progressId}-bar`} className="form-label">
          {t('bulk.progress', { done: number(done), total: number(op.total) })}
        </label>
        <progress id={`${progressId}-bar`} max={op.total} value={done} />
      </div>
      <dl className="glass-card bulk-counts">
        <div>
          <dt>{t(cloning ? 'bulk.clone.copied' : 'bulk.count.succeeded')}</dt>
          <dd>{number(op.succeeded)}</dd>
        </div>
        <div>
          <dt>{t(cloning ? 'bulk.clone.notCopied' : 'bulk.count.failed')}</dt>
          <dd>{number(op.failed)}</dd>
        </div>
        <div>
          <dt>{t('bulk.count.skipped')}</dt>
          <dd>{number(op.skipped)}</dd>
        </div>
        <div>
          <dt>{t('bulk.count.pending')}</dt>
          <dd>{number(op.pending)}</dd>
        </div>
      </dl>
      {!finished(op) && !op.cancelRequested && (
        <div className="form-actions">
          <button
            type="button"
            className="button-secondary"
            disabled={cancelling}
            onClick={() => void cancel()}
          >
            {t('bulk.cancel')}
          </button>
        </div>
      )}
      {problem && (
        <p role="alert" className="form-error">
          {problem}
        </p>
      )}
      {op.failed > 0 && (
        <section aria-labelledby={failuresId} className="glass-card bulk-failures-card">
          <h2 id={failuresId} className="facts-title">
            {t(cloning ? 'bulk.clone.failures' : 'bulk.failures')}
          </h2>
          <ul className="bulk-failures">
            {failures.map((item) => (
              <li key={item.position} className="bulk-failure">
                <p className="bulk-ticket">
                  {item.key ? (
                    <a href={routeHref(`#/tickets/${encodeURIComponent(item.key)}`)}>{item.key}</a>
                  ) : (
                    item.ref
                  )}
                </p>
                <p className="bulk-reason">{reason(item.error)}</p>
              </li>
            ))}
          </ul>
          {next !== null && (
            <button type="button" className="button-secondary" onClick={() => void more()}>
              {t('bulk.moreFailures')}
            </button>
          )}
        </section>
      )}
      {changed.length > 0 && (
        <section aria-labelledby={changedId} className="glass-card bulk-failures-card">
          <h2 id={changedId} className="facts-title">
            {t(cloning ? 'bulk.clone.changed' : 'bulk.changed')}
          </h2>
          <ul className="bulk-changed">
            {changed.map((item) => {
              // A clone links its copy; any other change the ticket it changed.
              const key = cloning ? (item.result?.ticket.key ?? null) : item.key;
              return (
                <li key={item.position}>
                  {key ? (
                    <a href={routeHref(`#/tickets/${encodeURIComponent(key)}`)}>{key}</a>
                  ) : (
                    item.ref
                  )}
                </li>
              );
            })}
          </ul>
          {nextChanged !== null && (
            <button type="button" className="button-secondary" onClick={() => void moreChanged()}>
              {t('bulk.moreChanged')}
            </button>
          )}
        </section>
      )}
      <p className="bulk-back">
        <a
          className="button-secondary"
          href={routeHref(
            op.params?.query
              ? `#/search?${new URLSearchParams({ q: op.params.query }).toString()}`
              : '#/search',
          )}
        >
          {t(op.params?.query ? 'bulk.backToSearch' : 'bulk.toSearch')}
        </a>
      </p>
    </section>
  );
}
