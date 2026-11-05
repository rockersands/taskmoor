import { type FormEvent, useEffect, useId, useState } from 'react';
import { ApiError, api } from '../api/client';
import { useT } from '../i18n/I18nProvider';

/** How long a sign-in lasts (ASVS 3.3.2), as `/api/v1/security/sessions` keeps it, in minutes. */
export interface SessionPolicy {
  lifetimeMinutes: number;
  idleMinutes: number;
}

export interface SessionPolicyClient {
  load: () => Promise<SessionPolicy & { defaults: SessionPolicy }>;
  save: (policy: SessionPolicy) => Promise<SessionPolicy>;
}

export const sessionPolicyClient: SessionPolicyClient = {
  load: () => api<SessionPolicy & { defaults: SessionPolicy }>('/security/sessions'),
  save: (policy) => api<SessionPolicy>('/security/sessions', { method: 'PUT', body: policy }),
};

/** The limits the server keeps (`session-policy.ts`), in the units the form asks for. */
const LIFETIME_HOURS = { min: 1, max: 90 * 24 };
const IDLE_MINUTES = { min: 5, max: 90 * 24 * 60 };

type State =
  | { status: 'loading' }
  | { status: 'loaded'; defaults: SessionPolicy }
  | { status: 'failed' };

/**
 * The session part of the Security page (the user's decision of 2026-11-01): how long a
 * sign-in lasts and how long it may go unused. The lifetime is asked in hours, the idle timeout
 * in minutes; the defaults are 14 days and 3 days, and ASVS level 2 asks for 12 hours and 30
 * minutes, which the hint names.
 */
export function SessionPolicyForm({
  client = sessionPolicyClient,
}: {
  client?: SessionPolicyClient;
}) {
  const t = useT();
  const id = useId();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [hours, setHours] = useState('');
  const [idle, setIdle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState('');

  useEffect(() => {
    let cancelled = false;
    client.load().then(
      (policy) => {
        if (cancelled) return;
        setHours(String(Math.round(policy.lifetimeMinutes / 60)));
        setIdle(String(policy.idleMinutes));
        setState({ status: 'loaded', defaults: policy.defaults });
      },
      () => !cancelled && setState({ status: 'failed' }),
    );
    return () => {
      cancelled = true;
    };
  }, [client]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSaved('');
    const lifetime = Number(hours);
    const idleMinutes = Number(idle);
    const whole = (n: number) => Number.isInteger(n);
    if (
      !whole(lifetime) ||
      lifetime < LIFETIME_HOURS.min ||
      lifetime > LIFETIME_HOURS.max ||
      !whole(idleMinutes) ||
      idleMinutes < IDLE_MINUTES.min ||
      idleMinutes > IDLE_MINUTES.max
    ) {
      setError(t('admin.sessions.outOfRange'));
      return;
    }
    if (idleMinutes > lifetime * 60) {
      setError(t('admin.sessions.idleTooLong'));
      return;
    }
    setBusy(true);
    try {
      const policy = await client.save({ lifetimeMinutes: lifetime * 60, idleMinutes });
      setHours(String(Math.round(policy.lifetimeMinutes / 60)));
      setIdle(String(policy.idleMinutes));
      setSaved(t('admin.sessions.saved'));
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 400
          ? t('admin.sessions.outOfRange')
          : t('admin.sessions.saveFailed'),
      );
    } finally {
      setBusy(false);
    }
  };

  if (state.status === 'loading') return null;
  if (state.status === 'failed') {
    return (
      <p role="alert" className="form-error">
        {t('admin.sessions.failed')}
      </p>
    );
  }
  return (
    <form
      className="form glass-card account-section"
      onSubmit={submit}
      aria-labelledby={`${id}-title`}
    >
      <h2 id={`${id}-title`} className="facts-title">
        {t('admin.sessions.title')}
      </h2>
      <p className="page-note">
        {t('admin.sessions.intro', {
          days: Math.round(state.defaults.lifetimeMinutes / 60 / 24),
          idleDays: Math.round(state.defaults.idleMinutes / 60 / 24),
        })}
      </p>
      <div className="form-field">
        <label htmlFor={`${id}-lifetime`}>{t('admin.sessions.lifetime')}</label>
        <input
          id={`${id}-lifetime`}
          type="number"
          inputMode="numeric"
          min={LIFETIME_HOURS.min}
          max={LIFETIME_HOURS.max}
          step={1}
          value={hours}
          aria-describedby={`${id}-hint`}
          onChange={(event) => setHours(event.target.value)}
        />
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-idle`}>{t('admin.sessions.idle')}</label>
        <input
          id={`${id}-idle`}
          type="number"
          inputMode="numeric"
          min={IDLE_MINUTES.min}
          max={IDLE_MINUTES.max}
          step={1}
          value={idle}
          aria-describedby={`${id}-hint`}
          onChange={(event) => setIdle(event.target.value)}
        />
      </div>
      <p id={`${id}-hint`} className="form-hint">
        {t('admin.sessions.hint')}
      </p>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={busy}>
          {t('admin.sessions.save')}
        </button>
      </div>
      <p role="status" className="form-status">
        {saved}
      </p>
    </form>
  );
}
