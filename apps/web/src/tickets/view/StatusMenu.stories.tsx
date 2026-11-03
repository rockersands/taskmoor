import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { StatusMenu } from './StatusMenu';

const meta = {
  title: 'Tickets/StatusMenu',
  component: StatusMenu,
  args: {
    status: { id: 2, name: 'Active', stage: 'active' },
    transitions: [
      { id: 1, name: 'New', to: { id: 1, name: 'New', stage: 'new' }, layout: [] },
      { id: 3, name: 'In Review', to: { id: 3, name: 'In Review', stage: 'active' }, layout: [] },
      { id: 4, name: 'Closed', to: { id: 4, name: 'Closed', stage: 'closed' }, layout: [] },
    ],
    onChoose: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ minHeight: 220 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StatusMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The status as one control. */
export const Default: Story = {};

/** Open: where the ticket can go. */
export const Open: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /^Status: Active/ }));
    await expect(canvas.getByRole('menuitem', { name: 'New' })).toHaveFocus();
  },
};

/** Nowhere to go: plain text. */
export const NowhereToGo: Story = { args: { transitions: [] } };
