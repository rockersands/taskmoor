import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { CriticalPathList } from './CriticalPathList';
import { criticalPathFixture } from './criticalFixtures';

/** The fixture plan's critical path: SHOP-2, two days late, then SHOP-3, which ends the plan. */
const meta = {
  title: 'Timeline/CriticalPathList',
  component: CriticalPathList,
  args: { path: criticalPathFixture(), headingId: 'critical-path' },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof CriticalPathList>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The path in words: how many tickets, the plan's end, then each chain in order. */
export const Path: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText('2 tickets are on the critical path. The plan ends Nov 20, 2026.'),
    ).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'SHOP-3 Take payments' })).toBeVisible();
    await expect(canvas.getByText(/the plan’s end\.$/)).toBeVisible();
  },
};

/** Work it does not name stays a count. */
export const WithCounts: Story = {
  args: {
    path: {
      ...criticalPathFixture(),
      more: 12,
      counts: { critical: 14, cycles: 2, undated: 3, waitsElsewhere: 1 },
    },
  },
};

/** No open ticket has dates. */
export const NoPath: Story = {
  args: {
    path: {
      ...criticalPathFixture(),
      planEnd: null,
      chains: [],
      counts: { critical: 0, cycles: 0, undated: 5, waitsElsewhere: 0 },
      listed: [],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(
        'No open ticket of this plan has dates, so there is no critical path.',
      ),
    ).toBeVisible();
  },
};

/** Reading it failed. */
export const Failed: Story = {
  args: { path: null, failed: true },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('alert')).toBeVisible();
  },
};
