import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { SAMPLE_RECOVERY_CODES } from '../account/fixtures';
import { RecoveryCodes } from './RecoveryCodes';

const meta = {
  title: 'TwoFactor/RecoveryCodes',
  component: RecoveryCodes,
  args: {
    codes: SAMPLE_RECOVERY_CODES,
    account: 'kalo@example.com',
    level: 2,
    doneLabel: 'Continue',
    onDone: () => {},
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof RecoveryCodes>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ShownOnce: Story = {};

export const Saved: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const next = canvas.getByRole('button', { name: 'Continue' });
    await expect(next).toBeDisabled();
    await userEvent.click(canvas.getByRole('checkbox', { name: 'I have saved these codes' }));
    await expect(next).toBeEnabled();
  },
};

export const InsideAccount: Story = { args: { level: 3, doneLabel: 'Done' } };

export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
