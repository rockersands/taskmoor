import { useEffect, useId, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { useSessionExpiry } from '../session/useSessionExpiry';
import {
  CHANNELS,
  type Channel,
  type EmailDelivery,
  NOTIFICATION_EVENTS,
  type NotificationPreferences,
  type NotificationsClient,
  type PreferenceChanges,
} from './client';

export interface NotificationsSectionProps {
  client: NotificationsClient;
}

const DELIVERIES: EmailDelivery[] = ['instant', 'daily', 'weekly', 'off'];
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const hourText = (hour: number) => `${String(hour).padStart(2, '0')}:00`;

/** The settings with a change made, before the backend confirms it. */
function applied(
  prefs: NotificationPreferences,
  changes: PreferenceChanges,
): NotificationPreferences {
  const events = { ...prefs.events };
  for (const [event, choice] of Object.entries(changes.events ?? {})) {
    events[event] = { ...(events[event] ?? { email: true, inbox: true }), ...choice };
  }
  return {
    ownChanges: changes.ownChanges ?? prefs.ownChanges,
    emailDelivery: changes.emailDelivery ?? prefs.emailDelivery,
    quietHours: changes.quietHours !== undefined ? changes.quietHours : prefs.quietHours,
    events,
  };
}

/**
 * How Taskmoor tells this person about changes (M1-056, M1-057; NTF-002, NTF-004): email at
 * once or as a digest, quiet hours, their own changes, and per event whether email and the
 * inbox carry it. Each change saves at once. Emails link here (#/account/notifications).
 */
export function NotificationsSection({ client }: NotificationsSectionProps) {
  const t = useT();
  const expired = useSessionExpiry();
  const id = useId();
  const [prefs, setPrefs] = useState<NotificationPreferences | 'loading' | 'failed'>('loading');
  const [status, setStatus] = useState<'idle' | 'saved' | 'failed'>('idle');

  useEffect(() => {
    let live = true;
    client.preferences().then(
      (loaded) => live && setPrefs(loaded),
      (error) => {
        if (live && !expired(error)) setPrefs('failed');
      },
    );
    return () => {
      live = false;
    };
  }, [client, expired]);

  // A change shows at once and goes back if it cannot be saved.
  const save = async (changes: PreferenceChanges) => {
    if (typeof prefs === 'string') return;
    const before = prefs;
    setPrefs(applied(prefs, changes));
    setStatus('idle');
    try {
      setPrefs(await client.update(changes));
      setStatus('saved');
    } catch (error) {
      setPrefs(before);
      if (expired(error)) return;
      setStatus('failed');
    }
  };

  const title = (
    <h2 id={`${id}-title`} className="facts-title" tabIndex={-1}>
      {t('notifications.title')}
    </h2>
  );
  if (prefs === 'loading' || prefs === 'failed') {
    return (
      <section aria-labelledby={`${id}-title`} className="account-section" id="notifications">
        {title}
        <p className="page-note" role={prefs === 'failed' ? 'alert' : 'status'}>
          {t(prefs === 'failed' ? 'notifications.failed' : 'notifications.loading')}
        </p>
      </section>
    );
  }
  const quiet = prefs.quietHours;
  const choose = (event: string, channel: Channel, on: boolean) =>
    save({ events: { [event]: { [channel]: on } } });

  return (
    <section aria-labelledby={`${id}-title`} className="account-section" id="notifications">
      {title}
      <p className="page-note">{t('notifications.intro')}</p>
      <fieldset className="notification-delivery">
        <legend>{t('notifications.email')}</legend>
        {DELIVERIES.map((delivery) => (
          <label key={delivery} className="notification-choice">
            <input
              type="radio"
              name={`${id}-delivery`}
              value={delivery}
              checked={prefs.emailDelivery === delivery}
              aria-describedby={`${id}-${delivery}-hint`}
              onChange={() => save({ emailDelivery: delivery })}
            />
            <span>
              {t(`notifications.delivery.${delivery}` as MessageId)}
              <span id={`${id}-${delivery}-hint`} className="form-hint">
                {t(`notifications.delivery.${delivery}Hint` as MessageId)}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="notification-quiet">
        <label className="notification-choice">
          <input
            type="checkbox"
            checked={quiet !== null}
            onChange={(e) => save({ quietHours: e.target.checked ? { start: 22, end: 7 } : null })}
          />
          <span>{t('notifications.quiet')}</span>
        </label>
        {quiet !== null && (
          <div className="notification-hours">
            {(['start', 'end'] as const).map((edge) => (
              <label key={edge}>
                {t(edge === 'start' ? 'notifications.quietFrom' : 'notifications.quietUntil')}
                <select
                  value={quiet[edge]}
                  onChange={(e) =>
                    save({ quietHours: { ...quiet, [edge]: Number(e.target.value) } })
                  }
                >
                  {HOURS.map((hour) => (
                    <option key={hour} value={hour}>
                      {hourText(hour)}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        )}
      </div>
      <label className="notification-choice">
        <input
          type="checkbox"
          checked={prefs.ownChanges}
          onChange={(e) => save({ ownChanges: e.target.checked })}
        />
        <span>{t('notifications.ownChanges')}</span>
      </label>
      <table className="notification-events">
        <caption>{t('notifications.events')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('notifications.event')}</th>
            {CHANNELS.map((channel) => (
              <th key={channel} scope="col">
                {t(`notifications.channel.${channel}` as MessageId)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {NOTIFICATION_EVENTS.map((event) => {
            const label = t(`notifications.event.${event}` as MessageId);
            return (
              <tr key={event}>
                <th scope="row">{label}</th>
                {CHANNELS.map((channel) => (
                  <td key={channel}>
                    <input
                      type="checkbox"
                      aria-label={t('notifications.toggle', {
                        channel: t(`notifications.channel.${channel}` as MessageId),
                        event: label,
                      })}
                      checked={prefs.events[event]?.[channel] ?? true}
                      onChange={(e) => choose(event, channel, e.target.checked)}
                    />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="form-status" role="status">
        {status === 'saved' ? t('notifications.saved') : ''}
      </p>
      {status === 'failed' && (
        <p className="form-error" role="alert">
          {t('notifications.saveFailed')}
        </p>
      )}
    </section>
  );
}
