import { type FormEvent, useEffect, useId, useState } from 'react';
import { ApiError, api } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { useSession } from '../session/SessionProvider';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { PageHeader } from '../shell/PageHeader';
import { Fact, Facts } from './Facts';

/**
 * The site's email settings (M1-057; NTF-002, NTF-004), as `GET /api/v1/admin/email-settings`
 * gives them: how long a ticket's changes wait to go out in one email, the hour digests go out,
 * and whether an SMTP server is set up. The server's address and sign-in stay where Taskmoor
 * runs; nothing here reads or sends them.
 */
export interface EmailSettings {
  batchWindowSeconds: number;
  digestHour: number;
  smtpConfigured: boolean;
}

export interface EmailSettingsClient {
  load: () => Promise<EmailSettings>;
  save: (change: { batchWindowSeconds?: number; digestHour?: number }) => Promise<EmailSettings>;
}

export const emailSettingsClient: EmailSettingsClient = {
  load: async () =>
    (await api<{ emailSettings: EmailSettings }>('/admin/email-settings')).emailSettings,
  save: async (change) =>
    (
      await api<{ emailSettings: EmailSettings }>('/admin/email-settings', {
        method: 'PUT',
        body: change,
      })
    ).emailSettings,
};

/** The batch window's range (`routes/email.ts`), in minutes as the page shows it. */
const MAX_MINUTES = 60;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/** Minutes as the field shows them: whole minutes plainly, a part of one to two places. */
const minutesOf = (seconds: number) => String(Math.round((seconds / 60) * 100) / 100);

/**
 * Email (T-155): for site administrators only, as the route is. Whether mail can go out at all,
 * the wait before a ticket's changes are emailed together (0 to 60 minutes), and the hour daily
 * and weekly digests go out in each person's own time zone.
 */
export function EmailSettingsPage({
  client = emailSettingsClient,
}: {
  client?: EmailSettingsClient;
}) {
  const t = useT();
  const id = useId();
  const expired = useSessionExpiry();
  const { session } = useSession();
  const notAdmin = session.status === 'signed-in' && !session.user.isSiteAdmin;
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'loaded'; settings: EmailSettings }
    | { status: 'failed' }
    | { status: 'forbidden' }
  >(notAdmin ? { status: 'forbidden' } : { status: 'loading' });
  const [minutes, setMinutes] = useState('');
  const [hour, setHour] = useState('8');
  const [status, setStatus] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const show = (settings: EmailSettings) => {
    setState({ status: 'loaded', settings });
    setMinutes(minutesOf(settings.batchWindowSeconds));
    setHour(String(settings.digestHour));
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: read once per client
  useEffect(() => {
    if (notAdmin) return;
    let live = true;
    client.load().then(
      (settings) => {
        if (live) show(settings);
      },
      (error: unknown) => {
        if (!live || expired(error)) return;
        setState({
          status: error instanceof ApiError && error.status === 403 ? 'forbidden' : 'failed',
        });
      },
    );
    return () => {
      live = false;
    };
  }, [client, notAdmin, expired]);

  const forbidden = state.status === 'forbidden';
  const header = (
    <PageHeader
      titleId={`${id}-title`}
      title={t('emailSettings.title')}
      {...(forbidden ? {} : { purpose: t('settings.emailHint'), about: t('emailSettings.about') })}
    />
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const wanted = Number(minutes);
    if (minutes.trim() === '' || !Number.isFinite(wanted) || wanted < 0 || wanted > MAX_MINUTES) {
      setStatus('');
      setProblem(t('emailSettings.windowInvalid'));
      return;
    }
    setProblem(null);
    client.save({ batchWindowSeconds: Math.round(wanted * 60), digestHour: Number(hour) }).then(
      (saved) => {
        show(saved);
        setStatus(t('emailSettings.saved'));
      },
      (error: unknown) => {
        if (expired(error)) return;
        setStatus('');
        setProblem(
          error instanceof ApiError && error.status === 403
            ? t('emailSettings.forbidden')
            : t('emailSettings.saveFailed'),
        );
      },
    );
  };

  return (
    <section className="page admin-page" aria-labelledby={`${id}-title`}>
      {header}
      {forbidden && <p className="page-note">{t('emailSettings.forbidden')}</p>}
      {state.status === 'failed' && (
        <p role="alert" className="form-error">
          {t('emailSettings.failed')}
        </p>
      )}
      {state.status === 'loading' && <p className="page-note">{t('emailSettings.loading')}</p>}
      {state.status === 'loaded' && (
        <>
          <Facts
            title={t('emailSettings.outgoing')}
            after={
              <p className="page-note">
                {t(
                  state.settings.smtpConfigured
                    ? 'emailSettings.serverOnNote'
                    : 'emailSettings.serverOffNote',
                )}
              </p>
            }
          >
            <Fact label={t('emailSettings.server')}>
              {t(
                state.settings.smtpConfigured
                  ? 'emailSettings.serverOn'
                  : 'emailSettings.serverOff',
              )}
            </Fact>
          </Facts>
          <form
            className="glass-card people-card people-form"
            aria-label={t('emailSettings.formLabel')}
            onSubmit={submit}
            noValidate
          >
            <div className="form-field">
              <label htmlFor={`${id}-window`} className="form-label">
                {t('emailSettings.window')}
              </label>
              <input
                id={`${id}-window`}
                type="number"
                inputMode="decimal"
                min={0}
                max={MAX_MINUTES}
                step="any"
                value={minutes}
                aria-describedby={`${id}-window-hint`}
                onChange={(event) => setMinutes(event.target.value)}
              />
              <p id={`${id}-window-hint`} className="form-hint">
                {t('emailSettings.windowHint')}
              </p>
            </div>
            <div className="form-field">
              <label htmlFor={`${id}-hour`} className="form-label">
                {t('emailSettings.digestHour')}
              </label>
              <select
                id={`${id}-hour`}
                value={hour}
                aria-describedby={`${id}-hour-hint`}
                onChange={(event) => setHour(event.target.value)}
              >
                {HOURS.map((h) => (
                  <option key={h} value={h}>
                    {t('emailSettings.hour', { hour: String(h).padStart(2, '0') })}
                  </option>
                ))}
              </select>
              <p id={`${id}-hour-hint`} className="form-hint">
                {t('emailSettings.digestHourHint')}
              </p>
            </div>
            <div className="form-actions">
              <button type="submit" className="button-primary">
                {t('emailSettings.save')}
              </button>
            </div>
            <p role="status" className="form-status">
              {status}
            </p>
            {problem && (
              <p role="alert" className="form-error">
                {problem}
              </p>
            )}
          </form>
        </>
      )}
    </section>
  );
}
