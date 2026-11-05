import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
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

/** The width of a small phone; nothing inside may stick out sideways. */
const atPhoneWidth = (Story: () => ReactElement) => (
  <div data-testid="phone-width" style={{ width: 360 }}>
    <Story />
  </div>
);
const fitsPhoneWidth = async (canvas: ReturnType<typeof within>) => {
  const box = canvas.getByTestId('phone-width');
  await expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
};

export const AtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1 })).toBeVisible();
    await canvas.findAllByRole('listitem');
    await fitsPhoneWidth(canvas);
  },
};

/** The empty list says what would be here and how it gets here. */
export const NoAccountsExplains: Story = {
  ...NoAccounts,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('There are no service accounts yet.')).toBeVisible();
    await expect(canvas.getByText(/^A service account lets a program/)).toBeVisible();
  },
};
