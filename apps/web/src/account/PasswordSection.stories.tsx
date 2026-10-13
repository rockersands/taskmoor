import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ApiError } from '../api/client';
import { SessionProvider } from '../session/SessionProvider';
import { fakeAccountClient, SIGNED_IN } from './fixtures';
import { PasswordSection } from './PasswordSection';

const meta = {
  title: 'Account/PasswordSection',
  component: PasswordSection,
  args: { email: 'kalo@example.com', client: fakeAccountClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={SIGNED_IN}>
        <main style={{ padding: 24, maxWidth: 720 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof PasswordSection>;

export default meta;
type Story = StoryObj<typeof meta>;

async function submit(canvasElement: HTMLElement, current: string, next: string) {
  const canvas = within(canvasElement);
  await userEvent.type(canvas.getByLabelText('Current password'), current);
  await userEvent.type(canvas.getByLabelText('New password'), next);
  await userEvent.type(canvas.getByLabelText('Confirm new password'), next);
  await userEvent.click(canvas.getByRole('button', { name: 'Change password' }));
  return canvas;
}

export const Empty: Story = {};

export const Changed: Story = {
  // Its own backend: a change signs the other sessions out.
  args: { client: fakeAccountClient() },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement, 'the old passphrase', 'a brand new passphrase');
    await expect(
      await canvas.findByText('Password changed. 2 other sessions were signed out.'),
    ).toBeVisible();
  },
};

export const WrongCurrentPassword: Story = {
  args: {
    client: fakeAccountClient({
      changePassword: async () => {
        throw new ApiError(403, { error: 'wrong_password' });
      },
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement, 'not it', 'a brand new passphrase');
    await expect(await canvas.findByRole('alert')).toBeVisible();
  },
};

export const WeakNewPassword: Story = {
  args: {
    client: fakeAccountClient({
      changePassword: async () => {
        throw new ApiError(400, {
          error: 'weak_password',
          codes: ['too_short', 'predictable'],
          problems: ['newPassword: too short', 'newPassword: predictable'],
        });
      },
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement, 'the old passphrase', 'abcabc');
    await expect(await canvas.findByRole('alert')).toHaveTextContent('Too short');
  },
};

export const LockedOut: Story = {
  args: {
    client: fakeAccountClient({
      changePassword: async () => {
        throw new ApiError(429, { error: 'too_many_attempts', retryAfterSeconds: 480 });
      },
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement, 'guess', 'a brand new passphrase');
    await expect(await canvas.findByRole('alert')).toHaveTextContent('8 minutes');
  },
};
