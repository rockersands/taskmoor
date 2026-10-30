import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { fakeTrackClient } from './fixtures';
import { TrackSummaryPage } from './TrackSummaryPage';

const meta = {
  title: 'Tracks/TrackSummaryPage',
  component: TrackSummaryPage,
  args: { trackKey: 'SHOP', client: fakeTrackClient() },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof TrackSummaryPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Open, new, closed and due tickets, and the open ones by stage, priority, type and person. */
export const Summary: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('region', { name: 'Open by assignee' })).toBeVisible();
  },
};

export const NotFound: Story = { args: { client: fakeTrackClient(null) } };

export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
