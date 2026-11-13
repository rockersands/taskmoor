import { useCallback, useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import { type Translate, useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { type LockAction, useLockText } from '../locks/useLockText';
import { routeHref } from '../routing/router';
import { PageHeader } from '../shell/PageHeader';
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
    const id = REASONS[code];
    return id ? t(id) : t('bulk.reason.other', { code: code || '?' });
  };
}

const finished = (op: BulkOperation) => op.status === 'done' || op.status === 'cancelled';

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
    return (
      <section aria-labelledby={titleId} className="page bulk-page">
        <PageHeader titleId={titleId} title={t('bulk.title.missing')} purpose={t('purpose.bulk')} />
        <p role="alert" className="form-error">
          {t('bulk.notFound')}
        </p>
      </section>
    );
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
    </section>
  );
}
