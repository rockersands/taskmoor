import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { INFO } from './fixtures';
import { InfoPanel } from './InfoPanel';

const meta = {
  title: 'Tickets/InfoPanel',
  component: InfoPanel,
  args: { ticketId: 41, client: { info: async () => INFO }, revision: 0 },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 360 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof InfoPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Answered, commented on yesterday, in progress twice. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const table = await canvas.findByRole('table', { name: 'Time in status' });
    await expect(within(table).getByRole('rowheader', { name: 'In progress' })).toBeVisible();
    await expect(canvas.getByText('Ada Lovelace and Grace Hopper')).toBeVisible();
  },
};

/** A new ticket: nobody has answered and nothing has moved. */
export const Untouched: Story = {
  args: {
    client: {
      info: async () => ({
        firstResponse: null,
        lastComment: null,
        daysSinceLastComment: null,
        participants: [],
        timeInStatus: [{ status: { id: 1, name: 'To do' }, seconds: 20, visits: 1 }],
      }),
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('No response yet')).toBeVisible();
    await expect(canvas.getByText('No comments')).toBeVisible();
    await expect(canvas.getByText('Under a minute')).toBeVisible();
  },
};
