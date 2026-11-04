import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
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

/**
 * A drag with pointer events, as a mouse or a finger makes it (T-162b): down on `from` (an
 * entry's link or its grip), over the page, then up there unless the test lets go itself. What
 * the page finds under the pointer is `over`.
 */
function pointerDrag(
  from: Element,
  over: Element | null,
  options: { pointerType?: 'mouse' | 'touch'; up?: boolean } = {},
) {
  const { pointerType = 'mouse', up = true } = options;
  const under = vi.spyOn(document, 'elementFromPoint').mockReturnValue(over);
  const point = { pointerId: 8, pointerType, isPrimary: true };
  fireEvent.pointerDown(from, { ...point, button: 0, clientX: 10, clientY: 200 });
  fireEvent.pointerMove(window, { ...point, clientX: 40, clientY: 300 });
  fireEvent.pointerMove(window, { ...point, clientX: 80, clientY: 300 });
  const letGo = () => {
    fireEvent.pointerUp(window, { ...point, clientX: 80, clientY: 300 });
    under.mockRestore();
  };
  if (up) letGo();
  return letGo;
}

describe('a track’s calendar (M1-049)', () => {
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
    // A mouse drags the entry itself, from anywhere on it (T-162b).
    pointerDrag(chip, day(/^Nov 13, 2026/));
    await waitFor(() =>
      expect(ticketOf(client, 'CAL-1')).toMatchObject({ start: '2026-11-07', due: '2026-11-13' }),
    );
    expect(screen.getByRole('status')).toHaveTextContent('CAL-1 is now due on Nov 13, 2026.');
  });

  it('[AGL-017] [NFR-005] says what is in hand, outlines the day, and Escape cancels', async () => {
    const client = renderCalendar();
    const chip = await screen.findByRole('link', { name: 'CAL-2 Press kit, due this day' });
    const target = day(/^Nov 16, 2026/);
    const letGo = pointerDrag(chip, within(target).getByText('16'), { up: false });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Moving CAL-2: drop it on another day. Escape cancels.',
    );
    expect(target).toHaveClass('is-drop-target');
    expect(chip.closest('.calendar-entry')).toHaveClass('is-dragging');
    expect(document.querySelector('.drag-ghost')).toHaveTextContent('CAL-2 Press kit');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    letGo();
    expect(screen.getByRole('status')).toHaveTextContent('CAL-2 stays where it was.');
    expect(target).not.toHaveClass('is-drop-target');
    expect(document.querySelector('.drag-ghost')).toBeNull();
    expect(ticketOf(client, 'CAL-2')?.due).toBe('2026-11-12');
    // Let go on its own day, or on no day at all: it stays too, and nothing is asked.
    pointerDrag(chip, day(/^Nov 12, 2026/));
    expect(screen.getByRole('status')).toHaveTextContent('CAL-2 stays where it was.');
    pointerDrag(chip, null);
    expect(ticketOf(client, 'CAL-2')?.due).toBe('2026-11-12');
  });

  it('[AGL-017] a finger drags an entry by its grip, not by its link; a tap opens its menu', async () => {
    // On a phone, where a finger is the pointer and the days stack.
    setViewportWidth(375);
    const user = userEvent.setup();
    const client = renderCalendar();
    const chip = await screen.findByRole('link', { name: 'CAL-2 Press kit, due this day' });
    // A finger on the link scrolls the page: nothing moves.
    pointerDrag(chip, day(/^Nov 14, 2026/), { pointerType: 'touch' });
    expect(ticketOf(client, 'CAL-2')?.due).toBe('2026-11-12');
    // By its grip, it drags.
    const grip = screen.getByRole('button', { name: 'Move the due day of CAL-2' });
    pointerDrag(grip, day(/^Nov 14, 2026/), { pointerType: 'touch' });
    await waitFor(() => expect(ticketOf(client, 'CAL-2')?.due).toBe('2026-11-14'));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'CAL-2 is now due on Nov 14, 2026.',
    );
    // A tap is the grip's own: a menu of the moves the keys make, one at a time.
    await user.click(screen.getByRole('button', { name: 'Move the due day of CAL-2' }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'One day earlier',
      'One day later',
      'One week earlier',
      'One week later',
    ]);
    await user.click(screen.getByRole('menuitem', { name: 'One week later' }));
    await waitFor(() => expect(ticketOf(client, 'CAL-2')?.due).toBe('2026-11-21'));
    // The keyboard stays with the entry on its new day.
    await waitFor(() =>
      expect(
        within(day(/^Nov 21, 2026/)).getByRole('button', { name: 'Move the due day of CAL-2' }),
      ).toHaveFocus(),
    );
    // A start entry has its own grip, which moves the start.
    expect(screen.getByRole('button', { name: 'Move the start of CAL-1' })).toBeVisible();
  });

  it('[AGL-017] moves a focused ticket with Alt and the arrows, the keyboard staying with it', async () => {
    const user = userEvent.setup();
    const client = renderCalendar();
    (await screen.findByRole('link', { name: 'CAL-2 Press kit, due this day' })).focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    await waitFor(() => expect(ticketOf(client, 'CAL-2')?.due).toBe('2026-11-19'));
    expect(ticketOf(client, 'CAL-2')?.start).toBeNull();
    await waitFor(() =>
      expect(
        within(day(/^Nov 19, 2026/)).getByRole('link', { name: 'CAL-2 Press kit, due this day' }),
      ).toHaveFocus(),
    );
    // On its grip, Alt and the arrows make the same moves and leave the keyboard on the grip.
    await user.tab();
    const grip = screen.getByRole('button', { name: 'Move the due day of CAL-2' });
    expect(grip).toHaveFocus();
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    await waitFor(() => expect(ticketOf(client, 'CAL-2')?.due).toBe('2026-11-18'));
    await waitFor(() =>
      expect(
        within(day(/^Nov 18, 2026/)).getByRole('button', { name: 'Move the due day of CAL-2' }),
      ).toHaveFocus(),
    );
  });

  it('[AGL-017] an entry is a real link to the ticket, which opens over the page', async () => {
    renderCalendar();
    const chip = await screen.findByRole('link', { name: 'CAL-2 Press kit, due this day' });
    expect(chip).toHaveAttribute('href', '#/tickets/CAL-2');
    // Never the browser's own drag, which would end the pointer's.
    expect(chip).toHaveAttribute('draggable', 'false');
  });

  it('[AGL-017] says a refused move, and turns the months', async () => {
    const user = userEvent.setup();
    renderCalendar(fakeCalendarClient({ refuse: true }));
    (await screen.findByRole('link', { name: 'CAL-2 Press kit, due this day' })).focus();
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'CAL-2 could not be rescheduled: you may not schedule tickets in its track.',
    );
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
