import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { App } from '../App';
import { SAMPLE_RECOVERY_CODES, SAMPLE_TOTP_SETUP } from '../account/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import { type Handler, stubBackend, untranslated, visibleTexts } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { setViewportWidth } from '../test/viewport';
import { EnrollmentStep } from './EnrollmentStep';
import { SessionProvider } from './SessionProvider';
import type { SecondFactorClient } from './secondFactorClient';

const NIA = {
  id: 4,
  name: 'Nia Okafor',
  email: 'nia@example.com',
  isSiteAdmin: false,
  timeZone: null,
  locale: null,
};
const CHALLENGE = 'enrolment-challenge';

const enrollmentRequired = () =>
  jsonResponse(200, { status: 'enrollment_required', challenge: CHALLENGE });
const setupStarted = () => jsonResponse(200, SAMPLE_TOTP_SETUP);
const enrolled = () =>
  jsonResponse(200, { status: 'signed_in', user: NIA, recoveryCodes: SAMPLE_RECOVERY_CODES });

/** Opens the sign-in page with this backend and gets past the password. */
async function passPassword(handlers: Record<string, Handler>) {
  const user = userEvent.setup();
  const calls = stubBackend({
    'GET /session': () => jsonResponse(401, { error: 'not_signed_in' }),
    'POST /session': enrollmentRequired,
    ...handlers,
  });
  window.location.hash = '#/sign-in';
  render(<App />);
  await user.type(await screen.findByLabelText('Email'), NIA.email);
  await user.type(screen.getByLabelText('Password'), 'a long enough passphrase');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByRole('heading', { level: 2, name: 'Set up two-factor authentication' });
  return { user, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sign-in: enrolment a policy requires', () => {
  it('[IAM-001] makes a person the policy covers set up an app before the session starts', async () => {
    const { user, calls } = await passPassword({
      'POST /session/enroll/totp': setupStarted,
      'POST /session/enroll/totp/confirm': enrolled,
    });
    expect(screen.getByText(/Your administrator requires two-factor authentication/)).toBeVisible();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Set up two-factor authentication' }),
    ).toHaveFocus();
    expect(
      await screen.findByRole('img', { name: 'QR code for your authenticator app' }),
    ).toBeVisible();
    // The same secret as text, in groups of four, for apps that cannot scan.
    expect(screen.getByText('MZXW 6YTB OI4T QNRV GQ3D CMZR GQ2D IMZT')).toBeVisible();
    const code = screen.getByLabelText('Code from the app');
    expect(code).toHaveAttribute('inputmode', 'numeric');
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');

    await user.type(code, '492039');
    await user.click(screen.getByRole('button', { name: 'Verify and continue' }));
    expect(calls.find((c) => c.path === '/session/enroll/totp/confirm')?.body).toEqual({
      challenge: CHALLENGE,
      setupToken: SAMPLE_TOTP_SETUP.setupToken,
      code: '492039',
    });

    // The codes come once; the app opens only after the person says they are saved.
    const codes = await screen.findByRole('region', { name: 'Save your recovery codes' });
    expect(within(codes).getByRole('heading', { level: 2 })).toHaveFocus();
    const list = within(codes).getByRole('list', { name: 'Recovery codes' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(SAMPLE_RECOVERY_CODES);
    const next = within(codes).getByRole('button', { name: 'Continue' });
    expect(next).toBeDisabled();
    await user.click(within(codes).getByRole('checkbox', { name: 'I have saved these codes' }));
    expect(next).toBeEnabled();
    await user.click(next);
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Nia Okafor' })).toBeVisible();
  });

  it('[IAM-001] copies the recovery codes and downloads them as a text file', async () => {
    const { user } = await passPassword({
      'POST /session/enroll/totp': setupStarted,
      'POST /session/enroll/totp/confirm': enrolled,
    });
    await user.type(await screen.findByLabelText('Code from the app'), '492039');
    await user.click(screen.getByRole('button', { name: 'Verify and continue' }));
    const codes = await screen.findByRole('region', { name: 'Save your recovery codes' });

    await user.click(within(codes).getByRole('button', { name: 'Copy all' }));
    expect(within(codes).getByRole('status')).toHaveTextContent('Recovery codes copied.');
    const copied = await navigator.clipboard.readText();
    expect(copied.split('\n')).toEqual([
      'Taskmoor recovery codes for nia@example.com. Each code works once.',
      '',
      ...SAMPLE_RECOVERY_CODES,
      '',
    ]);

    let file: Blob | undefined;
    const { createObjectURL, revokeObjectURL } = URL;
    onTestFinished(() => {
      Object.assign(URL, { createObjectURL, revokeObjectURL });
    });
    Object.assign(URL, {
      createObjectURL: (blob: Blob) => {
        file = blob;
        return 'blob:recovery-codes';
      },
      revokeObjectURL: () => {},
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await user.click(within(codes).getByRole('button', { name: 'Download as a text file' }));
    expect(click).toHaveBeenCalledTimes(1);
    const link = click.mock.contexts[0] as HTMLAnchorElement;
    expect(link.download).toBe('taskmoor-recovery-codes.txt');
    expect(link.href).toBe('blob:recovery-codes');
    // jsdom's Blob has no text(); FileReader reads it.
    const contents = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(file as Blob);
    });
    expect(contents).toBe(copied);
  });

  it('[IAM-001] says when the first code is wrong and keeps the setup', async () => {
    const { user } = await passPassword({
      'POST /session/enroll/totp': setupStarted,
      'POST /session/enroll/totp/confirm': () =>
        jsonResponse(401, { error: 'invalid_second_factor' }),
    });
    const code = await screen.findByLabelText('Code from the app');
    await user.type(code, '000000');
    await user.click(screen.getByRole('button', { name: 'Verify and continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That code is not correct.');
    expect(code).toHaveValue('');
    expect(code).toHaveFocus();
    expect(screen.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
  });

  it('[IAM-001] goes back to the password step when the challenge has expired', async () => {
    const { user } = await passPassword({
      'POST /session/enroll/totp': setupStarted,
      'POST /session/enroll/totp/confirm': () => jsonResponse(401, { error: 'invalid_challenge' }),
    });
    await user.type(await screen.findByLabelText('Code from the app'), '492039');
    await user.click(screen.getByRole('button', { name: 'Verify and continue' }));
    expect(await screen.findByRole('form', { name: 'Sign in' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('Enter your password again.');
    expect(screen.getByLabelText('Email')).toHaveValue(NIA.email);
  });

  it('[IAM-001] offers to try again when the setup cannot start', async () => {
    let attempts = 0;
    const { user } = await passPassword({
      'POST /session/enroll/totp': () => {
        attempts += 1;
        return attempts === 1 ? jsonResponse(500, { error: 'boom' }) : setupStarted();
      },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The setup could not be started. Try again in a moment.',
    );
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('img', { name: 'QR code for your authenticator app' }),
    ).toBeVisible();
  });

  it('[IAM-001] works on a phone-sized screen', async () => {
    setViewportWidth(375);
    await passPassword({ 'POST /session/enroll/totp': setupStarted });
    expect(
      await screen.findByRole('img', { name: 'QR code for your authenticator app' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Verify and continue' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeVisible();
  });

  it('passes every string through the pseudo-locale', async () => {
    const user = userEvent.setup();
    const errors: Error[] = [];
    const client: SecondFactorClient = {
      verify: async () => NIA,
      answerWithSecurityKey: async () => {
        throw new Error('not used');
      },
      startEnrollment: async () => SAMPLE_TOTP_SETUP,
      confirmEnrollment: async () => ({ user: NIA, recoveryCodes: SAMPLE_RECOVERY_CODES }),
    };
    const { container } = render(
      <I18nProvider locale="en-XA" onError={(e) => errors.push(e)}>
        <SessionProvider session={{ status: 'anonymous' }}>
          <EnrollmentStep
            challenge={CHALLENGE}
            email={NIA.email}
            onSignedIn={() => {}}
            onExpired={() => {}}
            onBack={() => {}}
            client={client}
          />
        </SessionProvider>
      </I18nProvider>,
    );
    await user.type(await screen.findByRole('textbox'), '492039');
    const setupTexts = visibleTexts(container);
    await user.keyboard('{Enter}');
    await screen.findByRole('checkbox');
    const texts = [...setupTexts, ...visibleTexts(container)];
    expect(texts.length).toBeGreaterThan(20);
    expect(untranslated(texts)).toEqual([]);
    expect(errors).toEqual([]);
  });
});
