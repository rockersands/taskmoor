import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { notSized, onARealTouchScreen, tooSmallForAFinger } from '../test/touch';
import { TrackSectionsContext } from '../tracks/trackSections';
import { BacklogPage } from './BacklogPage';
import type { BacklogTicket, SprintClient } from './client';
import { fakeSprintClient } from './fixtures';

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
const POINTER = 43;
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

/** A finger on a ticket's grip moved over the top of `to`, laid out by the browser itself. */
function dragOver(grip: Element, to: Element) {
  const from = grip.getBoundingClientRect();
  const a = { x: from.left + from.width / 2, y: from.top + from.height / 2 };
  const box = to.getBoundingClientRect();
  const b = { x: box.left + box.width / 2, y: box.top + Math.min(box.height / 4, 10) };
  grip.dispatchEvent(pointer('pointerdown', a));
  for (let i = 1; i <= 6; i++) {
    window.dispatchEvent(
      pointer('pointermove', { x: a.x + ((b.x - a.x) * i) / 6, y: a.y + ((b.y - a.y) * i) / 6 }),
    );
  }
  return b;
}

const meta = {
  title: 'Sprints/BacklogPage',
  component: BacklogPage,
  args: { boardId: 7, client: fakeSprintClient() },
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
} satisfies Meta<typeof BacklogPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The active sprint, a planned one and the backlog, with totals and each ticket's grip. */
export const Backlog: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'Checkout Sprint 1' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Complete sprint' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Move CHK-4' })).toBeVisible();
  },
};

/** A ticket's grip pressed: its menu of the moves a drag makes (T-162). */
export const GripMenu: Story = {
  args: { client: fakeSprintClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Move CHK-5' }));
    const menu = within(await canvas.findByRole('menu'));
    await expect(menu.getByRole('menuitem', { name: 'Move to the top' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Move to Checkout Sprint 2' })).toBeVisible();
  },
};

/** Someone who may not manage sprints sees the sections without the lifecycle buttons. */
export const ReadOnly: Story = {
  args: {
    client: (() => {
      const client = fakeSprintClient();
      return {
        ...client,
        backlog: async () => ({ ...(await client.backlog(7)), mayManage: false }),
      };
    })(),
  },
};

/** On a track with its sprints turned off, a planned sprint offers no Start, and the page says why. */
export const SprintsOff: Story = {
  args: { client: fakeSprintClient() },
  decorators: [
    (Story) => (
      <TrackSectionsContext.Provider value={{ backlog: true, sprints: false }}>
        <Story />
      </TrackSectionsContext.Provider>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'Checkout Sprint 2' })).toBeVisible();
    await expect(canvas.getByText(/This track has its sprints turned off/)).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Start sprint' })).toBeNull();
  },
};

/** Planning (M1-047): two tickets selected, with the selection's menus and the panels. */
export const Planning: Story = {
  args: { client: fakeSprintClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('checkbox', { name: 'Select CHK-4' }));
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Select CHK-5' }));
    await expect(await canvas.findByRole('group', { name: 'Selected tickets' })).toBeVisible();
    await expect(
      canvas.getByRole('complementary', { name: 'Outcomes and releases' }),
    ).toBeVisible();
  },
};

/**
 * CHK-4 in hand over the planned sprint (T-162): the sprint and the place are marked, a label
 * follows the finger, and the page says what is in hand and that Escape cancels.
 */
export const Dragging: Story = {
  args: { client: fakeSprintClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const sprint = await canvas.findByRole('region', { name: 'Checkout Sprint 2' });
    const target = within(sprint).getByRole('link', { name: 'CHK-3' }).closest('li') as Element;
    const before = target.getBoundingClientRect().top;
    dragOver(canvas.getByRole('button', { name: 'Move CHK-4' }), target);
    await waitFor(() => expect(target).toHaveClass('is-drop-before'));
    await expect(sprint).toHaveClass('is-drop-target');
    await expect(canvas.getByText(/^Moving CHK-4: drop on a place/)).toHaveClass('visually-hidden');
    // Picking it up moves nothing under the finger.
    await expect(target.getBoundingClientRect().top).toBe(before);
    await expect(document.querySelector('.drag-ghost')).toHaveTextContent('CHK-4');
  },
};

/** Let go there: CHK-4 joins the planned sprint before CHK-3. */
export const Dropped: Story = {
  args: { client: fakeSprintClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const sprint = await canvas.findByRole('region', { name: 'Checkout Sprint 2' });
    const target = within(sprint).getByRole('link', { name: 'CHK-3' }).closest('li') as Element;
    const at = dragOver(canvas.getByRole('button', { name: 'Move CHK-4' }), target);
    window.dispatchEvent(pointer('pointerup', at));
    await waitFor(() =>
      expect(
        within(sprint)
          .getAllByRole('link', { name: /^CHK-/ })
          .map((link) => link.textContent),
      ).toEqual(['CHK-4', 'CHK-3']),
    );
    await expect(canvas.getByRole('status')).toHaveTextContent(
      '1 ticket moved to Checkout Sprint 2.',
    );
  },
};

/** At a phone's width: the panels under the sections, the rows wrapped, no sideways scroll. */
export const AtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'Backlog', level: 2 })).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

/** The backlog's tickets with keys of one to four digits, in every section. */
const keysOfManyLengths = (): SprintClient => {
  const client = fakeSprintClient();
  const keys: Record<number, string> = { 2: 'CHK-23', 3: 'CHK-456', 5: 'CHK-1089' };
  const rekey = (x: BacklogTicket) => ({ ...x, key: keys[x.id] ?? x.key });
  return {
    ...client,
    backlog: async (boardId) => {
      const read = await client.backlog(boardId);
      return {
        ...read,
        sprints: read.sprints.map((s) => ({ ...s, tickets: s.tickets.map(rekey) })),
        backlog: { ...read.backlog, tickets: read.backlog.tickets.map(rekey) },
      };
    },
  };
};

/**
 * The keys are a column (TR-22; AGL-008): every summary on the page starts at one place, in every
 * section, whatever the length of the key before it, as in the sprint report's table.
 */
export const KeysInAColumn: Story = {
  args: { client: keysOfManyLengths() },
  decorators: [
    (Story) => (
      <div style={{ width: 960 }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('link', { name: 'CHK-1089' });
    const summaries = Array.from(canvasElement.querySelectorAll('.sprint-ticket-summary'));
    await expect(summaries).toHaveLength(5);
    const starts = new Set(summaries.map((x) => Math.round(x.getBoundingClientRect().left)));
    await expect([...starts]).toHaveLength(1);
  },
};

/**
 * The selection boxes on a phone (T-221): drawn at 28 px like every other box on touch, the
 * statistics' filter among them, with the label around each the finger's 44 px target.
 */
export const SelectionBoxesOnATouchScreen: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const box = await canvas.findByRole('checkbox', { name: 'Select CHK-1' });
    await expect(
      notSized(canvasElement, '.sprint-ticket-select input, .sprint-select-all input', 28),
    ).toEqual([]);
    await expect(
      tooSmallForAFinger(canvasElement, ['.sprint-ticket-select', '.sprint-select-all']),
    ).toEqual([]);
    // A press on the label, beside the box, chooses the ticket.
    const label = box.closest('label');
    if (!label) throw new Error('the box has a label around it');
    label.scrollIntoView({ block: 'center' });
    const target = label.getBoundingClientRect();
    const corner = document.elementFromPoint(target.left + 3, target.top + 3);
    await expect(corner).toBe(label);
    await userEvent.click(label);
    await expect(box).toBeChecked();
  },
};
