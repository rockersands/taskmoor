import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { ReleaseState } from './ReleaseState';

const meta = {
  title: 'Releases/ReleaseState',
  component: ReleaseState,
  args: { release: { shipped: false, archived: false, overdue: false } },
} satisfies Meta<typeof ReleaseState>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Every state side by side, each a word as well as a tone. */
export const States: Story = {
  render: () => (
    <p style={{ display: 'flex', gap: 12 }}>
      <ReleaseState release={{ shipped: false, archived: false, overdue: false }} />
      <ReleaseState release={{ shipped: false, archived: false, overdue: true }} />
      <ReleaseState release={{ shipped: true, archived: false, overdue: false }} />
      <ReleaseState release={{ shipped: true, archived: true, overdue: false }} />
    </p>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const word of ['Upcoming', 'Overdue', 'Shipped', 'Archived']) {
      await expect(canvas.getByText(word)).toBeVisible();
    }
  },
};
