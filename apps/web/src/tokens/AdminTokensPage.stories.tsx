import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ADMIN, MEMBER } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { AdminTokensPage } from './AdminTokensPage';
import { fakeAdminTokensClient } from './fixtures';

/** Stories pass an in-memory inventory; nothing calls a server. */
const meta = {
  title: 'Admin/AdminTokensPage',
  component: AdminTokensPage,
  args: { client: fakeAdminTokensClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof AdminTokensPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Inventory: Story = {};

export const DueForRotation: Story = {
  args: { client: fakeAdminTokensClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(await canvas.findByLabelText('Show'), 'expiring');
    await expect(await canvas.findByText('Expires in 5 days')).toBeVisible();
  },
};

export const BulkRevocationConfirmed: Story = {
  args: { client: fakeAdminTokensClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const bulk = within(await canvas.findByRole('region', { name: 'Revoke in bulk' }));
    await userEvent.click(bulk.getByRole('radio', { name: 'Every token' }));
    await userEvent.click(bulk.getByRole('button', { name: 'Revoke tokens' }));
    await userEvent.click(await bulk.findByRole('button', { name: 'Confirm revocation' }));
    await expect(await bulk.findByText('Revoked 6 tokens.')).toBeVisible();
  },
};

export const AskingToConfirm: Story = {
  args: { client: fakeAdminTokensClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const bulk = within(await canvas.findByRole('region', { name: 'Revoke in bulk' }));
    await userEvent.click(bulk.getByRole('radio', { name: 'Every token' }));
    await userEvent.click(bulk.getByRole('button', { name: 'Revoke tokens' }));
    await expect(await bulk.findByRole('button', { name: 'Confirm revocation' })).toHaveFocus();
  },
};

export const Empty: Story = {
  args: { client: fakeAdminTokensClient({}, { tokens: [] }) },
};

export const Failed: Story = {
  args: {
    client: fakeAdminTokensClient({
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
