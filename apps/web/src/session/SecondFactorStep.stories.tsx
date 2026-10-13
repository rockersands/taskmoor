import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ApiError } from '../api/client';
import { SecurityKeyError } from '../twofactor/webauthn';
import { fakeSecondFactorClient } from './fixtures';
import { SecondFactorStep } from './SecondFactorStep';
import { SessionProvider } from './SessionProvider';

/** The second step of sign-in; stories pass an in-memory backend. */
const meta = {
  title: 'Session/SecondFactorStep',
  component: SecondFactorStep,
  args: {
    challenge: 'story-challenge',
    methods: ['totp', 'recovery_code'],
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
} satisfies Meta<typeof SecondFactorStep>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AuthenticatorCode: Story = {};

export const EveryMethod: Story = {
  args: { methods: ['totp', 'webauthn', 'recovery_code'] },
};

export const SecurityKeyOnly: Story = {
  args: { methods: ['webauthn', 'recovery_code'] },
};

export const RecoveryCode: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Use a recovery code' }));
    await expect(canvas.getByLabelText('Recovery code')).toHaveFocus();
  },
};

export const WrongCode: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText('Authentication code'), '000000');
    await userEvent.click(canvas.getByRole('button', { name: 'Verify' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('not correct');
  },
};

export const KeyCancelled: Story = {
  args: {
    methods: ['webauthn'],
    client: fakeSecondFactorClient({
      answerWithSecurityKey: async () => {
        throw new SecurityKeyError('cancelled');
      },
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Use a security key' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('cancelled');
  },
};

export const WaitingForTheKey: Story = {
  args: {
    methods: ['webauthn', 'recovery_code'],
    client: fakeSecondFactorClient({ answerWithSecurityKey: () => new Promise(() => {}) }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Use a security key' }));
    await expect(await canvas.findByText(/use your security key/)).toBeVisible();
  },
};

export const LockedOut: Story = {
  args: {
    client: fakeSecondFactorClient({
      verify: async () => {
        throw new ApiError(429, { error: 'too_many_attempts', retryAfterSeconds: 240 });
      },
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText('Authentication code'), '123456');
    await userEvent.click(canvas.getByRole('button', { name: 'Verify' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('4 minutes');
  },
};

export const Phone: Story = {
  args: { methods: ['totp', 'webauthn', 'recovery_code'] },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
