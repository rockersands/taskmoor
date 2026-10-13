import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { jsonResponse } from '../test/setup';
import { setViewportWidth } from '../test/viewport';

const KALO = {
  id: 1,
  name: 'Kalo',
  email: 'kalo@example.com',
  isSiteAdmin: true,
  timeZone: null,
  locale: null,
};

describe('sign-in form', () => {
  it('[IAM-001] signs in with email and password and shows the protected page', async () => {
    const user = userEvent.setup();
    let signedIn = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/session') && init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as { email: string; password: string };
          if (body.password !== 'a long enough passphrase') {
            return jsonResponse(401, { error: 'invalid_credentials' });
          }
          signedIn = true;
          return jsonResponse(200, { user: { ...KALO, email: body.email } });
        }
        return signedIn
          ? jsonResponse(200, { user: KALO })
          : jsonResponse(401, { error: 'not_signed_in' });
      }),
    );
    window.location.hash = '#/settings';
    render(<App />);
    const form = await screen.findByRole('form', { name: 'Sign in' });
    expect(form).toBeVisible();

    await user.type(screen.getByLabelText('Email'), 'kalo@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrong password here');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('do not match');

    await user.clear(screen.getByLabelText('Password'));
    await user.type(screen.getByLabelText('Password'), 'a long enough passphrase');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  });

  it('[IAM-001] shows and hides the password with a toggle button, and accepts paste', async () => {
    const user = userEvent.setup();
    window.location.hash = '#/sign-in';
    render(<App session={{ status: 'anonymous' }} />);
    const password = screen.getByLabelText('Password');
    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveAttribute('autocomplete', 'current-password');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(toggle).toHaveAttribute('aria-controls', password.id);

    await user.click(password);
    await user.paste('a pasted passphrase');
    expect(password).toHaveValue('a pasted passphrase');

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(password).toHaveAttribute('type', 'text');
    // The name stays the same; aria-pressed carries the state.
    expect(screen.getByRole('button', { name: 'Show password' })).toBe(toggle);
    await user.click(toggle);
    expect(password).toHaveAttribute('type', 'password');
  });

  it.each([
    [30, 'Too many attempts. Try again in 30 seconds.'],
    [60, 'Too many attempts. Try again in 1 minute.'],
    [240, 'Too many attempts. Try again in 4 minutes.'],
  ])('[IAM-001] says how long to wait after a lockout of %s seconds', async (seconds, message) => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(429, { error: 'too_many_attempts', retryAfterSeconds: seconds }),
      ),
    );
    window.location.hash = '#/sign-in';
    render(<App session={{ status: 'anonymous' }} />);
    await user.type(screen.getByLabelText('Email'), 'someone@example.com');
    await user.type(screen.getByLabelText('Password'), 'guess number seven');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });

  it('[IAM-001] works on a phone-sized screen', async () => {
    setViewportWidth(375);
    window.location.hash = '#/sign-in';
    render(<App session={{ status: 'anonymous' }} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Show password' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });
});
