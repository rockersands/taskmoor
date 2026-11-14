import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Discovery, SignInSsoClient, SsoProviderSummary } from '../sso/client';
import { stubBackend } from '../test/backend';
import { GoogleSignInButton } from './GoogleSignInButton';
import { SessionProvider } from './SessionProvider';
import { SignInPage } from './SignInPage';

/** A Google provider the site named otherwise: the button still says Google (T-061). */
const GOOGLE: SsoProviderSummary = { id: 8, name: 'Personal Gmail', brand: 'google' };
const STAFF: SsoProviderSummary = { id: 1, name: 'Staff accounts' };

/** A Google Workspace domain whose provider requires single sign-on (T-061 with IAM-004). */
const STAFF_GOOGLE: SsoProviderSummary = { id: 9, name: 'Staff Google', brand: 'google' };

function openSignIn(locale: 'en' | 'es' = 'en') {
  const went: string[] = [];
  const domains: Record<string, Discovery> = {
    'gmail.com': { provider: GOOGLE, password: true },
    'example.com': { provider: STAFF_GOOGLE, password: false },
  };
  const client: SignInSsoClient = {
    providers: async () => [GOOGLE, STAFF],
    discover: async (email) =>
      domains[email.split('@')[1] ?? ''] ?? { provider: null, password: true },
    go: (url) => {
      went.push(url);
    },
  };
  stubBackend({});
  window.location.hash = '#/sign-in';
  render(
    <I18nProvider locale={locale}>
      <SessionProvider session={{ status: 'anonymous' }}>
        <SignInPage onSignedIn={() => {}} ssoClient={client} />
      </SessionProvider>
    </I18nProvider>,
  );
  return went;
}

describe("Google's sign-in button (T-061)", () => {
  it("[IAM-031] shows Google's G at the left of its words, which name the button", async () => {
    const user = userEvent.setup();
    const clicks: string[] = [];
    render(
      <I18nProvider locale="en">
        <GoogleSignInButton onClick={() => clicks.push('google')} />
      </I18nProvider>,
    );
    const button = screen.getByRole('button', { name: 'Sign in with Google' });
    expect(button).toHaveClass('google-sign-in');
    const mark = button.firstElementChild as SVGElement;
    expect(mark.tagName.toLowerCase()).toBe('svg');
    expect(mark.getAttribute('aria-hidden')).toBe('true');
    // The four colours of the G, in the order the guidelines draw them.
    expect(Array.from(mark.querySelectorAll('path'), (p) => p.getAttribute('fill'))).toEqual([
      '#EA4335',
      '#4285F4',
      '#FBBC05',
      '#34A853',
    ]);
    expect(button.textContent).toBe('Sign in with Google');
    await user.click(button);
    expect(clicks).toEqual(['google']);
  });

  it('[IAM-031] says it in Spanish', () => {
    render(
      <I18nProvider locale="es">
        <GoogleSignInButton onClick={() => {}} />
      </I18nProvider>,
    );
    expect(screen.getByRole('button', { name: 'Iniciar sesión con Google' })).toBeVisible();
  });

  it("[IAM-031] the sign-in page draws Google's button for a Google provider, whatever its name, and only for it", async () => {
    const user = userEvent.setup();
    const went = openSignIn();
    const others = await screen.findByRole('group', { name: 'Other ways to sign in' });
    const google = within(others).getByRole('button', { name: 'Sign in with Google' });
    expect(google).toHaveClass('google-sign-in');
    expect(within(others).queryByRole('button', { name: /Personal Gmail/ })).toBeNull();
    const staff = within(others).getByRole('button', { name: 'Sign in with Staff accounts' });
    expect(staff).not.toHaveClass('google-sign-in');
    expect(staff.querySelector('svg')).toBeNull();
    await user.click(google);
    expect(went).toEqual(['/api/v1/auth/oidc/8/start?returnTo=%2F']);
  });

  it("[IAM-032] a Gmail address gets Google's button in the form, not the accent one", async () => {
    const user = userEvent.setup();
    const went = openSignIn();
    await user.type(await screen.findByLabelText('Email'), 'sam@gmail.com');
    await user.tab();
    const form = screen.getByRole('form', { name: 'Sign in' });
    const google = await within(form).findByRole('button', { name: 'Sign in with Google' });
    expect(google).toHaveClass('google-sign-in');
    expect(google).not.toHaveClass('sso-button-emphasis');
    await user.click(google);
    expect(went).toEqual(['/api/v1/auth/oidc/8/start?returnTo=%2F']);
  });

  it("[IAM-031] where the domain signs in only through Google, the form's one button is Google's", async () => {
    const user = userEvent.setup();
    const went = openSignIn();
    await user.type(await screen.findByLabelText('Email'), 'ann@example.com');
    await user.tab();
    const form = screen.getByRole('form', { name: 'Sign in' });
    expect(await within(form).findByText('This address signs in with Staff Google.')).toBeVisible();
    expect(screen.queryByLabelText('Password')).toBeNull();
    // Google's look and words, not the accent button with the provider's name.
    const google = within(form).getByRole('button', { name: 'Sign in with Google' });
    expect(google).toHaveClass('google-sign-in');
    expect(google).toHaveAttribute('type', 'submit');
    expect(google.querySelector('svg')).not.toBeNull();
    expect(within(form).queryByRole('button', { name: /Staff Google/ })).toBeNull();
    expect(within(form).getAllByRole('button')).toHaveLength(1);
    // Enter in the email field leads there too, as the form's submit.
    await user.type(screen.getByLabelText('Email'), '{Enter}');
    expect(went).toEqual(['/api/v1/auth/oidc/9/start?returnTo=%2F']);
  });

  it("[IAM-031] keeps Google's words in Spanish on the page", async () => {
    openSignIn('es');
    expect(
      await screen.findByRole('button', { name: 'Iniciar sesión con Google' }),
    ).toBeInTheDocument();
  });
});
