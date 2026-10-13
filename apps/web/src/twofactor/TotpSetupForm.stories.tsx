import type { Meta, StoryObj } from '@storybook/react-vite';
import { SAMPLE_TOTP_SETUP } from '../account/fixtures';
import { TotpSetupForm } from './TotpSetupForm';

const meta = {
  title: 'TwoFactor/TotpSetupForm',
  component: TotpSetupForm,
  args: {
    setup: SAMPLE_TOTP_SETUP,
    submitLabel: 'Turn on',
    busy: false,
    error: null,
    onSubmit: () => {},
    onCancel: () => {},
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof TotpSetupForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ScanOrType: Story = {};

export const WrongCode: Story = {
  args: {
    error:
      'That code is not correct. Check that the time on your device is right and enter the newest code.',
  },
};

export const Busy: Story = { args: { busy: true } };

export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
