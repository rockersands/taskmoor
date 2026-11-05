import { type FormEvent, useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../../i18n/I18nProvider';
import type { AuditClient, SyslogSink, SyslogTarget } from './client';

/** Months; 0 keeps every record. */
const RETENTION_CHOICES = [3, 6, 12, 24, 36, 60, 84, 120, 0];

/**
 * How long the audit log keeps records, and the syslog receiver new records are forwarded to
 * (M1-085; IAM-013). The receiver gets what happens after it is named; the download has the
 * past.
 */
export function AuditSettings({ client }: { client: AuditClient }) {
  const t = useT();
  const intl = useIntl();
  const titleId = useId();
  const syslogId = useId();
  const [months, setMonths] = useState<number | null>(null);
  const [retentionState, setRetentionState] = useState<'idle' | 'saved' | 'failed'>('idle');
  const [sink, setSink] = useState<SyslogSink | null>(null);
  const [form, setForm] = useState<SyslogTarget & { enabled: boolean }>({
    enabled: false,
    host: '',
    port: 6514,
    transport: 'tls',
  });
  const [syslogState, setSyslogState] = useState<
    'idle' | 'saving' | 'saved' | 'testing' | 'tested' | 'unreachable' | 'invalid' | 'failed'
  >('idle');

  useEffect(() => {
    let live = true;
    client.retention().then(
      (m) => live && setMonths(m),
      () => live && setRetentionState('failed'),
    );
    client.syslog().then(
      (found) => {
        if (!live || !found) return;
        setSink(found);
        setForm({
          enabled: found.enabled,
          host: found.host,
          port: found.port,
          transport: found.transport,
        });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client]);

  const saveRetention = async (value: number) => {
    setMonths(value);
    try {
      setMonths(await client.setRetention(value));
      setRetentionState('saved');
    } catch {
      setRetentionState('failed');
    }
  };
  const saveSyslog = async (event: FormEvent) => {
    event.preventDefault();
    setSyslogState('saving');
    try {
      setSink(await client.setSyslog(form));
      setSyslogState('saved');
    } catch {
      setSyslogState(form.host.trim() === '' ? 'invalid' : 'failed');
    }
  };
  const test = async () => {
    setSyslogState('testing');
    try {
      await client.testSyslog({ host: form.host, port: form.port, transport: form.transport });
      setSyslogState('tested');
    } catch {
      setSyslogState('unreachable');
    }
  };
  const status: Record<string, string> = {
    saved: t('admin.audit.syslog.saved'),
    tested: t('admin.audit.syslog.tested'),
    testing: t('admin.audit.syslog.testing'),
  };
  const errors: Record<string, string> = {
    unreachable: t('admin.audit.syslog.unreachable'),
    invalid: t('admin.audit.syslog.invalid'),
    failed: t('admin.audit.syslog.failed'),
  };

  return (
    <section aria-labelledby={titleId} className="glass-card account-section audit-settings">
      <h2 id={titleId} className="facts-title">
        {t('admin.audit.settings')}
      </h2>
      <label className="form-field audit-retention">
        <span className="form-label">{t('admin.audit.retention')}</span>
        <select
          value={months ?? ''}
          disabled={months === null}
          onChange={(e) => void saveRetention(Number(e.target.value))}
        >
          {[...new Set([...RETENTION_CHOICES, ...(months ? [months] : [])])]
            .sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b))
            .map((m) => (
              <option key={m} value={m}>
                {m === 0 ? t('admin.audit.forever') : t('admin.audit.months', { count: m })}
              </option>
            ))}
        </select>
      </label>
      {retentionState === 'saved' && (
        <p role="status" className="form-status">
          {t('admin.audit.retentionSaved')}
        </p>
      )}
      {retentionState === 'failed' && (
        <p role="alert" className="form-error">
          {t('admin.audit.retentionFailed')}
        </p>
      )}

      <form
        aria-labelledby={syslogId}
        className="audit-syslog"
        onSubmit={(e) => void saveSyslog(e)}
      >
        <h3 id={syslogId} className="facts-title">
          {t('admin.audit.syslog.title')}
        </h3>
        <p className="form-hint">{t('admin.audit.syslog.hint')}</p>
        <div className="form-field form-field-inline">
          <input
            id={`${syslogId}-enabled`}
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />
          <label htmlFor={`${syslogId}-enabled`}>{t('admin.audit.syslog.enabled')}</label>
        </div>
        <label className="form-field">
          <span className="form-label">{t('admin.audit.syslog.host')}</span>
          <input
            type="text"
            required
            value={form.host}
            onChange={(e) => setForm({ ...form, host: e.target.value })}
          />
        </label>
        <label className="form-field">
          <span className="form-label">{t('admin.audit.syslog.port')}</span>
          <input
            type="number"
            min={1}
            max={65535}
            required
            value={form.port}
            onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
          />
        </label>
        <label className="form-field">
          <span className="form-label">{t('admin.audit.syslog.transport')}</span>
          <select
            value={form.transport}
            onChange={(e) =>
              setForm({ ...form, transport: e.target.value as SyslogTarget['transport'] })
            }
          >
            <option value="tls">{t('admin.audit.syslog.tls')}</option>
            <option value="tcp">{t('admin.audit.syslog.tcp')}</option>
            <option value="udp">{t('admin.audit.syslog.udp')}</option>
          </select>
        </label>
        <div className="form-actions">
          <button type="submit" className="button-primary" disabled={syslogState === 'saving'}>
            {t('admin.audit.syslog.save')}
          </button>
          <button
            type="button"
            className="button-secondary"
            disabled={form.host.trim() === '' || syslogState === 'testing'}
            onClick={() => void test()}
          >
            {t('admin.audit.syslog.test')}
          </button>
        </div>
        {status[syslogState] && (
          <p role="status" className="form-status">
            {status[syslogState]}
          </p>
        )}
        {errors[syslogState] && (
          <p role="alert" className="form-error">
            {errors[syslogState]}
          </p>
        )}
        {sink?.enabled && (
          <p className="page-note">
            {sink.lastError
              ? t('admin.audit.syslog.lastError', { error: sink.lastError })
              : sink.lastSentAt
                ? t('admin.audit.syslog.lastSent', {
                    when: intl.formatDate(new Date(sink.lastSentAt), {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }),
                  })
                : t('admin.audit.syslog.nothingYet')}
          </p>
        )}
      </form>
    </section>
  );
}
