import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { OAuthSignIn } from './OAuthSignIn';

/** A frontend whose backend is on another site signs in there (M1-107). */
const meta = {
  title: 'Session/OAuthSignIn',
  component: OAuthSignIn,
  args: {
    host: 'api.example.net',
    // The stories never leave the page.
    client: { begin: async () => false, failure: () => null },
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 32 }}>
        <section className="sign-in-prompt">
          <Story />
        </section>
      </main>
    ),
  ],
} satisfies Meta<typeof OAuthSignIn>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SignInPage: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(page.getByRole('button', { name: 'Sign in on api.example.net' })).toBeVisible();
  },
};

export const AfterAFailedSignIn: Story = {
  args: { client: { begin: async () => false, failure: () => 'state_mismatch' } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('alert')).toBeVisible();
  },
};
