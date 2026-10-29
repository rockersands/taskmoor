import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { BoardPage } from './BoardPage';
import { CARDS, fakeBoardClient } from './fixtures';

const meta = {
  title: 'Boards/BoardPage',
  component: BoardPage,
  args: { boardId: 7, client: fakeBoardClient() },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof BoardPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Three columns, an Expedite lane above the catch-all; Doing is over its maximum of 2. */
export const Board: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'Checkout team' })).toBeVisible();
    await expect(canvas.getByText('Over the maximum')).toBeVisible();
    await expect(canvas.getByRole('heading', { name: /^Expedite/ })).toBeVisible();
  },
};

/** "Only my tickets" on: cards narrow, counts stay whole. */
export const FilterOn: Story = {
  args: { client: fakeBoardClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Only my tickets' }));
    await expect(await canvas.findByText('2 hidden by board filters')).toBeVisible();
  },
};

/** A move into the last column, where two transitions lead: the board asks which. */
export const ChooseTransition: Story = {
  args: { client: fakeBoardClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Move SHOP-23' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Forward to Review and done' }));
    await expect(
      await canvas.findByRole('dialog', { name: 'Move SHOP-23 to Review and done' }),
    ).toBeVisible();
  },
};

/** Without lanes: one row of columns. */
export const NoLanes: Story = {
  args: {
    client: fakeBoardClient({
      lanes: [{ id: 'all', name: '', catchAll: true }],
      cards: CARDS.map((c) => ({ ...c, laneId: 'all' })),
    }),
  },
};

export const Empty: Story = {
  args: { client: fakeBoardClient({ cards: [] }) },
};
