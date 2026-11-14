import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { COMPACT_QUERY, useMediaQuery } from '../shell/useMediaQuery';
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
 * Per event, a table on wide screens; on phones one block per event with its channel switches
 * beneath (D23), so no translation runs off the page or breaks a word. Every box and radio is
 * the app's own (AC-11).
 */
export function NotificationsSection({ client }: NotificationsSectionProps) {
  const t = useT();
  const expired = useSessionExpiry();
  const id = useId();
  const compact = useMediaQuery(COMPACT_QUERY);
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

  // A change shows at once. Saves go one after the other, in the order they were made, and only
  // the answer to the latest is shown: an earlier answer arriving after a later change never
  // takes that change back. When a save fails, the settings go back to what the server holds,
  // and the failure stays said until the next save that works.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const latest = useRef(0);
  const failed = useRef(false);
  const save = (changes: PreferenceChanges) => {
    if (typeof prefs === 'string') return;
    const before = prefs;
    const mine = ++latest.current;
    setPrefs((shown) => (typeof shown === 'string' ? shown : applied(shown, changes)));
    setStatus('idle');
    queue.current = queue.current.then(async () => {
      try {
        const saved = await client.update(changes);
        if (mine !== latest.current) return;
        setPrefs(saved);
        setStatus(failed.current ? 'failed' : 'saved');
        failed.current = false;
      } catch (error) {
        if (expired(error)) return;
        failed.current = true;
        setStatus('failed');
        const held = await client.preferences().catch(() => before);
        if (mine === latest.current) {
          setPrefs(held);
          failed.current = false;
        }
      }
    });
  };

  const title = (
    <h2 id={`${id}-title`} className="facts-title" tabIndex={-1}>
      {t('notifications.title')}
    </h2>
  );
  if (prefs === 'loading' || prefs === 'failed') {
    return (
      <section
        aria-labelledby={`${id}-title`}
        className="glass-card account-section"
        id="notifications"
      >
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
    <section
      aria-labelledby={`${id}-title`}
      className="glass-card account-section"
      id="notifications"
    >
      {/* The page's intro says what this holds and that changes save at once (D17). */}
      {title}
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
                <span className="form-label">
                  {t(edge === 'start' ? 'notifications.quietFrom' : 'notifications.quietUntil')}
                </span>
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
      {compact ? (
        <fieldset className="notification-event-list">
          <legend className="notification-events-title">{t('notifications.events')}</legend>
          {NOTIFICATION_EVENTS.map((event) => {
            const label = t(`notifications.event.${event}` as MessageId);
            return (
              <fieldset key={event} className="notification-event">
                <legend>{label}</legend>
                <div className="notification-event-channels">
                  {CHANNELS.map((channel) => {
                    const name = t(`notifications.channel.${channel}` as MessageId);
                    return (
                      <label key={channel} className="check-row">
                        <input
                          type="checkbox"
                          aria-label={t('notifications.toggle', { channel: name, event: label })}
                          checked={prefs.events[event]?.[channel] ?? true}
                          onChange={(e) => choose(event, channel, e.target.checked)}
                        />
                        <span>{name}</span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            );
          })}
        </fieldset>
      ) : (
        <table className="data-table notification-events">
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
                      <label className="notification-cell">
                        <input
                          type="checkbox"
                          aria-label={t('notifications.toggle', {
                            channel: t(`notifications.channel.${channel}` as MessageId),
                            event: label,
                          })}
                          checked={prefs.events[event]?.[channel] ?? true}
                          onChange={(e) => choose(event, channel, e.target.checked)}
                        />
                      </label>
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
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
