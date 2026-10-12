import type { Meta, StoryObj } from '@storybook/react-vite';
import { SessionProvider } from '../session/SessionProvider';
import { ADMIN, HEALTHY, MEMBER, NEEDS_ATTENTION, STALE_BACKUP } from './fixtures';
import { SystemPage } from './SystemPage';

/** Stories pass the status in; nothing calls a backend. */
const meta = {
  title: 'Admin/SystemPage',
  component: SystemPage,
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof SystemPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Healthy: Story = { args: { load: async () => HEALTHY } };

export const NeedsAttention: Story = { args: { load: async () => NEEDS_ATTENTION } };

export const PendingMigrationAndOldBackup: Story = { args: { load: async () => STALE_BACKUP } };

export const Loading: Story = { args: { load: () => new Promise(() => {}) } };

export const Failed: Story = {
  args: {
    load: async () => {
      throw new Error('network');
    },
  },
};

export const NotAnAdministrator: Story = {
  args: { load: async () => HEALTHY },
  decorators: [
    (Story) => (
      <SessionProvider session={MEMBER}>
        <Story />
      </SessionProvider>
    ),
  ],
};
