import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { SIGNED_IN } from '../account/fixtures';
import { ApiError } from '../api/client';
import { SessionProvider } from '../session/SessionProvider';
import { POLICY } from './fixtures';
import { TokenForm } from './TokenForm';

const meta = {
  title: 'Tokens/TokenForm',
  component: TokenForm,
  args: { policy: POLICY, allowAdmin: false, onCreate: async () => {} },
  decorators: [
    (Story) => (
      <SessionProvider session={SIGNED_IN}>
        <main style={{ padding: 24, maxWidth: 720 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof TokenForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Person: Story = {};

export const Administrator: Story = { args: { allowAdmin: true } };

export const TwoYearMaximum: Story = {
  args: { policy: { maxLifetimeDays: 730, reminderDays: 30 } },
};

export const ShortMaximum: Story = {
  args: { policy: { maxLifetimeDays: 14, reminderDays: 3 } },
};

export const ExpiryRefused: Story = {
  args: {
    onCreate: async () => {
      throw new ApiError(400, { error: 'expiry_too_long', maxLifetimeDays: 90 });
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText('Token name'), 'Long-lived export');
    await userEvent.click(canvas.getByRole('button', { name: 'Create token' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(
      'Tokens may last at most 90 days.',
    );
  },
};

export const NoScopeChosen: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText('Token name'), 'Nothing allowed');
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Read' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Create token' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('Choose at least one scope.');
  },
};

export const Phone: Story = {
  args: { allowAdmin: true },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
