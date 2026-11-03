import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { fakeToolsClient } from './fixtures';
import { SubticketProgressMini } from './Progress';
import { SubticketsPanel } from './SubticketsPanel';

const meta = {
  title: 'Tickets/SubticketsPanel',
  component: SubticketsPanel,
  args: {
    ticket: {
      id: 41,
      key: 'SHOP-41',
      track: { key: 'SHOP' },
      ticketType: { level: { rank: 0 } },
    },
    client: fakeToolsClient(),
    revision: 0,
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 640 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof SubticketsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One closed, one in progress, and the form for another. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('1 of 2 closed (50%)')).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: 'New subticket' })).toBeVisible();
  },
};

/** None yet. */
export const Empty: Story = {
  args: { client: fakeToolsClient({ children: [] }) },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText('None yet.')).toBeVisible();
  },
};

/** An outcome: the tickets one level down, of several types. */
export const UnderAnOutcome: Story = {
  args: {
    ticket: {
      id: 41,
      key: 'SHOP-41',
      track: { key: 'SHOP' },
      ticketType: { level: { rank: 1 } },
    },
    client: fakeToolsClient({
      childTypes: [
        { id: 1, name: 'Feature' },
        { id: 2, name: 'Bug' },
      ],
    }),
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole('region', { name: 'Tickets under this' }),
    ).toBeVisible();
  },
};

/** The small form on a card or a row. */
export const Mini: Story = {
  render: () => <SubticketProgressMini progress={{ total: 8, closed: 3 }} />,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText('3/8')).toBeVisible();
  },
};
