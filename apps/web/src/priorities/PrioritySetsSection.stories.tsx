import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ADMIN } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import type { Priority, PrioritySet } from './client';
import { fakePrioritiesClient } from './fixtures';
import { PrioritySetsSection } from './PrioritySetsSection';

const PRIORITIES: Priority[] = [
  { id: 1, name: 'Urgent', description: '', icon: null, color: null, order: 1, level: 1 },
  { id: 2, name: 'High', description: '', icon: null, color: null, order: 2, level: 2 },
  { id: 3, name: 'Normal', description: '', icon: null, color: null, order: 3, level: 4 },
  { id: 4, name: 'Low', description: '', icon: null, color: null, order: 4, level: 5 },
  { id: 5, name: 'Very low', description: '', icon: null, color: null, order: 5, level: 6 },
];

const SETS: PrioritySet[] = [
  {
    id: 1,
    name: 'Default priority set',
    description: '',
    isDefault: true,
    priorityIds: [1, 2, 3, 4, 5],
    defaultPriorityId: 3,
    trackCount: 3,
  },
  {
    id: 2,
    name: 'Support',
    description: 'For the help desk tracks.',
    isDefault: false,
    priorityIds: [1, 2, 3],
    defaultPriorityId: null,
    trackCount: 1,
  },
];

const meta = {
  title: 'Admin/Priority sets',
  component: PrioritySetsSection,
  args: {
    client: fakePrioritiesClient(),
    priorities: PRIORITIES,
    sets: SETS,
    reload: async () => {},
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
} satisfies Meta<typeof PrioritySetsSection>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The default set first, with its badge; a set with no default gives the middle priority. */
export const Sets: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Default set')).toBeVisible();
    await expect(
      canvas.getByText(
        'Offers Urgent, High, and Normal. New tickets get the middle one. 1 track uses it.',
      ),
    ).toBeVisible();
  },
};

/** A set open: what it offers, what new tickets get, Make default and Delete. */
export const ManagingASet: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Manage priority set Support' }));
    await expect(canvas.getByRole('group', { name: 'Priorities it offers' })).toBeVisible();
    await expect(
      canvas.getByRole('button', { name: 'Make Support the default set' }),
    ).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Delete priority set Support' })).toBeVisible();
  },
};

/** The default set open: no Delete, and the reason. */
export const TheDefaultSet: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole('button', { name: 'Manage priority set Default priority set' }),
    );
    await expect(canvas.getByText(/^Tracks that choose no set use this one\./)).toBeVisible();
  },
};
