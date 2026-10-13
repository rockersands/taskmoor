import { startRegistration } from '@simplewebauthn/browser';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { I18nProvider } from '../i18n/I18nProvider';
import { messagesEn } from '../i18n/messages.en';
import { pseudoLocalize } from '../i18n/pseudo';
import { SessionProvider } from '../session/SessionProvider';
import { type Handler, noContent, stubBackend, untranslated, visibleTexts } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { setViewportWidth } from '../test/viewport';
import type { TwoFactorStatus } from './client';
import {
  fakeAccountClient,
  SAMPLE_RECOVERY_CODES,
  SAMPLE_TOTP_SETUP,
  SIGNED_IN,
  sampleSessions,
  TWO_FACTOR_OFF,
  twoFactorOn,
} from './fixtures';
import { TwoFactorSection } from './TwoFactorSection';

vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => true,
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
}));

const REGISTRATION_OPTIONS = { challenge: 'registration-challenge', rp: { name: 'Taskmoor' } };
const REGISTRATION_RESPONSE = {
  id: 'new-credential',
  rawId: 'new-credential',
  type: 'public-key',
  response: { clientDataJSON: 'e30', attestationObject: 'AA' },
  clientExtensionResults: {},
};

const section = () => screen.getByRole('region', { name: 'Two-factor authentication' });

/** The Account page with a backend whose two-factor state the handlers can change. */
async function openAccount(
  initial: TwoFactorStatus,
  handlers: (state: { factors: TwoFactorStatus }) => Record<string, Handler> = () => ({}),
) {
  const user = userEvent.setup();
  const state = { factors: initial };
  const calls = stubBackend({
    'GET /sessions': () => jsonResponse(200, { sessions: sampleSessions() }),
    'GET /account/two-factor': () => jsonResponse(200, state.factors),
    ...handlers(state),
  });
  window.location.hash = '#/account';
  render(<App session={SIGNED_IN} />);
  await within(await screen.findByRole('region', { name: 'Two-factor authentication' })).findByText(
    /Two-factor authentication is (on|off)\./,
  );
  return { user, calls, state };
}

beforeEach(() => {
  vi.mocked(startRegistration).mockReset();
});

describe('account page: two-factor authentication', () => {
  it('[IAM-001] sets up an authenticator app and shows the recovery codes once', async () => {
    const { user, calls } = await openAccount(TWO_FACTOR_OFF, (state) => ({
      'POST /account/two-factor/totp': () => jsonResponse(200, SAMPLE_TOTP_SETUP),
      'POST /account/two-factor/totp/confirm': () => {
        state.factors = { ...state.factors, totp: true, recoveryRemaining: 10 };
        return jsonResponse(201, { recoveryCodes: SAMPLE_RECOVERY_CODES });
      },
    }));
    const tf = within(section());
    expect(tf.getByText('Two-factor authentication is off.')).toBeVisible();
    // Recovery codes come with the first factor; until then there is nothing to show.
    expect(tf.queryByRole('heading', { level: 3, name: 'Recovery codes' })).toBeNull();

    await user.click(tf.getByRole('button', { name: 'Set up authenticator app' }));
    expect(tf.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
    expect(tf.getByText('MZXW 6YTB OI4T QNRV GQ3D CMZR GQ2D IMZT')).toBeVisible();
    const code = tf.getByLabelText('Code from the app');
    expect(code).toHaveFocus();
    await user.type(code, '492039');
    await user.click(tf.getByRole('button', { name: 'Turn on' }));

    const codes = await tf.findByRole('region', { name: 'Save your recovery codes' });
    expect(within(codes).getByRole('heading', { level: 3 })).toHaveFocus();
    expect(within(codes).getAllByRole('listitem')).toHaveLength(10);
    expect(tf.getByText('Authenticator app set up.')).toHaveAttribute('role', 'status');
    const done = within(codes).getByRole('button', { name: 'Done' });
    expect(done).toBeDisabled();
    await user.click(within(codes).getByRole('checkbox', { name: 'I have saved these codes' }));
    await user.click(done);

    expect(tf.queryByRole('region', { name: 'Save your recovery codes' })).toBeNull();
    expect(await tf.findByText('Two-factor authentication is on.')).toBeVisible();
    expect(tf.getByText('Your authenticator app is set up.')).toBeVisible();
    expect(tf.getByText('10 recovery codes left.')).toBeVisible();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Two-factor authentication' }),
    ).toHaveFocus();
    expect(calls.find((c) => c.path === '/account/two-factor/totp/confirm')?.body).toEqual({
      setupToken: SAMPLE_TOTP_SETUP.setupToken,
      code: '492039',
    });
  });

  it('[IAM-001] keeps the setup open after a wrong code', async () => {
    const { user } = await openAccount(TWO_FACTOR_OFF, () => ({
      'POST /account/two-factor/totp': () => jsonResponse(200, SAMPLE_TOTP_SETUP),
      'POST /account/two-factor/totp/confirm': () => jsonResponse(400, { error: 'invalid_code' }),
    }));
    const tf = within(section());
    await user.click(tf.getByRole('button', { name: 'Set up authenticator app' }));
    await user.type(tf.getByLabelText('Code from the app'), '000000');
    await user.click(tf.getByRole('button', { name: 'Turn on' }));
    expect(await tf.findByRole('alert')).toHaveTextContent('That code is not correct.');
    expect(tf.getByLabelText('Code from the app')).toHaveValue('');
    expect(tf.getByText('Two-factor authentication is off.')).toBeVisible();
  });

  it('[IAM-001] closes a setup that took too long and says to start again', async () => {
    const { user } = await openAccount(TWO_FACTOR_OFF, () => ({
      'POST /account/two-factor/totp': () => jsonResponse(200, SAMPLE_TOTP_SETUP),
      'POST /account/two-factor/totp/confirm': () => jsonResponse(400, { error: 'setup_expired' }),
    }));
    const tf = within(section());
    await user.click(tf.getByRole('button', { name: 'Set up authenticator app' }));
    await user.type(tf.getByLabelText('Code from the app'), '492039');
    await user.click(tf.getByRole('button', { name: 'Turn on' }));
    expect(await tf.findByRole('alert')).toHaveTextContent(
      'The setup took longer than 10 minutes. Start it again.',
    );
    expect(tf.queryByLabelText('Code from the app')).toBeNull();
    expect(tf.getByRole('button', { name: 'Set up authenticator app' })).toBeVisible();
  });

  it('[IAM-001] registers a security key with a name', async () => {
    vi.mocked(startRegistration).mockResolvedValue(REGISTRATION_RESPONSE as never);
    const { user, calls } = await openAccount(twoFactorOn(), (state) => ({
      'POST /account/two-factor/webauthn/options': () =>
        jsonResponse(200, { options: REGISTRATION_OPTIONS, registrationToken: 'sealed' }),
      'POST /account/two-factor/webauthn': (body) => {
        const { name } = body as { name: string };
        const key = { id: 30, name, createdAt: new Date().toISOString(), lastUsedAt: null };
        state.factors = {
          ...state.factors,
          securityKeys: [...state.factors.securityKeys, key],
        };
        return jsonResponse(201, { securityKey: key, recoveryCodes: null });
      },
    }));
    const tf = within(section());
    await user.click(tf.getByRole('button', { name: 'Add a security key' }));
    const name = tf.getByLabelText('Name of the key');
    expect(name).toHaveValue('Security key');
    expect(name).toHaveFocus();
    await user.clear(name);
    await user.type(name, 'Green key');
    await user.click(tf.getByRole('button', { name: 'Register key' }));

    expect(await tf.findByText('Security key Green key added.')).toHaveAttribute('role', 'status');
    await waitFor(() => expect(tf.getAllByRole('listitem')).toHaveLength(3));
    expect(startRegistration).toHaveBeenCalledWith({ optionsJSON: REGISTRATION_OPTIONS });
    expect(calls.find((c) => c.path === '/account/two-factor/webauthn')?.body).toEqual({
      registrationToken: 'sealed',
      name: 'Green key',
      response: REGISTRATION_RESPONSE,
    });
    // A second factor brings no new recovery codes.
    expect(tf.queryByRole('region', { name: 'Save your recovery codes' })).toBeNull();
    const keys = tf.getAllByRole('listitem');
    expect(keys.map((li) => li.querySelector('.session-device')?.textContent)).toEqual([
      'Blue key',
      'Work laptop',
      'Green key',
    ]);
    expect(keys[2]).toHaveTextContent('Not used yet');
  });

  it.each([
    ['NotAllowedError', 'The security key did not answer, or the request was cancelled.'],
    ['InvalidStateError', 'This security key is already registered for you.'],
  ])('[IAM-001] explains a key the browser refused (%s)', async (errorName, message) => {
    vi.mocked(startRegistration).mockRejectedValue(
      Object.assign(new Error('refused'), { name: errorName }),
    );
    const { user, calls } = await openAccount(twoFactorOn(), () => ({
      'POST /account/two-factor/webauthn/options': () =>
        jsonResponse(200, { options: REGISTRATION_OPTIONS, registrationToken: 'sealed' }),
    }));
    const tf = within(section());
    await user.click(tf.getByRole('button', { name: 'Add a security key' }));
    await user.click(tf.getByRole('button', { name: 'Register key' }));
    expect(await tf.findByRole('alert')).toHaveTextContent(message);
    expect(calls.some((c) => c.path === '/account/two-factor/webauthn')).toBe(false);
  });

  it('[IAM-001] removes a key after asking for the password', async () => {
    const { user, calls } = await openAccount(twoFactorOn(), (state) => ({
      'POST /account/two-factor/webauthn/21/remove': (body) => {
        if ((body as { password: string }).password !== 'the current passphrase') {
          return jsonResponse(403, { error: 'wrong_password' });
        }
        state.factors = {
          ...state.factors,
          securityKeys: state.factors.securityKeys.filter((k) => k.id !== 21),
        };
        return noContent();
      },
    }));
    const tf = within(section());
    await user.click(tf.getByRole('button', { name: 'Remove Blue key' }));
    const confirm = tf.getByRole('form', { name: 'Remove Blue key' });
    const password = within(confirm).getByLabelText('Current password');
    expect(password).toHaveFocus();
    expect(password).toHaveAttribute('autocomplete', 'current-password');

    await user.type(password, 'not my password');
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));
    const alert = await within(confirm).findByRole('alert');
    expect(alert).toHaveTextContent('The current password is not correct.');
    expect(password).toHaveAttribute('aria-invalid', 'true');
    expect(password).toHaveValue('');

    await user.type(password, 'the current passphrase');
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));
    expect(await tf.findByText('Removed Blue key.')).toHaveAttribute('role', 'status');
    await waitFor(() => expect(tf.getAllByRole('listitem')).toHaveLength(1));
    expect(tf.queryByText('Blue key')).toBeNull();
    expect(
      calls.filter((c) => c.path === '/account/two-factor/webauthn/21/remove').map((c) => c.body),
    ).toEqual([{ password: 'not my password' }, { password: 'the current passphrase' }]);
  });

  it('[IAM-001] keeps the last factor when the policy requires one, and says why', async () => {
    await openAccount({
      totp: false,
      securityKeys: [twoFactorOn().securityKeys[0] as TwoFactorStatus['securityKeys'][number]],
      recoveryRemaining: 10,
      required: true,
    });
    const tf = within(section());
    const note = tf.getByText(/Your administrator requires two-factor authentication/);
    const remove = tf.getByRole('button', { name: 'Remove Blue key' });
    expect(remove).toBeDisabled();
    expect(remove.getAttribute('aria-describedby')).toBe(note.id);
    // Adding a factor is always possible.
    expect(tf.getByRole('button', { name: 'Set up authenticator app' })).toBeEnabled();
    expect(tf.getByRole('button', { name: 'Add a security key' })).toBeEnabled();
  });

  it('[IAM-001] lets a covered person remove a factor while another one remains', async () => {
    await openAccount({ ...twoFactorOn(), required: true });
    const tf = within(section());
    expect(tf.getByRole('button', { name: 'Switch off the app' })).toBeEnabled();
    expect(tf.getByRole('button', { name: 'Remove Blue key' })).toBeEnabled();
  });

  it('[IAM-001] reports the policy when the backend refuses the last factor', async () => {
    const { user } = await openAccount(
      { totp: true, securityKeys: [], recoveryRemaining: 10, required: false },
      () => ({
        'POST /account/two-factor/totp/disable': () =>
          jsonResponse(409, { error: 'two_factor_required' }),
      }),
    );
    const tf = within(section());
    await user.click(tf.getByRole('button', { name: 'Switch off the app' }));
    await user.type(tf.getByLabelText('Current password'), 'the current passphrase');
    await user.click(
      within(tf.getByRole('form', { name: 'Switch off the app' })).getByRole('button', {
        name: 'Switch off the app',
      }),
    );
    expect(await tf.findByRole('alert')).toHaveTextContent(
      'Your administrator requires two-factor authentication, so your last method cannot be removed.',
    );
  });

  it('[IAM-001] switches the app off after asking for the password', async () => {
    const { user, calls } = await openAccount(
      { totp: true, securityKeys: [], recoveryRemaining: 7, required: false },
      (state) => ({
        'POST /account/two-factor/totp/disable': () => {
          state.factors = TWO_FACTOR_OFF;
          return noContent();
        },
      }),
    );
    const tf = within(section());
    expect(tf.getByText('7 recovery codes left.')).toBeVisible();
    await user.click(tf.getByRole('button', { name: 'Switch off the app' }));
    const confirm = tf.getByRole('form', { name: 'Switch off the app' });
    await user.type(within(confirm).getByLabelText('Current password'), 'the current passphrase');
    await user.click(within(confirm).getByRole('button', { name: 'Switch off the app' }));
    expect(await tf.findByText('Authenticator app switched off.')).toBeVisible();
    expect(await tf.findByText('Two-factor authentication is off.')).toBeVisible();
    expect(tf.queryByRole('heading', { level: 3, name: 'Recovery codes' })).toBeNull();
    expect(calls.find((c) => c.path === '/account/two-factor/totp/disable')?.body).toEqual({
      password: 'the current passphrase',
    });
  });

  it('[IAM-001] generates new recovery codes after asking for the password', async () => {
    const { user } = await openAccount(twoFactorOn(), (state) => ({
      'POST /account/two-factor/recovery-codes': () => {
        state.factors = { ...state.factors, recoveryRemaining: 10 };
        return jsonResponse(201, { recoveryCodes: SAMPLE_RECOVERY_CODES });
      },
    }));
    const tf = within(section());
    expect(tf.getByText('8 recovery codes left.')).toBeVisible();
    await user.click(tf.getByRole('button', { name: 'Generate new codes' }));
    const confirm = tf.getByRole('form', { name: 'Generate new codes' });
    await user.type(within(confirm).getByLabelText('Current password'), 'the current passphrase');
    await user.click(within(confirm).getByRole('button', { name: 'Generate new codes' }));
    const codes = await tf.findByRole('region', { name: 'Save your recovery codes' });
    expect(within(codes).getByText('KD7QX-M2PLA')).toBeVisible();
    await user.click(within(codes).getByRole('checkbox', { name: 'I have saved these codes' }));
    await user.click(within(codes).getByRole('button', { name: 'Done' }));
    expect(await tf.findByText('10 recovery codes left.')).toBeVisible();
  });

  it('[IAM-001] cancels a confirmation without calling the backend', async () => {
    const { user, calls } = await openAccount(twoFactorOn());
    const tf = within(section());
    await user.click(tf.getByRole('button', { name: 'Generate new codes' }));
    await user.click(tf.getByRole('button', { name: 'Cancel' }));
    expect(tf.queryByLabelText('Current password')).toBeNull();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Two-factor authentication' }),
    ).toHaveFocus();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('[IAM-001] reports settings that could not be read', async () => {
    stubBackend({
      'GET /sessions': () => jsonResponse(200, { sessions: sampleSessions() }),
      'GET /account/two-factor': () => jsonResponse(500, { error: 'boom' }),
    });
    window.location.hash = '#/account';
    render(<App session={SIGNED_IN} />);
    expect(await within(section()).findByRole('alert')).toHaveTextContent(
      'Your two-factor settings could not be read. Try again in a moment.',
    );
  });

  it('[IAM-001] works on a phone-sized screen', async () => {
    setViewportWidth(375);
    const { user } = await openAccount(twoFactorOn());
    const tf = within(section());
    for (const name of [
      'Switch off the app',
      'Remove Blue key',
      'Remove Work laptop',
      'Add a security key',
      'Generate new codes',
    ]) {
      expect(tf.getByRole('button', { name })).toBeVisible();
    }
    await user.click(tf.getByRole('button', { name: 'Remove Work laptop' }));
    expect(tf.getByRole('button', { name: 'Show current password' })).toBeVisible();
  });

  it('passes every string through the pseudo-locale', async () => {
    const user = userEvent.setup();
    const errors: Error[] = [];
    const client = fakeAccountClient({}, { twoFactor: { ...twoFactorOn(), required: true } });
    const { container } = render(
      <I18nProvider locale="en-XA" onError={(e) => errors.push(e)}>
        <SessionProvider session={SIGNED_IN}>
          <TwoFactorSection client={client} email="kalo@example.com" timeZone={null} />
        </SessionProvider>
      </I18nProvider>,
    );
    const texts: string[] = [];
    const [firstKey] = await screen.findAllByRole('listitem');
    texts.push(...visibleTexts(container));
    // The password confirmation and the key form have their own strings.
    await user.click(within(firstKey as HTMLElement).getByRole('button'));
    texts.push(...visibleTexts(container));
    await user.click(
      screen.getByRole('button', { name: pseudoLocalize(messagesEn['account.twoFactor.addKey']) }),
    );
    texts.push(...visibleTexts(container));
    expect(texts.length).toBeGreaterThan(25);
    expect(untranslated(texts)).toEqual([]);
    expect(errors).toEqual([]);
  });
});
