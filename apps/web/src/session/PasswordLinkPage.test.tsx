import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { jsonResponse } from '../test/setup';
import { setViewportWidth } from '../test/viewport';
import { passwordTokenFromHash } from './PasswordLinkPage';

const TOKEN = 'one-time-link-token-0123456789';
const NIA = {
  id: 7,
  name: 'Nia',
  email: 'nia@example.com',
  isSiteAdmin: false,
  timeZone: null,
  locale: null,
};

type Call = { url: string; method: string; body: unknown };

function stubLinks(answer: (path: string, body: unknown) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method: init?.method ?? 'GET', body });
      return answer(url.replace(/^\/api\/v1/, ''), body);
    }),
  );
  return calls;
}

const validLink =
  (
    purpose: 'activate' | 'reset',
    redeem: (body: unknown) => Response = () => jsonResponse(200, { user: NIA }),
  ) =>
  (path: string, body: unknown) => {
    if (path === '/password-links/inspect') {
      return jsonResponse(200, { purpose, name: 'Nia', email: 'nia@example.com' });
    }
    if (path === '/password-links/redeem') return redeem(body);
    return jsonResponse(401, { error: 'not_signed_in' });
  };

async function choosePassword(
  user: ReturnType<typeof userEvent.setup>,
  password: string,
  confirm = password,
) {
  await user.type(screen.getByLabelText('New password'), password);
  await user.type(screen.getByLabelText('Confirm new password'), confirm);
  await user.click(screen.getByRole('button', { name: 'Save password and sign in' }));
}

describe('password link page', () => {
  it('reads the one-time token from the link', () => {
    expect(passwordTokenFromHash(`#/password?token=${TOKEN}`)).toBe(TOKEN);
    expect(passwordTokenFromHash('#/password?token=')).toBeNull();
    expect(passwordTokenFromHash('#/password')).toBeNull();
  });

  it('[IAM-001] activates an account: checks the link, sets the password and signs in', async () => {
    const user = userEvent.setup();
    const calls = stubLinks(validLink('activate'));
    window.location.hash = `#/password?token=${TOKEN}`;
    render(<App />);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Choose a password for Nia' }),
    ).toBeVisible();
    expect(screen.getByText(/Your account nia@example.com is ready/)).toBeVisible();
    // Stands alone, like setup: no navigation before the person can sign in.
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.getByLabelText('New password')).toHaveAttribute('autocomplete', 'new-password');

    await choosePassword(user, 'a long enough passphrase');
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
    expect(window.location.hash).toBe('#/home');
    expect(screen.getByRole('button', { name: 'Nia' })).toBeVisible();

    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => [c.url, c.body])).toEqual([
      ['/api/v1/password-links/inspect', { token: TOKEN }],
      ['/api/v1/password-links/redeem', { token: TOKEN, password: 'a long enough passphrase' }],
    ]);
    // The token only ever travels in a request body.
    expect(calls.every((c) => !c.url.includes(TOKEN))).toBe(true);
  });

  it('[IAM-001] resets a password with its own heading', async () => {
    stubLinks(validLink('reset'));
    window.location.hash = `#/password?token=${TOKEN}`;
    render(<App />);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Reset the password for Nia' }),
    ).toBeVisible();
    expect(screen.getByText(/Every other session of this account is signed out/)).toBeVisible();
  });

  it('[IAM-001] explains an invalid, expired or used link, as an alert (D24)', async () => {
    stubLinks(() => jsonResponse(404, { error: 'invalid_link' }));
    window.location.hash = `#/password?token=${TOKEN}`;
    render(<App />);
    // Announced and drawn as the sign-in page's errors are, not as a plain note.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/invalid, has expired or was already used/);
    expect(alert).toHaveClass('page-note');
    expect(screen.queryByLabelText('New password')).toBeNull();
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute(
      'href',
      '#/sign-in',
    );
  });

  it('[IAM-001] explains a link that was used while the page was open', async () => {
    const user = userEvent.setup();
    stubLinks(validLink('activate', () => jsonResponse(404, { error: 'invalid_link' })));
    window.location.hash = `#/password?token=${TOKEN}`;
    render(<App />);
    await screen.findByLabelText('New password');
    await choosePassword(user, 'a long enough passphrase');
    expect(await screen.findByText(/invalid, has expired or was already used/)).toBeVisible();
  });

  it('[IAM-001] needs the token from the link, and says so without the intro (AC-7, AC-15)', () => {
    window.location.hash = '#/password';
    render(<App />);
    expect(screen.getByRole('alert')).toHaveTextContent(/This address has no password link in it/);
    expect(screen.queryByText(/This link works once/)).toBeNull();
    // The frame's one way out (D24).
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute(
      'href',
      '#/sign-in',
    );
    expect(screen.getAllByRole('banner')[0]).toHaveTextContent('Taskmoor');
  });

  it('[IAM-001] shows a translated message per password problem', async () => {
    const user = userEvent.setup();
    stubLinks(
      validLink('activate', () =>
        jsonResponse(400, {
          error: 'weak_password',
          codes: ['too_short'],
          problems: ['password: must be at least 12 characters'],
        }),
      ),
    );
    window.location.hash = `#/password?token=${TOKEN}`;
    render(<App />);
    await screen.findByLabelText('New password');
    await choosePassword(user, 'short');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Choose a different password:');
    expect(within(alert).getByRole('listitem')).toHaveTextContent(
      'Too short: use at least 12 characters.',
    );
    expect(screen.getByLabelText('New password')).toHaveAttribute('aria-invalid', 'true');
    expect(window.location.hash).toBe(`#/password?token=${TOKEN}`);
  });

  it('[IAM-001] catches different passwords before calling the backend', async () => {
    const user = userEvent.setup();
    const calls = stubLinks(validLink('activate'));
    window.location.hash = `#/password?token=${TOKEN}`;
    render(<App />);
    await screen.findByLabelText('New password');
    await choosePassword(user, 'a long enough passphrase', 'a different passphrase');
    expect(await screen.findByRole('alert')).toHaveTextContent('The two passwords differ.');
    expect(calls.some((c) => c.url.endsWith('/redeem'))).toBe(false);
  });

  it('[IAM-001] says how long to wait when the address is locked', async () => {
    stubLinks(() => jsonResponse(429, { error: 'too_many_attempts', retryAfterSeconds: 600 }));
    window.location.hash = `#/password?token=${TOKEN}`;
    render(<App />);
    expect(await screen.findByText('Too many attempts. Try again in 10 minutes.')).toBeVisible();
  });

  it('[IAM-001] shows and hides both passwords and works on a phone', async () => {
    setViewportWidth(375);
    const user = userEvent.setup();
    stubLinks(validLink('activate'));
    window.location.hash = `#/password?token=${TOKEN}`;
    render(<App />);
    await screen.findByLabelText('New password');
    const show = screen.getByRole('button', { name: 'Show new password' });
    await user.click(show);
    expect(show).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('New password')).toHaveAttribute('type', 'text');
    expect(screen.getByLabelText('Confirm new password')).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Show password confirmation' })).toBeVisible();
  });
});
