import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { SIGNED_IN } from '../account/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import { SessionProvider } from '../session/SessionProvider';
import { setViewportWidth } from '../test/viewport';
import type { PreferenceChanges } from './client';
import { fakeNotificationsClient } from './fixtures';
import { NotificationsSection } from './NotificationsSection';

function renderSection(client = fakeNotificationsClient(), locale: 'en' | 'es' = 'en') {
  render(
    <I18nProvider locale={locale}>
      <SessionProvider session={SIGNED_IN}>
        <NotificationsSection client={client} />
      </SessionProvider>
    </I18nProvider>,
  );
  return within(
    screen.getByRole('region', { name: locale === 'es' ? 'Notificaciones' : 'Notifications' }),
  );
}

describe('notification settings (M1-057)', () => {
  it('[NTF-004] uses the app’s own check boxes and radios, not the browser’s (AC-11)', async () => {
    const section = renderSection();
    await section.findByRole('table');
    for (const box of section.getAllByRole('checkbox')) expect(box).toHaveClass('glass-check');
    for (const radio of section.getAllByRole('radio')) {
      expect(radio.closest('label')).toHaveClass('notification-choice');
    }
  });

  it('[NTF-004] on a phone, one block per event with its channels beneath, in Spanish too (D23, AC-1)', async () => {
    setViewportWidth(375);
    const section = renderSection(fakeNotificationsClient(), 'es');
    const events = await section.findByRole('group', { name: 'De qué te enteras, y dónde' });
    expect(section.queryByRole('table')).toBeNull();
    const blocks = within(events).getAllByRole('group');
    // Mentions, shared track groups, checklist changes and the 15 policy events.
    expect(blocks).toHaveLength(18);
    const first = blocks[0] as HTMLElement;
    expect(within(first).getAllByRole('checkbox')).toHaveLength(2);
    for (const box of within(events).getAllByRole('checkbox')) {
      expect(box).toHaveClass('glass-check');
    }
    // Each switch keeps its full name: the channel, then the event.
    expect(within(first).getAllByRole('checkbox')[0]).toHaveAccessibleName(/^Correo electrónico: /);
  });

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
    // The heading row, mentions, track groups shared with you (T-206), checklist changes on
    // tickets you follow (NTF-015) and the 15 policy events.
    expect(within(table).getAllByRole('row')).toHaveLength(19);
    expect(within(table).getByRole('checkbox', { name: 'Inbox: Ticket closed' })).toBeChecked();
    expect(
      within(table).getByRole('checkbox', {
        name: 'Email: A track group is shared with you or set on you',
      }),
    ).toBeChecked();
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

  it('[NTF-015] has a row for checklist changes, chosen per channel like any other event', async () => {
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
    const name = 'A checklist changes on a ticket you follow';
    const inbox = await section.findByRole('checkbox', { name: `Inbox: ${name}` });
    expect(inbox).toBeChecked();
    expect(section.getByRole('checkbox', { name: `Email: ${name}` })).toBeChecked();
    await user.click(inbox);
    expect(await section.findByText('Notification settings saved.')).toBeVisible();
    expect(saved).toEqual([{ events: { checklist_changed: { inbox: false } } }]);
    expect(section.getByRole('checkbox', { name: `Inbox: ${name}` })).not.toBeChecked();
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
