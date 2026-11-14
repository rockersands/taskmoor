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

/** The limits the server keeps (`session-policy.ts`), in minutes. */
const LIFETIME = { min: 60, max: 90 * 24 * 60 };
const IDLE = { min: 5, max: 90 * 24 * 60 };

/** The units a length is entered in (D22), with their minutes. */
const UNITS = { minutes: 1, hours: 60, days: 24 * 60 } as const;
export type Unit = keyof typeof UNITS;
const EVERY_UNIT: readonly Unit[] = ['minutes', 'hours', 'days'];

/**
 * A number and a unit for a length in minutes: the largest of `units` that holds it whole
 * (minutes are always among them).
 */
export function inUnits(
  minutes: number,
  units: readonly Unit[] = EVERY_UNIT,
): { amount: string; unit: Unit } {
  const unit =
    [...units].reverse().find((u) => minutes % UNITS[u] === 0 && minutes !== 0) ?? 'minutes';
  return { amount: String(minutes / UNITS[unit]), unit };
}

/** The minutes of a number and a unit, or null when the number is not a whole one. */
export function toMinutes(length: { amount: string; unit: Unit }): number | null {
  const n = Number(length.amount);
  return length.amount.trim() !== '' && Number.isInteger(n) ? n * UNITS[length.unit] : null;
}

type State =
  | { status: 'loading' }
  | { status: 'loaded'; defaults: SessionPolicy }
  | { status: 'failed' };

/**
 * The session part of the Security page (the user's decision of 2026-11-01): how long a
 * sign-in lasts and how long it may go unused, each a number with a unit picker (minutes, hours
 * or days, D22); the defaults are 14 days and 3 days, and ASVS level 2 asks for a sign-in of at
 * most 12 hours that ends after 30 minutes unused, which the hint names (S3-AC-5).
 */
export function SessionPolicyForm({
  client = sessionPolicyClient,
}: {
  client?: SessionPolicyClient;
}) {
  const t = useT();
  const id = useId();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [lifetime, setLifetime] = useState<{ amount: string; unit: Unit }>({
    amount: '',
    unit: 'days',
  });
  const [idle, setIdle] = useState<{ amount: string; unit: Unit }>({ amount: '', unit: 'days' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState('');

  useEffect(() => {
    let cancelled = false;
    client.load().then(
      (policy) => {
        if (cancelled) return;
        setLifetime(inUnits(policy.lifetimeMinutes));
        setIdle(inUnits(policy.idleMinutes));
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
    const lifetimeMinutes = toMinutes(lifetime);
    const idleMinutes = toMinutes(idle);
    if (
      lifetimeMinutes === null ||
      lifetimeMinutes < LIFETIME.min ||
      lifetimeMinutes > LIFETIME.max ||
      idleMinutes === null ||
      idleMinutes < IDLE.min ||
      idleMinutes > IDLE.max
    ) {
      setError(t('admin.sessions.outOfRange'));
      return;
    }
    if (idleMinutes > lifetimeMinutes) {
      setError(t('admin.sessions.idleTooLong'));
      return;
    }
    setBusy(true);
    try {
      const policy = await client.save({ lifetimeMinutes, idleMinutes });
      setLifetime(inUnits(policy.lifetimeMinutes));
      setIdle(inUnits(policy.idleMinutes));
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
      <LengthField
        id={`${id}-lifetime`}
        label={t('admin.sessions.lifetime')}
        hintId={`${id}-hint`}
        value={lifetime}
        onChange={setLifetime}
      />
      <LengthField
        id={`${id}-idle`}
        label={t('admin.sessions.idle')}
        hintId={`${id}-hint`}
        value={idle}
        onChange={setIdle}
      />
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

/**
 * A length as a number and its unit, side by side (D22): the session lengths here, and the
 * windows of the security alerts (S3-AC-6), which offer minutes and hours.
 */
export function LengthField({
  id,
  label,
  hintId,
  value,
  onChange,
  units = EVERY_UNIT,
}: {
  id: string;
  label: string;
  hintId: string;
  value: { amount: string; unit: Unit };
  onChange: (value: { amount: string; unit: Unit }) => void;
  units?: readonly Unit[];
}) {
  const t = useT();
  return (
    <div className="form-field">
      <label htmlFor={id}>{label}</label>
      <div className="length-field">
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          value={value.amount}
          aria-describedby={hintId}
          onChange={(event) => onChange({ ...value, amount: event.target.value })}
        />
        <select
          aria-label={t('admin.sessions.unitOf', { field: label })}
          value={value.unit}
          onChange={(event) => onChange({ ...value, unit: event.target.value as Unit })}
        >
          {units.map((unit) => (
            <option key={unit} value={unit}>
              {t(`admin.sessions.unit.${unit}`)}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
