import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fireEvent, userEvent, waitFor, within } from 'storybook/test';
import { gripsTooSmall, onARealTouchScreen, tooSmallForAFinger } from '../../test/touch';
import { ChecklistsPanel } from './ChecklistsPanel';
import { fakeToolsClient, STARTING_CHECKLISTS } from './fixtures';

const meta = {
  title: 'Tickets/ChecklistsPanel',
  component: ChecklistsPanel,
  args: { ticket: { id: 41 }, client: fakeToolsClient(), revision: 0 },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 720 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof ChecklistsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Three done, one open and one rejected: 75%. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('3 of 4 done (75%)')).toBeVisible();
    await expect(canvas.getByRole('checkbox', { name: 'Write the notes' })).toBeChecked();
  },
};

/** Two lists, with the numbers for both together. */
export const Several: Story = {
  args: {
    client: fakeToolsClient({
      checklists: [
        ...STARTING_CHECKLISTS,
        {
          id: 31,
          name: 'Afterwards',
          items: [{ id: 400, text: 'Tidy up', state: 'in_progress' }],
          progress: { done: 0, counted: 1, percent: 0 },
        },
      ],
    }),
  },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText('All checklists')).toBeVisible();
  },
};

/** Someone who may only read: the states are words, and nothing can change. */
export const ReadOnly: Story = {
  args: { client: fakeToolsClient({ canEdit: false }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('checkbox', { name: 'Print it' })).toBeDisabled();
    await expect(canvas.getByText('Rejected')).toBeVisible();
  },
};

/** None yet. */
export const Empty: Story = {
  args: { client: fakeToolsClient({ checklists: [] }) },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText('No checklists yet.')).toBeVisible();
  },
};

/**
 * An item dragged by its grip (TT-5), as a pointer does it: the item fades, a line shows where it
 * would land, and letting go moves it there.
 */
export const DraggingAnItem: Story = {
  args: { client: fakeToolsClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const row = (text: string) =>
      canvas.getByRole('checkbox', { name: text }).closest('li') as HTMLElement;
    await canvas.findByRole('checkbox', { name: 'Write the notes' });
    const grip = row('Write the notes').querySelector('.checklist-grip') as HTMLElement;
    const from = grip.getBoundingClientRect();
    const to = row('Tell the people').getBoundingClientRect();
    const point = { pointerId: 5, pointerType: 'mouse', isPrimary: true, button: 0 };
    const x = from.left + from.width / 2;
    fireEvent.pointerDown(grip, { ...point, clientX: x, clientY: from.top + 4 });
    fireEvent.pointerMove(window, { ...point, clientX: x, clientY: to.bottom - 4 });
    await expect(row('Tell the people')).toHaveAttribute('data-landing', 'after');
    fireEvent.pointerUp(window, { ...point, clientX: x, clientY: to.bottom - 4 });
    await waitFor(() =>
      expect(
        (canvas.getAllByRole('checkbox') as HTMLInputElement[]).map(
          (box) => box.labels?.[0]?.textContent,
        )[3],
      ).toBe('Write the notes'),
    );
  },
};

/**
 * NFR-007, ADR-033: on a real touch screen at a desktop's width, every item's grip is a finger's
 * size (T-290).
 */
export const GripsOnATouchScreen: Story = {
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    await expect(window.innerWidth).toBeGreaterThanOrEqual(768);
    await expect(await gripsTooSmall(canvasElement, ['.checklist-grip'])).toEqual([]);
  },
};

/** Where the left edge of each item's `selector` is, rounded to a pixel. */
const lefts = (root: Element, selector: string) =>
  Array.from(root.querySelectorAll('.checklist-item'), (row) =>
    Math.round(row.querySelector(selector)?.getBoundingClientRect().left ?? -1),
  );

/**
 * At a ticket's width on a desktop the items line up (S3-WK-2): the first has only Move down, the
 * last only Move up, the others both, yet every grip and every state starts at one line, and the
 * names share one width.
 */
export const ItemsInLine: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 600 }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('button', { name: 'Move down Write the notes' });
    for (const selector of ['.checklist-grip', 'select']) {
      const found = lefts(canvasElement, selector);
      await expect(found).toHaveLength(5);
      await expect(new Set(found).size, `${selector}: ${found.join()}`).toBe(1);
    }
    const names = Array.from(canvasElement.querySelectorAll('.checklist-item-text'), (name) =>
      Math.round(name.getBoundingClientRect().width),
    );
    await expect(new Set(names).size, names.join()).toBe(1);
  },
};

/**
 * On a phone an item takes two rows (PL-44): its name, then its grip, its state and More, which
 * holds Edit, the moves and Remove. Every control is a finger's size, and nothing goes sideways.
 */
export const ItemsOnAPhone: Story = {
  parameters: {
    viewport: {
      options: { phone360: { name: 'Phone', styles: { width: '360px', height: '740px' } } },
    },
  },
  globals: { viewport: { value: 'phone360', isRotated: false } },
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('button', { name: 'More options for Write the notes' });
    await expect(window.innerWidth).toBe(360);
    await expect(canvas.queryByRole('button', { name: /^Move / })).toBeNull();
    for (const row of canvasElement.querySelectorAll('.checklist-item')) {
      const name = (row.querySelector('.checklist-item-text') as Element).getBoundingClientRect();
      const tops = ['.checklist-grip', 'select', '.checklist-item-menu button'].map((selector) =>
        Math.round((row.querySelector(selector) as Element).getBoundingClientRect().top),
      );
      // One row of controls, under the name.
      await expect(Math.max(...tops) - Math.min(...tops), tops.join()).toBeLessThanOrEqual(2);
      await expect(Math.min(...tops)).toBeGreaterThanOrEqual(Math.floor(name.bottom));
    }
    await expect(
      tooSmallForAFinger(canvasElement, ['.checklist-item-menu button', '.checklist-item select']),
    ).toEqual([]);
    const page = canvasElement.ownerDocument.documentElement;
    await expect(page.scrollWidth).toBeLessThanOrEqual(page.clientWidth);
    // More holds the rest, the first item's without Move up.
    await userEvent.click(canvas.getByRole('button', { name: 'More options for Write the notes' }));
    const menu = await canvas.findByRole('menu', { name: 'More options for Write the notes' });
    await expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Edit', 'Move down', 'Remove']);
  },
};

/** The same on a phone, with nothing sideways. */
export const GripsOnATouchPhone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    await expect(window.innerWidth).toBeLessThan(768);
    await expect(await gripsTooSmall(canvasElement, ['.checklist-grip'])).toEqual([]);
    const page = canvasElement.ownerDocument.documentElement;
    await expect(page.scrollWidth).toBeLessThanOrEqual(page.clientWidth);
  },
};
