import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { ChecklistsPanel } from './ChecklistsPanel';
import { fakeToolsClient, STARTING_CHECKLISTS } from './fixtures';

const meta = {
  title: 'Tickets/ChecklistsPanel',
  component: ChecklistsPanel,
  args: { ticket: { id: 41 }, client: fakeToolsClient(), revision: 0 },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 720 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof ChecklistsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Three done, one open and one rejected: 75%. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('3 of 4 done (75%)')).toBeVisible();
    await expect(canvas.getByRole('checkbox', { name: 'Write the notes' })).toBeChecked();
  },
};

/** Two lists, with the numbers for both together. */
export const Several: Story = {
  args: {
    client: fakeToolsClient({
      checklists: [
        ...STARTING_CHECKLISTS,
        {
          id: 31,
          name: 'Afterwards',
          items: [{ id: 400, text: 'Tidy up', state: 'in_progress' }],
          progress: { done: 0, counted: 1, percent: 0 },
        },
      ],
    }),
  },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText('All checklists')).toBeVisible();
  },
};

/** Someone who may only read: the states are words, and nothing can change. */
export const ReadOnly: Story = {
  args: { client: fakeToolsClient({ canEdit: false }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('checkbox', { name: 'Print it' })).toBeDisabled();
    await expect(canvas.getByText('Rejected')).toBeVisible();
  },
};

/** None yet. */
export const Empty: Story = {
  args: { client: fakeToolsClient({ checklists: [] }) },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText('No checklists yet.')).toBeVisible();
  },
};
