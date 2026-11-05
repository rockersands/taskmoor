import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { useSessionExpiry } from '../session/useSessionExpiry';
import type { AccountClient, AccountSession } from './client';
import { deviceName } from './device';

export interface SessionsSectionProps {
  client: AccountClient;
  /** The person's time zone for dates; null follows the device. */
  timeZone: string | null;
}

type State =
  | { status: 'loading' }
  | { status: 'loaded'; sessions: AccountSession[] }
  | { status: 'failed' };

/** Where the person is signed in, and a way to sign those sessions out (IAM-004). */
export function SessionsSection({ client, timeZone }: SessionsSectionProps) {
  const t = useT();
  const intl = useIntl();
  const expired = useSessionExpiry();
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [state, setState] = useState<State>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const sessions = await client.listSessions();
      // This device first, then the most recently active.
      setState({
        status: 'loaded',
        sessions: [...sessions].sort((a, b) => Number(b.current) - Number(a.current)),
      });
    } catch (e) {
      if (!expired(e)) setState({ status: 'failed' });
    }
  }, [client, expired]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Runs one sign-out, reports it and re-reads the list. */
  const act = async (action: () => Promise<string>) => {
    setBusy(true);
    setDone('');
    setError(null);
    try {
      const message = await action();
      // The pressed button is about to disappear; keep focus in the section.
      heading.current?.focus();
      setDone(message);
    } catch (e) {
      if (expired(e)) return;
      setError(t('account.sessionActionFailed'));
    } finally {
      setBusy(false);
    }
    await load();
  };

  const signOutOne = (session: AccountSession, device: string) =>
    act(async () => {
      try {
        await client.signOutSession(session.id);
      } catch (e) {
        // Already gone (expired or signed out elsewhere): the outcome is the same.
        if (!(e instanceof ApiError && e.status === 404)) throw e;
      }
      return t('account.sessionSignedOut', { device });
    });

  const signOutOthers = () =>
    act(async () => t('account.othersSignedOut', { count: await client.signOutOtherSessions() }));

  const when = (iso: string) =>
    intl.formatDate(iso, {
      dateStyle: 'medium',
      timeStyle: 'short',
      ...(timeZone ? { timeZone } : {}),
    });

  const lastActive = (iso: string) => {
    const seconds = Math.min(0, (Date.parse(iso) - Date.now()) / 1000);
    const ago = -seconds;
    if (ago < 60) return t('account.activeNow');
    const [value, unit]: [number, Intl.RelativeTimeFormatUnit] =
      ago < 3600
        ? [seconds / 60, 'minute']
        : ago < 86_400
          ? [seconds / 3600, 'hour']
          : [seconds / 86_400, 'day'];
    return t('account.lastActive', {
      when: intl.formatRelativeTime(Math.round(value), unit, { numeric: 'auto' }),
    });
  };

  const others = state.status === 'loaded' ? state.sessions.filter((s) => !s.current) : [];

  return (
    <section aria-labelledby={titleId} className="glass-card account-section">
      <h2 id={titleId} ref={heading} tabIndex={-1} className="facts-title">
        {t('account.sessions')}
      </h2>
      <p className="page-note">{t('account.sessionsIntro')}</p>
      {state.status === 'loading' && <p className="page-note">{t('account.sessionsLoading')}</p>}
      {state.status === 'failed' && (
        <p role="alert" className="form-error">
          {t('account.sessionsFailed')}
        </p>
      )}
      {state.status === 'loaded' && (
        <>
          <ul className="session-list">
            {state.sessions.map((session) => {
              const device = session.app
                ? t('account.sessionApp', { name: session.app })
                : deviceName(t, session.userAgent);
              return (
                <li key={session.id} className="session-item">
                  <div className="session-main">
                    <p className="session-device">
                      <span>{device}</span>
                      {session.current && (
                        <span className="session-badge">{t('account.thisDevice')}</span>
                      )}
                    </p>
                    <p className="session-meta">
                      <span>
                        {session.ip
                          ? t('account.ipAddress', { address: session.ip })
                          : t('account.unknownAddress')}
                      </span>
                      <span>{lastActive(session.lastSeenAt)}</span>
                      <span>{t('account.signedInAt', { when: when(session.createdAt) })}</span>
                    </p>
                  </div>
                  {!session.current && (
                    <button
                      type="button"
                      className="button-secondary"
                      aria-label={t('account.signOutSessionNamed', { device })}
                      disabled={busy}
                      onClick={() => void signOutOne(session, device)}
                    >
                      {t('account.signOutSession')}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {others.length === 0 ? (
            <p className="page-note">{t('account.onlyThisSession')}</p>
          ) : (
            <div>
              <button
                type="button"
                className="button-secondary"
                disabled={busy}
                onClick={() => void signOutOthers()}
              >
                {t('account.signOutOthers')}
              </button>
            </div>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <p role="status" className="form-status">
        {done}
      </p>
    </section>
  );
}
