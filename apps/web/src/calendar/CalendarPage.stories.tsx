import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { asOnATouchScreen, onARealTouchScreen } from '../test/touch';
import { CalendarPage } from './CalendarPage';
import { fakeCalendarClient } from './fixtures';

/** The width of a small phone; nothing inside may stick out sideways. */
const atPhoneWidth = (Story: () => ReactElement) => (
  <div data-testid="phone-width" style={{ width: 360 }}>
    <Story />
  </div>
);
const fitsPhoneWidth = async (canvas: ReturnType<typeof within>) => {
  const box = canvas.getByTestId('phone-width');
  await expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
};

/** The pointer this file's drags use: one no other test's clicks share. */
const POINTER = 48;
const pointer = (type: string, at: { x: number; y: number }) =>
  new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId: POINTER,
    pointerType: 'touch',
    isPrimary: true,
    clientX: at.x,
    clientY: at.y,
  });

/**
 * A finger on an entry's grip (T-162b) moved over the middle of the day `to`, laid out by the
 * browser itself: `to` is first brought into view, and the press is on the grip wherever it is.
 */
function dragOver(grip: Element, to: Element) {
  const from = grip.getBoundingClientRect();
  const a = { x: from.left + from.width / 2, y: from.top + from.height / 2 };
  grip.dispatchEvent(pointer('pointerdown', a));
  to.scrollIntoView({ block: 'center' });
  const box = to.getBoundingClientRect();
  const b = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  for (let i = 1; i <= 6; i++) {
    window.dispatchEvent(
      pointer('pointermove', { x: a.x + ((b.x - a.x) * i) / 6, y: a.y + ((b.y - a.y) * i) / 6 }),
    );
  }
  return b;
}

const meta = {
  title: 'Views/CalendarPage',
  component: CalendarPage,
  args: {
    trackKey: 'CAL',
    client: fakeCalendarClient(),
    now: () => new Date('2026-11-06T09:00:00Z'),
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
  // A drag a story leaves under way ends before the next one starts.
  beforeEach: () => () => {
    window.dispatchEvent(pointer('pointercancel', { x: 0, y: 0 }));
  },
} satisfies Meta<typeof CalendarPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** November with due and start days, a sprint, a release and today. */
export const Month: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'November 2026' })).toBeVisible();
    await expect(canvas.getByText('◆ Launch')).toBeVisible();
  },
};

/** An entry's grip pressed (T-162b): a menu of the moves its keys make. */
export const EntryGripMenu: Story = {
  args: { client: fakeCalendarClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Move the due day of CAL-2' }));
    const menu = within(await canvas.findByRole('menu'));
    // The menu fades in: visible once its first frames have been drawn.
    await waitFor(() =>
      expect(menu.getByRole('menuitem', { name: 'One day earlier' })).toBeVisible(),
    );
    await expect(menu.getByRole('menuitem', { name: 'One week later' })).toBeVisible();
  },
};

/**
 * CAL-2 in hand by its grip, over the 16th (T-162b): the day is outlined, the entry fades where it
 * was, a label follows the finger, and the page says what is in hand and that Escape cancels.
 */
export const EntryInHand: Story = {
  args: { client: fakeCalendarClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const grip = await canvas.findByRole('button', { name: 'Move the due day of CAL-2' });
    const day = canvas.getByRole('listitem', { name: /^Nov 16, 2026/ });
    // Measured from the month's name above it: near the screen's edge a drag scrolls the page.
    const month = canvas.getByRole('heading', { level: 2 });
    const gap = () => day.getBoundingClientRect().top - month.getBoundingClientRect().top;
    const before = gap();
    dragOver(grip, day);
    await waitFor(() => expect(day).toHaveClass('is-drop-target'));
    await expect(
      canvas.getByText('Moving CAL-2: drop it on another day. Escape cancels.'),
    ).toHaveClass('visually-hidden');
    // Picking it up moves nothing under the finger.
    await expect(gap()).toBe(before);
    await expect(document.querySelector('.drag-ghost')).toHaveTextContent('CAL-2 Press kit');
  },
};

/**
 * On a touch screen with seven narrow days (T-162b): 63 px a day, a portrait tablet with the
 * sidebar open. The grip keeps its full finger size on a row of its own, and the name keeps the
 * day's whole width. A day with room, as a phone's single column, has the grip beside the name.
 */
export const EntryOnATouchTablet: Story = {
  args: { client: fakeCalendarClient() },
  beforeEach: asOnATouchScreen,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const grip = await canvas.findByRole('button', { name: 'Move the due day of CAL-2' });
    const chip = canvas.getByRole('link', { name: 'CAL-2 Press kit, due this day' });
    const grid = canvasElement.querySelector<HTMLElement>('.calendar-grid');
    const entry = chip.parentElement;
    if (!grid || !entry) throw new Error('the calendar draws its grid and the entry');
    const boxes = () => ({
      entry: entry.getBoundingClientRect(),
      chip: chip.getBoundingClientRect(),
      grip: grip.getBoundingClientRect(),
    });

    grid.style.gridTemplateColumns = 'repeat(7, 320px)';
    const roomy = boxes();
    await expect(roomy.grip.width).toBe(44);
    await expect(roomy.grip.left).toBeGreaterThanOrEqual(roomy.chip.right);
    await expect(roomy.grip.top).toBe(roomy.chip.top);

    grid.style.gridTemplateColumns = 'repeat(7, 63px)';
    const narrow = boxes();
    await expect(narrow.chip.width).toBe(narrow.entry.width);
    await expect(narrow.grip.top).toBeGreaterThanOrEqual(narrow.chip.bottom);
    await expect(narrow.grip.width).toBe(44);
    await expect(narrow.grip.height).toBe(44);
    await expect(narrow.grip.right).toBeLessThanOrEqual(narrow.entry.right);
  },
};

/** Let go there: CAL-2 is due on the 16th. */
export const EntryDropped: Story = {
  args: { client: fakeCalendarClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const grip = await canvas.findByRole('button', { name: 'Move the due day of CAL-2' });
    const day = canvas.getByRole('listitem', { name: /^Nov 16, 2026/ });
    window.dispatchEvent(pointer('pointerup', dragOver(grip, day)));
    await waitFor(() =>
      expect(
        within(canvas.getByRole('listitem', { name: /^Nov 16, 2026/ })).getByRole('link', {
          name: 'CAL-2 Press kit, due this day',
        }),
      ).toBeVisible(),
    );
    await expect(canvas.getByRole('status')).toHaveTextContent('CAL-2 is now due on Nov 16, 2026.');
  },
};

/** At a phone's width: the month becomes a list of days on one sheet of glass. */
export const AtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'November 2026' })).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

/**
 * The list of days on a phone's touch screen (D9; M1-049): the card keeps room inside its edge,
 * and each finger-tall chip has its text in the middle of its height, not at the top.
 */
export const DayListOnATouchPhone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const chip = await canvas.findByRole('link', { name: 'CAL-2 Press kit, due this day' });
    const card = canvasElement.querySelector('.calendar-grid.is-agenda')?.getBoundingClientRect();
    if (!card) throw new Error('a phone shows the month as a list of days');
    const box = chip.getBoundingClientRect();
    await expect(box.height).toBeGreaterThanOrEqual(44);
    await expect(box.left - card.left).toBeGreaterThanOrEqual(16);
    for (const heading of canvasElement.querySelectorAll('.calendar-date')) {
      await expect(heading.getBoundingClientRect().left - card.left).toBeGreaterThanOrEqual(16);
    }
    const words = document.createRange();
    words.selectNodeContents(chip);
    const text = words.getBoundingClientRect();
    const middle = (r: DOMRect) => (r.top + r.bottom) / 2;
    await expect(Math.abs(middle(text) - middle(box))).toBeLessThanOrEqual(1);
  },
};

/**
 * Every chip that is not as it should be, as `name: what`: a chip a finger tall on a touch screen
 * (never taller), as tall as its one line of words with a mouse (the grip beside it does not
 * stretch it), and its words in the middle of its height either way. Nothing, on a calendar that
 * keeps its promise; no chips at all is named too.
 */
function chipsOff(root: HTMLElement): string[] {
  const chips = Array.from(root.querySelectorAll<HTMLElement>('.calendar-entry .calendar-chip'));
  if (chips.length === 0) return ['no chips'];
  const touch = matchMedia('(pointer: coarse)').matches;
  return chips.flatMap((chip) => {
    const name = chip.textContent?.trim().slice(0, 24) ?? '';
    const box = chip.getBoundingClientRect();
    const words = document.createRange();
    words.selectNodeContents(chip);
    const text = words.getBoundingClientRect();
    const style = getComputedStyle(chip);
    const frame =
      Number.parseFloat(style.paddingTop) +
      Number.parseFloat(style.paddingBottom) +
      Number.parseFloat(style.borderTopWidth) +
      Number.parseFloat(style.borderBottomWidth);
    const off: string[] = [];
    if (touch && Math.abs(box.height - 44) > 0.5) off.push(`${Math.round(box.height)} px tall`);
    if (!touch && box.height > text.height + frame + 0.5) {
      off.push(`${Math.round(box.height)} px tall for a ${Math.round(text.height)} px line`);
    }
    const by = (text.top + text.bottom) / 2 - (box.top + box.bottom) / 2;
    if (Math.abs(by) > 1) off.push(`words ${Math.round(by)} px from the middle`);
    return off.map((what) => `${name}: ${what}`);
  });
}

/**
 * AGL-017: with a mouse, each chip is as tall as its one line of words, not stretched to its grip,
 * and its words sit in its middle (T-274: Plans' fix, kept by every calendar).
 */
export const ChipsHoldTheirLine: Story = {
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole('link', { name: 'CAL-2 Press kit, due this day' });
    await expect(chipsOff(canvasElement)).toEqual([]);
  },
};

/**
 * AGL-017, ADR-033: the month at a desktop's width on a touch screen. Each chip is a finger tall
 * beside its finger-sized grip, no taller, with its one line of words in its middle, not at its
 * top (T-274).
 */
export const ChipsOnATouchScreen: Story = {
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    await expect(window.innerWidth).toBeGreaterThanOrEqual(768);
    await within(canvasElement).findByRole('link', { name: 'CAL-2 Press kit, due this day' });
    await expect(chipsOff(canvasElement)).toEqual([]);
  },
};

/** AGL-017, ADR-033, D9: the same in a phone's list of days, every chip of it (T-274). */
export const ChipsOnATouchPhone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    await expect(window.innerWidth).toBeLessThan(768);
    await within(canvasElement).findByRole('link', { name: 'CAL-2 Press kit, due this day' });
    await expect(canvasElement.querySelector('.calendar-grid.is-agenda')).not.toBeNull();
    await expect(chipsOff(canvasElement)).toEqual([]);
  },
};

/** A track that is not there, or not for this person: the page still says what it is. */
export const NotFound: Story = {
  args: {
    client: {
      ...fakeCalendarClient(),
      calendar: async () => {
        throw new Error('not found');
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toBeVisible();
    await expect(canvas.getByRole('heading', { name: 'Calendar', level: 1 })).toBeVisible();
  },
};
