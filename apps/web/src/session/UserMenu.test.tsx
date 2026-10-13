import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { KALO, SIGNED_IN, sampleSessions } from '../account/fixtures';
import { jsonResponse } from '../test/setup';
import { setViewportWidth } from '../test/viewport';

const menuButton = () => screen.getByRole('button', { name: 'Kalo Mendes' });

describe('user menu', () => {
  it('[IAM-001] shows the signed-in person and opens a menu with Account and Sign out', async () => {
    const user = userEvent.setup();
    render(<App session={SIGNED_IN} />);
    const button = menuButton();
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    expect(button).toHaveAttribute('aria-expanded', 'false');

    await user.click(button);
    const menu = screen.getByRole('menu', { name: 'Kalo Mendes' });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(button).toHaveAttribute('aria-controls', menu.id);
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Account', 'Sign out']);
    expect(within(menu).getByRole('menuitem', { name: 'Account' })).toHaveFocus();
    expect(screen.getByText('Signed in as kalo@example.com')).toBeVisible();
  });

  it('[IAM-001] follows the menu button keyboard pattern', async () => {
    const user = userEvent.setup();
    render(<App session={SIGNED_IN} />);
    const button = menuButton();
    act(() => button.focus());

    await user.keyboard('{ArrowDown}');
    const account = screen.getByRole('menuitem', { name: 'Account' });
    const signOut = screen.getByRole('menuitem', { name: 'Sign out' });
    expect(account).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(signOut).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(account).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(signOut).toHaveFocus();
    await user.keyboard('{Home}');
    expect(account).toHaveFocus();
    await user.keyboard('{End}');
    expect(signOut).toHaveFocus();
    await user.keyboard('a');
    expect(account).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(button).toHaveFocus();

    // Arrow up opens on the last item; Enter and Space open on the first.
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toHaveFocus();
    await user.keyboard('{Escape}');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('menuitem', { name: 'Account' })).toHaveFocus();
    await user.keyboard('{Tab}');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('[IAM-001] closes when someone clicks elsewhere', async () => {
    const user = userEvent.setup();
    render(<App session={SIGNED_IN} />);
    await user.click(menuButton());
    expect(screen.getByRole('menu')).toBeVisible();
    await user.click(screen.getByRole('heading', { level: 1 }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(menuButton()).toHaveAttribute('aria-expanded', 'false');
  });

  it('[IAM-008] goes to the account page', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      // One answer for the Account page's sessions and API tokens alike.
      vi.fn(async () =>
        jsonResponse(200, {
          sessions: sampleSessions(),
          tokens: [],
          policy: { maxLifetimeDays: 365, reminderDays: 14 },
        }),
      ),
    );
    render(<App session={SIGNED_IN} />);
    await user.click(menuButton());
    await user.click(screen.getByRole('menuitem', { name: 'Account' }));
    expect(window.location.hash).toBe('#/account');
    expect(await screen.findByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('[IAM-001] signs out, shows the sign-in page and signs back in', async () => {
    const user = userEvent.setup();
    let signedIn = true;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/session') && init?.method === 'DELETE') {
        signedIn = false;
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/session') && init?.method === 'POST') {
        signedIn = true;
        return jsonResponse(200, { user: KALO });
      }
      return signedIn
        ? jsonResponse(200, { user: KALO })
        : jsonResponse(401, { error: 'not_signed_in' });
    });
    vi.stubGlobal('fetch', fetch);
    window.location.hash = '#/settings';
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Kalo Mendes' }));
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));

    const heading = await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    expect(window.location.hash).toBe('#/sign-in');
    expect(heading).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Kalo Mendes' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '#/sign-in');
    expect(
      fetch.mock.calls.some(([url, init]) => url.endsWith('/session') && init?.method === 'DELETE'),
    ).toBe(true);

    await user.type(screen.getByLabelText('Email'), 'kalo@example.com');
    await user.type(screen.getByLabelText('Password'), 'a long enough passphrase');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Kalo Mendes' })).toBeVisible();
  });

  it('[IAM-001] says so when signing out fails and stays signed in', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    render(<App session={SIGNED_IN} />);
    await user.click(menuButton());
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Signing out did not work.');
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toHaveFocus();
    expect(window.location.hash).toBe('');

    // Reopening the menu starts without the old error.
    await user.keyboard('{Escape}');
    await user.click(menuButton());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('[IAM-001] offers a sign-in link to visitors who are not signed in', async () => {
    render(<App session={{ status: 'anonymous' }} />);
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '#/sign-in');
    expect(screen.queryByRole('button', { name: /Kalo/ })).toBeNull();
  });

  it('[IAM-001] keeps its name on a phone, where only the initial shows', async () => {
    setViewportWidth(375);
    const user = userEvent.setup();
    render(<App session={SIGNED_IN} />);
    const button = menuButton();
    expect(button).toHaveTextContent('K');
    await user.click(button);
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
  });

  it('[IAM-001] goes home when a signed-in person opens the sign-in page', async () => {
    window.location.hash = '#/sign-in';
    render(<App session={SIGNED_IN} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
    expect(window.location.hash).toBe('#/home');
  });
});
