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
    draft: 3,
    busy: false,
    onRestore: async () => true,
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

/** Over a draft, restoring asks first, saying what it replaces; focus waits on Cancel (D13). */
export const ConfirmingRestore: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: 'Restore version 1 as the draft' });
    await expect(trigger).toHaveClass('button-danger-quiet');
    await userEvent.click(trigger);
    const question = canvas.getByRole('group', {
      name: 'Restoring version 1 replaces the draft (version 3) and every unsaved change. The published version stays as it is.',
    });
    await expect(within(question).getByRole('button', { name: 'Restore version 1' })).toBeVisible();
    await expect(within(question).getByRole('button', { name: 'Cancel' })).toHaveFocus();
  },
};

/** The question at a phone's width: it takes the row's whole line and nothing sticks out. */
export const ConfirmingRestoreOnAPhone: Story = {
  decorators: [
    (Story) => (
      <div data-testid="phone-width" style={{ width: 360 }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Restore version 1 as the draft' }));
    await expect(canvas.getByRole('group', { name: /^Restoring version 1/ })).toBeVisible();
    const box = canvas.getByTestId('phone-width');
    await expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
  },
};

/** With no draft and no unsaved change, a restore loses nothing: a plain button that acts at once. */
export const NothingToReplace: Story = {
  args: { replacesWork: false, draft: null, versions: VERSIONS.slice(1) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('button', { name: 'Restore version 1 as the draft' }),
    ).toHaveClass('button-secondary');
  },
};
