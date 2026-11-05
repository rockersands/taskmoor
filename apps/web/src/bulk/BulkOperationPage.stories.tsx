import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { BulkOperationPage } from './BulkOperationPage';
import { fakeBulkClient, RUNNING } from './fixtures';

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

/** At a phone's width: the counts wrap and the tickets not changed stay inside. */
export const AtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', { name: 'Bulk edit of 1,200 tickets' }),
    ).toBeVisible();
    await expect(canvas.getByText(/^How a change to many tickets/)).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

/** A bulk change that cannot be found still has its page: a title and what the page is for. */
export const NotFound: Story = {
  args: {
    client: {
      ...fakeBulkClient(),
      get: async () => {
        throw new Error('not found');
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toBeVisible();
    await expect(canvas.getByRole('heading', { level: 1, name: 'Bulk change' })).toBeVisible();
  },
};
