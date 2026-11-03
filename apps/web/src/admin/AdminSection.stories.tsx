import type { Meta, StoryObj } from '@storybook/react-vite';
import { SessionProvider } from '../session/SessionProvider';
import { AdminGroupPage } from './AdminGroupPage';
import { AdminLayout } from './AdminLayout';
import { AdminOverviewPage, type OverviewClient } from './AdminOverviewPage';
import { RECENT_ALERTS } from './alertsFixtures';
import { ADMIN, CONFIG_ADMIN, HEALTHY } from './fixtures';
import { ADMIN_GROUPS } from './sections';

const never = () => new Promise<never>(() => {});
const CLIENT: OverviewClient = {
  system: async () => HEALTHY,
  alerts: async () => RECENT_ALERTS,
  people: async () => ({
    users: [
      {
        id: 2,
        name: 'Noor Haddad',
        email: 'noor@example.com',
        isSiteAdmin: false,
        active: true,
        hasPassword: false,
        createdAt: '2026-10-01T00:00:00.000Z',
        deactivatedAt: null,
        lastSignInAt: null,
      },
    ],
    total: 1,
  }),
};

const meta = {
  title: 'Admin/Administration',
  component: AdminOverviewPage,
  args: { client: CLIENT },
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <main style={{ padding: 24 }}>
          <AdminLayout hash="#/admin">
            <Story />
          </AdminLayout>
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof AdminOverviewPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** What a site administrator opens on: every group, health, people and alerts. */
export const Overview: Story = {};

/** Nothing back yet. */
export const Reading: Story = {
  args: { client: { system: never, alerts: never, people: never } },
};

/** Nobody waiting and no alert raised. */
export const NothingWaiting: Story = {
  args: {
    client: { ...CLIENT, alerts: async () => [], people: async () => ({ users: [], total: 0 }) },
  },
};

/** A configuration administrator sees only the setup pages. */
export const ConfigurationAdministrator: Story = {
  render: (args) => (
    <SessionProvider session={CONFIG_ADMIN}>
      <AdminLayout hash="#/admin">
        <AdminOverviewPage {...args} />
      </AdminLayout>
    </SessionProvider>
  ),
  decorators: [],
};

/** A group's own page, where a breadcrumb leads back to. */
export const GroupPage: Story = {
  render: () => {
    const group = ADMIN_GROUPS.find((g) => g.id === 'setup') ?? ADMIN_GROUPS[0];
    return group ? <AdminGroupPage group={group} /> : <div />;
  },
};
