import { type FormEvent, useEffect, useId, useState } from 'react';
import { ApiError, api } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { currentRoute, routeHref } from '../routing/router';
import { PageHeader } from '../shell/PageHeader';
import { PASSWORD_MIN_LENGTH, passwordProblemMessages, tooManyAttemptsMessage } from './errors';
import { PasswordField } from './PasswordField';
import { type SessionUser, useSession } from './SessionProvider';

/** What a valid link is for, from POST /api/v1/password-links/inspect. */
export interface PasswordLink {
  purpose: 'activate' | 'reset';
  name: string;
  email: string;
}

/**
 * The one-time link endpoints (IAM-001). The token always travels in a POST body, never in a
 * request URL, so it stays out of server and proxy logs.
 */
export interface PasswordLinkClient {
  inspect: (token: string) => Promise<PasswordLink>;
  /** Sets the password and signs this browser in; resolves to the user. */
  redeem: (token: string, password: string) => Promise<SessionUser>;
}

export const passwordLinkClient: PasswordLinkClient = {
  inspect: (token) =>
    api<PasswordLink>('/password-links/inspect', { method: 'POST', body: { token } }),
  redeem: async (token, password) =>
    (
      await api<{ user: SessionUser }>('/password-links/redeem', {
        method: 'POST',
        body: { token, password },
      })
    ).user,
};

/** The token travels in the hash query of the link: #/password?token=... */
export function passwordTokenFromHash(hash: string): string | null {
  const query = hash.split('?')[1];
  if (!query) return null;
  return new URLSearchParams(query).get('token') || null;
}

type State =
  | { status: 'no-token' }
  | { status: 'checking' }
  | { status: 'ready'; link: PasswordLink }
  | { status: 'invalid' }
  /** The check failed for another reason: too many attempts, or no backend. */
  | { status: 'unavailable'; error: unknown };

type Failure = { message: string; problems: string[]; field: 'new' | 'confirm' | null };

export interface PasswordLinkPageProps {
  /** Runs once the password is set and the browser is signed in. */
  onDone: () => void;
  /** Stories and tests pass their own endpoints; the page calls the backend otherwise. */
  client?: PasswordLinkClient;
}

/**
 * Where an activation or reset link lands (#/password?token=...). Like setup it stands alone,
 * without the shell: the person is not signed in yet. The link is checked first, so a used or
 * expired link says so before anyone types a password.
 */
export function PasswordLinkPage({ onDone, client = passwordLinkClient }: PasswordLinkPageProps) {
  const t = useT();
  const { setUser } = useSession();
  const id = useId();
  const token = passwordTokenFromHash(currentRoute());
  const [state, setState] = useState<State>(
    token ? { status: 'checking' } : { status: 'no-token' },
  );
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const errorId = `${id}-error`;

  useEffect(() => {
    if (!token) {
      setState({ status: 'no-token' });
      return;
    }
    let cancelled = false;
    setState({ status: 'checking' });
    client.inspect(token).then(
      (link) => {
        if (!cancelled) setState({ status: 'ready', link });
      },
      (error: unknown) => {
        if (cancelled) return;
        setState(
          error instanceof ApiError && error.status === 404
            ? { status: 'invalid' }
            : { status: 'unavailable', error },
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [token, client]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!token) return;
    if (password !== confirm) {
      setFailure({ message: t('password.mismatch'), problems: [], field: 'confirm' });
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      setUser(await client.redeem(token, password));
      onDone();
    } catch (error) {
      setBusy(false);
      if (error instanceof ApiError && error.status === 404) {
        setState({ status: 'invalid' });
        return;
      }
      const throttled = tooManyAttemptsMessage(t, error);
      if (throttled) setFailure({ message: throttled, problems: [], field: null });
      else if (error instanceof ApiError && error.code === 'weak_password') {
        setFailure({
          message: t('password.problemsIntro'),
          problems: passwordProblemMessages(t, error.body),
          field: 'new',
        });
      } else setFailure({ message: t('passwordLink.saveFailed'), problems: [], field: null });
    }
  };

  if (state.status !== 'ready') {
    const note =
      state.status === 'checking'
        ? t('passwordLink.checking')
        : state.status === 'no-token'
          ? t('passwordLink.noToken')
          : state.status === 'invalid'
            ? t('passwordLink.invalid')
            : (tooManyAttemptsMessage(t, state.error) ?? t('passwordLink.failed'));
    return (
      <main className="setup">
        <PageHeader title={t('passwordLink.title')} purpose={t('purpose.passwordLink')} />
        <p className="page-note" role={state.status === 'checking' ? 'status' : undefined}>
          {note}
        </p>
        {state.status !== 'checking' && (
          <a className="button-primary setup-link" href={routeHref('#/sign-in')}>
            {t('passwordLink.goToSignIn')}
          </a>
        )}
      </main>
    );
  }

  const { link } = state;
  const activate = link.purpose === 'activate';
  const title = t(activate ? 'passwordLink.activateTitle' : 'passwordLink.resetTitle', {
    name: link.name,
  });
  const flagged = (field: Failure['field']) => failure !== null && failure.field === field;

  return (
    <main className="setup">
      <PageHeader
        title={title}
        purpose={t(activate ? 'passwordLink.activateIntro' : 'passwordLink.resetIntro', {
          email: link.email,
        })}
      />
      <form className="form glass-card account-section" onSubmit={submit} aria-label={title}>
        {/* Lets password managers file the new password under the right account. */}
        <input type="email" autoComplete="username" value={link.email} readOnly hidden />
        <PasswordField
          label={t('password.new')}
          toggleLabel={t('password.showNew')}
          autoComplete="new-password"
          hint={t('password.hint', { min: PASSWORD_MIN_LENGTH })}
          value={password}
          onChange={setPassword}
          invalid={flagged('new')}
          describedBy={flagged('new') ? errorId : undefined}
        />
        <PasswordField
          label={t('password.confirmNew')}
          toggleLabel={t('password.showConfirm')}
          autoComplete="new-password"
          value={confirm}
          onChange={setConfirm}
          invalid={flagged('confirm')}
          describedBy={flagged('confirm') ? errorId : undefined}
        />
        {failure && (
          <div id={errorId} className="form-error" role="alert">
            <p>{failure.message}</p>
            {failure.problems.length > 0 && (
              <ul>
                {failure.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        <button type="submit" className="button-primary" disabled={busy}>
          {t('passwordLink.submit')}
        </button>
      </form>
    </main>
  );
}
