import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { currentRoute, navigate, routeHref } from '../routing/router';
import { EnrollmentStep } from '../session/EnrollmentStep';
import {
  PASSWORD_MIN_LENGTH,
  passwordProblemMessages,
  tooManyAttemptsMessage,
} from '../session/errors';
import { PasswordField } from '../session/PasswordField';
import { passwordTokenFromHash } from '../session/PasswordLinkPage';
import { SecondFactorStep } from '../session/SecondFactorStep';
import type { SecondFactorMethod, SessionUser } from '../session/SessionProvider';
import { useSession } from '../session/SessionProvider';
import { SignInForm } from '../session/SignInForm';
import { hashParam, type SignInSsoClient, signInSsoClient } from '../sso/client';
import { type InvitationClient, type InvitationLink, invitationClient } from './client';

/**
 * A single sign-on leaves this site and comes back. The token must not travel in the address the
 * sign-in starts with, where a server or proxy log could keep it (the same reason it goes in POST
 * bodies), so it waits in this tab's storage and the sign-in comes back to the bare route.
 */
const TOKEN_KEY = 'taskmoor.invitation';
function rememberToken(token: string | null): string | null {
  try {
    if (token) {
      window.sessionStorage.setItem(TOKEN_KEY, token);
      return token;
    }
    return window.sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return token;
  }
}
function forgetToken() {
  try {
    window.sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing was kept, then.
  }
}

export interface InvitationPageProps {
  /** Stories and tests pass their own endpoints; the page calls the backend otherwise. */
  client?: InvitationClient;
  /** Where the person lands; the page navigates there otherwise. */
  onJoined?: (trackKey: string) => void;
  /** Stories and tests pass their own single sign-on endpoints. */
  ssoClient?: SignInSsoClient;
}

type State =
  | { status: 'no-token' }
  | { status: 'checking' }
  | { status: 'ready'; link: InvitationLink }
  | { status: 'invalid' }
  | { status: 'unavailable'; error: unknown };

type Step =
  | { kind: 'form' }
  | { kind: 'second-factor'; challenge: string; methods: SecondFactorMethod[] }
  | { kind: 'enroll'; challenge: string };

/**
 * Where an invitation's link lands (#/invite?token=...; IAM-027, IAM-029). It stands alone, like
 * a password link: the person may not be signed in yet. It offers both ways in for every address,
 * so it says nothing about accounts: choose a password, or sign in with what the site has
 * enabled (a password, or a provider that vouches for this address). Choosing a password leads
 * straight into the ordinary sign-in, which asks for a second factor where the site requires one.
 */
export function InvitationPage({
  client = invitationClient,
  onJoined,
  ssoClient,
}: InvitationPageProps) {
  const t = useT();
  const { session, signIn, signOut, setUser } = useSession();
  const id = useId();
  const [token] = useState(() => rememberToken(passwordTokenFromHash(currentRoute())));
  const [state, setState] = useState<State>(
    token ? { status: 'checking' } : { status: 'no-token' },
  );
  const [mode, setMode] = useState<'new' | 'account'>(() =>
    hashParam(currentRoute(), 'account') === '1' ? 'account' : 'new',
  );
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; problems: string[] } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'form' });
  /** The password was chosen here: the link is used up, and the track's key is known. */
  const [redeemedTrack, setRedeemedTrack] = useState<string | null>(null);
  /** The person signed in on this page, so joining needs no further click. */
  const [cameThrough, setCameThrough] = useState(false);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
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
        if (error instanceof ApiError && error.status === 404) forgetToken();
      },
    );
    return () => {
      cancelled = true;
    };
  }, [token, client]);

  // A provider serves this address (decided by its domain alone, so it says nothing about
  // accounts): signing in comes first, with the provider on offer (IAM-032). Choosing a password
  // stays one click away, unless the domain enforces single sign-on and the server refuses it.
  const linkEmail = state.status === 'ready' ? state.link.email : null;
  const modeTouched = useRef(false);
  useEffect(() => {
    if (!linkEmail || modeTouched.current) return;
    let cancelled = false;
    (ssoClient ?? signInSsoClient).discover(linkEmail).then(
      (found) => {
        if (!cancelled && !modeTouched.current && found?.provider) setMode('account');
      },
      // Unanswered: the page stays as it is.
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [linkEmail, ssoClient]);

  const anonymous = session.status === 'anonymous';
  useEffect(() => {
    if (anonymous) setCameThrough(true);
  }, [anonymous]);

  const land = useCallback(
    (key: string) => {
      forgetToken();
      if (onJoined) onJoined(key);
      else navigate(`#/tracks/${encodeURIComponent(key)}`);
    },
    [onJoined],
  );

  const join = useCallback(async () => {
    if (!token) return;
    setBusy(true);
    setFailure(null);
    try {
      const { track } = await client.accept(token);
      land(track.key);
    } catch (error) {
      setBusy(false);
      // A password chosen here already took the invitation up: nothing is left but to go in.
      if (redeemedTrack) {
        land(redeemedTrack);
        return;
      }
      if (error instanceof ApiError && error.status === 404) {
        setState({ status: 'invalid' });
        return;
      }
      setFailure({
        message: tooManyAttemptsMessage(t, error) ?? t('invite.failed'),
        problems: [],
      });
    }
  }, [client, land, redeemedTrack, t, token]);

  const signedInAs = session.status === 'signed-in' ? session.user.email.toLowerCase() : null;
  const invitedEmail = state.status === 'ready' ? state.link.email : null;
  const ownInvitation = signedInAs !== null && signedInAs === invitedEmail;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when signing in has finished
  useEffect(() => {
    if (ownInvitation && cameThrough) void join();
  }, [ownInvitation, cameThrough]);

  const choosePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (!token || state.status !== 'ready') return;
    if (password !== confirm) {
      setFailure({ message: t('password.mismatch'), problems: [] });
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      await client.redeem(token, name.trim(), password);
      setRedeemedTrack(state.link.track.key);
    } catch (error) {
      setBusy(false);
      if (error instanceof ApiError && error.status === 404) {
        setState({ status: 'invalid' });
      } else if (error instanceof ApiError && error.code === 'sso_required') {
        setMode('account');
        setNotice(t('invite.useProvider'));
      } else if (error instanceof ApiError && error.code === 'weak_password') {
        setFailure({
          message: t('password.problemsIntro'),
          problems: passwordProblemMessages(t, error.body),
        });
      } else {
        setFailure({
          message: tooManyAttemptsMessage(t, error) ?? t('invite.failed'),
          problems: [],
        });
      }
      return;
    }
    // The ordinary sign-in from here on, so whatever it requires it still requires.
    try {
      const outcome = await signIn(state.link.email, password);
      setPassword('');
      setConfirm('');
      if (outcome.status === 'second_factor') {
        setStep({ kind: 'second-factor', challenge: outcome.challenge, methods: outcome.methods });
      } else if (outcome.status === 'enrollment_required') {
        setStep({ kind: 'enroll', challenge: outcome.challenge });
      }
    } catch {
      setMode('account');
      setNotice(t('invite.signInToFinish'));
    } finally {
      setBusy(false);
    }
  };

  const backToForm = useCallback(() => {
    setStep({ kind: 'form' });
    setMode('account');
    setNotice(t('invite.signInToFinish'));
  }, [t]);
  const onSignedIn = useCallback((user: SessionUser) => setUser(user), [setUser]);

  const title = t('invite.title');
  if (state.status !== 'ready') {
    const note =
      state.status === 'checking'
        ? t('invite.checking')
        : state.status === 'no-token'
          ? t('invite.noToken')
          : state.status === 'invalid'
            ? t('invite.invalid')
            : (tooManyAttemptsMessage(t, state.error) ?? t('invite.failed'));
    return (
      <main className="setup">
        <h1 className="page-title">{title}</h1>
        <p className="page-note" role={state.status === 'checking' ? 'status' : undefined}>
          {note}
        </p>
        {state.status !== 'checking' && (
          <a className="button-primary setup-link" href={routeHref('#/sign-in')}>
            {t('invite.goToSignIn')}
          </a>
        )}
      </main>
    );
  }

  const { link } = state;
  const intro = (
    <>
      <h1 className="page-title">
        {t('invite.titleFor', { key: link.track.key, name: link.track.name })}
      </h1>
      <p className="page-note">
        {t(link.invitedBy ? 'invite.introBy' : 'invite.intro', {
          who: link.invitedBy ?? '',
          role: link.roleName,
          email: link.email,
        })}
      </p>
      {link.secondFactorRequired && <p className="page-note">{t('invite.secondFactorNote')}</p>}
    </>
  );

  if (step.kind === 'second-factor' && !signedInAs) {
    return (
      <main className="setup">
        {intro}
        <SecondFactorStep
          challenge={step.challenge}
          methods={step.methods}
          onSignedIn={onSignedIn}
          onExpired={backToForm}
          onBack={backToForm}
        />
      </main>
    );
  }
  if (step.kind === 'enroll' && !signedInAs) {
    return (
      <main className="setup">
        {intro}
        <EnrollmentStep
          challenge={step.challenge}
          email={link.email}
          onSignedIn={onSignedIn}
          onExpired={backToForm}
          onBack={backToForm}
        />
      </main>
    );
  }

  const errorBox = failure && (
    <div className="form-error" role="alert">
      <p>{failure.message}</p>
      {failure.problems.length > 0 && (
        <ul>
          {failure.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
    </div>
  );

  if (signedInAs !== null) {
    return (
      <main className="setup">
        {intro}
        {errorBox}
        {ownInvitation ? (
          <button
            type="button"
            className="button-primary"
            disabled={busy}
            onClick={() => void join()}
          >
            {t('invite.join', { key: link.track.key })}
          </button>
        ) : (
          <>
            <p className="page-note">{t('invite.otherAccount', { email: link.email })}</p>
            <button type="button" className="button-secondary" onClick={() => void signOut()}>
              {t('invite.signOut')}
            </button>
          </>
        )}
      </main>
    );
  }

  return (
    <main className="setup">
      {intro}
      {notice && (
        <p role="status" className="page-note">
          {notice}
        </p>
      )}
      <fieldset className="form-field invite-delivery">
        <legend className="form-label">{t('invite.howIn')}</legend>
        <label>
          <input
            type="radio"
            name={`${id}-mode`}
            checked={mode === 'new'}
            onChange={() => {
              modeTouched.current = true;
              setMode('new');
            }}
          />{' '}
          {t('invite.mode.new')}
        </label>
        <label>
          <input
            type="radio"
            name={`${id}-mode`}
            checked={mode === 'account'}
            onChange={() => {
              modeTouched.current = true;
              setMode('account');
            }}
          />{' '}
          {t('invite.mode.account')}
        </label>
      </fieldset>
      {mode === 'new' ? (
        <form className="form" onSubmit={choosePassword} aria-label={t('invite.mode.new')}>
          {/* Lets password managers file the new password under the right account. */}
          <input type="email" autoComplete="username" value={link.email} readOnly hidden />
          <div className="form-field">
            <label htmlFor={`${id}-name`} className="form-label">
              {t('invite.name')}
            </label>
            <input
              id={`${id}-name`}
              type="text"
              required
              autoComplete="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <PasswordField
            label={t('password.new')}
            toggleLabel={t('password.showNew')}
            autoComplete="new-password"
            hint={t('password.hint', { min: PASSWORD_MIN_LENGTH })}
            value={password}
            onChange={setPassword}
          />
          <PasswordField
            label={t('password.confirmNew')}
            toggleLabel={t('password.showConfirm')}
            autoComplete="new-password"
            value={confirm}
            onChange={setConfirm}
          />
          {errorBox}
          <button type="submit" className="button-primary" disabled={busy}>
            {t('invite.submit')}
          </button>
        </form>
      ) : (
        <SignInForm
          initialEmail={link.email}
          ssoReturnRoute="#/invite"
          {...(ssoClient ? { ssoClient } : {})}
        />
      )}
    </main>
  );
}
