import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { StatusMenu } from './StatusMenu';

const meta = {
  title: 'Tickets/StatusMenu',
  component: StatusMenu,
  args: {
    status: { id: 2, name: 'Active', stage: 'active' },
    transitions: [
      { id: 1, name: 'New', to: { id: 1, name: 'New', stage: 'new' }, layout: [] },
      { id: 3, name: 'In Review', to: { id: 3, name: 'In Review', stage: 'active' }, layout: [] },
      { id: 4, name: 'Closed', to: { id: 4, name: 'Closed', stage: 'closed' }, layout: [] },
    ],
    onChoose: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ minHeight: 220 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StatusMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The status as one control. */
export const Default: Story = {};

/** Open: where the ticket can go. */
export const Open: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /^Status: Active/ }));
    await expect(canvas.getByRole('menuitem', { name: 'New' })).toHaveFocus();
  },
};

/** A colour with nothing showing: transparent, or an alpha of 0. */
const clear = (colour: string) => colour === 'transparent' || /,\s*0\)$/.test(colour);

/**
 * Opened with a click, no place to go is filled (PL-47; CORE-019): the menu starts with 'Now:
 * Active', and the first item has the focus without the filled look other menus give the current
 * value. A key moves the focus and fills the item it reaches; opened from the keyboard, the first
 * item is filled at once.
 */
export const NothingFilledAfterAClick: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const status = canvas.getByRole('button', { name: /^Status: Active/ });
    await userEvent.click(status);
    await expect(canvas.getByText('Now: Active')).toBeVisible();
    const first = canvas.getByRole('menuitem', { name: 'New' });
    await expect(first).toHaveFocus();
    for (const item of canvas.getAllByRole('menuitem')) {
      const fill = getComputedStyle(item).backgroundColor;
      await expect(clear(fill), `${item.textContent}: ${fill}`).toBe(true);
    }
    await userEvent.keyboard('{ArrowDown}');
    const second = canvas.getByRole('menuitem', { name: 'In Review' });
    await expect(second).toHaveFocus();
    await expect(clear(getComputedStyle(second).backgroundColor)).toBe(false);
    await userEvent.keyboard('{Escape}');
    await expect(status).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    const again = canvas.getByRole('menuitem', { name: 'New' });
    await expect(again).toHaveFocus();
    await expect(clear(getComputedStyle(again).backgroundColor)).toBe(false);
  },
};

/** Nowhere to go: plain text. */
export const NowhereToGo: Story = { args: { transitions: [] } };
