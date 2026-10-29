import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { BulkOperationPage } from './BulkOperationPage';
import { fakeBulkClient, RUNNING } from './fixtures';

const meta = {
  title: 'Tickets/BulkOperationPage',
  component: BulkOperationPage,
  args: { id: '7', client: fakeBulkClient(), pollMs: 60_000 },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof BulkOperationPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Part way through, with three tickets that were not changed and why. */
export const Running: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', { name: 'Bulk edit of 1,200 tickets' }),
    ).toBeVisible();
    await expect(canvas.getByLabelText('643 of 1,200 tickets finished')).toBeVisible();
    await expect(
      canvas.getByText('In status Approved, only the Approvers group can edit this ticket.'),
    ).toBeVisible();
  },
};

export const Done: Story = {
  args: {
    client: fakeBulkClient(
      { ...RUNNING, status: 'done', succeeded: 1197, pending: 0 },
      { failures: [] },
    ),
  },
};

export const Cancel: Story = {
  args: { client: fakeBulkClient(RUNNING, { step: 0 }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Cancel the rest' }));
    await expect(await canvas.findByText('Cancelling after the tickets in hand.')).toBeVisible();
  },
};
