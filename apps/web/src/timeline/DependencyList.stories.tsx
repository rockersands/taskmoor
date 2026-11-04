import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { planItems } from '../plans/fixtures';
import { DependencyList } from './DependencyList';
import { dependenciesOf } from './dependencies';

/** The fixture plan's tickets: SHOP-2 blocks SHOP-3 (late) and OPS-4, OPS-4 blocks OPS-5. */
const items = planItems();
const links = [
  { from: 2, to: 3 },
  { from: 2, to: 4 },
  { from: 4, to: 5 },
];

const meta = {
  title: 'Timeline/DependencyList',
  component: DependencyList,
  args: {
    dependencies: dependenciesOf(items, links, [{ id: 4, outside: 2, unlisted: 1 }]),
    headingId: 'dependencies',
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof DependencyList>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Each blocked ticket with its blockers: late ones in words and in red, the others counted. */
export const Dependencies: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Late:')).toBeVisible();
    await expect(canvas.getByText('2 tickets outside this plan')).toBeVisible();
    await expect(canvas.getByText('1 ticket of this plan not shown here')).toBeVisible();
  },
};

/** Narrowed to the tickets with a late blocker. */
export const OnlyLate: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Only late ones' }));
    await expect(canvas.getByRole('link', { name: 'SHOP-3 Take payments' })).toBeVisible();
    await expect(canvas.queryByRole('link', { name: 'OPS-4 Scale the servers' })).toBeNull();
  },
};

/** Nothing shown is blocked. */
export const NoneBlocked: Story = {
  args: { dependencies: dependenciesOf(items, []) },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText('No ticket shown here is blocked.')).toBeVisible();
  },
};
