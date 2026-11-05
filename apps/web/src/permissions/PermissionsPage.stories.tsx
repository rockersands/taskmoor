import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { ADMIN } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { fakePermissionsClient } from './fixtures';
import { PermissionsPage } from './PermissionsPage';

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

const meta = {
  title: 'Admin/Permissions',
  component: PermissionsPage,
  args: { client: fakePermissionsClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof PermissionsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Roles, policies and global permissions. */
export const Permissions: Story = {};

/** The default policy open: its grants by permission, and the form to give one. */
export const PolicyOpen: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Manage Default access policy' }),
    );
    await expect(
      await canvas.findByRole('form', { name: 'Give a permission in Default access policy' }),
    ).toBeVisible();
  },
};

/** All three parts on a phone, each on its card with its rows as wells. */
export const AtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'Roles' })).toBeVisible();
    await expect(canvas.getByText(/^Roles, access policies and/)).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};
