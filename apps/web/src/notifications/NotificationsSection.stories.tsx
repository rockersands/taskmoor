import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { SIGNED_IN } from '../account/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { defaultPreferences, fakeNotificationsClient } from './fixtures';
import { NotificationsSection } from './NotificationsSection';

/** Stories save to in-memory settings; nothing calls a server. */
const meta = {
  title: 'Account/NotificationsSection',
  component: NotificationsSection,
  args: { client: fakeNotificationsClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={SIGNED_IN}>
        <main style={{ padding: 24, maxWidth: 720 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof NotificationsSection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const EverythingOn: Story = {};

export const DigestWithQuietHours: Story = {
  args: {
    client: fakeNotificationsClient(
      {},
      {
        ...defaultPreferences(),
        emailDelivery: 'daily',
        quietHours: { start: 22, end: 7 },
        ownChanges: true,
      },
    ),
  },
};

export const Loading: Story = {
  args: { client: fakeNotificationsClient({ preferences: () => new Promise(() => {}) }) },
};

export const Failed: Story = {
  args: {
    client: fakeNotificationsClient({
      preferences: () => Promise.reject(new Error('backend down')),
    }),
  },
};

export const TurnsAnEmailOff: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('checkbox', { name: 'Email: Ticket updated' }));
    await expect(await canvas.findByText('Notification settings saved.')).toBeVisible();
    await expect(canvas.getByRole('checkbox', { name: 'Email: Ticket updated' })).not.toBeChecked();
  },
};
