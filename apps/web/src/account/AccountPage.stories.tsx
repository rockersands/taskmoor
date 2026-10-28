import type { Meta, StoryObj } from '@storybook/react-vite';
import { fakeNotificationsClient } from '../notifications/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { fakePersonalTokensClient } from '../tokens/fixtures';
import { AccountPage } from './AccountPage';
import { fakeAccountClient, SIGNED_IN, sampleSessions } from './fixtures';

/** Stories pass an in-memory account backend; nothing calls a server. */
const meta = {
  title: 'Account/AccountPage',
  component: AccountPage,
  args: {
    client: fakeAccountClient(),
    tokens: fakePersonalTokensClient(),
    notifications: fakeNotificationsClient(),
  },
  decorators: [
    (Story) => (
      <SessionProvider session={SIGNED_IN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof AccountPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ThreeSessions: Story = {};

export const OnlyThisDevice: Story = {
  args: {
    client: fakeAccountClient({}, { sessions: sampleSessions().filter((s) => s.current) }),
  },
};

export const SessionsLoading: Story = {
  args: { client: fakeAccountClient({ listSessions: () => new Promise(() => {}) }) },
};

export const SessionsFailed: Story = {
  args: {
    client: fakeAccountClient({
      listSessions: async () => {
        throw new Error('network');
      },
    }),
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
