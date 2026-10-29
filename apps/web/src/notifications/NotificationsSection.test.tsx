import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { SIGNED_IN } from '../account/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import { SessionProvider } from '../session/SessionProvider';
import type { PreferenceChanges } from './client';
import { fakeNotificationsClient } from './fixtures';
import { NotificationsSection } from './NotificationsSection';

function renderSection(client = fakeNotificationsClient()) {
  render(
    <I18nProvider locale="en">
      <SessionProvider session={SIGNED_IN}>
        <NotificationsSection client={client} />
      </SessionProvider>
    </I18nProvider>,
  );
  return within(screen.getByRole('region', { name: 'Notifications' }));
}

describe('notification settings (M1-057)', () => {
  it('[NTF-004] shows email delivery, quiet hours, own changes and every event by channel', async () => {
    const section = renderSection();
    expect(await section.findByRole('radio', { name: /At once/ })).toBeChecked();
    expect(section.getByRole('radio', { name: /Daily digest/ })).toHaveAccessibleDescription(
      'One email a day with everything that happened.',
    );
    expect(
      section.getByRole('checkbox', { name: 'Hold email during quiet hours' }),
    ).not.toBeChecked();
    expect(
      section.getByRole('checkbox', { name: 'Tell me about changes I make myself' }),
    ).not.toBeChecked();
    const table = section.getByRole('table', { name: 'What you hear about, and where' });
    expect(within(table).getAllByRole('row')).toHaveLength(17);
    expect(within(table).getByRole('checkbox', { name: 'Inbox: Ticket closed' })).toBeChecked();
  });

  it('[NTF-004] saves each change at once', async () => {
    const user = userEvent.setup();
    const saved: PreferenceChanges[] = [];
    const base = fakeNotificationsClient();
    const section = renderSection({
      ...base,
      update: (changes) => {
        saved.push(changes);
        return base.update(changes);
      },
    });
    await user.click(await section.findByRole('radio', { name: /Weekly digest/ }));
    await user.click(section.getByRole('checkbox', { name: 'Email: Ticket updated' }));
    await user.click(section.getByRole('checkbox', { name: 'Hold email during quiet hours' }));
    await user.selectOptions(await section.findByRole('combobox', { name: 'Until' }), '06:00');
    expect(await section.findByText('Notification settings saved.')).toBeVisible();
    expect(saved).toEqual([
      { emailDelivery: 'weekly' },
      { events: { ticket_updated: { email: false } } },
      { quietHours: { start: 22, end: 7 } },
      { quietHours: { start: 22, end: 6 } },
    ]);
    expect(section.getByRole('checkbox', { name: 'Email: Ticket updated' })).not.toBeChecked();
  });

  it('says when the settings cannot be read', async () => {
    const failing = renderSection(
      fakeNotificationsClient({ preferences: () => Promise.reject(new Error('down')) }),
    );
    expect(await failing.findByRole('alert')).toHaveTextContent(
      'Your notification settings could not be read.',
    );
  });

  it('reports a change that could not be saved and shows the saved choice again', async () => {
    const user = userEvent.setup();
    const section = renderSection(
      fakeNotificationsClient({ update: () => Promise.reject(new Error('down')) }),
    );
    await user.click(await section.findByRole('radio', { name: /No email/ }));
    expect(await section.findByRole('alert')).toHaveTextContent('That change could not be saved.');
    // The choice shown goes back to what is saved.
    expect(section.getByRole('radio', { name: /At once/ })).toBeChecked();
  });
});
