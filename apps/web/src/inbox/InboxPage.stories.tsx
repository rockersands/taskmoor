import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { fakeInboxClient, ITEMS, NOW } from './fixtures';
import { InboxPage } from './InboxPage';

const meta = {
  title: 'Notifications/InboxPage',
  component: InboxPage,
  args: { client: fakeInboxClient(), now: () => NOW },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof InboxPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Mentions and changes, newest first; unread ones stand out. */
export const Inbox: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Ana Ruiz mentioned you in a comment')).toBeVisible();
    await expect(canvas.getByText('3 unread')).toBeVisible();
  },
};

/** Only direct asks: mentions and tickets assigned to the reader. */
export const Priority: Story = {
  args: { client: fakeInboxClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: /^Priority/ }));
    await expect(await canvas.findByText('Mi Rivera assigned it to you')).toBeVisible();
    await expect(canvas.queryByText('Jo Park: Comment added')).toBeNull();
  },
};

/** The snooze choices of one item, open. */
export const Snooze: Story = {
  args: { client: fakeInboxClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Snooze SHOP-19' }));
    await expect(canvas.getByRole('button', { name: 'Until tomorrow' })).toBeVisible();
  },
};

export const Empty: Story = {
  args: { client: fakeInboxClient([]) },
};

/** All read: nothing stands out, and there is nothing to mark. */
export const AllRead: Story = {
  args: { client: fakeInboxClient(ITEMS.map((i) => ({ ...i, read: true }))) },
};
