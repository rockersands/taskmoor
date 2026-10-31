import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { SessionProvider } from '../session/SessionProvider';
import { fakeAccountClient, SIGNED_IN, sampleSessions } from './fixtures';
import { SessionsSection } from './SessionsSection';

const meta = {
  title: 'Account/SessionsSection',
  component: SessionsSection,
  args: { client: fakeAccountClient(), timeZone: null },
  decorators: [
    (Story) => (
      <SessionProvider session={SIGNED_IN}>
        <main style={{ padding: 24, maxWidth: 720 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof SessionsSection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ThreeDevices: Story = {};

export const InTheProfileTimeZone: Story = { args: { timeZone: 'Pacific/Auckland' } };

export const UnknownDeviceAndAddress: Story = {
  args: {
    client: fakeAccountClient(
      {},
      {
        sessions: sampleSessions().map((s) =>
          s.current ? s : { ...s, ip: null, userAgent: 'curl/8.9.1' },
        ),
      },
    ),
  },
};

/** An MCP client's grant (M1-072) shows the app the person allowed, and can be ended. */
export const AnAppYouAllowed: Story = {
  args: {
    client: fakeAccountClient(
      {},
      {
        sessions: sampleSessions().map((s) =>
          s.id === 12 ? { ...s, userAgent: 'node', app: 'Desktop assistant' } : s,
        ),
      },
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Desktop assistant (an app you allowed)')).toBeVisible();
  },
};

export const OthersSignedOut: Story = {
  // Its own backend: signing out changes the sessions it keeps.
  args: { client: fakeAccountClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Sign out all other sessions' }),
    );
    await expect(await canvas.findByText('Signed out 2 other sessions.')).toBeVisible();
    await expect(await canvas.findByText('You are not signed in anywhere else.')).toBeVisible();
  },
};

export const Failed: Story = {
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
