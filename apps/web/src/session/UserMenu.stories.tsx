import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { SIGNED_IN } from '../account/fixtures';
import { SessionProvider } from './SessionProvider';
import { UserMenu } from './UserMenu';

/** The end of the top bar: the signed-in person's menu, or a sign-in link. */
const meta = {
  title: 'Session/UserMenu',
  component: UserMenu,
  args: { onSignedOut: () => {} },
  decorators: [
    (Story) => (
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'flex-end',
          padding: 16,
          minHeight: 240,
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof UserMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

const signedIn: Story['decorators'] = [
  (Story) => (
    <SessionProvider session={SIGNED_IN}>
      <Story />
    </SessionProvider>
  ),
];

export const SignedIn: Story = { decorators: signedIn };

export const Open: Story = {
  decorators: signedIn,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Kalo Mendes' }));
    await expect(canvas.getByRole('menu', { name: 'Kalo Mendes' })).toBeVisible();
    await expect(canvas.getByRole('menuitem', { name: 'Account' })).toHaveFocus();
  },
};

export const OpenWithTheKeyboard: Story = {
  decorators: signedIn,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    canvas.getByRole('button', { name: 'Kalo Mendes' }).focus();
    await userEvent.keyboard('{ArrowUp}');
    await expect(canvas.getByRole('menuitem', { name: 'Sign out' })).toHaveFocus();
  },
};

export const SignedOut: Story = {
  decorators: [
    (Story) => (
      <SessionProvider session={{ status: 'anonymous' }}>
        <Story />
      </SessionProvider>
    ),
  ],
};
