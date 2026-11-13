import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { HelpMenu } from './HelpMenu';

const meta = {
  title: 'Shell/HelpMenu',
  component: HelpMenu,
  decorators: [
    (Story) => (
      <div style={{ display: 'flex', justifyContent: 'flex-end', minHeight: 240 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof HelpMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Closed, at the top bar. */
export const Default: Story = {};

/** Open: the tutorials and the shortcuts. */
export const Open: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Help' }));
    await expect(canvas.getByRole('menuitem', { name: 'Tutorials' })).toHaveFocus();
  },
};

/** Every keyboard shortcut in one dialog. */
export const Shortcuts: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Help' }));
    await userEvent.click(canvas.getByRole('menuitem', { name: 'Keyboard shortcuts' }));
    // Drawn at the end of the page's body, out of the top bar (OverlayLayer).
    const body = within(document.body);
    await expect(body.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  },
};
