import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { SessionProvider } from './SessionProvider';
import { SignInPage } from './SignInPage';

/** Where "Sign in" in the top bar leads and where signing out lands. */
const meta = {
  title: 'Session/SignInPage',
  component: SignInPage,
  args: { onSignedIn: () => {} },
  decorators: [
    (Story) => (
      <main style={{ padding: 32 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof SignInPage>;

export default meta;
type Story = StoryObj<typeof meta>;

const anonymous: Story['decorators'] = [
  (Story) => (
    <SessionProvider session={{ status: 'anonymous' }}>
      <Story />
    </SessionProvider>
  ),
];

export const Form: Story = { decorators: anonymous };

export const PasswordShown: Story = {
  decorators: anonymous,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText('Password'), 'correct horse battery');
    await userEvent.click(canvas.getByRole('button', { name: 'Show password' }));
    await expect(canvas.getByLabelText('Password')).toHaveAttribute('type', 'text');
  },
};

export const CheckingTheSession: Story = {
  decorators: [
    (Story) => (
      <SessionProvider session={{ status: 'loading' }}>
        <Story />
      </SessionProvider>
    ),
  ],
};

export const Phone: Story = {
  decorators: anonymous,
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
