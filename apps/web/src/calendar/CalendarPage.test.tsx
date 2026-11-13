import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { setViewportWidth } from '../test/viewport';
import { CalendarPage, withoutTrackName } from './CalendarPage';
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
  fireEvent.pointerMove(window, { ...point, buttons: 1, clientX: 40, clientY: 300 });
  fireEvent.pointerMove(window, { ...point, buttons: 1, clientX: 80, clientY: 300 });
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
    expect(await screen.findByRole('heading', { name: 'Calendar', level: 1 })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'November 2026' })).toBeVisible();
    const tenth = within(day(/^Nov 10, 2026, 1 ticket/));
    expect(tenth.getByRole('link', { name: 'CAL-1 Build the site, due this day' })).toBeVisible();
    // Inside the track its sprint is named without the track's name (TR-18).
    expect(within(day(/^Nov 9, 2026/)).getByText('Sprint 1')).toBeVisible();
    expect(screen.queryByText('Launch Sprint 1')).toBeNull();
    expect(
      within(day(/^Nov 4, 2026/)).getByRole('link', {
        name: 'Starts: CAL-1 Build the site',
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
    expect(screen.getByText('Moving CAL-2: drop it on another day. Escape cancels.')).toHaveClass(
      'visually-hidden',
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

  it('[AGL-017] a mouse let go where the page cannot hear it moves nothing, and the next press drags', async () => {
    const client = renderCalendar();
    const chip = await screen.findByRole('link', { name: 'CAL-2 Press kit, due this day' });
    const target = day(/^Nov 16, 2026/);
    const letGo = pointerDrag(chip, target, { up: false });
    expect(chip.closest('.calendar-entry')).toHaveClass('is-dragging');
    // Back on the page with no button held, then an ordinary click on another day.
    fireEvent.pointerMove(window, {
      pointerId: 8,
      pointerType: 'mouse',
      buttons: 0,
      clientX: 80,
      clientY: 300,
    });
    expect(screen.getByRole('status')).toHaveTextContent('CAL-2 stays where it was.');
    expect(target).not.toHaveClass('is-drop-target');
    expect(document.querySelector('.drag-ghost')).toBeNull();
    letGo();
    expect(ticketOf(client, 'CAL-2')?.due).toBe('2026-11-12');
    pointerDrag(chip, target);
    await waitFor(() => expect(ticketOf(client, 'CAL-2')?.due).toBe('2026-11-16'));
  });

  it('[AGL-017] a finger drags an entry by its grip, not by its link; a tap opens its menu', async () => {
    // On a phone, where a finger is the pointer and only the days with something on them show.
    setViewportWidth(375);
    const user = userEvent.setup();
    const client = renderCalendar();
    const chip = await screen.findByRole('link', { name: 'CAL-2 Press kit, due this day' });
    // A finger on the link scrolls the page: nothing moves.
    pointerDrag(chip, day(/^Nov 10, 2026/), { pointerType: 'touch' });
    expect(ticketOf(client, 'CAL-2')?.due).toBe('2026-11-12');
    // By its grip, it drags.
    const grip = screen.getByRole('button', { name: 'Move the due day of CAL-2' });
    pointerDrag(grip, day(/^Nov 10, 2026/), { pointerType: 'touch' });
    await waitFor(() => expect(ticketOf(client, 'CAL-2')?.due).toBe('2026-11-10'));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'CAL-2 is now due on Nov 10, 2026.',
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
    await waitFor(() => expect(ticketOf(client, 'CAL-2')?.due).toBe('2026-11-17'));
    // The keyboard stays with the entry on its new day.
    await waitFor(() =>
      expect(
        within(day(/^Nov 17, 2026/)).getByRole('button', { name: 'Move the due day of CAL-2' }),
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

  it('[AGL-017] on a phone lists only the days with something on them, each with its weekday', async () => {
    setViewportWidth(375);
    renderCalendar();
    await screen.findByRole('heading', { name: 'Calendar', level: 1 });
    const days = within(screen.getByRole('list', { name: 'Days' })).getAllByRole('listitem');
    // The 3rd, 4th, 9th (the sprint begins), 10th, 12th and 21st (the release): no empty days.
    expect(days.map((d) => d.getAttribute('aria-label')?.split(',').slice(0, 2).join(','))).toEqual(
      ['Nov 3, 2026', 'Nov 4, 2026', 'Nov 9, 2026', 'Nov 10, 2026', 'Nov 12, 2026', 'Nov 21, 2026'],
    );
    // Each says its weekday and date, not a bare number (D9).
    expect(days.map((d) => d.querySelector('.calendar-date')?.textContent)).toEqual([
      'Tue, Nov 3',
      'Wed, Nov 4',
      'Mon, Nov 9',
      'Tue, Nov 10',
      'Thu, Nov 12',
      'Sat, Nov 21',
    ]);
    // A desktop keeps the whole month of weeks.
    setViewportWidth(1280);
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Days' })).getAllByRole('listitem').length,
      ).toBeGreaterThan(28),
    );
  });

  it('[AGL-017] on a phone puts the month on its own line, before its buttons', async () => {
    setViewportWidth(375);
    renderCalendar();
    const month = await screen.findByRole('heading', { name: 'November 2026' });
    const previous = screen.getByRole('button', { name: 'Previous month' });
    // The month comes first, so Previous and Next sit together after it.
    expect(month.compareDocumentPosition(previous) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(previous.nextElementSibling).toBe(screen.getByRole('button', { name: 'Next month' }));
  });

  it('[AGL-017] speaks of fingers on a phone and of keys on a desktop', async () => {
    renderCalendar();
    expect(await screen.findByText(/^Drag a ticket to another day/)).toBeVisible();
    act(() => setViewportWidth(375));
    // The phone lists only some days (D9): a drag reaches those, the grip's menu any day.
    expect(
      await screen.findByText(
        'Drag a ticket by its grip to one of the days listed, or tap the grip for a menu that moves it a day or a week at a time, to any day. Its start moves along.',
      ),
    ).toBeVisible();
    expect(screen.queryByText(/Alt and the left or right arrow/)).toBeNull();
  });

  it('[AGL-017] [NFR-005] names a start entry beginning with the words it shows', async () => {
    renderCalendar();
    const start = await screen.findByRole('link', { name: /^Starts: CAL-1/ });
    const shown = (start.textContent ?? '').replace(/\s+/g, ' ').trim();
    // Label in Name (WCAG 2.5.3): the name begins with "Starts:" as the chip does.
    expect(start.getAttribute('aria-label')?.startsWith(shown)).toBe(true);
  });

  it('[AGL-017] keeps no pill to the track summary: the tab bar leads there', async () => {
    renderCalendar();
    await screen.findByRole('heading', { name: 'Calendar', level: 1 });
    expect(screen.getByText('Launch')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Track summary' })).toBeNull();
    expect(screen.getByRole('button', { name: 'What is Calendar for?' })).toBeVisible();
  });

  it('[AGL-017] fits a phone: the days stack, nothing scrolls sideways', async () => {
    setViewportWidth(375);
    renderCalendar();
    await screen.findByRole('heading', { name: 'Calendar', level: 1 });
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
  });
});

describe('sprint names inside a track (TR-18)', () => {
  it('[AGL-017] drops the track’s name in front, and only a whole one', () => {
    expect(withoutTrackName('Mobile apps Sprint 1', 'Mobile apps')).toBe('Sprint 1');
    expect(withoutTrackName('Launch: week 2', 'Launch')).toBe('week 2');
    expect(withoutTrackName('Launchpad 3', 'Launch')).toBe('Launchpad 3');
    expect(withoutTrackName('Launch', 'Launch')).toBe('Launch');
    expect(withoutTrackName('Sprint 4', 'Launch')).toBe('Sprint 4');
  });
});
