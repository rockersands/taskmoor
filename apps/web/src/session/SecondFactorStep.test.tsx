import { startAuthentication } from '@simplewebauthn/browser';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { I18nProvider } from '../i18n/I18nProvider';
import { type Handler, stubBackend, untranslated, visibleTexts } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { setViewportWidth } from '../test/viewport';
import { SecurityKeyError } from '../twofactor/webauthn';
import { SecondFactorStep } from './SecondFactorStep';
import { SessionProvider } from './SessionProvider';
import type { SecondFactorClient } from './secondFactorClient';

vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => true,
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
}));

const KALO = {
  id: 1,
  name: 'Kalo',
  email: 'kalo@example.com',
  isSiteAdmin: false,
  timeZone: null,
  locale: null,
};
const CHALLENGE = 'challenge-from-the-password-step';
const KEY_OPTIONS = { challenge: 'webauthn-challenge', rpId: 'localhost', allowCredentials: [] };
const KEY_RESPONSE = {
  id: 'credential-1',
  rawId: 'credential-1',
  type: 'public-key',
  response: { clientDataJSON: 'e30', authenticatorData: 'AA', signature: 'AA' },
  clientExtensionResults: {},
};

const secondFactor = (methods: string[]) => () =>
  jsonResponse(200, { status: 'second_factor', challenge: CHALLENGE, methods });
const signedIn = () => jsonResponse(200, { status: 'signed_in', user: KALO });

/** Opens the sign-in page with this backend and gets past the password. */
async function passPassword(handlers: Record<string, Handler>) {
  const user = userEvent.setup();
  const calls = stubBackend({
    'GET /session': () => jsonResponse(401, { error: 'not_signed_in' }),
    ...handlers,
  });
  window.location.hash = '#/sign-in';
  render(<App />);
  await user.type(await screen.findByLabelText('Email'), 'kalo@example.com');
  await user.type(screen.getByLabelText('Password'), 'a long enough passphrase');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByRole('form', { name: 'Two-factor authentication' });
  return { user, calls };
}

beforeEach(() => {
  vi.mocked(startAuthentication).mockReset();
});

describe('sign-in: second factor', () => {
  it('[IAM-001] asks for the authenticator code after the password and signs in with it', async () => {
    const { user, calls } = await passPassword({
      'POST /session': secondFactor(['totp', 'recovery_code']),
      'POST /session/second-factor': signedIn,
    });
    const code = screen.getByLabelText('Authentication code');
    expect(code).toHaveFocus();
    expect(code).toHaveAttribute('inputmode', 'numeric');
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    expect(screen.getByText('Enter the 6-digit code from your authenticator app.')).toBeVisible();
    // No security key on this account: no button for one.
    expect(screen.queryByRole('button', { name: 'Use a security key' })).toBeNull();

    await user.type(code, '123 456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
    expect(calls.find((c) => c.path === '/session/second-factor')?.body).toEqual({
      challenge: CHALLENGE,
      method: 'totp',
      code: '123 456',
    });
  });

  it('[IAM-001] says when the code is wrong, clears it and keeps the step', async () => {
    const { user } = await passPassword({
      'POST /session': secondFactor(['totp']),
      'POST /session/second-factor': () => jsonResponse(401, { error: 'invalid_second_factor' }),
    });
    const code = screen.getByLabelText('Authentication code');
    await user.type(code, '000000');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('That code is not correct.');
    expect(code).toHaveValue('');
    expect(code).toHaveFocus();
    expect(code).toHaveAttribute('aria-invalid', 'true');
    expect(code.getAttribute('aria-describedby')).toContain(alert.id);
    // Without recovery codes left there is no switch to them.
    expect(screen.queryByRole('button', { name: 'Use a recovery code' })).toBeNull();
  });

  it('[IAM-001] signs in with a recovery code instead', async () => {
    const { user, calls } = await passPassword({
      'POST /session': secondFactor(['totp', 'recovery_code']),
      'POST /session/second-factor': (body) =>
        (body as { method: string }).method === 'recovery_code'
          ? signedIn()
          : jsonResponse(401, { error: 'invalid_second_factor' }),
    });
    await user.click(screen.getByRole('button', { name: 'Use a recovery code' }));
    const field = screen.getByLabelText('Recovery code');
    expect(field).toHaveFocus();
    expect(field).toHaveAttribute('autocomplete', 'off');
    expect(screen.queryByLabelText('Authentication code')).toBeNull();
    // And back again.
    expect(screen.getByRole('button', { name: 'Use your authenticator app' })).toBeVisible();

    await user.type(field, 'kd7qx-m2pla');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
    expect(calls.find((c) => c.path === '/session/second-factor')?.body).toEqual({
      challenge: CHALLENGE,
      method: 'recovery_code',
      code: 'kd7qx-m2pla',
    });
  });

  it('[IAM-001] says when a recovery code was already used', async () => {
    const { user } = await passPassword({
      'POST /session': secondFactor(['totp', 'recovery_code']),
      'POST /session/second-factor': () => jsonResponse(401, { error: 'invalid_second_factor' }),
    });
    await user.click(screen.getByRole('button', { name: 'Use a recovery code' }));
    await user.type(screen.getByLabelText('Recovery code'), 'KD7QX-M2PLA');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That recovery code is not valid or was already used.',
    );
  });

  it('[IAM-001] goes back to the password step when the challenge has expired', async () => {
    const { user } = await passPassword({
      'POST /session': secondFactor(['totp']),
      'POST /session/second-factor': () => jsonResponse(401, { error: 'invalid_challenge' }),
    });
    await user.type(screen.getByLabelText('Authentication code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByRole('form', { name: 'Sign in' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The sign-in took too long or had too many wrong codes. Enter your password again.',
    );
    // The email stays; the password is typed again.
    expect(screen.getByLabelText('Email')).toHaveValue('kalo@example.com');
    expect(screen.getByLabelText('Password')).toHaveValue('');
    expect(screen.getByLabelText('Password')).toHaveFocus();
  });

  it('[IAM-001] goes back to the password step on request', async () => {
    const { user } = await passPassword({ 'POST /session': secondFactor(['totp']) });
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('form', { name: 'Sign in' })).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('[IAM-001] says how long to wait after too many wrong codes', async () => {
    const { user } = await passPassword({
      'POST /session': secondFactor(['totp']),
      'POST /session/second-factor': () =>
        jsonResponse(429, { error: 'too_many_attempts', retryAfterSeconds: 300 }),
    });
    await user.type(screen.getByLabelText('Authentication code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many attempts. Try again in 5 minutes.',
    );
  });

  it('[IAM-001] signs in with a security key', async () => {
    vi.mocked(startAuthentication).mockResolvedValue(KEY_RESPONSE as never);
    const { user, calls } = await passPassword({
      'POST /session': secondFactor(['totp', 'webauthn', 'recovery_code']),
      'POST /session/second-factor/webauthn': () => jsonResponse(200, { options: KEY_OPTIONS }),
      'POST /session/second-factor': signedIn,
    });
    await user.click(screen.getByRole('button', { name: 'Use a security key' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
    expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: KEY_OPTIONS });
    expect(calls.find((c) => c.path === '/session/second-factor/webauthn')?.body).toEqual({
      challenge: CHALLENGE,
    });
    expect(calls.find((c) => c.path === '/session/second-factor')?.body).toEqual({
      challenge: CHALLENGE,
      method: 'webauthn',
      response: KEY_RESPONSE,
    });
  });

  it('[IAM-001] offers the key first when it is the only factor', async () => {
    await passPassword({ 'POST /session': secondFactor(['webauthn', 'recovery_code']) });
    expect(screen.getByText('Use your security key to finish signing in.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Use a security key' })).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Verify' })).toBeNull();
    expect(screen.queryByLabelText('Authentication code')).toBeNull();
  });

  it('[IAM-001] reports a security key request that was cancelled', async () => {
    vi.mocked(startAuthentication).mockRejectedValue(
      Object.assign(new Error('The operation either timed out or was not allowed.'), {
        name: 'NotAllowedError',
      }),
    );
    const { user, calls } = await passPassword({
      'POST /session': secondFactor(['webauthn']),
      'POST /session/second-factor/webauthn': () => jsonResponse(200, { options: KEY_OPTIONS }),
    });
    await user.click(screen.getByRole('button', { name: 'Use a security key' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The security key did not answer, or the request was cancelled. Try again.',
    );
    expect(calls.some((c) => c.path === '/session/second-factor')).toBe(false);
  });

  it('[IAM-001] reports a key the account does not know', async () => {
    vi.mocked(startAuthentication).mockResolvedValue(KEY_RESPONSE as never);
    const { user } = await passPassword({
      'POST /session': secondFactor(['webauthn']),
      'POST /session/second-factor/webauthn': () => jsonResponse(200, { options: KEY_OPTIONS }),
      'POST /session/second-factor': () => jsonResponse(401, { error: 'invalid_second_factor' }),
    });
    await user.click(screen.getByRole('button', { name: 'Use a security key' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That security key is not registered for this account.',
    );
  });

  it('[IAM-001] works on a phone-sized screen', async () => {
    setViewportWidth(375);
    await passPassword({ 'POST /session': secondFactor(['totp', 'webauthn', 'recovery_code']) });
    const form = screen.getByRole('form', { name: 'Two-factor authentication' });
    for (const name of ['Verify', 'Use a security key', 'Use a recovery code', 'Back']) {
      expect(within(form).getByRole('button', { name })).toBeVisible();
    }
    expect(screen.getByRole('button', { name: 'Open navigation' })).toBeVisible();
  });

  it('passes every string through the pseudo-locale', async () => {
    const user = userEvent.setup();
    const errors: Error[] = [];
    const client: SecondFactorClient = {
      verify: async () => {
        throw new Error('network');
      },
      answerWithSecurityKey: async () => {
        throw new SecurityKeyError('cancelled');
      },
      startEnrollment: async () => {
        throw new Error('not used');
      },
      confirmEnrollment: async () => {
        throw new Error('not used');
      },
    };
    const { container } = render(
      <I18nProvider locale="en-XA" onError={(e) => errors.push(e)}>
        <SessionProvider session={{ status: 'anonymous' }}>
          <SecondFactorStep
            challenge={CHALLENGE}
            methods={['totp', 'webauthn', 'recovery_code']}
            onSignedIn={() => {}}
            onExpired={() => {}}
            onBack={() => {}}
            client={client}
          />
        </SessionProvider>
      </I18nProvider>,
    );
    await user.type(screen.getByRole('textbox'), '123456');
    await user.keyboard('{Enter}');
    await screen.findByRole('alert');
    const texts = visibleTexts(container);
    expect(texts.length).toBeGreaterThan(6);
    expect(untranslated(texts)).toEqual([]);
    expect(errors).toEqual([]);
  });
});
