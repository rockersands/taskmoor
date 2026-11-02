import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { SessionProvider } from '../session/SessionProvider';
import { fakeAlertsClient } from './alertsFixtures';
import { ADMIN, MEMBER } from './fixtures';
import { type SecurityClient, SecurityPage, type TwoFactorPolicy } from './SecurityPage';
import type { SessionPolicy, SessionPolicyClient } from './SessionPolicyForm';

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

const DEFAULTS: SessionPolicy = { lifetimeMinutes: 14 * 24 * 60, idleMinutes: 3 * 24 * 60 };

/** The session policy in memory, from the defaults. */
function fakeSessions(): SessionPolicyClient {
  let policy = DEFAULTS;
  return {
    load: async () => ({ ...policy, defaults: DEFAULTS }),
    save: async (next) => {
      policy = next;
      return policy;
    },
  };
}

const meta = {
  title: 'Admin/SecurityPage',
  component: SecurityPage,
  args: { client: fakeSecurityClient(), sessions: fakeSessions(), alerts: fakeAlertsClient() },
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

/** The session part: twelve hours and thirty minutes, the ASVS level-2 values, saved. */
export const SessionSettings: Story = {
  args: { sessions: fakeSessions() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const form = await canvas.findByRole('form', { name: 'Sign-in sessions' });
    const lifetime = within(form).getByLabelText('A sign-in lasts (hours)');
    await userEvent.clear(lifetime);
    await userEvent.type(lifetime, '12');
    const idle = within(form).getByLabelText('Sign out after this many minutes unused');
    await userEvent.clear(idle);
    await userEvent.type(idle, '30');
    await userEvent.click(within(form).getByRole('button', { name: 'Save session settings' }));
    await expect(await within(form).findByText('Session settings saved.')).toBeVisible();
  },
};
