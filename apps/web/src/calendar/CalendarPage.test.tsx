import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { setViewportWidth } from '../test/viewport';
import { CalendarPage } from './CalendarPage';
import { fakeCalendarClient } from './fixtures';

function renderCalendar(client = fakeCalendarClient()) {
  render(
    <I18nProvider locale="en">
      <CalendarPage trackKey="CAL" client={client} now={() => new Date('2026-11-06T09:00:00Z')} />
    </I18nProvider>,
  );
  return client;
}
const day = (label: RegExp | string) => screen.getByRole('listitem', { name: label });
const ticketOf = (client: ReturnType<typeof fakeCalendarClient>, key: string) =>
  client.tickets().find((x) => x.key === key);

describe('a track’s calendar (M1-049)', () => {
  // jsdom has no DragEvent: a mouse event stands in.
  beforeAll(() => {
    if (!('DragEvent' in window)) {
      Object.defineProperty(window, 'DragEvent', {
        value: class extends MouseEvent {},
        configurable: true,
      });
    }
  });
  const transfer = () => ({
    setData: () => undefined,
    getData: () => '',
    effectAllowed: 'move',
    dropEffect: 'move',
  });

  it('[AGL-017] shows tickets on their due and start days, with sprints and releases', async () => {
    renderCalendar();
    expect(await screen.findByRole('heading', { name: 'Calendar of Launch' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'November 2026' })).toBeVisible();
    const tenth = within(day(/^Nov 10, 2026, 1 ticket/));
    expect(tenth.getByRole('link', { name: 'CAL-1 Build the site, due this day' })).toBeVisible();
    expect(within(day(/^Nov 9, 2026/)).getByText('Launch Sprint 1')).toBeVisible();
    expect(
      within(day(/^Nov 4, 2026/)).getByRole('link', {
        name: 'CAL-1 Build the site, starts this day',
      }),
    ).toBeVisible();
    expect(within(day(/^Nov 21, 2026/)).getByText('◆ Launch')).toBeVisible();
  });

  it('[AGL-017] moves a ticket dragged to another day: due there, its start along', async () => {
    const client = renderCalendar();
    const chip = await screen.findByRole('link', { name: 'CAL-1 Build the site, due this day' });
    const t = transfer();
    fireEvent.dragStart(chip, { dataTransfer: t });
    const target = day(/^Nov 13, 2026/);
    fireEvent.dragOver(target, { dataTransfer: t });
    fireEvent.drop(target, { dataTransfer: t });
    await waitFor(() =>
      expect(ticketOf(client, 'CAL-1')).toMatchObject({ start: '2026-11-07', due: '2026-11-13' }),
    );
    expect(screen.getByRole('status')).toHaveTextContent('CAL-1 is now due on Nov 13, 2026.');
  });

  it('[AGL-017] moves a focused ticket with Alt and the arrows', async () => {
    const user = userEvent.setup();
    const client = renderCalendar();
    (await screen.findByRole('link', { name: 'CAL-2 Press kit, due this day' })).focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    await waitFor(() => expect(ticketOf(client, 'CAL-2')?.due).toBe('2026-11-19'));
    expect(ticketOf(client, 'CAL-2')?.start).toBeNull();
  });

  it('[AGL-017] an entry is a real link to the ticket, which opens over the page', async () => {
    renderCalendar();
    const chip = await screen.findByRole('link', { name: 'CAL-2 Press kit, due this day' });
    expect(chip).toHaveAttribute('href', '#/tickets/CAL-2');
    expect(chip).toHaveAttribute('draggable', 'true');
  });

  it('[AGL-017] says a refused move, and turns the months', async () => {
    const user = userEvent.setup();
    renderCalendar(fakeCalendarClient({ refuse: true }));
    (await screen.findByRole('link', { name: 'CAL-2 Press kit, due this day' })).focus();
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    expect(await screen.findByRole('alert')).toHaveTextContent('CAL-2 could not be moved');
    await user.click(screen.getByRole('button', { name: 'Next month' }));
    expect(await screen.findByRole('heading', { name: 'December 2026' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'This month' }));
    expect(await screen.findByRole('heading', { name: 'November 2026' })).toBeVisible();
  });

  it('[AGL-017] fits a phone: the days stack, nothing scrolls sideways', async () => {
    setViewportWidth(375);
    renderCalendar();
    await screen.findByRole('heading', { name: 'Calendar of Launch' });
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
  });
});
