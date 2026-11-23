import { type FormEvent, useEffect, useId, useState } from 'react';
import { ApiError, api } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { personTimeZone } from '../i18n/zone';
import { EmptyState } from '../shell/EmptyState';
import { inUnits, LengthField, toMinutes, type Unit } from './SessionPolicyForm';

/** The alert rules the server knows (ADR-109), in the order the form shows them. */
export const ALERT_RULES = [
  'sign_in_failures_account',
  'sign_in_failures_address',
  'access_refusals',
  'bulk_exports',
] as const;
export type AlertRule = (typeof ALERT_RULES)[number];

export interface AlertRuleSetting {
  enabled: boolean;
  threshold: number;
  windowMinutes: number;
}
export type AlertRules = Record<AlertRule, AlertRuleSetting>;

/** An alert raised, as the server lists the latest ones. */
export interface RaisedAlert {
  id: number;
  rule: string;
  count: number;
  threshold: number;
  windowMinutes: number;
  subject: {
    userId?: number | null;
    tokenId?: number | null;
    address?: string | null;
    email?: string | null;
  };
  raisedAt: string;
}

export interface SecurityAlerts {
  rules: AlertRules;
  defaults: AlertRules;
  recent: RaisedAlert[];
}

export interface SecurityAlertsClient {
  load: () => Promise<SecurityAlerts>;
  save: (rules: AlertRules) => Promise<SecurityAlerts>;
}

export const securityAlertsClient: SecurityAlertsClient = {
  load: () => api<SecurityAlerts>('/security/alerts'),
  save: (rules) => api<SecurityAlerts>('/security/alerts', { method: 'PUT', body: { rules } }),
};

/** The limits the server keeps (`security/alerts.ts`). */
const THRESHOLD = { min: 1, max: 100_000 };
const WINDOW = { min: 1, max: 1440 };
/** A window is at most a day, so it is entered in minutes or hours, as session lengths are. */
const WINDOW_UNITS: readonly Unit[] = ['minutes', 'hours'];

type Length = { amount: string; unit: Unit };
type Draft = Record<AlertRule, { enabled: boolean; threshold: string; window: Length }>;
const draftOf = (rules: AlertRules): Draft =>
  Object.fromEntries(
    ALERT_RULES.map((r) => [
      r,
      {
        enabled: rules[r].enabled,
        threshold: String(rules[r].threshold),
        window: inUnits(rules[r].windowMinutes, WINDOW_UNITS),
      },
    ]),
  ) as Draft;

type State =
  | { status: 'loading' }
  | { status: 'loaded'; defaults: AlertRules; recent: RaisedAlert[] }
  | { status: 'failed' };

/**
 * The alert part of the Security page (ASVS 11.1.7, 11.1.8; ADR-109): for each rule (failed
 * sign-ins for one account, from one address, refused requests, bulk exports) whether it is on,
 * how many events raise an alert and within how many minutes; then the latest alerts. Alerts go
 * to every site administrator's inbox and email.
 */
export function SecurityAlertsForm({
  client = securityAlertsClient,
  locale,
}: {
  client?: SecurityAlertsClient;
  /** How times are written; the reader's locale unless given. */
  locale?: string;
}) {
  const t = useT();
  const id = useId();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState('');

  useEffect(() => {
    let cancelled = false;
    client.load().then(
      (alerts) => {
        if (cancelled) return;
        setDraft(draftOf(alerts.rules));
        setState({ status: 'loaded', defaults: alerts.defaults, recent: alerts.recent });
      },
      () => !cancelled && setState({ status: 'failed' }),
    );
    return () => {
      cancelled = true;
    };
  }, [client]);

  const change = (
    rule: AlertRule,
    field: 'enabled' | 'threshold' | 'window',
    value: string | boolean | Length,
  ) => setDraft((d) => (d ? { ...d, [rule]: { ...d[rule], [field]: value } } : d));
  // A window in words, in the unit that holds it whole: '1 hour', '15 minutes'.
  const length = (minutes: number) => {
    const { amount, unit } = inUnits(minutes, WINDOW_UNITS);
    return t('admin.alerts.length', { amount: Number(amount), unit });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    setError(null);
    setSaved('');
    const within = (n: number | null, range: { min: number; max: number }) =>
      n !== null && Number.isInteger(n) && n >= range.min && n <= range.max ? n : null;
    const rules = {} as AlertRules;
    for (const rule of ALERT_RULES) {
      const text = draft[rule].threshold;
      const threshold = within(text.trim() === '' ? null : Number(text), THRESHOLD);
      const windowMinutes = within(toMinutes(draft[rule].window), WINDOW);
      if (threshold === null || windowMinutes === null) {
        setError(t('admin.alerts.outOfRange'));
        return;
      }
      rules[rule] = { enabled: draft[rule].enabled, threshold, windowMinutes };
    }
    setBusy(true);
    try {
      const alerts = await client.save(rules);
      setDraft(draftOf(alerts.rules));
      setState({ status: 'loaded', defaults: alerts.defaults, recent: alerts.recent });
      setSaved(t('admin.alerts.saved'));
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 400
          ? t('admin.alerts.outOfRange')
          : t('admin.alerts.saveFailed'),
      );
    } finally {
      setBusy(false);
    }
  };

  if (state.status === 'loading') return null;
  if (state.status === 'failed' || !draft) {
    return (
      <p role="alert" className="form-error">
        {t('admin.alerts.failed')}
      </p>
    );
  }
  // On the reader's own clock (T-280), as the rest of the app writes times.
  const zone = personTimeZone();
  const when = (iso: string) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      ...(zone ? { timeZone: zone } : {}),
    }).format(new Date(iso));
  const ruleName = (rule: string) =>
    t(
      ((ALERT_RULES as readonly string[]).includes(rule)
        ? `admin.alerts.rule.${rule}`
        : 'admin.alerts.rule.access_refusals') as MessageId,
    );
  return (
    // Checked here, so the message is the page's own, in the reader's language.
    <form
      className="form glass-card account-section"
      onSubmit={submit}
      aria-labelledby={`${id}-title`}
      noValidate
    >
      <h2 id={`${id}-title`} className="facts-title">
        {t('admin.alerts.title')}
      </h2>
      <p className="page-note">{t('admin.alerts.intro')}</p>
      {ALERT_RULES.map((rule) => (
        <fieldset key={rule}>
          <legend>{ruleName(rule)}</legend>
          <div className="form-field form-field-inline">
            <input
              id={`${id}-${rule}-on`}
              type="checkbox"
              checked={draft[rule].enabled}
              onChange={(event) => change(rule, 'enabled', event.target.checked)}
            />
            <label htmlFor={`${id}-${rule}-on`}>{t('admin.alerts.enabled')}</label>
          </div>
          <div className="form-field">
            <label htmlFor={`${id}-${rule}-threshold`}>{t('admin.alerts.threshold')}</label>
            {/* As narrow as the window's number beside its unit (S3-AC-6). */}
            <div className="length-field">
              <input
                id={`${id}-${rule}-threshold`}
                type="number"
                inputMode="numeric"
                min={THRESHOLD.min}
                max={THRESHOLD.max}
                step={1}
                value={draft[rule].threshold}
                onChange={(event) => change(rule, 'threshold', event.target.value)}
              />
            </div>
          </div>
          {/* A number and a unit, like the session lengths above (D22, S3-AC-6). */}
          <LengthField
            id={`${id}-${rule}-window`}
            label={t('admin.alerts.window')}
            hintId={`${id}-${rule}-default`}
            value={draft[rule].window}
            units={WINDOW_UNITS}
            onChange={(value) => change(rule, 'window', value)}
          />
          <p id={`${id}-${rule}-default`} className="form-hint">
            {t('admin.alerts.default', {
              threshold: state.defaults[rule].threshold,
              length: length(state.defaults[rule].windowMinutes),
            })}
          </p>
        </fieldset>
      ))}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={busy}>
          {t('admin.alerts.save')}
        </button>
      </div>
      <p role="status" className="form-status">
        {saved}
      </p>
      <h3 id={`${id}-recent`} className="facts-title">
        {t('admin.alerts.recent')}
      </h3>
      {state.recent.length === 0 ? (
        <EmptyState compact title={t('admin.alerts.none')} />
      ) : (
        <ul aria-labelledby={`${id}-recent`} className="security-alerts-list">
          {state.recent.map((alert) => (
            <li key={alert.id} className="security-alert">
              <span>
                {t('admin.alerts.raised', {
                  rule: ruleName(alert.rule),
                  count: alert.count,
                  minutes: alert.windowMinutes,
                  time: when(alert.raisedAt),
                })}
              </span>
              {alert.subject.address && (
                <span className="security-alert-subject">
                  {t('admin.alerts.address', { address: alert.subject.address })}
                </span>
              )}
              {alert.subject.email && (
                <span className="security-alert-subject">
                  {t('admin.alerts.email', { email: alert.subject.email })}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
