import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { fakeReleaseClient } from './fixtures';
import { ReleasesPage } from './ReleasesPage';

const meta = {
  title: 'Releases/ReleasesPage',
  component: ReleasesPage,
  args: { trackKey: 'CHK', client: fakeReleaseClient() },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof ReleasesPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Upcoming, shipped and archived releases, with the form to add one. */
export const Hub: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', { name: 'Releases of Checkout' }),
    ).toBeVisible();
    await expect(canvas.getByText('Overdue')).toBeVisible();
    await expect(canvas.getByRole('form', { name: 'New release' })).toBeVisible();
  },
};

/** Someone who may only read the track's releases. */
export const ReadOnly: Story = {
  args: { client: fakeReleaseClient({ mayManage: false }) },
};
