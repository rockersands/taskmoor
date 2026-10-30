import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { BoardPage } from './BoardPage';
import { CARDS, fakeBoardClient, manyCards } from './fixtures';

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

/** When the board's data arrived, for the render budget below. */
const arrival = { at: 0 };

/**
 * 5,000 cards (M1-046: rendered in under a second from the data's arrival). Timing only: the
 * same board passes axe in the stories above, and axe over 5,000 cards measures axe.
 */
export const FiveThousandCards: Story = {
  args: {
    client: (() => {
      const inner = fakeBoardClient({ cards: manyCards(5000) });
      return {
        ...inner,
        data: async (...args: Parameters<typeof inner.data>) => {
          const data = await inner.data(...args);
          arrival.at = performance.now();
          return data;
        },
      };
    })(),
  },
  parameters: { a11y: { test: 'off' } },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelectorAll('.board-card')).toHaveLength(5000), {
      timeout: 10_000,
      interval: 10,
    });
    const took = performance.now() - arrival.at;
    await expect(took).toBeLessThan(1000);
  },
};
