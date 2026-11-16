import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { type Session, SessionProvider } from '../session/SessionProvider';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import {
  type EmailSettings,
  type EmailSettingsClient,
  EmailSettingsPage,
} from './EmailSettingsPage';
import { ADMIN, CONFIG_ADMIN } from './fixtures';

/** The settings as the server keeps them; `saved` lists what each save sent. */
function fakeEmail(start: Partial<EmailSettings> = {}) {
  let stored: EmailSettings = {
    batchWindowSeconds: 120,
    digestHour: 8,
    smtpConfigured: false,
    ...start,
  };
  const saved: unknown[] = [];
  const client: EmailSettingsClient & { saved: unknown[] } = {
    saved,
    load: async () => ({ ...stored }),
    save: async (change) => {
      saved.push(change);
      stored = { ...stored, ...change };
      return { ...stored };
    },
  };
  return client;
}

function renderPage(
  client: EmailSettingsClient = fakeEmail(),
  session: Session = ADMIN,
  locale: Locale = 'en',
) {
  const { container } = render(
    <I18nProvider locale={locale}>
      <SessionProvider session={session}>
        <main>
          <EmailSettingsPage client={client} />
        </main>
      </SessionProvider>
    </I18nProvider>,
  );
  return container;
}

describe('the email settings page (T-155)', () => {
  it('[NTF-002] says whether mail can go out, and never shows the server or its password', async () => {
    renderPage(fakeEmail({ smtpConfigured: true }));
    const card = await screen.findByRole('region', { name: 'Outgoing mail' });
    expect(within(card).getByText('Mail server')).toBeVisible();
    expect(within(card).getByText('Set up')).toBeVisible();
    expect(within(card).getByText(/^Taskmoor can send email/)).toBeVisible();
    // Nothing on the page asks for or shows the server's sign-in.
    expect(screen.queryByLabelText(/password|user name|server address/i)).toBeNull();
  });

  it('[NTF-002] says when no server is set up, and that email waits', async () => {
    renderPage();
    const card = await screen.findByRole('region', { name: 'Outgoing mail' });
    expect(within(card).getByText('Not set up')).toBeVisible();
    expect(within(card).getByText(/^Email waits unsent/)).toBeVisible();
  });

  it('[NTF-002] (1) [NTF-004] changes the batch window in minutes and the digest hour', async () => {
    const user = userEvent.setup();
    const client = fakeEmail();
    renderPage(client);
    const form = await screen.findByRole('form', { name: 'When email goes out' });
    const window = within(form).getByRole('spinbutton', {
      name: 'Wait before emailing a ticket’s changes, in minutes',
    });
    expect(window).toHaveValue(2);
    expect(within(form).getByLabelText('Digest hour')).toHaveDisplayValue('08:00');
    await user.clear(window);
    await user.type(window, '5');
    await user.selectOptions(within(form).getByLabelText('Digest hour'), '07:00');
    await user.click(within(form).getByRole('button', { name: 'Save email settings' }));
    expect(await within(form).findByRole('status')).toHaveTextContent(
      'The email settings were saved.',
    );
    expect(client.saved).toEqual([{ batchWindowSeconds: 300, digestHour: 7 }]);
  });

  it('[NTF-002] keeps a window set through the API in seconds, and refuses one out of range', async () => {
    const user = userEvent.setup();
    const client = fakeEmail({ batchWindowSeconds: 90 });
    renderPage(client);
    const form = await screen.findByRole('form', { name: 'When email goes out' });
    const window = within(form).getByRole('spinbutton', {
      name: 'Wait before emailing a ticket’s changes, in minutes',
    });
    expect(window).toHaveValue(1.5);
    await user.click(within(form).getByRole('button', { name: 'Save email settings' }));
    await waitFor(() => expect(client.saved).toEqual([{ batchWindowSeconds: 90, digestHour: 8 }]));
    await user.clear(window);
    await user.type(window, '61');
    await user.click(within(form).getByRole('button', { name: 'Save email settings' }));
    expect(within(form).getByRole('alert')).toHaveTextContent(
      'Give a number of minutes from 0 to 60.',
    );
    expect(client.saved).toHaveLength(1);
  });

  it('[NTF-002] says so when a save fails', async () => {
    const user = userEvent.setup();
    const client = fakeEmail();
    client.save = async () => {
      throw new ApiError(500, { error: 'internal' });
    };
    renderPage(client);
    const form = await screen.findByRole('form', { name: 'When email goes out' });
    await user.click(within(form).getByRole('button', { name: 'Save email settings' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'The email settings could not be saved. Try again in a moment.',
    );
  });

  it('[IAM-009] a configuration administrator is told only that the page is not theirs', async () => {
    const container = renderPage(fakeEmail(), CONFIG_ADMIN);
    expect(
      await screen.findByText('Only site administrators change the email settings.'),
    ).toBeVisible();
    expect(screen.getByRole('heading', { level: 1, name: 'Email' })).toBeVisible();
    expect(container.querySelector('.page-purpose')).toBeNull();
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('[NTF-002] says when the settings cannot be read, under the page’s header', async () => {
    const client = fakeEmail();
    client.load = async () => {
      throw new Error('network');
    };
    renderPage(client);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The email settings could not be read. Try again in a moment.',
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Email' })).toBeVisible();
  });

  it('[NTF-002] fits a small phone', async () => {
    setViewportWidth(375);
    renderPage();
    expect(await screen.findByRole('button', { name: 'Save email settings' })).toBeVisible();
  });

  it('[NFR-006] passes every string through the pseudo-locale', async () => {
    renderPage(fakeEmail(), ADMIN, 'en-XA');
    const main = screen.getByRole('main');
    await within(main).findByRole('form');
    expect(untranslated(visibleTexts(main))).toEqual([]);
  });
});
