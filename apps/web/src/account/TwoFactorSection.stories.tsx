import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { SessionProvider } from '../session/SessionProvider';
import { SecurityKeyError } from '../twofactor/webauthn';
import { fakeAccountClient, SIGNED_IN, twoFactorOn } from './fixtures';
import { TwoFactorSection } from './TwoFactorSection';

/** Stories pass an in-memory account backend; nothing calls a server or a security key. */
const meta = {
  title: 'Account/TwoFactorSection',
  component: TwoFactorSection,
  args: { client: fakeAccountClient(), email: 'kalo@example.com', timeZone: null },
  decorators: [
    (Story) => (
      <SessionProvider session={SIGNED_IN}>
        <main style={{ padding: 24, maxWidth: 720 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof TwoFactorSection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Off: Story = {};

export const AppAndTwoKeys: Story = {
  args: { client: fakeAccountClient({}, { twoFactor: twoFactorOn() }) },
};

export const RequiredLastFactor: Story = {
  args: {
    client: fakeAccountClient(
      {},
      {
        twoFactor: {
          totp: true,
          securityKeys: [],
          recoveryRemaining: 3,
          required: true,
        },
      },
    ),
  },
};

export const SetUpTheApp: Story = {
  // Its own backend: turning the app on changes what it keeps.
  args: { client: fakeAccountClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Set up authenticator app' }));
    await userEvent.type(canvas.getByLabelText('Code from the app'), '492039');
    await userEvent.click(canvas.getByRole('button', { name: 'Turn on' }));
    await expect(
      await canvas.findByRole('region', { name: 'Save your recovery codes' }),
    ).toBeVisible();
  },
};

export const AddKeyCancelled: Story = {
  args: {
    client: fakeAccountClient(
      {
        addSecurityKey: async () => {
          throw new SecurityKeyError('cancelled');
        },
      },
      { twoFactor: twoFactorOn() },
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Add a security key' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Register key' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('cancelled');
  },
};

export const ConfirmRemoval: Story = {
  args: { client: fakeAccountClient({}, { twoFactor: twoFactorOn() }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Remove Blue key' }));
    await expect(canvas.getByLabelText('Current password')).toHaveFocus();
  },
};

export const Loading: Story = {
  args: { client: fakeAccountClient({ twoFactorStatus: () => new Promise(() => {}) }) },
};

export const Failed: Story = {
  args: {
    client: fakeAccountClient({
      twoFactorStatus: async () => {
        throw new Error('network');
      },
    }),
  },
};

export const Phone: Story = {
  args: { client: fakeAccountClient({}, { twoFactor: twoFactorOn() }) },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
