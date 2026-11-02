import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { defaultPreferences } from '../notifications/fixtures';
import { type Handler, noContent, stubBackend as stubAny } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { setViewportWidth } from '../test/viewport';
import { personalTokens } from '../tokens/fixtures';
import { KALO, SIGNED_IN, sampleSessions, TWO_FACTOR_OFF } from './fixtures';

/** The page's backend: two-factor is off and notifications are on unless a test says otherwise. */
const stubBackend = (handlers: Record<string, Handler>) =>
  stubAny({
    'GET /account/two-factor': () => jsonResponse(200, TWO_FACTOR_OFF),
    'GET /account/notification-preferences': () =>
      jsonResponse(200, { preferences: defaultPreferences() }),
    'GET /account/data-exports': () => jsonResponse(200, { exports: [] }),
    ...handlers,
  });
const sessionsAnswer =
  (sessions = sampleSessions()) =>
  () =>
    jsonResponse(200, { sessions });

const tokensAnswer = () =>
  jsonResponse(200, {
    tokens: personalTokens(),
    policy: { maxLifetimeDays: 365, reminderDays: 14 },
  });

const region = (name: string) => screen.getByRole('region', { name });

async function openAccount(handlers: Record<string, Handler> = {}) {
  const calls = stubBackend({
    'GET /sessions': sessionsAnswer(),
    'GET /account/tokens': tokensAnswer,
    ...handlers,
  });
  window.location.hash = '#/account';
  render(<App session={SIGNED_IN} />);
  await screen.findByRole('heading', { level: 1, name: 'Account' });
  return calls;
}

async function fillPassword(
  user: ReturnType<typeof userEvent.setup>,
  current: string,
  next: string,
  confirm = next,
) {
  const password = within(region('Password'));
  await user.type(password.getByLabelText('Current password'), current);
  await user.type(password.getByLabelText('New password'), next);
  await user.type(password.getByLabelText('Confirm new password'), confirm);
  await user.click(password.getByRole('button', { name: 'Change password' }));
}

describe('account page: profile', () => {
  it('[IAM-008] shows profile, password, sessions and API tokens to the signed-in person', async () => {
    await openAccount();
    for (const name of [
      'Profile',
      'Password',
      'Two-factor authentication',
      'Sessions',
      'API tokens',
    ]) {
      expect(within(region(name)).getByRole('heading', { level: 2, name })).toBeVisible();
    }
    expect(screen.getByLabelText('Name')).toHaveValue('Kalo Mendes');
    expect(screen.getByLabelText('Email')).toHaveValue('kalo@example.com');
    expect(screen.getByLabelText('Email')).toHaveAttribute('readonly');
    // Account is personal settings: Settings stays highlighted in the navigation.
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
  });

  it('[IAM-008] saves name, time zone and locale and shows the new name in the user menu', async () => {
    const user = userEvent.setup();
    const calls = await openAccount({
      'PATCH /account': (body) =>
        jsonResponse(200, { user: { ...KALO, ...(body as Record<string, unknown>) } }),
    });
    const profile = within(region('Profile'));
    await user.clear(profile.getByLabelText('Name'));
    await user.type(profile.getByLabelText('Name'), 'Kalo M.');
    await user.selectOptions(profile.getByLabelText('Time zone'), 'Europe/Madrid');
    await user.selectOptions(profile.getByLabelText('Language and region'), 'en-GB');
    await user.click(profile.getByRole('button', { name: 'Save profile' }));

    expect(await profile.findByText('Profile saved.')).toHaveAttribute('role', 'status');
    expect(calls.find((c) => c.method === 'PATCH')).toEqual({
      method: 'PATCH',
      path: '/account',
      body: { name: 'Kalo M.', timeZone: 'Europe/Madrid', locale: 'en-GB' },
    });
    expect(screen.getByRole('button', { name: 'Kalo M.' })).toHaveAttribute(
      'aria-haspopup',
      'menu',
    );
  });

  it('[IAM-008] offers Automatic first and every time zone the browser knows', async () => {
    const user = userEvent.setup();
    const calls = await openAccount({
      'PATCH /account': () => jsonResponse(200, { user: { ...KALO, timeZone: null } }),
    });
    const zone = within(region('Profile')).getByLabelText('Time zone');
    const options = within(zone).getAllByRole('option');
    expect(options[0]).toHaveTextContent('Automatic');
    expect(options[0]).toHaveValue('');
    expect(options.length).toBeGreaterThan(100);
    expect(within(zone).getByRole('option', { name: 'America/New York' })).toHaveValue(
      'America/New_York',
    );
    expect(within(zone).getByRole('option', { name: 'UTC' })).toBeInTheDocument();
    const locale = within(region('Profile')).getByLabelText('Language and region');
    expect(within(locale).getByRole('option', { name: 'English (United Kingdom)' })).toHaveValue(
      'en-GB',
    );

    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    await screen.findByText('Profile saved.');
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
      name: 'Kalo Mendes',
      timeZone: null,
      locale: null,
    });
  });

  it('[IAM-008] keeps a saved time zone and locale selected', async () => {
    stubBackend({ 'GET /sessions': sessionsAnswer(), 'GET /account/tokens': tokensAnswer });
    window.location.hash = '#/account';
    render(
      <App
        session={{
          status: 'signed-in',
          user: { ...KALO, timeZone: 'Asia/Kolkata', locale: 'gsw-CH' },
        }}
      />,
    );
    expect(await screen.findByLabelText('Time zone')).toHaveValue('Asia/Kolkata');
    expect(screen.getByLabelText('Language and region')).toHaveValue('gsw-CH');
  });

  it('[IAM-008] reports a time zone the backend refuses', async () => {
    const user = userEvent.setup();
    await openAccount({
      'PATCH /account': () => jsonResponse(400, { error: 'invalid_time_zone' }),
    });
    await user.selectOptions(screen.getByLabelText('Time zone'), 'Europe/Madrid');
    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That time zone is not recognised.');
    expect(screen.getByLabelText('Time zone')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByText('Profile saved.')).toBeNull();
  });
});

describe('account page: password', () => {
  it('[IAM-001] changes the password and says how many other sessions were signed out', async () => {
    const user = userEvent.setup();
    const calls = await openAccount({
      'PUT /account/password': () => jsonResponse(200, { signedOutSessions: 2 }),
    });
    await fillPassword(user, 'the current passphrase', 'a brand new passphrase');

    expect(
      await screen.findByText('Password changed. 2 other sessions were signed out.'),
    ).toHaveAttribute('role', 'status');
    expect(calls.find((c) => c.method === 'PUT')).toEqual({
      method: 'PUT',
      path: '/account/password',
      body: { currentPassword: 'the current passphrase', newPassword: 'a brand new passphrase' },
    });
    const password = within(region('Password'));
    expect(password.getByLabelText('Current password')).toHaveValue('');
    expect(password.getByLabelText('New password')).toHaveValue('');
    // The other sessions are gone, so the list is read again.
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'GET' && c.path === '/sessions')).toHaveLength(2),
    );
  });

  it('[IAM-001] says so when there were no other sessions', async () => {
    const user = userEvent.setup();
    await openAccount({
      'PUT /account/password': () => jsonResponse(200, { signedOutSessions: 0 }),
    });
    await fillPassword(user, 'the current passphrase', 'a brand new passphrase');
    expect(
      await screen.findByText('Password changed. You were not signed in anywhere else.'),
    ).toBeVisible();
  });

  it('[IAM-001] catches different new passwords before calling the backend', async () => {
    const user = userEvent.setup();
    const calls = await openAccount();
    await fillPassword(user, 'the current passphrase', 'a brand new passphrase', 'a typo');
    expect(await screen.findByRole('alert')).toHaveTextContent('The two passwords differ.');
    expect(screen.getByLabelText('Confirm new password')).toHaveAttribute('aria-invalid', 'true');
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('[IAM-001] says when the current password is wrong', async () => {
    const user = userEvent.setup();
    await openAccount({
      'PUT /account/password': () => jsonResponse(403, { error: 'wrong_password' }),
    });
    await fillPassword(user, 'not my password', 'a brand new passphrase');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The current password is not correct.');
    const current = screen.getByLabelText('Current password');
    expect(current).toHaveAttribute('aria-invalid', 'true');
    expect(current.getAttribute('aria-describedby')).toBe(alert.id);
  });

  it('[IAM-001] explains each password problem in the reader’s language', async () => {
    const user = userEvent.setup();
    await openAccount({
      'PUT /account/password': () =>
        jsonResponse(400, {
          error: 'weak_password',
          codes: ['common', 'contains_identity', 'rule_from_a_newer_backend'],
          problems: [
            'newPassword: is too common',
            'newPassword: must not contain your name',
            'newPassword: breaks a rule this frontend does not know yet',
          ],
        }),
    });
    await fillPassword(user, 'the current passphrase', 'kalomendes2024!!');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Choose a different password:');
    expect(
      within(alert)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'Too common: it appears in lists of leaked passwords, also with digits or symbols added.',
      'It contains your name, your email address or the product name.',
      'newPassword: breaks a rule this frontend does not know yet',
    ]);
    const next = screen.getByLabelText('New password');
    expect(next).toHaveAttribute('aria-invalid', 'true');
    expect(next.getAttribute('aria-describedby')).toContain(alert.id);
  });

  it('[IAM-001] shows how long to wait after too many wrong passwords', async () => {
    const user = userEvent.setup();
    await openAccount({
      'PUT /account/password': () =>
        jsonResponse(429, { error: 'too_many_attempts', retryAfterSeconds: 125 }),
    });
    await fillPassword(user, 'guess number six', 'a brand new passphrase');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many attempts. Try again in 3 minutes.',
    );
  });

  it('[IAM-001] shows and hides each password on its own', async () => {
    const user = userEvent.setup();
    await openAccount();
    const password = within(region('Password'));
    const toggle = password.getByRole('button', { name: 'Show new password' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(password.getByLabelText('New password')).toHaveAttribute('type', 'password');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(password.getByLabelText('New password')).toHaveAttribute('type', 'text');
    expect(password.getByLabelText('Current password')).toHaveAttribute('type', 'password');
    expect(password.getByRole('button', { name: 'Show current password' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(
      password.getByRole('button', { name: 'Show password confirmation' }),
    ).toBeInTheDocument();
  });
});

describe('account page: sessions', () => {
  it('[IAM-004] lists each session with device, address and activity, this device first', async () => {
    // The backend lists this device last here; the page still shows it first.
    const sessions = sampleSessions();
    const currentLast = [
      ...sessions.filter((s) => !s.current),
      ...sessions.filter((s) => s.current),
    ];
    await openAccount({ 'GET /sessions': sessionsAnswer(currentLast) });
    const items = await within(region('Sessions')).findAllByRole('listitem');
    expect(items).toHaveLength(3);
    const [here, firefox, iphone] = items as [HTMLElement, HTMLElement, HTMLElement];
    expect(here).toHaveTextContent('Chrome on Windows');
    expect(here).toHaveTextContent('This device');
    expect(here).toHaveTextContent('IP address 203.0.113.7');
    expect(here).toHaveTextContent('Active now');
    expect(within(here).queryByRole('button')).toBeNull();
    expect(firefox).toHaveTextContent('Firefox on Linux');
    expect(firefox).toHaveTextContent('Last active 5 minutes ago');
    expect(firefox).not.toHaveTextContent('This device');
    expect(iphone).toHaveTextContent('Safari on iOS');
    expect(iphone).toHaveTextContent('Last active yesterday');
    expect(iphone).toHaveTextContent('IP address 2001:db8:85a3::8a2e:370:7334');
    expect(
      within(iphone).getByRole('button', { name: 'Sign out Safari on iOS' }),
    ).toHaveTextContent('Sign out');
  });

  it('[IAM-004] signs out one other session', async () => {
    const user = userEvent.setup();
    let sessions = sampleSessions();
    const calls = await openAccount({
      'GET /sessions': () => jsonResponse(200, { sessions }),
      'DELETE /sessions/12': () => {
        sessions = sessions.filter((s) => s.id !== 12);
        return noContent();
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Sign out Firefox on Linux' }));
    expect(await screen.findByText('Signed out Firefox on Linux.')).toHaveAttribute(
      'role',
      'status',
    );
    await waitFor(() =>
      expect(within(region('Sessions')).getAllByRole('listitem')).toHaveLength(2),
    );
    expect(screen.queryByText('Firefox on Linux')).toBeNull();
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/sessions/12')).toBe(true);
    // The pressed button is gone; focus waits on the section heading.
    expect(screen.getByRole('heading', { level: 2, name: 'Sessions' })).toHaveFocus();
  });

  it('[IAM-004] treats a session that is already gone as signed out', async () => {
    const user = userEvent.setup();
    await openAccount({ 'DELETE /sessions/13': () => jsonResponse(404, { error: 'not_found' }) });
    await user.click(await screen.findByRole('button', { name: 'Sign out Safari on iOS' }));
    expect(await screen.findByText('Signed out Safari on iOS.')).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('[IAM-004] signs out every other session at once', async () => {
    const user = userEvent.setup();
    let sessions = sampleSessions();
    await openAccount({
      'GET /sessions': () => jsonResponse(200, { sessions }),
      'DELETE /sessions/others': () => {
        sessions = sessions.filter((s) => s.current);
        return jsonResponse(200, { revoked: 2 });
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Sign out all other sessions' }));
    expect(await screen.findByText('Signed out 2 other sessions.')).toBeVisible();
    expect(await screen.findByText('You are not signed in anywhere else.')).toBeVisible();
    expect(within(region('Sessions')).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Sign out all other sessions' })).toBeNull();
  });

  it('[IAM-004] reports a failed sign-out and keeps the list', async () => {
    const user = userEvent.setup();
    await openAccount({ 'DELETE /sessions/others': () => jsonResponse(500, { error: 'boom' }) });
    await user.click(await screen.findByRole('button', { name: 'Sign out all other sessions' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The session could not be signed out. Try again in a moment.',
    );
    expect(within(region('Sessions')).getAllByRole('listitem')).toHaveLength(3);
  });

  it('[IAM-004] reports a list that could not be read', async () => {
    await openAccount({ 'GET /sessions': () => jsonResponse(500, { error: 'boom' }) });
    expect(await within(region('Sessions')).findByRole('alert')).toHaveTextContent(
      'Your sessions could not be read. Try again in a moment.',
    );
  });

  it('[IAM-004] asks to sign in again when the session ended elsewhere', async () => {
    await openAccount({
      'GET /sessions': () => jsonResponse(401, { error: 'not_signed_in' }),
      'GET /session': () => jsonResponse(401, { error: 'not_signed_in' }),
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Sign in to continue' }),
    ).toBeVisible();
  });
});

describe('account page: access and layout', () => {
  it('[IAM-008] asks anonymous visitors to sign in', async () => {
    window.location.hash = '#/account';
    render(<App session={{ status: 'anonymous' }} />);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Sign in to continue' }),
    ).toBeVisible();
  });

  it('[IAM-008] is linked from Settings and offered in the command palette', async () => {
    const user = userEvent.setup();
    stubBackend({ 'GET /sessions': sessionsAnswer(), 'GET /account/tokens': tokensAnswer });
    window.location.hash = '#/settings';
    render(<App session={SIGNED_IN} />);
    expect(await screen.findByRole('link', { name: 'Account' })).toHaveAttribute(
      'href',
      '#/account',
    );
    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('password');
    expect(screen.getByRole('option', { name: 'Account' })).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(window.location.hash).toBe('#/account');
  });

  it('[IAM-008] leaves Account out of the command palette when signed out', async () => {
    const user = userEvent.setup();
    render(<App session={{ status: 'anonymous' }} />);
    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('account');
    expect(screen.queryByRole('option', { name: 'Account' })).toBeNull();
  });

  it('[IAM-008] works on a phone-sized screen', async () => {
    setViewportWidth(375);
    await openAccount();
    expect(await within(region('Sessions')).findAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Change password' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open navigation' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Kalo Mendes' })).toBeVisible();
  });

  it('passes every string through the pseudo-locale', async () => {
    stubBackend({ 'GET /sessions': sessionsAnswer(), 'GET /account/tokens': tokensAnswer });
    window.location.hash = '#/account';
    const errors: Error[] = [];
    render(<App session={SIGNED_IN} locale="en-XA" onI18nError={(e) => errors.push(e)} />);
    const main = screen.getByRole('main');
    await within(main).findAllByRole('listitem');
    const texts: string[] = [];
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim();
      if (text) texts.push(text);
    }
    for (const el of main.querySelectorAll('[aria-label], [title]')) {
      for (const attr of ['aria-label', 'title']) {
        const value = el.getAttribute(attr);
        if (value) texts.push(value);
      }
    }
    expect(texts.length).toBeGreaterThan(40);
    expect(texts.filter((t) => !/^\[.+\]$/s.test(t))).toEqual([]);
    expect(errors).toEqual([]);
  });
});
