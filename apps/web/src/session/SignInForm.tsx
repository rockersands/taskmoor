import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { currentRoute, replaceRoute } from '../routing/router';
import {
  appBase,
  type Discovery,
  hashParam,
  returnTo,
  type SignInSsoClient,
  type SsoProviderSummary,
  signInSsoClient,
  startUrl,
  withoutHashParam,
} from '../sso/client';
import { ssoErrorMessage, ssoRequiredProvider } from '../sso/errors';
import { EnrollmentStep } from './EnrollmentStep';
import { tooManyAttemptsMessage } from './errors';
import { PasswordField } from './PasswordField';
import { SecondFactorStep } from './SecondFactorStep';
import { type SecondFactorMethod, type SessionUser, useSession } from './SessionProvider';

type Step =
  | { kind: 'password' }
  | { kind: 'second-factor'; challenge: string; methods: SecondFactorMethod[] }
  | { kind: 'enroll'; challenge: string };

export interface SignInFormProps {
  /** Stories and tests pass their own single sign-on endpoints; the form calls the backend otherwise. */
  ssoClient?: SignInSsoClient;
  /** The address to start from, where the page already knows it (an invitation's). */
  initialEmail?: string;
  /** Where a single sign-on comes back to, when the current address must not travel. */
  ssoReturnRoute?: string;
}

const normalized = (email: string) => email.trim().toLowerCase();
const looksLikeEmail = (email: string) => /^[^@\s]+@[^@\s]+$/.test(email);

/**
 * Sign-in (IAM-001, IAM-003): email and password, and a button per identity provider (M1-080).
 * Email first: leaving the email field asks which methods its domain uses; a domain with a
 * provider gets that provider's button emphasised, and where the provider enforces single
 * sign-on the password field gives way to it (IAM-004). The backend has the last word: a
 * password for such a domain answers `sso_required` and leads to the same prompt, while
 * break-glass accounts sign in with their password from `#/sign-in?method=password`.
 * With a second factor the password leads to a second step (M1-084): a code, a security key or
 * a recovery code, or the authenticator-app setup a two-factor policy requires. Going back
 * keeps the email.
 */
export function SignInForm({
  ssoClient = signInSsoClient,
  initialEmail = '',
  ssoReturnRoute,
}: SignInFormProps) {
  const t = useT();
  const { signIn, setUser } = useSession();
  const id = useId();
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  // A failed single sign-on comes back as #/sign-in?sso_error=<code>.
  const [error, setError] = useState<string | null>(() => {
    const code = hashParam(currentRoute(), 'sso_error');
    return code ? ssoErrorMessage(t, code) : null;
  });
  const [busy, setBusy] = useState(false);
  const passwordInput = useRef<HTMLInputElement>(null);
  const [returned, setReturned] = useState(0);
  const [providers, setProviders] = useState<SsoProviderSummary[]>([]);
  const [discovery, setDiscovery] = useState<(Discovery & { email: string }) | null>(null);
  const asked = useRef<{ email: string; answer: Promise<Discovery | null> } | null>(null);

  // The error is read once; the address loses it, so a reload does not show it again.
  useEffect(() => {
    const hash = currentRoute();
    if (hashParam(hash, 'sso_error') === null) return;
    replaceRoute(withoutHashParam(hash, 'sso_error'));
  }, []);

  useEffect(() => {
    let cancelled = false;
    ssoClient.providers().then(
      (list) => {
        if (!cancelled) setProviders(Array.isArray(list) ? list : []);
      },
      // Without the list the password still works; there is just no button to show.
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [ssoClient]);

  // Back from the second step: the cursor waits in the password field.
  useEffect(() => {
    if (returned > 0) passwordInput.current?.focus();
  }, [returned]);

  /** Which methods the email's domain uses; one request per address, null when unanswered. */
  const discover = useCallback(
    (address: string): Promise<Discovery | null> => {
      const key = normalized(address);
      if (!looksLikeEmail(key)) return Promise.resolve(null);
      if (asked.current?.email === key) return asked.current.answer;
      const answer = ssoClient.discover(key).then(
        (found) => {
          const provider =
            typeof found?.provider?.id === 'number' && typeof found.provider.name === 'string'
              ? {
                  id: found.provider.id,
                  name: found.provider.name,
                  ...(found.provider.protocol === 'saml' ? { protocol: 'saml' as const } : {}),
                }
              : null;
          const known: Discovery = { provider, password: found?.password !== false };
          if (asked.current?.email === key) setDiscovery({ ...known, email: key });
          return known;
        },
        () => {
          // Unanswered: the password form stays as it is, and the next attempt asks again.
          if (asked.current?.email === key) asked.current = null;
          return null;
        },
      );
      asked.current = { email: key, answer };
      return answer;
    },
    [ssoClient],
  );

  // An address the page already knows (an invitation's) is never left, so ask at once: the
  // provider that serves it is offered from the start (IAM-032).
  useEffect(() => {
    if (initialEmail) void discover(initialEmail);
  }, [initialEmail, discover]);

  const key = normalized(email);
  const known = discovery?.email === key ? discovery : null;
  const breakGlass = hashParam(currentRoute(), 'method') === 'password';
  const organisation = known?.provider ?? null;
  const enforced = organisation && known?.password === false && !breakGlass ? organisation : null;
  const others = providers.filter((p) => p.id !== organisation?.id);

  const start = (provider: SsoProviderSummary) =>
    ssoClient.go(startUrl(provider, returnTo(ssoReturnRoute ?? currentRoute(), appBase())));

  const promptFor = (provider: SsoProviderSummary) => {
    const answer: Discovery = { provider, password: false };
    asked.current = { email: key, answer: Promise.resolve(answer) };
    setDiscovery({ ...answer, email: key });
    setPassword('');
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (enforced) {
      start(enforced);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Email first, also when the form is sent straight away: a domain that signs in with its
      // provider gets the provider, and the password is not sent.
      const found = breakGlass ? null : (known ?? (await discover(email)));
      if (found?.provider && !found.password) {
        promptFor(found.provider);
        return;
      }
      const outcome = await signIn(email, password);
      if (outcome.status !== 'signed_in') {
        setPassword('');
        setStep(
          outcome.status === 'second_factor'
            ? { kind: 'second-factor', challenge: outcome.challenge, methods: outcome.methods }
            : { kind: 'enroll', challenge: outcome.challenge },
        );
      }
    } catch (e) {
      const required = ssoRequiredProvider(e);
      if (required) {
        promptFor(required);
        // At the break-glass address the password stays on offer, so say why it did not work.
        if (breakGlass) setError(t('auth.sso.breakGlassOnly', { name: required.name }));
        return;
      }
      // A locked email or address answers 429 with the wait (IAM-001 lockout).
      setError(
        tooManyAttemptsMessage(t, e) ??
          (e instanceof ApiError && e.status === 401
            ? t('auth.invalidCredentials')
            : t('auth.failed')),
      );
    } finally {
      setBusy(false);
    }
  };

  const backToPassword = useCallback((message: string | null) => {
    setStep({ kind: 'password' });
    setError(message);
    setReturned((count) => count + 1);
  }, []);
  const onExpired = useCallback(
    () => backToPassword(t('auth.challengeExpired')),
    [backToPassword, t],
  );
  const onBack = useCallback(() => backToPassword(null), [backToPassword]);
  const onSignedIn = useCallback((user: SessionUser) => setUser(user), [setUser]);

  if (step.kind === 'second-factor') {
    return (
      <SecondFactorStep
        challenge={step.challenge}
        methods={step.methods}
        onSignedIn={onSignedIn}
        onExpired={onExpired}
        onBack={onBack}
      />
    );
  }
  if (step.kind === 'enroll') {
    return (
      <EnrollmentStep
        challenge={step.challenge}
        email={email}
        onSignedIn={onSignedIn}
        onExpired={onExpired}
        onBack={onBack}
      />
    );
  }

  return (
    <div className="sign-in-methods">
      <form className="form" onSubmit={submit} aria-label={t('auth.signIn')}>
        <div className="sign-in-email">
          <div className="form-field">
            <label htmlFor={`${id}-email`}>{t('auth.email')}</label>
            <input
              id={`${id}-email`}
              type="email"
              autoComplete="username"
              required
              value={email}
              aria-describedby={`${id}-organisation`}
              onChange={(e) => setEmail(e.target.value)}
              // The field's own value: a password manager or a fast typist can leave before
              // the last change has rendered.
              onBlur={(e) => void discover(e.currentTarget.value)}
            />
          </div>
          <p id={`${id}-organisation`} role="status" className="form-status">
            {organisation ? t('auth.sso.organisation', { name: organisation.name }) : ''}
          </p>
        </div>
        {organisation && !enforced && (
          <button
            type="button"
            className="button-secondary sso-button sso-button-emphasis"
            onClick={() => start(organisation)}
          >
            {t('auth.sso.signInWith', { name: organisation.name })}
          </button>
        )}
        {!enforced && (
          <PasswordField
            label={t('auth.password')}
            autoComplete="current-password"
            value={password}
            onChange={setPassword}
            inputRef={passwordInput}
          />
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {/* One button: when the domain enforces single sign-on it leads there, so focus stays. */}
        <button type="submit" className="button-primary" disabled={busy}>
          {enforced ? t('auth.sso.signInWith', { name: enforced.name }) : t('auth.signIn')}
        </button>
      </form>
      {others.length > 0 && (
        <fieldset className="sso-options">
          <legend className="sso-divider">{t('auth.sso.others')}</legend>
          {others.map((provider) => (
            <button
              key={provider.id}
              type="button"
              className="button-secondary sso-button"
              onClick={() => start(provider)}
            >
              {t('auth.sso.signInWith', { name: provider.name })}
            </button>
          ))}
        </fieldset>
      )}
    </div>
  );
}
