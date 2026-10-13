import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { SIGNED_IN } from '../account/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { fakePersonalTokensClient } from './fixtures';
import { TokensSection } from './TokensSection';

/** Stories pass an in-memory backend; nothing calls a server. */
const meta = {
  title: 'Tokens/TokensSection',
  component: TokensSection,
  args: { client: fakePersonalTokensClient(), allowAdmin: false, timeZone: null },
  decorators: [
    (Story) => (
      <SessionProvider session={SIGNED_IN}>
        <main style={{ padding: 24, maxWidth: 760 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof TokensSection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SeveralTokens: Story = {};

export const NoTokens: Story = {
  args: { client: fakePersonalTokensClient({}, { tokens: [] }) },
};

export const Administrator: Story = {
  args: { client: fakePersonalTokensClient({}, { tokens: [] }), allowAdmin: true },
};

export const CreatedAndShownOnce: Story = {
  // Its own backend: creating a token changes the list it keeps.
  args: { client: fakePersonalTokensClient({}, { tokens: [] }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByLabelText('Token name'), 'Deploy script');
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Write' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Create token' }));
    await expect(await canvas.findByLabelText('New token')).toHaveFocus();
    await expect(await canvas.findByText('Deploy script')).toBeVisible();
  },
};

export const Revoked: Story = {
  args: { client: fakePersonalTokensClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Revoke Deploy script' }));
    await expect(await canvas.findByText('Revoked Deploy script.')).toBeVisible();
  },
};

export const Loading: Story = {
  args: { client: fakePersonalTokensClient({ list: () => new Promise(() => {}) }) },
};

export const Failed: Story = {
  args: {
    client: fakePersonalTokensClient({
      list: async () => {
        throw new Error('network');
      },
    }),
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
