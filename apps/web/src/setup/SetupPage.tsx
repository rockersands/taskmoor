import { type FormEvent, useEffect, useId, useState } from 'react';
import { ApiError, api } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { currentRoute } from '../routing/router';
import { PASSWORD_MIN_LENGTH, passwordProblemMessages } from '../session/errors';
import { PasswordField } from '../session/PasswordField';
import { useSession } from '../session/SessionProvider';
import { PageHeader } from '../shell/PageHeader';
import { StandaloneFrame, StandaloneNote } from '../shell/StandaloneFrame';

type Status = 'checking' | 'ready' | 'done' | 'submitting' | 'already-set-up' | 'no-token';

/** The token travels in the hash query the installer printed: #/setup?token=... */
export function setupTokenFromHash(hash: string): string | null {
  const query = hash.split('?')[1];
  if (!query) return null;
  return new URLSearchParams(query).get('token');
}

/**
 * First-run setup (OPS-003, M0-027): one form creates the site administrator, names the
 * instance and, optionally, records mail settings. The one-time token in the link authorises
 * it. Whether the site is set up is asked first, with or without a token (AC-5): a site that is
 * set up says so, and the frame's way out leads to sign in (D24).
 */
export function SetupPage({ onDone }: { onDone: () => void }) {
  const t = useT();
  const { refresh } = useSession();
  const id = useId();
  const token = setupTokenFromHash(currentRoute());
  const [status, setStatus] = useState<Status>('checking');
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [instanceName, setInstanceName] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [withSmtp, setWithSmtp] = useState(false);
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('587');
  const [smtpSecure, setSmtpSecure] = useState(false);
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpFrom, setSmtpFrom] = useState('');

  useEffect(() => {
    const open = token ? 'ready' : 'no-token';
    api<{ needed: boolean }>('/setup')
      .then(({ needed }) => setStatus(needed ? open : 'already-set-up'))
      .catch(() => setStatus(open));
  }, [token]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirm) {
      setError(t('password.mismatch'));
      return;
    }
    setStatus('submitting');
    setError(null);
    setProblems([]);
    try {
      await api('/setup', {
        method: 'POST',
        body: {
          token,
          instanceName,
          admin: { name, email, password },
          ...(withSmtp
            ? {
                smtp: {
                  host: smtpHost,
                  port: Number(smtpPort),
                  secure: smtpSecure,
                  user: smtpUser || undefined,
                  from: smtpFrom,
                },
              }
            : {}),
        },
      });
      await refresh();
      setStatus('done');
      onDone();
    } catch (e) {
      setStatus('ready');
      if (e instanceof ApiError) {
        if (e.code === 'invalid_setup_token') setError(t('setup.invalidToken'));
        else if (e.code === 'setup_completed') setStatus('already-set-up');
        else if (e.code === 'weak_password' || e.code === 'invalid_request') {
          // Password problems come as codes with translated messages; other fields as text.
          setError(t(e.code === 'weak_password' ? 'password.problemsIntro' : 'setup.invalid'));
          setProblems(passwordProblemMessages(t, e.body));
        } else setError(t('setup.failed'));
      } else setError(t('setup.failed'));
    }
  };

  // The intro describes the form, so a page without one leaves it out (AC-7). Only a site that is
  // set up has an account to sign in with, so only there does the frame offer the way out.
  if (status === 'no-token' || status === 'already-set-up' || (status === 'checking' && !token)) {
    return (
      <StandaloneFrame wayOut={status === 'already-set-up'}>
        <main className="setup">
          <PageHeader
            title={t('setup.title')}
            {...(status === 'checking' ? { purpose: t('setup.intro') } : {})}
          />
          {/* A missing link is a problem; a site already set up is only information. */}
          <StandaloneNote
            kind={status === 'checking' ? 'checking' : status === 'no-token' ? 'problem' : 'note'}
          >
            {status === 'checking'
              ? t('setup.checking')
              : status === 'no-token'
                ? t('setup.noToken')
                : t('setup.alreadySetUp')}
          </StandaloneNote>
        </main>
      </StandaloneFrame>
    );
  }

  const field = (key: string) => `${id}-${key}`;
  return (
    // No account exists yet, so there is nowhere to sign in.
    <StandaloneFrame wayOut={false}>
      <main className="setup">
        <PageHeader title={t('setup.title')} purpose={t('setup.intro')} />
        {/* One card, as on every stand-alone form (D24, AC-16): its groups are wells inside it,
            and 'Finish setup' ends the card rather than standing under it. */}
        <form
          className="form glass-card account-section"
          onSubmit={submit}
          aria-label={t('setup.title')}
        >
          <fieldset>
            <legend>{t('setup.instance')}</legend>
            <div className="form-field">
              <label htmlFor={field('instance')}>{t('setup.instanceName')}</label>
              <input
                id={field('instance')}
                required
                maxLength={100}
                value={instanceName}
                onChange={(e) => setInstanceName(e.target.value)}
              />
            </div>
          </fieldset>
          <fieldset>
            <legend>{t('setup.admin')}</legend>
            <div className="form-field">
              <label htmlFor={field('name')}>{t('setup.adminName')}</label>
              <input
                id={field('name')}
                required
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="form-field">
              <label htmlFor={field('email')}>{t('auth.email')}</label>
              <input
                id={field('email')}
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <PasswordField
              label={t('auth.password')}
              autoComplete="new-password"
              hint={t('password.hint', { min: PASSWORD_MIN_LENGTH })}
              value={password}
              onChange={setPassword}
            />
            <PasswordField
              label={t('setup.confirmPassword')}
              toggleLabel={t('password.showConfirm')}
              autoComplete="new-password"
              value={confirm}
              onChange={setConfirm}
            />
          </fieldset>
          <fieldset>
            <legend>{t('setup.mail')}</legend>
            <div className="form-field form-field-inline">
              <input
                id={field('with-smtp')}
                type="checkbox"
                checked={withSmtp}
                onChange={(e) => setWithSmtp(e.target.checked)}
              />
              <label htmlFor={field('with-smtp')}>{t('setup.configureMail')}</label>
            </div>
            {withSmtp && (
              <>
                <div className="form-field">
                  <label htmlFor={field('smtp-host')}>{t('setup.smtpHost')}</label>
                  <input
                    id={field('smtp-host')}
                    required
                    value={smtpHost}
                    onChange={(e) => setSmtpHost(e.target.value)}
                  />
                </div>
                <div className="form-field">
                  <label htmlFor={field('smtp-port')}>{t('setup.smtpPort')}</label>
                  <input
                    id={field('smtp-port')}
                    type="number"
                    min={1}
                    max={65535}
                    required
                    value={smtpPort}
                    onChange={(e) => setSmtpPort(e.target.value)}
                  />
                </div>
                <div className="form-field form-field-inline">
                  <input
                    id={field('smtp-secure')}
                    type="checkbox"
                    checked={smtpSecure}
                    onChange={(e) => setSmtpSecure(e.target.checked)}
                  />
                  <label htmlFor={field('smtp-secure')}>{t('setup.smtpSecure')}</label>
                </div>
                <div className="form-field">
                  <label htmlFor={field('smtp-user')}>{t('setup.smtpUser')}</label>
                  <input
                    id={field('smtp-user')}
                    autoComplete="off"
                    value={smtpUser}
                    onChange={(e) => setSmtpUser(e.target.value)}
                  />
                </div>
                <div className="form-field">
                  <label htmlFor={field('smtp-from')}>{t('setup.smtpFrom')}</label>
                  <input
                    id={field('smtp-from')}
                    type="email"
                    required
                    value={smtpFrom}
                    onChange={(e) => setSmtpFrom(e.target.value)}
                  />
                </div>
                <p className="form-hint">{t('setup.smtpPasswordHint')}</p>
              </>
            )}
          </fieldset>
          {error && (
            <div className="form-error" role="alert">
              <p>{error}</p>
              {problems.length > 0 && (
                <ul>
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <button
            type="submit"
            className="button-primary"
            disabled={status === 'submitting' || status === 'checking'}
          >
            {t('setup.submit')}
          </button>
        </form>
      </main>
    </StandaloneFrame>
  );
}
