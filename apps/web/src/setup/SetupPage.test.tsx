import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { jsonResponse } from '../test/setup';
import { setupTokenFromHash } from './SetupPage';

type Call = { url: string; init?: RequestInit };

function stubApi(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call = { url, ...(init ? { init } : {}) };
      calls.push(call);
      return answer(call);
    }),
  );
  return calls;
}

async function fillAdminForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Instance name'), 'Acme Tracker');
  await user.type(screen.getByLabelText('Name'), 'Kalo');
  await user.type(screen.getByLabelText('Email'), 'kalo@example.com');
  await user.type(screen.getByLabelText('Password'), 'a long enough passphrase');
  await user.type(screen.getByLabelText('Confirm password'), 'a long enough passphrase');
}

describe('setup page', () => {
  it('reads the one-time token from the setup link', () => {
    expect(setupTokenFromHash('#/setup?token=abc-123')).toBe('abc-123');
    expect(setupTokenFromHash('#/setup')).toBeNull();
    expect(setupTokenFromHash('#/setup?other=1')).toBeNull();
  });

  it('[OPS-003] explains that the installer link is needed without a token', async () => {
    stubApi(({ url }) =>
      url.endsWith('/setup')
        ? jsonResponse(200, { needed: true })
        : jsonResponse(401, { error: 'not_signed_in' }),
    );
    window.location.hash = '#/setup';
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Set up Taskmoor' })).toBeVisible();
    expect(await screen.findByText(/needs the whole setup link/)).toBeVisible();
    // No intro that says to create an account here (AC-7).
    expect(screen.queryByText(/This runs once/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Finish setup' })).toBeNull();
    // No account exists yet, so the frame offers no way to sign in.
    expect(screen.getAllByRole('banner')[0]).toHaveTextContent('Taskmoor');
    expect(screen.queryByRole('link', { name: 'Go to sign in' })).toBeNull();
  });

  it('[OPS-003] says a site that is set up is set up, also without a link (AC-5)', async () => {
    stubApi(({ url }) =>
      url.endsWith('/setup')
        ? jsonResponse(200, { needed: false })
        : jsonResponse(401, { error: 'not_signed_in' }),
    );
    window.location.hash = '#/setup';
    render(<App />);
    expect(
      await screen.findByText('This site is already set up. Sign in with your account.'),
    ).toBeVisible();
    expect(screen.queryByText(/needs the whole setup link/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute(
      'href',
      '#/sign-in',
    );
  });

  it('[OPS-003] creates the administrator, signs in and leaves for the home page', async () => {
    const user = userEvent.setup();
    const calls = stubApi(({ url, init }) => {
      if (url.endsWith('/setup') && init?.method === 'POST') {
        return jsonResponse(201, {
          user: { id: 1, name: 'Kalo', email: 'kalo@example.com', isSiteAdmin: true },
        });
      }
      if (url.endsWith('/setup')) return jsonResponse(200, { needed: true });
      if (url.endsWith('/session')) {
        return jsonResponse(200, {
          user: { id: 1, name: 'Kalo', email: 'kalo@example.com', isSiteAdmin: true },
        });
      }
      return jsonResponse(404, {});
    });
    window.location.hash = '#/setup?token=one-time';
    render(<App />);
    await screen.findByRole('button', { name: 'Finish setup' });
    await fillAdminForm(user);
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));

    const post = calls.find((c) => c.init?.method === 'POST');
    expect(JSON.parse(String(post?.init?.body))).toEqual({
      token: 'one-time',
      instanceName: 'Acme Tracker',
      admin: { name: 'Kalo', email: 'kalo@example.com', password: 'a long enough passphrase' },
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
    expect(window.location.hash).toBe('#/home');
  });

  it('[OPS-003] shows the backend refusals: a used token and an already set-up instance', async () => {
    const user = userEvent.setup();
    let status = 403;
    stubApi(({ url, init }) => {
      if (url.endsWith('/setup') && init?.method === 'POST') {
        return jsonResponse(status, {
          error: status === 403 ? 'invalid_setup_token' : 'setup_completed',
        });
      }
      if (url.endsWith('/setup')) return jsonResponse(200, { needed: true });
      return jsonResponse(401, { error: 'not_signed_in' });
    });
    window.location.hash = '#/setup?token=stale';
    render(<App />);
    await screen.findByRole('button', { name: 'Finish setup' });
    await fillAdminForm(user);
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/invalid or has expired/);

    status = 409;
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(await screen.findByText(/already set up/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute(
      'href',
      '#/sign-in',
    );
  });

  it('[IAM-001] explains each password problem in the reader’s language', async () => {
    const user = userEvent.setup();
    stubApi(({ url, init }) => {
      if (url.endsWith('/setup') && init?.method === 'POST') {
        return jsonResponse(400, {
          error: 'weak_password',
          codes: ['predictable', 'contains_identity', 'rule_from_a_newer_backend'],
          problems: [
            'admin.password: is too predictable',
            'admin.password: must not contain your name',
            'admin.password: breaks a newer rule',
          ],
        });
      }
      if (url.endsWith('/setup')) return jsonResponse(200, { needed: true });
      return jsonResponse(401, { error: 'not_signed_in' });
    });
    window.location.hash = '#/setup?token=t';
    render(<App />);
    await screen.findByRole('button', { name: 'Finish setup' });
    await fillAdminForm(user);
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Choose a different password:');
    expect(
      within(alert)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'Too predictable: avoid repeated patterns and sequences such as abcabc or 123456.',
      'It contains your name, your email address or the product name.',
      'admin.password: breaks a newer rule',
    ]);
  });

  it('[IAM-001] lets the administrator show the password while typing it', async () => {
    const user = userEvent.setup();
    stubApi(({ url }) =>
      url.endsWith('/setup') ? jsonResponse(200, { needed: true }) : jsonResponse(401, {}),
    );
    window.location.hash = '#/setup?token=t';
    render(<App />);
    await screen.findByRole('button', { name: 'Finish setup' });
    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text');
    expect(screen.getByLabelText('Confirm password')).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Show password confirmation' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('catches a password mismatch before calling the backend', async () => {
    const user = userEvent.setup();
    const calls = stubApi(({ url }) =>
      url.endsWith('/setup') ? jsonResponse(200, { needed: true }) : jsonResponse(401, {}),
    );
    window.location.hash = '#/setup?token=t';
    render(<App />);
    await screen.findByRole('button', { name: 'Finish setup' });
    await user.type(screen.getByLabelText('Instance name'), 'Acme');
    await user.type(screen.getByLabelText('Name'), 'Kalo');
    await user.type(screen.getByLabelText('Email'), 'kalo@example.com');
    await user.type(screen.getByLabelText('Password'), 'a long enough passphrase');
    await user.type(screen.getByLabelText('Confirm password'), 'a different passphrase');
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The two passwords differ.');
    expect(calls.some((c) => c.init?.method === 'POST')).toBe(false);
  });
});
