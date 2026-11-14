import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, within } from 'storybook/test';
import { SessionProvider } from '../session/SessionProvider';
import { ADMIN, HEALTHY, MEMBER, NEEDS_ATTENTION, STALE_BACKUP } from './fixtures';
import { SystemPage } from './SystemPage';
import { textLines } from './textLines';
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
  args: { load: async () => NEEDS_ATTENTION },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'Database' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Refresh' })).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

/**
 * A long data directory wraps only after a '/', never inside a folder's name: it once broke as
 * '.cache/dem' and 'o/data'.
 */
export const DataDirectoryBreaksAtSlashes: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 420 }}>
        <Story />
      </div>
    ),
  ],
  args: {
    load: async () => ({
      ...HEALTHY,
      disk: {
        ...(HEALTHY.disk as NonNullable<typeof HEALTHY.disk>),
        path: '/Users/someone/Documents/taskmoor/.cache/demo/data',
      },
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const label = await canvas.findByText('Data directory');
    const value = label.nextElementSibling as HTMLElement;
    const lines = textLines(value);
    await expect(lines.length).toBeGreaterThan(1);
    await expect(lines.slice(0, -1).filter((line) => !line.endsWith('/'))).toEqual([]);
  },
};
