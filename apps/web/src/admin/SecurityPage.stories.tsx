import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { SessionProvider } from '../session/SessionProvider';
import { ADMIN, MEMBER } from './fixtures';
import { type SecurityClient, SecurityPage, type TwoFactorPolicy } from './SecurityPage';

const GROUPS = [
  { id: 3, name: 'Finance' },
  { id: 7, name: 'Platform team' },
  { id: 9, name: 'Support' },
];

/** An in-memory policy store, so saving behaves like the real page. */
function fakeSecurityClient(
  initial: TwoFactorPolicy = { required: 'none', groupIds: [] },
  overrides: Partial<SecurityClient> = {},
): SecurityClient {
  let policy = initial;
  return {
    loadPolicy: async () => policy,
    savePolicy: async (next) => {
      policy = next;
      return policy;
    },
    listGroups: async () => GROUPS,
    ...overrides,
  };
}

const meta = {
  title: 'Admin/SecurityPage',
  component: SecurityPage,
  args: { client: fakeSecurityClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof SecurityPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Nobody: Story = {};

export const AdministratorsAndAGroup: Story = {
  args: { client: fakeSecurityClient({ required: 'site_admins', groupIds: [7] }) },
};

export const SavedForEveryone: Story = {
  // Its own store: saving changes it.
  args: { client: fakeSecurityClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('radio', { name: 'Everyone' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Save policy' }));
    await expect(await canvas.findByText('Policy saved.')).toBeVisible();
  },
};

export const NoGroups: Story = {
  args: { client: fakeSecurityClient(undefined, { listGroups: async () => [] }) },
};

export const Loading: Story = {
  args: { client: fakeSecurityClient(undefined, { loadPolicy: () => new Promise(() => {}) }) },
};

export const Failed: Story = {
  args: {
    client: fakeSecurityClient(undefined, {
      loadPolicy: async () => {
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
  args: { client: fakeSecurityClient({ required: 'everyone', groupIds: [3] }) },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
