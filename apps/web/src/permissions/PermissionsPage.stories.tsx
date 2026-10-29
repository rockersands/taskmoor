import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ADMIN } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { fakePermissionsClient } from './fixtures';
import { PermissionsPage } from './PermissionsPage';

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
