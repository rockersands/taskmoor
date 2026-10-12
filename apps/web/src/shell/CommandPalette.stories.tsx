import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { type Command, CommandPalette } from './CommandPalette';

const commands: Command[] = [
  { id: 'go-home', labelId: 'nav.home', run: () => {} },
  { id: 'go-projects', labelId: 'nav.projects', run: () => {} },
  { id: 'go-boards', labelId: 'nav.boards', run: () => {} },
  { id: 'go-settings', labelId: 'nav.settings', run: () => {} },
];

const meta = {
  title: 'Shell/CommandPalette',
  component: CommandPalette,
  args: { commands },
  decorators: [
    (Story) => (
      <div style={{ padding: 16, minHeight: 360 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CommandPalette>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {};

export const Open: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /Search or jump to/ }));
    await expect(canvas.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  },
};

export const Filtered: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /Search or jump to/ }));
    await userEvent.keyboard('proj');
    await expect(canvas.getAllByRole('option')).toHaveLength(1);
  },
};
