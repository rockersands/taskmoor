import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { BacklogPage } from './BacklogPage';
import { fakeSprintClient } from './fixtures';

const meta = {
  title: 'Sprints/BacklogPage',
  component: BacklogPage,
  args: { boardId: 7, client: fakeSprintClient() },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof BacklogPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The active sprint, a planned one and the backlog, with totals and the move menus. */
export const Backlog: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'Checkout Sprint 1' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Complete sprint' })).toBeVisible();
    await expect(canvas.getByRole('combobox', { name: 'Move CHK-4 to' })).toBeVisible();
  },
};

/** Someone who may not manage sprints sees the sections without the lifecycle buttons. */
export const ReadOnly: Story = {
  args: {
    client: (() => {
      const client = fakeSprintClient();
      return {
        ...client,
        backlog: async () => ({ ...(await client.backlog(7)), mayManage: false }),
      };
    })(),
  },
};
