import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { jsonResponse } from '../test/setup';

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
          return jsonResponse(200, {
            user: { id: 1, name: 'Kalo', email: body.email, isSiteAdmin: true },
          });
        }
        return signedIn
          ? jsonResponse(200, {
              user: { id: 1, name: 'Kalo', email: 'kalo@example.com', isSiteAdmin: true },
            })
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
});
