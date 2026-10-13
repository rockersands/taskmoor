import type { Meta, StoryObj } from '@storybook/react-vite';
import { SAMPLE_TOTP_SETUP } from '../account/fixtures';
import { QrCode } from './QrCode';

const meta = {
  title: 'TwoFactor/QrCode',
  component: QrCode,
  args: { value: SAMPLE_TOTP_SETUP.uri, label: 'QR code for your authenticator app' },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof QrCode>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AuthenticatorUri: Story = {};

export const ShortText: Story = { args: { value: 'Taskmoor' } };

export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
