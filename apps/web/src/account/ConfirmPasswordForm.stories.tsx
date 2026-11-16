import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ApiError } from '../api/client';
import { SessionProvider } from '../session/SessionProvider';
import { ConfirmPasswordForm } from './ConfirmPasswordForm';
import { SIGNED_IN } from './fixtures';

const meta = {
  title: 'Account/ConfirmPasswordForm',
  component: ConfirmPasswordForm,
  args: {
    email: 'kalo@example.com',
    label: 'Remove Blue key',
    submitLabel: 'Remove',
    onConfirm: async () => {},
    onCancel: () => {},
  },
  decorators: [
    (Story) => (
      <SessionProvider session={SIGNED_IN}>
        <main style={{ padding: 24, maxWidth: 720 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof ConfirmPasswordForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

/** A removal says what it takes away first, and its submit has the danger look (D13, T-267). */
export const Removing: Story = {
  args: { outcome: 'You can no longer sign in with Blue key.' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const form = canvas.getByRole('form', { name: 'Remove Blue key' });
    await expect(form).toHaveAccessibleDescription('You can no longer sign in with Blue key.');
    await expect(canvas.getByRole('button', { name: 'Remove' })).toHaveClass('button-danger');
    await expect(canvas.getByLabelText('Current password')).toHaveFocus();
  },
};

export const WrongPassword: Story = {
  args: {
    onConfirm: async () => {
      throw new ApiError(403, { error: 'wrong_password' });
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText('Current password'), 'not it');
    await userEvent.click(canvas.getByRole('button', { name: 'Remove' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('not correct');
  },
};

export const LastRequiredFactor: Story = {
  args: {
    onConfirm: async () => {
      throw new ApiError(409, { error: 'two_factor_required' });
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText('Current password'), 'the current passphrase');
    await userEvent.click(canvas.getByRole('button', { name: 'Remove' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('last method');
  },
};
