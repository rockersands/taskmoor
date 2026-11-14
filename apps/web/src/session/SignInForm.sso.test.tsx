import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { messagesEn } from '../i18n/messages.en';
import { messagesEs } from '../i18n/messages.es';
import type { Discovery, SignInSsoClient, SsoProviderSummary } from '../sso/client';
import { type Handler, stubBackend, untranslated, visibleTexts } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { setViewportWidth } from '../test/viewport';
import { SessionProvider } from './SessionProvider';
import { SignInForm } from './SignInForm';
import { SignInPage } from './SignInPage';

const SAM = {
  id: 4,
  name: 'Sam',
  email: 'sam@corp.test',
  isSiteAdmin: false,
  timeZone: null,
  locale: null,
};
const STAFF: SsoProviderSummary = { id: 1, name: 'Staff accounts' };
const PARTNERS: SsoProviderSummary = { id: 2, name: 'Partners' };
const UMBRELLA: SsoProviderSummary = { id: 3, name: 'Umbrella' };

/** Which methods each synthetic domain uses: corp.test offers, enforced.test enforces. */
const DOMAINS: Record<string, Discovery> = {
  'corp.test': { provider: STAFF, password: true },
  'enforced.test': { provider: UMBRELLA, password: false },
};

/** A stand-in for the single sign-on endpoints that records where the browser was sent. */
function fakeSso(overrides: Partial<SignInSsoClient> = {}) {
  const went: string[] = [];
  const asked: string[] = [];
  const client: SignInSsoClient = {
    providers: async () => [STAFF, PARTNERS, UMBRELLA],
    discover: async (email) => {
      asked.push(email);
      return DOMAINS[email.split('@')[1] ?? ''] ?? { provider: null, password: true };
    },
    go: (url) => {
      went.push(url);
    },
    ...overrides,
  };
  return { client, went, asked };
}

function openSignIn(
  client: SignInSsoClient,
  options: { hash?: string; handlers?: Record<string, Handler>; locale?: Locale } = {},
) {
  const calls = stubBackend({
    'POST /session': () => jsonResponse(200, { user: SAM }),
    ...options.handlers,
  });
  window.location.hash = options.hash ?? '#/sign-in';
  const signedIn: string[] = [];
  const errors: Error[] = [];
  const view = render(
    <I18nProvider locale={options.locale ?? 'en'} onError={(e) => errors.push(e)}>
      <SessionProvider session={{ status: 'anonymous' }}>
        <SignInPage onSignedIn={() => signedIn.push('home')} ssoClient={client} />
      </SessionProvider>
    </I18nProvider>,
  );
  return { calls, signedIn, errors, container: view.container };
}

const passwordSent = (calls: { method: string; path: string }[]) =>
  calls.some((c) => c.method === 'POST' && c.path === '/session');

describe('sign-in with single sign-on (M1-080)', () => {
  it('[IAM-003] offers a button per enabled provider that starts the sign-in there', async () => {
    const user = userEvent.setup();
    const { client, went } = fakeSso();
    openSignIn(client);
    const others = await screen.findByRole('group', {
      name: 'Other ways to sign in',
    });
    expect(
      within(others)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Sign in with Staff accounts', 'Sign in with Partners', 'Sign in with Umbrella']);
    await user.click(within(others).getByRole('button', { name: 'Sign in with Partners' }));
    // From the sign-in page itself the browser comes back to the start page.
    expect(went).toEqual(['/api/v1/auth/oidc/2/start?returnTo=%2F']);
  });

  it('[IAM-032] a site with Google offers it for a Gmail address, with the password still there', async () => {
    const user = userEvent.setup();
    const google: SsoProviderSummary = { id: 8, name: 'Google' };
    const { client, went } = fakeSso({
      providers: async () => [google],
      discover: async (email) =>
        email.endsWith('@gmail.com')
          ? { provider: google, password: true }
          : { provider: null, password: true },
    });
    const { calls } = openSignIn(client);
    // Before any address, it is on offer for whoever has it.
    const others = await screen.findByRole('group', { name: 'Other ways to sign in' });
    expect(within(others).getByRole('button', { name: 'Sign in with Google' })).toBeVisible();

    await user.type(screen.getByLabelText('Email'), 'sam@gmail.com');
    await user.tab();
    const form = screen.getByRole('form', { name: 'Sign in' });
    expect(await within(form).findByText('This address signs in with Google.')).toBeVisible();
    expect(screen.queryByRole('group', { name: 'Other ways to sign in' })).toBeNull();
    expect(within(form).getByLabelText('Password')).toBeVisible();

    // The password goes on working: Google does not stand in its way.
    await user.type(within(form).getByLabelText('Password'), 'a password');
    await user.click(within(form).getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(passwordSent(calls)).toBe(true));
    expect(went).toEqual([]);
  });

  it('[IAM-032] an address the page already knows gets its provider without leaving the field', async () => {
    const google: SsoProviderSummary = { id: 8, name: 'Google' };
    const { client } = fakeSso({
      providers: async () => [google],
      discover: async () => ({ provider: google, password: true }),
    });
    stubBackend({});
    render(
      <I18nProvider locale="en">
        <SessionProvider session={{ status: 'anonymous' }}>
          <SignInForm ssoClient={client} initialEmail="sam@gmail.com" ssoReturnRoute="#/invite" />
        </SessionProvider>
      </I18nProvider>,
    );
    expect(await screen.findByRole('button', { name: 'Sign in with Google' })).toBeVisible();
    expect(await screen.findByText('This address signs in with Google.')).toBeVisible();
  });

  it('[IAM-002] starts a SAML provider at its own address', async () => {
    const user = userEvent.setup();
    const contractors: SsoProviderSummary = { id: 4, name: 'Contractors', protocol: 'saml' };
    const { client, went } = fakeSso({
      providers: async () => [STAFF, contractors],
      discover: async () => ({ provider: contractors, password: false }),
    });
    openSignIn(client);
    await user.click(await screen.findByRole('button', { name: 'Sign in with Contractors' }));
    expect(went).toEqual(['/api/v1/auth/saml/4/start?returnTo=%2F']);
    // Where the domain's SAML provider enforces single sign-on, the email leads there too.
    await user.type(screen.getByLabelText('Email'), 'kai@contractors.test');
    await user.tab();
    const form = screen.getByRole('form', { name: 'Sign in' });
    await within(form).findByText('This address signs in with Contractors.');
    await user.click(within(form).getByRole('button', { name: 'Sign in with Contractors' }));
    expect(went).toEqual([
      '/api/v1/auth/saml/4/start?returnTo=%2F',
      '/api/v1/auth/saml/4/start?returnTo=%2F',
    ]);
  });

  it('[IAM-003] comes back to the page the person was on', async () => {
    const user = userEvent.setup();
    const { client, went } = fakeSso();
    openSignIn(client, { hash: '#/tracks/ACME' });
    await user.click(await screen.findByRole('button', { name: 'Sign in with Staff accounts' }));
    expect(went).toEqual([
      `/api/v1/auth/oidc/1/start?returnTo=${encodeURIComponent('/#/tracks/ACME')}`,
    ]);
  });

  it('[IAM-003] names the provider of the email domain and offers it first; the password still works', async () => {
    const user = userEvent.setup();
    const { client, went, asked } = fakeSso();
    const { calls, signedIn } = openSignIn(client);
    await user.type(screen.getByLabelText('Email'), 'Sam@Corp.test');
    await user.tab();
    const form = screen.getByRole('form', { name: 'Sign in' });
    expect(
      await within(form).findByText('This address signs in with Staff accounts.'),
    ).toBeVisible();
    expect(screen.getByLabelText('Email')).toHaveAccessibleDescription(
      'This address signs in with Staff accounts.',
    );
    expect(within(form).getByRole('button', { name: 'Sign in with Staff accounts' })).toBeVisible();
    // The other providers stay below; Staff accounts is not offered twice.
    const others = screen.getByRole('group', { name: 'Other ways to sign in' });
    expect(
      within(others).queryByRole('button', { name: 'Sign in with Staff accounts' }),
    ).toBeNull();
    expect(asked).toEqual(['sam@corp.test']);

    await user.type(screen.getByLabelText('Password'), 'a long enough passphrase');
    await user.click(within(form).getByRole('button', { name: 'Sign in' }));
    expect(passwordSent(calls)).toBe(true);
    expect(went).toEqual([]);
    expect(signedIn).toEqual(['home']);
    // One question per address, also when the form is sent.
    expect(asked).toEqual(['sam@corp.test']);
  });

  it('[IAM-004] where the provider enforces single sign-on, the password field gives way to it', async () => {
    const user = userEvent.setup();
    const { client, went } = fakeSso();
    const { calls } = openSignIn(client);
    await user.type(screen.getByLabelText('Email'), 'ana@enforced.test');
    await user.tab();
    const form = screen.getByRole('form', { name: 'Sign in' });
    expect(await within(form).findByText('This address signs in with Umbrella.')).toBeVisible();
    expect(screen.queryByLabelText('Password')).toBeNull();
    // One button: the form's own, so pressing Enter in the email field leads there too.
    const submit = within(form).getByRole('button', { name: 'Sign in with Umbrella' });
    expect(submit).toHaveAttribute('type', 'submit');
    await user.click(submit);
    expect(went).toEqual(['/api/v1/auth/oidc/3/start?returnTo=%2F']);
    expect(passwordSent(calls)).toBe(false);

    // Another address brings the password back.
    await user.clear(screen.getByLabelText('Email'));
    await user.type(screen.getByLabelText('Email'), 'bo@example.com');
    await user.tab();
    expect(await screen.findByLabelText('Password')).toBeVisible();
    expect(within(form).getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  it('[IAM-004] asks again when sending the form if the domain could not be checked, and never sends the password', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const { client, went } = fakeSso({
      discover: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('network');
        return { provider: UMBRELLA, password: false };
      },
    });
    const { calls } = openSignIn(client);
    await user.type(screen.getByLabelText('Email'), 'ana@enforced.test');
    await user.type(screen.getByLabelText('Password'), 'a long enough passphrase');
    // Unanswered on leaving the field: the password form stays as it was.
    expect(screen.getByLabelText('Password')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('button', { name: 'Sign in with Umbrella' })).toBeVisible();
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(attempts).toBe(2);
    expect(passwordSent(calls)).toBe(false);
    expect(went).toEqual([]);
  });

  it('[IAM-004] a password the backend refuses with sso_required leads to the provider', async () => {
    const user = userEvent.setup();
    // The domain check said a password is fine; the backend has the last word.
    const { client } = fakeSso({ discover: async () => ({ provider: null, password: true }) });
    openSignIn(client, {
      handlers: {
        'POST /session': () =>
          jsonResponse(403, { error: 'sso_required', provider: { id: 3, name: 'Umbrella' } }),
      },
    });
    await user.type(screen.getByLabelText('Email'), 'ana@enforced.test');
    await user.type(screen.getByLabelText('Password'), 'a long enough passphrase');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('button', { name: 'Sign in with Umbrella' })).toBeVisible();
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('[IAM-004] break-glass accounts sign in with a password at #/sign-in?method=password', async () => {
    const user = userEvent.setup();
    const { client, asked, went } = fakeSso();
    const { calls, signedIn } = openSignIn(client, { hash: '#/sign-in?method=password' });
    await user.type(screen.getByLabelText('Email'), 'ana@enforced.test');
    await user.tab();
    expect(await screen.findByText('This address signs in with Umbrella.')).toBeVisible();
    // The password stays on offer, next to the provider.
    await user.type(screen.getByLabelText('Password'), 'the break-glass passphrase');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(passwordSent(calls)).toBe(true);
    expect(signedIn).toEqual(['home']);
    expect(went).toEqual([]);
    expect(asked).toEqual(['ana@enforced.test']);
  });

  it('[IAM-004] at the break-glass address, other accounts learn why the password did not work', async () => {
    const user = userEvent.setup();
    const { client } = fakeSso();
    openSignIn(client, {
      hash: '#/sign-in?method=password',
      handlers: {
        'POST /session': () =>
          jsonResponse(403, { error: 'sso_required', provider: { id: 3, name: 'Umbrella' } }),
      },
    });
    await user.type(screen.getByLabelText('Email'), 'ana@enforced.test');
    await user.type(screen.getByLabelText('Password'), 'a long enough passphrase');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'For this domain only break-glass accounts can use a password; everyone else signs in with Umbrella.',
    );
    expect(screen.getByLabelText('Password')).toHaveValue('');
    expect(screen.getAllByRole('button', { name: 'Sign in with Umbrella' }).length).toBeGreaterThan(
      0,
    );
  });

  it('[IAM-003] a failed single sign-on comes back with the reason, once', async () => {
    const { client } = fakeSso();
    openSignIn(client, { hash: '#/sign-in?sso_error=no_account' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'There is no account for you here yet. Ask a site administrator to create one. If you were invited, sign in with the very address the invitation went to.',
    );
    // The same person to ask as the line under the form (D12, D15).
    expect(screen.getByText(/Ask a site administrator for a new password link/)).toBeVisible();
    // Above the form, as its own alert, not as a password error (AC-10).
    const form = screen.getByRole('form', { name: 'Sign in' });
    expect(form.contains(alert)).toBe(false);
    expect(alert.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByLabelText('Password')).not.toHaveAttribute('aria-invalid');
    // The address loses the reason, so a reload does not show it again.
    expect(window.location.hash).toBe('#/sign-in');
  });

  it('[IAM-003] every reason names a site administrator as the one to ask, in English and Spanish (D12)', () => {
    const reasons = (messages: Record<string, string>) =>
      Object.entries(messages).filter(([id]) => id.startsWith('auth.sso.error.'));
    // Every reason that sends the person to someone sends them to the role the sign-in page names.
    const vague = [
      ...reasons(messagesEn).filter(
        ([, text]) => /administrator/i.test(text) && !text.includes('a site administrator'),
      ),
      ...reasons(messagesEs).filter(
        ([, text]) => /administrador/i.test(text) && !text.includes('un administrador del sitio'),
      ),
    ];
    expect(vague).toEqual([]);
    expect(messagesEn['auth.forgotPassword']).toContain('a site administrator');
    expect(messagesEs['auth.forgotPassword']).toContain('un administrador del sitio');
  });

  it('[IAM-003] a reason this frontend does not know still gets a sentence', async () => {
    const { client } = fakeSso();
    openSignIn(client, { hash: '#/sign-in?sso_error=something_new&method=password' });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Single sign-on did not work. Try again in a moment.',
    );
    expect(window.location.hash).toBe('#/sign-in?method=password');
  });

  it('[IAM-001] without the provider list or the domain check, the password still signs in', async () => {
    const user = userEvent.setup();
    const { client } = fakeSso({
      providers: async () => {
        throw new Error('network');
      },
      discover: async () => {
        throw new Error('network');
      },
    });
    const { calls, signedIn } = openSignIn(client);
    await user.type(screen.getByLabelText('Email'), 'sam@corp.test');
    await user.type(screen.getByLabelText('Password'), 'a long enough passphrase');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(passwordSent(calls)).toBe(true);
    expect(signedIn).toEqual(['home']);
    expect(screen.queryByRole('group', { name: 'Other ways to sign in' })).toBeNull();
  });

  it('[IAM-003] works on a phone-sized screen', async () => {
    setViewportWidth(375);
    const { client } = fakeSso();
    openSignIn(client);
    const others = await screen.findByRole('group', {
      name: 'Other ways to sign in',
    });
    expect(within(others).getAllByRole('button')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  it('[IAM-003] every text goes through the catalogue (en-XA)', async () => {
    const user = userEvent.setup();
    const { client } = fakeSso();
    const { container, errors } = openSignIn(client, {
      hash: '#/sign-in?sso_error=provider_error',
      locale: 'en-XA',
    });
    await screen.findByRole('alert');
    await user.type(screen.getByRole('textbox'), 'sam@corp.test');
    await user.tab();
    await screen.findAllByText(/Staff accounts/);
    const texts = visibleTexts(container).filter(
      // Typed and provider-given values are data, not interface text.
      (text) => !['sam@corp.test'].includes(text),
    );
    expect(texts.length).toBeGreaterThan(6);
    expect(untranslated(texts)).toEqual([]);
    expect(errors).toEqual([]);
  });
});
