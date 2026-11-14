import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ADMIN, CONFIG_ADMIN } from '../admin/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { type Session, SessionProvider } from '../session/SessionProvider';
import { visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { fakeWebhooksClient } from './fixtures';
import { WebhooksPage } from './WebhooksPage';

function renderPage(
  session: Session = ADMIN,
  locale: Locale = 'en',
  client = fakeWebhooksClient(),
) {
  render(
    <I18nProvider locale={locale}>
      <SessionProvider session={session}>
        <main>
          <WebhooksPage client={client} />
        </main>
      </SessionProvider>
    </I18nProvider>,
  );
  return client;
}

describe('webhooks page (UI-T18)', () => {
  it('[API-009] lists webhooks with where they send, what, and which are off', async () => {
    renderPage();
    const item = (await screen.findByText('Team chat')).closest('li') as HTMLElement;
    expect(within(item).getByText('Off')).toBeVisible();
    expect(within(item).getByText('https://chat.example.com/hooks/abc')).toBeVisible();
    expect(screen.getByText('Only tickets that match: track = PAY')).toBeVisible();
    expect(
      screen.getByText('JSON, signed when a secret is set: ticket.*, comment.created'),
    ).toBeVisible();
  });

  it('[API-009] creates a webhook, and shows what the server refuses by field', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await screen.findByRole('button', { name: 'New webhook' }));
    const form = screen.getByRole('form', { name: 'New webhook' });
    await user.type(within(form).getByLabelText('Name'), 'Payments channel');
    await user.type(within(form).getByLabelText('Address'), 'https://hooks.example.com/new');
    await user.click(within(form).getByLabelText('Releases'));
    await user.type(within(form).getByLabelText(/Other events/), 'board.created');
    await user.click(within(form).getByRole('button', { name: 'Create webhook' }));
    expect(await within(form).findByText('Another webhook already has this name.')).toBeVisible();
    await user.clear(within(form).getByLabelText('Name'));
    await user.type(within(form).getByLabelText('Name'), 'Ops');
    await user.click(within(form).getByRole('button', { name: 'Create webhook' }));
    expect(await screen.findByText('Webhook Ops was created.')).toBeInTheDocument();
    expect(client.calls.at(-1)).toEqual({
      action: 'create',
      args: [
        {
          name: 'Ops',
          url: 'https://hooks.example.com/new',
          format: 'json',
          events: ['ticket.*', 'release.*', 'board.created'],
          filterQuery: null,
          enabled: true,
        },
      ],
    });
  });

  it('[API-009] asks for at least one event', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await screen.findByRole('button', { name: 'New webhook' }));
    const form = screen.getByRole('form', { name: 'New webhook' });
    await user.type(within(form).getByLabelText('Name'), 'Empty');
    await user.type(within(form).getByLabelText('Address'), 'https://hooks.example.com/e');
    await user.click(within(form).getByLabelText('Tickets'));
    await user.click(within(form).getByRole('button', { name: 'Create webhook' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('Choose at least one event');
    expect(client.calls).toEqual([]);
  });

  it('[API-009] changes a webhook, keeps its secret unless told, and sends its version', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Change Payments channel' }));
    const form = screen.getByRole('form', { name: 'Change Payments channel' });
    expect(within(form).getByLabelText(/Other events/)).toHaveValue('comment.created');
    expect(within(form).getByText(/A secret is set/)).toBeVisible();
    await user.click(within(form).getByLabelText('On: send events'));
    await user.click(within(form).getByRole('button', { name: 'Save webhook' }));
    expect(await screen.findByText('Webhook Payments channel was saved.')).toBeInTheDocument();
    expect(client.calls.at(-1)).toMatchObject({
      action: 'update',
      args: [3, 2, { enabled: false }],
    });
    expect(client.calls.at(-1)?.args[2]).not.toHaveProperty('secret');
  });

  it('[API-009] removes a secret when asked', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Change Payments channel' }));
    const form = screen.getByRole('form', { name: 'Change Payments channel' });
    await user.click(within(form).getByLabelText('Remove the secret'));
    await user.click(within(form).getByRole('button', { name: 'Save webhook' }));
    await screen.findByText('Webhook Payments channel was saved.');
    expect(client.calls.at(-1)?.args[2]).toMatchObject({ secret: null });
  });

  it('[API-009] deletes after asking', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    const trigger = await screen.findByRole('button', { name: 'Delete Team chat' });
    expect(trigger).toHaveClass('button-danger-quiet');
    await user.click(trigger);
    // Asks first, saying what will happen (D13); Escape gives the focus back.
    const question = screen.getByRole('group', {
      name: 'Delete Team chat? Its deliveries go with it.',
    });
    expect(within(question).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Delete Team chat' })).toHaveFocus();
    expect(client.calls).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Delete Team chat' }));
    await user.click(
      within(screen.getByRole('group')).getByRole('button', { name: 'Delete Team chat' }),
    );
    expect(await screen.findByText('Webhook Team chat was deleted.')).toBeInTheDocument();
    expect(client.calls).toEqual([{ action: 'remove', args: [4] }]);
    expect(screen.getByRole('heading', { level: 1, name: 'Webhooks' })).toHaveFocus();
  });

  it('[API-009] shows deliveries, filters them, and sends failed ones again', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Deliveries of Payments channel' }));
    const panel = screen.getByRole('region', { name: 'Deliveries of Payments channel' });
    expect(await within(panel).findByText('Service Unavailable')).toBeVisible();
    expect(within(panel).getByText(/6 attempts/)).toBeVisible();
    expect(within(panel).getByText(/Last answer 503/)).toBeVisible();
    await user.click(within(panel).getByRole('button', { name: 'Send ticket.created again' }));
    expect(await within(panel).findByText(/asked to go again/)).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Send all failed ones again' }));
    await user.selectOptions(within(panel).getByLabelText('Show'), 'Delivered');
    expect(await within(panel).findByText('comment.created')).toBeVisible();
    expect(within(panel).queryByText('Service Unavailable')).toBeNull();
    expect(client.calls.filter((c) => c.action === 'replay')).toEqual([
      { action: 'replay', args: [3, ['00000000-0000-4000-8000-000000000001']] },
      { action: 'replay', args: [3, 'failed'] },
    ]);
  });

  it('[API-009] explains an empty list', async () => {
    renderPage(ADMIN, 'en', fakeWebhooksClient([]));
    expect(await screen.findByText('No webhooks yet')).toBeVisible();
  });

  it('[IAM-009] is for site administrators only', () => {
    renderPage(CONFIG_ADMIN);
    expect(screen.getByText(/Only site administrators/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'New webhook' })).toBeNull();
  });

  it('fits a small phone', async () => {
    setViewportWidth(375);
    renderPage();
    expect(await screen.findByText('Team chat')).toBeVisible();
  });

  it('passes every string through the pseudo-locale', async () => {
    renderPage(ADMIN, 'en-XA');
    const main = screen.getByRole('main');
    await within(main).findByText('Team chat');
    const fixed = ['Payments channel', 'Team chat'];
    const plain = visibleTexts(main).filter((t) => /^[A-Za-z ]+$/.test(t) && !fixed.includes(t));
    expect(plain).toEqual([]);
  });
});
