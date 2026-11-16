import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Discovery, SignInSsoClient, SsoProviderSummary } from '../sso/client';
import { stubBackend } from '../test/backend';
import { GoogleMark } from './GoogleMark';
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
    // Google's G as a decorative image, 20 px square: no name of its own, the words give it.
    const mark = button.firstElementChild as HTMLImageElement;
    expect(mark.tagName.toLowerCase()).toBe('img');
    expect(mark).toHaveAttribute('alt', '');
    expect(mark).toHaveAttribute(
      'src',
      expect.stringMatching(/google-g\.svg$|^data:image\/svg\+xml/),
    );
    expect([mark.getAttribute('width'), mark.getAttribute('height')]).toEqual(['20', '20']);
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
    expect(staff.querySelector('img, svg')).toBeNull();
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
    expect(google.querySelector('img.google-sign-in-mark')).not.toBeNull();
    expect(within(form).queryByRole('button', { name: /Staff Google/ })).toBeNull();
    expect(within(form).getAllByRole('button')).toHaveLength(1);
    // Enter in the email field leads there too, as the form's submit.
    await user.type(screen.getByLabelText('Email'), '{Enter}');
    expect(went).toEqual(['/api/v1/auth/oidc/9/start?returnTo=%2F']);
  });

  it("[IAM-031] focus stays on the form's button when sending it turns the domain into Google's", async () => {
    const user = userEvent.setup();
    const went = openSignIn();
    // A password manager fills the address and a password without the email field losing focus,
    // so the domain is first asked about when the form is sent.
    fireEvent.change(await screen.findByLabelText('Email'), {
      target: { value: 'ann@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'saved one' } });
    const form = screen.getByRole('form', { name: 'Sign in' });
    const button = within(form).getByRole('button', { name: 'Sign in' });
    button.focus();
    await user.keyboard(' ');
    const google = await within(form).findByRole('button', { name: 'Sign in with Google' });
    expect(google).toHaveClass('google-sign-in');
    expect(google).not.toHaveClass('button-primary');
    // The same element, only dressed as Google's: a keyboard or screen reader stays on it.
    expect(google).toBe(button);
    expect(google).toHaveFocus();
    expect(went).toEqual([]);
    await user.keyboard(' ');
    expect(went).toEqual(['/api/v1/auth/oidc/9/start?returnTo=%2F']);
  });

  it("[IAM-031] keeps Google's words in Spanish on the page", async () => {
    openSignIn('es');
    expect(
      await screen.findByRole('button', { name: 'Iniciar sesión con Google' }),
    ).toBeInTheDocument();
  });
});

/** The shipped G: Google's file, cropped to the G (T-262). From the root or from apps/web. */
const MARK_FILE = join(
  ['apps/web/src', 'src'].find((d) => existsSync(join(d, 'assets/google'))) ?? 'src',
  'assets/google/google-g.svg',
);

describe("Google's G (T-262)", () => {
  const svg = new DOMParser().parseFromString(readFileSync(MARK_FILE, 'utf8'), 'image/svg+xml');
  const root = svg.documentElement;

  // Element for element it is the bundle's: the golden file in build/google-assets.test.ts.
  it("[IAM-031] shows the G alone, in Google's gradient, with nothing from elsewhere", () => {
    expect(root.tagName).toBe('svg');
    expect(svg.querySelector('parsererror')).toBeNull();
    // The bundle's 40 px round button puts the G in the 20 px square at (10, 10).
    expect(root.getAttribute('viewBox')).toBe('10 10 20 20');
    // Kept from the bundle: the placeholder path Figma leaves after the gradient paints nothing.
    expect(root.getAttribute('fill')).toBe('none');
    const mask = root.querySelector('mask');
    expect(mask?.getAttribute('x')).toBe('10');
    expect(mask?.getAttribute('y')).toBe('10');
    // Google's colours, blended: the conic gradient and the blurred shapes over it.
    const conic = root.querySelector('foreignObject > div')?.getAttribute('style') ?? '';
    for (const colour of [
      'rgba(255, 70, 65, 1)',
      'rgba(49, 134, 255, 1)',
      'rgba(14, 188, 95, 1)',
    ]) {
      expect(conic).toContain(colour);
    }
    expect(conic).toContain('rgba(255, 204, 0, 1)');
    expect(Array.from(root.querySelectorAll('ellipse'), (e) => e.getAttribute('fill'))).toEqual([
      '#3186FF',
      '#3186FF',
      '#FF4641',
      '#FF5B8B',
      '#3186FF',
      '#FF4641',
    ]);
    // Every reference points inside the file; nothing names another file or a host.
    const ids = new Set(Array.from(root.querySelectorAll('[id]'), (e) => e.id));
    const text = readFileSync(MARK_FILE, 'utf8');
    for (const [, id] of text.matchAll(/url\(#([^)]+)\)/g)) expect(ids).toContain(id);
    expect(root.querySelectorAll('image, script, style, use, a')).toHaveLength(0);
    expect(text).not.toMatch(/href=/);
    // Only the SVG and XHTML namespaces, which name no place to fetch.
    const namespaces = /http:\/\/www\.w3\.org\/(2000\/svg|1999\/xhtml)/g;
    expect(text.replace(namespaces, '')).not.toMatch(/https?:\/\//);
  });

  it('[IAM-031] two buttons on one page share no ids: each G is an image of its own', () => {
    const { container } = render(
      <I18nProvider locale="en">
        <GoogleSignInButton onClick={() => {}} />
        <GoogleSignInButton onClick={() => {}} />
        <GoogleMark className="google-sign-in-mark" />
      </I18nProvider>,
    );
    const marks = container.querySelectorAll('img.google-sign-in-mark');
    expect(marks).toHaveLength(3);
    expect(container.querySelectorAll('[id], svg, mask, filter')).toHaveLength(0);
  });
});
