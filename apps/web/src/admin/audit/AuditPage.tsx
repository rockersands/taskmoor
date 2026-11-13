import { type FormEvent, useCallback, useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import { ApiError } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { useSession } from '../../session/SessionProvider';
import { EmptyState } from '../../shell/EmptyState';
import { PageHeader } from '../../shell/PageHeader';
import { COMPACT_QUERY, useMediaQuery } from '../../shell/useMediaQuery';
import { AuditSettings } from './AuditSettings';
import {
  type AuditClient,
  type AuditFilter,
  type AuditRecord,
  auditClient,
  type ChainStatus,
} from './client';
import { auditActionWords, auditSubjectText } from './words';

type Log =
  | { status: 'loading' }
  | { status: 'loaded'; records: AuditRecord[]; next: string | null; more: boolean }
  | { status: 'failed' };

/**
 * The audit log for site administrators (M1-085; IAM-013): records newest first with filters
 * by day and action, a download of what the filter finds as CSV or JSON Lines, a check of the
 * hash chain, and the retention and syslog settings.
 */
export function AuditPage({ client = auditClient }: { client?: AuditClient }) {
  const t = useT();
  const intl = useIntl();
  const { session } = useSession();
  const titleId = useId();
  const formId = useId();
  const compact = useMediaQuery(COMPACT_QUERY);
  const notAdmin = session.status === 'signed-in' && !session.user.isSiteAdmin;
  const [forbidden, setForbidden] = useState(notAdmin);
  const [draft, setDraft] = useState<AuditFilter>({});
  const [filter, setFilter] = useState<AuditFilter>({});
  const [log, setLog] = useState<Log>({ status: 'loading' });
  const [chain, setChain] = useState<ChainStatus | 'checking' | 'failed' | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      try {
        const page = await client.search(filter, cursor);
        setLog((prev) => ({
          status: 'loaded',
          records:
            cursor && prev.status === 'loaded' ? [...prev.records, ...page.records] : page.records,
          next: page.nextCursor,
          more: false,
        }));
      } catch (error) {
        if (error instanceof ApiError && (error.status === 403 || error.status === 401)) {
          setForbidden(true);
        }
        setLog({ status: 'failed' });
      }
    },
    [client, filter],
  );

  useEffect(() => {
    if (notAdmin) return;
    setLog({ status: 'loading' });
    void load();
  }, [notAdmin, load]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFilter({ ...draft });
  };
  const verify = async () => {
    setChain('checking');
    try {
      setChain(await client.verify());
    } catch {
      setChain('failed');
    }
  };
  const when = (iso: string) =>
    intl.formatDate(new Date(iso), { dateStyle: 'medium', timeStyle: 'medium' });
  const who = (r: AuditRecord) =>
    r.actor
      ? t('common.value', { value: r.actor.name ?? r.actor.email ?? `#${r.actor.id}` })
      : t('admin.audit.system');

  const header = (
    <PageHeader
      titleId={titleId}
      title={t('admin.audit.title')}
      {...(forbidden ? {} : { purpose: t('settings.auditLogHint'), about: t('admin.audit.intro') })}
    />
  );

  if (forbidden) {
    return (
      <section aria-labelledby={titleId} className="page audit-page">
        {header}
        <p className="page-note">{t('admin.audit.forbidden')}</p>
      </section>
    );
  }

  return (
    <section aria-labelledby={titleId} className="page audit-page">
      {header}
      <form id={formId} className="glass-card audit-filter" onSubmit={submit}>
        <label className="form-field">
          <span className="form-label">{t('admin.audit.from')}</span>
          <input
            type="date"
            value={draft.from ?? ''}
            onChange={(e) => setDraft({ ...draft, from: e.target.value || undefined })}
          />
        </label>
        <label className="form-field">
          <span className="form-label">{t('admin.audit.to')}</span>
          <input
            type="date"
            value={draft.to ?? ''}
            onChange={(e) => setDraft({ ...draft, to: e.target.value || undefined })}
          />
        </label>
        <label className="form-field">
          <span className="form-label">{t('admin.audit.action')}</span>
          <input
            type="text"
            value={draft.action ?? ''}
            placeholder={t('admin.audit.actionPlaceholder')}
            onChange={(e) => setDraft({ ...draft, action: e.target.value || undefined })}
          />
        </label>
        <button type="submit" className="button-primary">
          {t('admin.audit.search')}
        </button>
      </form>

      <div className="audit-actions">
        <a className="button-secondary" href={client.exportUrl(filter, 'csv')} download>
          {t('admin.audit.exportCsv')}
        </a>
        <a className="button-secondary" href={client.exportUrl(filter, 'jsonl')} download>
          {t('admin.audit.exportJson')}
        </a>
        <button
          type="button"
          className="button-secondary"
          onClick={() => void verify()}
          disabled={chain === 'checking'}
        >
          {t('admin.audit.verify')}
        </button>
      </div>
      {chain !== null && (
        <p
          role={chain === 'failed' || (typeof chain === 'object' && !chain.ok) ? 'alert' : 'status'}
          className={
            chain === 'failed' || (typeof chain === 'object' && !chain.ok)
              ? 'form-error'
              : 'form-status'
          }
        >
          {chain === 'checking'
            ? t('admin.audit.verifying')
            : chain === 'failed'
              ? t('admin.audit.verifyFailed')
              : chain.ok
                ? t('admin.audit.chainOk', { count: chain.checked })
                : t('admin.audit.chainBroken', { seq: chain.firstBroken?.seq ?? 0 })}
        </p>
      )}

      {log.status === 'loading' && (
        <p role="status" className="page-note">
          {t('admin.audit.loading')}
        </p>
      )}
      {log.status === 'failed' && (
        <p role="alert" className="form-error">
          {t('admin.audit.failed')}
        </p>
      )}
      {log.status === 'loaded' && log.records.length === 0 && (
        <EmptyState title={t('admin.audit.none')}>{t('empty.audit.body')}</EmptyState>
      )}
      {log.status === 'loaded' && log.records.length > 0 && compact && (
        // On a phone one block per record: when, who and what, then what about and from where (D19).
        <ul className="glass-card audit-entries" aria-label={t('admin.audit.table')}>
          {log.records.map((r) => (
            <li key={r.seq} className="audit-entry">
              <p className="audit-entry-when">{when(r.occurredAt)}</p>
              <p className="audit-entry-what">
                <strong>{who(r)}</strong> <span>{auditActionWords(t, r.action)}</span>
              </p>
              {(r.subject || r.ip) && (
                <p className="page-note">
                  {r.subject && (
                    <span>
                      {t('admin.audit.entryAbout', { subject: auditSubjectText(t, r.subject) })}
                    </span>
                  )}
                  {r.subject && r.ip && ' · '}
                  {r.ip && <span>{t('admin.audit.entryFrom', { address: r.ip })}</span>}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      {log.status === 'loaded' && log.records.length > 0 && !compact && (
        <div className="glass-card glass-scroller">
          <table className="data-table audit-table">
            <caption className="visually-hidden">{t('admin.audit.table')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('admin.audit.column.when')}</th>
                <th scope="col">{t('admin.audit.column.who')}</th>
                <th scope="col">{t('admin.audit.column.action')}</th>
                <th scope="col">{t('admin.audit.column.subject')}</th>
                <th scope="col">{t('admin.audit.column.address')}</th>
              </tr>
            </thead>
            <tbody>
              {log.records.map((r) => (
                <tr key={r.seq}>
                  <td className="audit-when">{when(r.occurredAt)}</td>
                  <td>{who(r)}</td>
                  <td title={r.action}>{auditActionWords(t, r.action)}</td>
                  <td>{r.subject ? auditSubjectText(t, r.subject) : ''}</td>
                  <td>{r.ip ? t('common.value', { value: r.ip }) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {log.status === 'loaded' && log.next && (
        <button
          type="button"
          className="button-secondary"
          disabled={log.more}
          onClick={() => {
            setLog({ ...log, more: true });
            void load(log.next ?? undefined);
          }}
        >
          {t('admin.audit.more')}
        </button>
      )}

      <AuditSettings client={client} />
    </section>
  );
}
