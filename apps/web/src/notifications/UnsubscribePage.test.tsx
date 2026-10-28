import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { fakeUnsubscribeClient } from './fixtures';
import { UnsubscribePage } from './UnsubscribePage';

function renderPage(client = fakeUnsubscribeClient()) {
  render(
    <I18nProvider locale="en">
      <UnsubscribePage client={client} />
    </I18nProvider>,
  );
}

describe('unsubscribe page (M1-057)', () => {
  beforeEach(() => {
    window.location.hash = '#/unsubscribe?token=test-token-0123456789';
  });

  it('[NTF-002] names what the link turns off and turns it off only on request', async () => {
    const user = userEvent.setup();
    const confirmed: string[] = [];
    renderPage(fakeUnsubscribeClient({ confirm: async (token) => void confirmed.push(token) }));
    expect(
      await screen.findByText('Stop emails about “Ticket updated” to k…@example.com?'),
    ).toBeVisible();
    expect(confirmed).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Unsubscribe' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Done: you will no longer get emails about “Ticket updated”.',
    );
    expect(confirmed).toEqual(['test-token-0123456789']);
    expect(screen.getByRole('link', { name: 'Notification settings' })).toHaveAttribute(
      'href',
      '#/account/notifications',
    );
  });

  it('[NTF-002] a link for all email says so', async () => {
    renderPage(fakeUnsubscribeClient({}, { event: null, email: 'k…@example.com', used: false }));
    expect(
      await screen.findByText('Stop all notification emails to k…@example.com?'),
    ).toBeVisible();
  });

  it('says when a link is not valid or missing', async () => {
    renderPage(fakeUnsubscribeClient({ inspect: () => Promise.reject(new Error('404')) }));
    expect(await screen.findByText(/This unsubscribe link is not valid/)).toBeVisible();
  });

  it('reports a failed unsubscribe', async () => {
    const user = userEvent.setup();
    renderPage(fakeUnsubscribeClient({ confirm: () => Promise.reject(new Error('down')) }));
    await user.click(await screen.findByRole('button', { name: 'Unsubscribe' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That did not work.');
  });
});
