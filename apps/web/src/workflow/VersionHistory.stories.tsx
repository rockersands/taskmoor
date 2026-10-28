import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import type { VersionEntry } from './client';
import { VersionHistory } from './VersionHistory';

const VERSIONS: VersionEntry[] = [
  {
    version: 3,
    state: 'draft',
    createdAt: '2026-10-27T15:00:00.000Z',
    createdBy: { id: 1, name: 'Kalo Admin' },
    publishedAt: null,
    publishedBy: null,
  },
  {
    version: 2,
    state: 'published',
    createdAt: '2026-10-21T09:00:00.000Z',
    createdBy: { id: 1, name: 'Kalo Admin' },
    publishedAt: '2026-10-21T10:00:00.000Z',
    publishedBy: { id: 2, name: 'Rin Okafor' },
  },
  {
    version: 1,
    state: 'earlier',
    createdAt: '2026-10-20T09:00:00.000Z',
    createdBy: null,
    publishedAt: '2026-10-20T09:00:00.000Z',
    publishedBy: null,
  },
];

const meta = {
  title: 'Workflows/VersionHistory',
  component: VersionHistory,
  args: {
    versions: VERSIONS,
    loading: false,
    failed: false,
    replacesWork: true,
    busy: false,
    onRestore: () => {},
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 720 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof VersionHistory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Versions: Story = {};

export const Loading: Story = { args: { versions: null, loading: true } };

export const Failed: Story = { args: { versions: null, failed: true } };

export const ConfirmingRestore: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Restore version 1 as the draft' }));
    await expect(canvas.getByRole('button', { name: 'Restore version 1' })).toHaveFocus();
  },
};
