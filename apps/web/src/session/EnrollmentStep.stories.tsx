import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { EnrollmentStep } from './EnrollmentStep';
import { fakeSecondFactorClient } from './fixtures';
import { SessionProvider } from './SessionProvider';

/** Sign-in when a two-factor policy requires an app first; stories pass an in-memory backend. */
const meta = {
  title: 'Session/EnrollmentStep',
  component: EnrollmentStep,
  args: {
    challenge: 'story-challenge',
    email: 'kalo@example.com',
    onSignedIn: () => {},
    onExpired: () => {},
    onBack: () => {},
    client: fakeSecondFactorClient(),
  },
  decorators: [
    (Story) => (
      <SessionProvider session={{ status: 'anonymous' }}>
        <main style={{ padding: 32 }}>
          <h1 className="page-title">Sign in</h1>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof EnrollmentStep>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ScanTheCode: Story = {};

export const WrongCode: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByLabelText('Code from the app'), '000000');
    await userEvent.click(canvas.getByRole('button', { name: 'Verify and continue' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('not correct');
  },
};

export const RecoveryCodesShown: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByLabelText('Code from the app'), '492039');
    await userEvent.click(canvas.getByRole('button', { name: 'Verify and continue' }));
    const next = await canvas.findByRole('button', { name: 'Continue' });
    await expect(next).toBeDisabled();
    await userEvent.click(canvas.getByRole('checkbox', { name: 'I have saved these codes' }));
    await expect(next).toBeEnabled();
  },
};

export const Preparing: Story = {
  args: { client: fakeSecondFactorClient({ startEnrollment: () => new Promise(() => {}) }) },
};

export const SetupFailed: Story = {
  args: {
    client: fakeSecondFactorClient({
      startEnrollment: async () => {
        throw new Error('network');
      },
    }),
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
