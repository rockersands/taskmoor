import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { ADMIN, MEMBER } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { AdminTokensPage } from './AdminTokensPage';
import { fakeAdminTokensClient, manyTokens } from './fixtures';

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
    // As every destructive action asks (D13): the focus on Cancel, the safe choice.
    await bulk.findByRole('button', { name: 'Confirm revocation' });
    await expect(bulk.getByRole('button', { name: 'Cancel' })).toHaveFocus();
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
    await expect(await canvas.findByRole('list', { name: 'Tokens' })).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

/** The empty list says what would be here and how it gets here. */
export const EmptyExplains: Story = {
  ...Empty,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('No API tokens yet')).toBeVisible();
    await expect(canvas.getByText(/^Tokens show here once/)).toBeVisible();
    // Nothing to revoke in bulk while there is no token at all (AD-31).
    await expect(canvas.queryByRole('heading', { name: 'Revoke in bulk' })).toBeNull();
  },
};

/** More tokens than a page holds (T-308): the count says how many, Show more lists the rest. */
const showsMore = async (canvasElement: HTMLElement) => {
  const canvas = within(canvasElement);
  await expect(await canvas.findByText('5 tokens')).toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: 'Show more' }));
  await expect(await canvas.findByText('Token 004')).toBeVisible();
  return canvas;
};

export const ShowMoreTokens: Story = {
  args: { client: fakeAdminTokensClient({}, { tokens: manyTokens(5), pageSize: 2 }) },
  play: async ({ canvasElement }) => {
    await showsMore(canvasElement);
  },
};

export const ShowMoreTokensAtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  args: { client: fakeAdminTokensClient({}, { tokens: manyTokens(5), pageSize: 2 }) },
  play: async ({ canvasElement }) => {
    await fitsPhoneWidth(await showsMore(canvasElement));
  },
};
