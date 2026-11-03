import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { BoardsPage } from './BoardsPage';
import { fakeBoardClient } from './fixtures';

const meta = {
  title: 'Boards/BoardsPage',
  component: BoardsPage,
  args: { client: fakeBoardClient(), onCreated: () => {} },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof BoardsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The boards a person sees, and the form that makes one from a query. */
export const Boards: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('link', { name: 'Checkout team' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Create board' })).toBeVisible();
    await expect(await canvas.findByRole('option', { name: 'Payments (PAY)' })).toBeInTheDocument();
  },
};

/** The advanced way: any query, with the chosen track already in it. */
export const AdvancedQuery: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('option', { name: 'Payments (PAY)' });
    await userEvent.click(
      canvas.getByRole('button', { name: 'Advanced: choose the tickets with a query' }),
    );
    await expect(canvas.getByRole('textbox', { name: 'Tickets (a query)' })).toHaveFocus();
  },
};
