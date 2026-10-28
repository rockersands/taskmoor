import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { fakeUnsubscribeClient } from './fixtures';
import { UnsubscribePage } from './UnsubscribePage';

/** The page reads its token from the hash; each story sets one first. */
const meta = {
  title: 'Notifications/UnsubscribePage',
  component: UnsubscribePage,
  args: { client: fakeUnsubscribeClient() },
  decorators: [
    (Story) => {
      window.location.hash = '#/unsubscribe?token=story-token-0123456789';
      return <Story />;
    },
  ],
} satisfies Meta<typeof UnsubscribePage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OneEvent: Story = {};

export const AllEmail: Story = {
  args: {
    client: fakeUnsubscribeClient({}, { event: null, email: 'k…@example.com', used: false }),
  },
};

export const InvalidLink: Story = {
  args: { client: fakeUnsubscribeClient({ inspect: () => Promise.reject(new Error('404')) }) },
};

export const Confirms: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Unsubscribe' }));
    await expect(
      await canvas.findByText('Done: you will no longer get emails about “Ticket updated”.'),
    ).toBeVisible();
  },
};
