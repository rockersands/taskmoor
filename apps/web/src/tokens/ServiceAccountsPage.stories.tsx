import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ADMIN, MEMBER } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { fakeServiceAccountsClient } from './fixtures';
import { ServiceAccountsPage } from './ServiceAccountsPage';

/** Stories pass an in-memory backend; nothing calls a server. */
const meta = {
  title: 'Admin/ServiceAccountsPage',
  component: ServiceAccountsPage,
  args: { client: fakeServiceAccountsClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof ServiceAccountsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Accounts: Story = {};

export const ManagingTokens: Story = {
  args: { client: fakeServiceAccountsClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Show the tokens of Release robot' }),
    );
    await expect(
      await canvas.findByRole('list', { name: 'Tokens of Release robot' }),
    ).toBeVisible();
  },
};

export const Rotated: Story = {
  args: { client: fakeServiceAccountsClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Show the tokens of Release robot' }),
    );
    const list = within(await canvas.findByRole('list', { name: 'Tokens of Release robot' }));
    await userEvent.click(list.getByRole('button', { name: 'Rotate Release key' }));
    await expect(await canvas.findByLabelText('New token')).toHaveFocus();
  },
};

export const NoAccounts: Story = {
  args: { client: fakeServiceAccountsClient({}, { accounts: [], tokens: [] }) },
};

export const Failed: Story = {
  args: {
    client: fakeServiceAccountsClient({
      list: async () => {
        throw new Error('network');
      },
    }),
  },
};

export const NotAnAdministrator: Story = {
  decorators: [
    (Story) => (
      <SessionProvider session={MEMBER}>
        <Story />
      </SessionProvider>
    ),
  ],
};

export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
