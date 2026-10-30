import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { fakeReleaseClient } from './fixtures';
import { ReleasePage } from './ReleasePage';

const meta = {
  title: 'Releases/ReleasePage',
  component: ReleasePage,
  args: {
    releaseId: 2,
    client: fakeReleaseClient({ approver: true }),
    now: () => new Date('2026-10-30T09:00:00Z'),
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof ReleasePage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** An overdue release: progress by stage, warnings, an approver's choice and shipping. */
export const Upcoming: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'Checkout 2.0' })).toBeVisible();
    await expect(canvas.getByRole('region', { name: 'Warnings' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Approve' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Ship this release…' })).toBeVisible();
  },
};

/** A shipped release with its generated notes. */
export const Shipped: Story = {
  args: { releaseId: 1 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'Feature', level: 3 })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Copy as Markdown' })).toBeVisible();
  },
};

/** Someone who may read the release but neither ship nor approve it. */
export const ReadOnly: Story = {
  args: { client: fakeReleaseClient({ mayManage: false }) },
};
