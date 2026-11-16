import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MEMBER } from '../admin/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import { type Session, SessionProvider } from '../session/SessionProvider';
import { HOLD } from '../shell/pointerDrag';
import { useTimeZone } from '../test/timeZone';
import { setCoarsePointer, setViewportWidth } from '../test/viewport';
import { CalendarPage, withoutTrackName } from './CalendarPage';
import type { CalendarClient, CalendarTicket } from './client';
import { calendarTicket, fakeCalendarClient } from './fixtures';

function renderCalendar(
  client = fakeCalendarClient(),
  now = () => new Date('2026-11-06T09:00:00Z'),
) {
  render(
    <I18nProvider locale="en">
      <CalendarPage trackKey="CAL" client={client} now={now} />
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
 * the page finds under the pointer is `over`. It heads down the page, as a flick that scrolls
 * would, unless it goes `sideways` first; `rest` is how long it stays put before it moves, in
 * milliseconds (T-228).
 */
function pointerDrag(
  from: Element,
  over: Element | null,
  options: {
    pointerType?: 'mouse' | 'pen' | 'touch';
    up?: boolean;
    sideways?: boolean;
    rest?: number;
  } = {},
) {
  const { pointerType = 'mouse', up = true, sideways = false, rest = 0 } = options;
  const under = vi.spyOn(document, 'elementFromPoint').mockReturnValue(over);
  const point = { pointerId: 8, pointerType, isPrimary: true };
  /** A pointer event at a time of the test's choosing (a React event reads 0 as "now"). */
  const fire = (
    kind: 'pointerDown' | 'pointerMove' | 'pointerUp',
    target: Element | Window,
    init: object,
    time: number,
  ) => {
    const event = createEvent[kind](target, init);
    Object.defineProperty(event, 'timeStamp', { value: time });
    fireEvent(target, event);
  };
  const pressed = 1_000;
  const moved = pressed + rest;
  fire('pointerDown', from, { ...point, button: 0, clientX: 10, clientY: 200 }, pressed);
  fire(
    'pointerMove',
    window,
    { ...point, buttons: 1, clientX: 40, clientY: sideways ? 205 : 300 },
    moved,
  );
  fire('pointerMove', window, { ...point, buttons: 1, clientX: 80, clientY: 300 }, moved + 16);
  const letGo = () => {
    fire('pointerUp', window, { ...point, clientX: 80, clientY: 300 }, moved + 32);
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
    setCoarsePointer(true);
    const user = userEvent.setup();
    const client = renderCalendar();
    const chip = await screen.findByRole('link', { name: 'CAL-2 Press kit, due this day' });
    // A finger on the link scrolls the page: nothing moves.
    pointerDrag(chip, day(/^Nov 10, 2026/), { pointerType: 'touch' });
    expect(ticketOf(client, 'CAL-2')?.due).toBe('2026-11-12');
    // By its grip, it drags once the finger has rested on it (T-228).
    const grip = screen.getByRole('button', { name: 'Move the due day of CAL-2' });
    pointerDrag(grip, day(/^Nov 10, 2026/), { pointerType: 'touch', rest: HOLD });
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

  it('[AGL-017] a quick flick up or down from a grip scrolls the page; a finger that moves sideways drags', async () => {
    setViewportWidth(375);
    setCoarsePointer(true);
    const client = renderCalendar();
    const grip = await screen.findByRole('button', { name: 'Move the due day of CAL-2' });
    // A flick down the page that happens to start on the grip: the page's scroll, no drag (T-228).
    const letGo = pointerDrag(grip, day(/^Nov 10, 2026/), { pointerType: 'touch', up: false });
    expect(grip.closest('.calendar-entry')).not.toHaveClass('is-dragging');
    expect(day(/^Nov 10, 2026/)).not.toHaveClass('is-drop-target');
    expect(document.body).not.toHaveClass('is-pointer-dragging');
    letGo();
    expect(ticketOf(client, 'CAL-2')?.due).toBe('2026-11-12');
    // Sideways first, at once: a drag.
    pointerDrag(grip, day(/^Nov 10, 2026/), { pointerType: 'touch', sideways: true });
    await waitFor(() => expect(ticketOf(client, 'CAL-2')?.due).toBe('2026-11-10'));
  });

  it('[NFR-007] where a mouse is the pointer, a finger or a pen on a grip drags straight away', async () => {
    // A laptop with a touch screen or a pen: its grips keep `touch-action: none`, so nothing
    // scrolls under them, and a press straight down the page is a drag at once, as before T-228.
    const client = renderCalendar();
    const grip = await screen.findByRole('button', { name: 'Move the due day of CAL-2' });
    pointerDrag(grip, day(/^Nov 10, 2026/), { pointerType: 'touch' });
    await waitFor(() => expect(ticketOf(client, 'CAL-2')?.due).toBe('2026-11-10'));
    const moved = screen.getByRole('button', { name: 'Move the due day of CAL-2' });
    pointerDrag(moved, day(/^Nov 17, 2026/), { pointerType: 'pen' });
    await waitFor(() => expect(ticketOf(client, 'CAL-2')?.due).toBe('2026-11-17'));
  });

  it('[NFR-007] a pen on a touch screen drags by the grip straight down at once', async () => {
    // An iPad with a pencil: the grips leave scrolling to the page there, and the pen still drags
    // at once in any direction (ADR-114 section 12).
    setCoarsePointer(true);
    const client = renderCalendar();
    const grip = await screen.findByRole('button', { name: 'Move the due day of CAL-2' });
    pointerDrag(grip, day(/^Nov 19, 2026/), { pointerType: 'pen' });
    await waitFor(() => expect(ticketOf(client, 'CAL-2')?.due).toBe('2026-11-19'));
  });

  it('[NFR-007] only under a touch screen’s pointer do the grips leave scrolling to the page', () => {
    // jsdom's style sheets drop `touch-action`, so the rules are read from the text: each rule
    // with the media block it sits in, if any.
    const dir = ['apps/web/src/styles', 'src/styles'].find((d) => existsSync(d)) ?? 'src/styles';
    const text = readFileSync(join(dir, 'views.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules: Array<{ media: string; selector: string; body: string }> = [];
    const open: string[] = [];
    let from = 0;
    for (let at = 0; at < text.length; at += 1) {
      if (text[at] === '{') {
        open.push(text.slice(from, at).trim());
        from = at + 1;
      } else if (text[at] === '}') {
        const selector = open.pop() ?? '';
        if (!selector.startsWith('@')) {
          const media = open.find((head) => head.startsWith('@media')) ?? '';
          rules.push({ media, selector, body: text.slice(from, at) });
        }
        from = at + 1;
      }
    }
    /** The grip's `touch-action` where the media block's condition says so ('' is top level). */
    const touchActions = (media: (condition: string) => boolean) =>
      rules
        .filter((rule) => media(rule.media) && rule.selector === '.calendar-grip .move-grip-handle')
        .flatMap((rule) => /touch-action:\s*([^;]+);/.exec(rule.body)?.[1] ?? []);
    // Under a mouse the grip keeps drag.css's `none`: a pen or a finger there drags at once.
    expect(touchActions((media) => media === '')).toEqual([]);
    expect(touchActions((media) => media.includes('pointer: coarse'))).toEqual(['pan-y']);
  });

  it('[AGL-017] a mouse drags by the grip straight away, in any direction', async () => {
    const client = renderCalendar();
    const grip = await screen.findByRole('button', { name: 'Move the due day of CAL-2' });
    pointerDrag(grip, day(/^Nov 19, 2026/));
    await waitFor(() => expect(ticketOf(client, 'CAL-2')?.due).toBe('2026-11-19'));
  });

  it('[AGL-017] a drag that starts on a grip with its menu open closes the menu', async () => {
    const user = userEvent.setup();
    const client = renderCalendar();
    const grip = await screen.findByRole('button', { name: 'Move the due day of CAL-2' });
    await user.click(grip);
    expect(screen.getByRole('menu')).toBeVisible();
    // Pressed again and dragged: the menu goes once the press is a drag (T-228).
    const letGo = pointerDrag(grip, day(/^Nov 16, 2026/), { up: false });
    expect(grip.closest('.calendar-entry')).toHaveClass('is-dragging');
    expect(screen.queryByRole('menu')).toBeNull();
    letGo();
    await waitFor(() => expect(ticketOf(client, 'CAL-2')?.due).toBe('2026-11-16'));
  });

  it('[AGL-017] Alt and an arrow inside the grip’s menu move its choice, not the ticket', async () => {
    const user = userEvent.setup();
    const client = renderCalendar();
    await user.click(await screen.findByRole('button', { name: 'Move the due day of CAL-2' }));
    expect(screen.getByRole('menuitem', { name: 'One day earlier' })).toHaveFocus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    // The menu's own arrow key, and it stays open; the ticket stays on its day (T-228).
    expect(screen.getByRole('menu')).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'One day later' })).toHaveFocus();
    await act(async () => {});
    expect(ticketOf(client, 'CAL-2')?.due).toBe('2026-11-12');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
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
    // The keyboard stays with the entry where it is.
    expect(
      within(day(/^Nov 12, 2026/)).getByRole('link', { name: 'CAL-2 Press kit, due this day' }),
    ).toHaveFocus();
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
        'Touch and hold a ticket’s grip, then drag it to one of the days listed, or tap the grip for a menu that moves it a day or a week at a time, to any day. Its start moves along.',
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

/**
 * A client that answers as `fakeCalendarClient` does but, after a move, no longer lists the moved
 * ticket: as when the move takes it out of what someone may see.
 */
function losingClient(): CalendarClient & { tickets: () => CalendarTicket[] } {
  const inner = fakeCalendarClient();
  const gone = new Set<string>();
  return {
    ...inner,
    calendar: async (...args) => {
      const data = await inner.calendar(...args);
      return { ...data, tickets: data.tickets.filter((x) => !gone.has(x.key)) };
    },
    move: async (key, days) => {
      gone.add(key);
      return inner.move(key, days);
    },
  };
}

describe('the keyboard stays with a moved entry (T-229)', () => {
  it('[AGL-017] Alt and the down arrow from the last week turn the month, the keyboard on the entry', async () => {
    const user = userEvent.setup();
    const client = renderCalendar(
      fakeCalendarClient({ more: [calendarTicket(20, 'Wrap up', { due: '2026-11-30' })] }),
    );
    (await screen.findByRole('link', { name: 'CAL-20 Wrap up, due this day' })).focus();
    // The 30th is in November's last week; a week later is past the weeks drawn.
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    await waitFor(() => expect(ticketOf(client, 'CAL-20')?.due).toBe('2026-12-07'));
    expect(await screen.findByRole('heading', { name: 'December 2026' })).toBeVisible();
    await waitFor(() =>
      expect(
        within(day(/^Dec 7, 2026/)).getByRole('link', { name: 'CAL-20 Wrap up, due this day' }),
      ).toHaveFocus(),
    );
  });

  it('[AGL-017] [PLN-012] opens a day that holds more than it shows, to reach the moved entry', async () => {
    const user = userEvent.setup();
    const busy = Array.from({ length: 6 }, (_, i) =>
      calendarTicket(10 + i, `Busy ${i + 1}`, { due: '2026-11-19' }),
    );
    const client = renderCalendar(
      fakeCalendarClient({
        more: [...busy, calendarTicket(16, 'Late arrival', { due: '2026-11-12' })],
      }),
    );
    (await screen.findByRole('link', { name: 'CAL-16 Late arrival, due this day' })).focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    await waitFor(() => expect(ticketOf(client, 'CAL-16')?.due).toBe('2026-11-19'));
    // The seventh ticket on the 19th, behind its "more" button until the day opens.
    await waitFor(() =>
      expect(
        within(day(/^Nov 19, 2026/)).getByRole('link', {
          name: 'CAL-16 Late arrival, due this day',
        }),
      ).toHaveFocus(),
    );
    expect(
      within(day(/^Nov 19, 2026/)).getByRole('button', { name: 'Show fewer' }),
    ).toHaveAttribute('aria-expanded', 'true');
  });

  it('[AGL-017] on a phone the grip’s menu moves a ticket into next month, which it turns to', async () => {
    setViewportWidth(375);
    const user = userEvent.setup();
    const client = renderCalendar(
      fakeCalendarClient({ more: [calendarTicket(20, 'Wrap up', { due: '2026-11-26' })] }),
    );
    await user.click(await screen.findByRole('button', { name: 'Move the due day of CAL-20' }));
    await user.click(screen.getByRole('menuitem', { name: 'One week later' }));
    await waitFor(() => expect(ticketOf(client, 'CAL-20')?.due).toBe('2026-12-03'));
    // A phone lists only this month's days: the 3rd of December is in the next one.
    expect(await screen.findByRole('heading', { name: 'December 2026' })).toBeVisible();
    await waitFor(() =>
      expect(
        within(day(/^Dec 3, 2026/)).getByRole('button', { name: 'Move the due day of CAL-20' }),
      ).toHaveFocus(),
    );
  });

  it('[AGL-017] a moved ticket no longer drawn leaves the keyboard on its day', async () => {
    const user = userEvent.setup();
    const client = renderCalendar(losingClient());
    (await screen.findByRole('link', { name: 'CAL-2 Press kit, due this day' })).focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    await waitFor(() => expect(ticketOf(client, 'CAL-2')?.due).toBe('2026-11-19'));
    await waitFor(() => expect(day(/^Nov 19, 2026/)).toHaveFocus());
    expect(screen.queryByRole('link', { name: /^CAL-2 / })).toBeNull();
  });

  it('[AGL-017] on a phone, with its day not listed either, on the line that says what happened', async () => {
    setViewportWidth(375);
    const user = userEvent.setup();
    renderCalendar(losingClient());
    await user.click(await screen.findByRole('button', { name: 'Move the due day of CAL-2' }));
    await user.click(screen.getByRole('menuitem', { name: 'One week later' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('CAL-2 is now due on Nov 19, 2026.'),
    );
    await waitFor(() => expect(screen.getByRole('status')).toHaveFocus());
  });
});

/**
 * Due dates are calendar days, and this month and today are the person's own: at 8 pm on the
 * last day of November in Mexico City (UTC−6) it is already December in UTC.
 */
describe('this month on the person’s own clock (AGL-017)', () => {
  useTimeZone('America/Mexico_City');
  const evening = () => new Date('2026-12-01T02:00:00Z');

  it('[AGL-017] opens on the local month and marks the local today in the evening', async () => {
    renderCalendar(fakeCalendarClient(), evening);
    expect(await screen.findByRole('heading', { name: 'November 2026' })).toBeVisible();
    expect(day(/^Nov 30, 2026/)).toHaveClass('is-today');
    expect(day(/^Dec 1, 2026/)).not.toHaveClass('is-today');
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    expect(screen.getByRole('heading', { name: 'December 2026' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'This month' }));
    expect(screen.getByRole('heading', { name: 'November 2026' })).toBeVisible();
  });

  it('[AGL-017] opens on the month and today of the zone saved on the account, not the device’s (T-280)', async () => {
    // The account says Tokyo, where 02:00 on 1 December in UTC is 11:00 that day.
    const member = (MEMBER as Extract<Session, { status: 'signed-in' }>).user;
    render(
      <I18nProvider locale="en">
        <SessionProvider
          session={{ status: 'signed-in', user: { ...member, timeZone: 'Asia/Tokyo' } }}
        >
          <CalendarPage trackKey="CAL" client={fakeCalendarClient()} now={evening} />
        </SessionProvider>
      </I18nProvider>,
    );
    expect(await screen.findByRole('heading', { name: 'December 2026' })).toBeVisible();
    expect(day(/^Dec 1, 2026/)).toHaveClass('is-today');
  });

  it('[AGL-017] saves a ticket dragged in the evening on the day it was dropped on', async () => {
    const client = renderCalendar(fakeCalendarClient(), evening);
    const chip = await screen.findByRole('link', { name: 'CAL-1 Build the site, due this day' });
    pointerDrag(chip, day(/^Nov 13, 2026/));
    await waitFor(() =>
      expect(ticketOf(client, 'CAL-1')).toMatchObject({ start: '2026-11-07', due: '2026-11-13' }),
    );
    expect(screen.getByRole('status')).toHaveTextContent('CAL-1 is now due on Nov 13, 2026.');
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
