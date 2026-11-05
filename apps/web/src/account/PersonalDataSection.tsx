import { useCallback, useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { EmptyState } from '../shell/EmptyState';
import type { PersonalDataClient, PersonalExport } from './personalData';

export interface PersonalDataSectionProps {
  client: PersonalDataClient;
  /** The person's time zone for dates; null follows the device. */
  timeZone: string | null;
  /** How long to wait before asking again while a download is being made (tests pass 0). */
  pollMs?: number;
}

type State =
  | { status: 'loading' }
  | { status: 'loaded'; exports: PersonalExport[] }
  | { status: 'failed' };

/**
 * A download of one's own data (ASVS 8.3.2, IAM-008; ADR-111): the server makes a ZIP in the
 * background and keeps it for a week. The list says how each download stands and offers the
 * finished ones. A site administrator sees the same panel for anyone on the People page.
 */
export function PersonalDataSection({ client, timeZone, pollMs = 3000 }: PersonalDataSectionProps) {
  const t = useT();
  const intl = useIntl();
  const expired = useSessionExpiry();
  const titleId = useId();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState({ status: 'loaded', exports: await client.list() });
    } catch (e) {
      if (!expired(e)) setState({ status: 'failed' });
    }
  }, [client, expired]);

  useEffect(() => {
    void load();
  }, [load]);

  // While one is being made, ask again now and then (after each answer).
  useEffect(() => {
    const pending =
      state.status === 'loaded' &&
      state.exports.some((e) => e.state === 'queued' || e.state === 'running');
    if (!pending) return;
    const timer = setTimeout(() => void load(), pollMs);
    return () => clearTimeout(timer);
  }, [state, load, pollMs]);

  const ask = async () => {
    setBusy(true);
    setDone('');
    setError(null);
    try {
      await client.request();
      setDone(t('personalData.requested'));
    } catch (e) {
      if (expired(e)) return;
      const code = e instanceof ApiError ? (e.body as { error?: string } | null)?.error : undefined;
      setError(
        code === 'export_in_progress'
          ? t('personalData.inProgress')
          : code === 'storage_unavailable'
            ? t('personalData.noStorage')
            : t('personalData.failed'),
      );
    } finally {
      setBusy(false);
    }
    await load();
  };

  const when = (iso: string) =>
    intl.formatDate(iso, {
      dateStyle: 'medium',
      timeStyle: 'short',
      ...(timeZone ? { timeZone } : {}),
    });
  const size = (bytes: number | null) =>
    bytes === null
      ? ''
      : intl.formatNumber(bytes / 1024 / 1024, {
          style: 'unit',
          unit: 'megabyte',
          maximumFractionDigits: 1,
        });

  return (
    <section aria-labelledby={titleId} className="glass-card account-section">
      <h2 id={titleId} className="facts-title">
        {client.subject
          ? t('personalData.titleOf', { name: client.subject })
          : t('personalData.title')}
      </h2>
      <p className="page-note">{t('personalData.intro')}</p>
      <div className="form-actions">
        <button type="button" className="button-primary" disabled={busy} onClick={() => void ask()}>
          {t('personalData.request')}
        </button>
      </div>
      <p role="status" className="form-status">
        {done}
      </p>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {state.status === 'loading' && <p className="page-note">{t('personalData.loading')}</p>}
      {state.status === 'failed' && (
        <p role="alert" className="form-error">
          {t('personalData.loadFailed')}
        </p>
      )}
      {state.status === 'loaded' &&
        (state.exports.length === 0 ? (
          <EmptyState compact title={t('personalData.none')}>
            {t('empty.personalData.body')}
          </EmptyState>
        ) : (
          <ul className="session-list">
            {state.exports.map((e) => (
              <li key={e.id} className="session-item">
                <div className="session-main">
                  <p className="session-device">
                    {t('personalData.askedAt', { when: when(e.createdAt) })}
                  </p>
                  <p className="session-meta">
                    <span>{t(`personalData.state.${e.state}`)}</span>
                    {e.state === 'ready' && e.expiresAt && (
                      <span>{t('personalData.until', { when: when(e.expiresAt) })}</span>
                    )}
                    {e.state === 'ready' && <span>{size(e.size)}</span>}
                  </p>
                </div>
                {e.state === 'ready' && (
                  <a
                    className="button-secondary"
                    href={client.downloadUrl(e.id)}
                    download
                    aria-label={t('personalData.downloadOf', { when: when(e.createdAt) })}
                  >
                    {t('personalData.download')}
                  </a>
                )}
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}
