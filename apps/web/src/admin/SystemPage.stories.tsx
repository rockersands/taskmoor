import type { Meta, StoryObj } from '@storybook/react-vite';
import { SessionProvider } from '../session/SessionProvider';
import { ADMIN, HEALTHY, MEMBER, NEEDS_ATTENTION, STALE_BACKUP } from './fixtures';
import { SystemPage } from './SystemPage';
import type { UpdateCheck } from './UpdateNotice';

const updateCheck: UpdateCheck = {
  version: '0.4.0',
  enabled: true,
  environmentOff: false,
  developmentBuild: false,
  checkedAt: '2026-10-12T08:00:00.000Z',
  latest: '0.5.0',
  updateAvailable: true,
  command: 'bash update.sh 0.5.0',
  releaseUrl: 'https://github.com/Rockersands/taskmoor/releases/tag/v0.5.0',
};

/** Stories pass the status in; nothing calls a backend. */
const meta = {
  title: 'Admin/SystemPage',
  component: SystemPage,
  args: {
    updates: {
      load: async () => updateCheck,
      setEnabled: async (enabled) => ({ ...updateCheck, enabled }),
    },
  },
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
