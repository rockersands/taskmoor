import { type FormEvent, useCallback, useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import { useCsvSeparator } from '../../account/csvStyle';
import { ApiError } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import type { MessageId } from '../../i18n/messages.en';
import { useSession } from '../../session/SessionProvider';
import { EmptyState } from '../../shell/EmptyState';
import { PageHeader } from '../../shell/PageHeader';
import { COMPACT_QUERY, useMediaQuery } from '../../shell/useMediaQuery';
import { TableScroller } from '../TableScroller';
import { AuditSettings } from './AuditSettings';
import {
  type AuditClient,
  type AuditFilter,
  type AuditRecord,
  auditClient,
  type ChainStatus,
} from './client';
import { AUDIT_SUBJECTS, AUDIT_VERBS, auditActionWords, auditSubjectText } from './words';

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
  // Commas or semicolons, as the person's spreadsheet opens them (T-263).
  const csvSeparator = useCsvSeparator();
  const intl = useIntl();
  const { session } = useSession();
  const titleId = useId();
  const formId = useId();
  const compact = useMediaQuery(COMPACT_QUERY);
  const notAdmin = session.status === 'signed-in' && !session.user.isSiteAdmin;
  const [forbidden, setForbidden] = useState(notAdmin);
  const [draft, setDraft] = useState<Omit<AuditFilter, 'action'>>({});
  // The action is picked in words, what it is about and then what happened, and sent as its code:
  // `user.` for every event about a person, `user.deactivated` for one kind (AD-2).
  const [subject, setSubject] = useState('');
  const [verb, setVerb] = useState('');
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
    setFilter({ ...draft, ...(subject ? { action: `${subject}.${verb}` } : {}) });
  };
  const verify = async () => {
    setChain('checking');
    try {
      setChain(await client.verify());
    } catch {
      setChain('failed');
    }
  };
  // The pickers' choices in words, in the order of the language.
  const byWords = (a: [string, string], b: [string, string]) =>
    a[1].localeCompare(b[1], intl.locale);
  const subjects = AUDIT_SUBJECTS.map((code): [string, string] => [
    code,
    t(`admin.audit.subject.${code}` as MessageId),
  ]).sort(byWords);
  const verbs = AUDIT_VERBS.map((code): [string, string] => {
    const words = t(`admin.audit.verb.${code}` as MessageId);
    return [code, words.charAt(0).toLocaleUpperCase(intl.locale) + words.slice(1)];
  }).sort(byWords);
  const when = (iso: string) =>
    intl.formatDate(new Date(iso), { dateStyle: 'medium', timeStyle: 'medium' });
  // In the table the day and the time stand on two lines, and where a record came from under who
  // made it, so the action and its subject have the room they need beside Administration's list
  // (AD-2).
  const whenCell = (iso: string) => (
    <time dateTime={iso}>
      <span className="audit-day">{intl.formatDate(new Date(iso), { dateStyle: 'medium' })}</span>{' '}
      <span className="audit-time">{intl.formatTime(new Date(iso), { timeStyle: 'medium' })}</span>
    </time>
  );
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
          <select
            value={subject}
            onChange={(e) => {
              setSubject(e.target.value);
              setVerb('');
            }}
          >
            <option value="">{t('admin.audit.anySubject')}</option>
            {subjects.map(([code, words]) => (
              <option key={code} value={code}>
                {words}
              </option>
            ))}
          </select>
        </label>
        {subject && (
          <label className="form-field">
            <span className="form-label">{t('admin.audit.actionVerb')}</span>
            <select value={verb} onChange={(e) => setVerb(e.target.value)}>
              <option value="">{t('admin.audit.anyVerb')}</option>
              {verbs.map(([code, words]) => (
                <option key={code} value={code}>
                  {words}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="submit" className="button-primary">
          {t('admin.audit.search')}
        </button>
      </form>

      <div className="audit-actions">
        <a
          className="button-secondary"
          href={client.exportUrl(filter, 'csv', csvSeparator)}
          download
        >
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
                <strong>{who(r)}</strong> <span>{auditActionWords(t, r.action, r.about)}</span>
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
        <TableScroller label={t('admin.audit.table')} className="glass-card glass-scroller">
          <table className="data-table audit-table">
            <caption className="visually-hidden">{t('admin.audit.table')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('admin.audit.column.when')}</th>
                <th scope="col">{t('admin.audit.column.who')}</th>
                <th scope="col">{t('admin.audit.column.action')}</th>
                <th scope="col">{t('admin.audit.column.subject')}</th>
              </tr>
            </thead>
            <tbody>
              {log.records.map((r) => (
                <tr key={r.seq}>
                  <td className="audit-when">{whenCell(r.occurredAt)}</td>
                  <td className="audit-who">
                    {who(r)}
                    {r.ip && (
                      <span className="audit-from">
                        {t('admin.audit.entryFrom', { address: r.ip })}
                      </span>
                    )}
                  </td>
                  <td>{auditActionWords(t, r.action, r.about)}</td>
                  <td>{r.subject ? auditSubjectText(t, r.subject) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
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
