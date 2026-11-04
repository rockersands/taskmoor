import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { CalendarPage } from './CalendarPage';
import { fakeCalendarClient } from './fixtures';

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
    dragOver(grip, day);
    await waitFor(() => expect(day).toHaveClass('is-drop-target'));
    await expect(canvas.getByRole('status')).toHaveTextContent(
      'Moving CAL-2: drop it on another day. Escape cancels.',
    );
    await expect(document.querySelector('.drag-ghost')).toHaveTextContent('CAL-2 Press kit');
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
