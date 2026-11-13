import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { DangerAction } from './DangerAction';

const meta = {
  title: 'Shell/DangerAction',
  component: DangerAction,
  args: {
    label: 'Deactivate',
    outcome: 'Ana Ruiz can no longer sign in. Her tickets and comments stay.',
    confirmLabel: 'Deactivate Ana Ruiz',
    onConfirm: fn(),
  },
  decorators: [
    (Story) => (
      <div className="glass-card" style={{ padding: 24, margin: 16, maxWidth: 520 }}>
        <p className="page-note" style={{ marginTop: 0 }}>
          Ana Ruiz, ana@example.test
        </p>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DangerAction>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The first step looks like a danger, never like a harmless action (D13). */
export const Button: Story = {
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: 'Deactivate' });
    const quiet = document.createElement('button');
    quiet.className = 'button-secondary';
    canvasElement.append(quiet);
    const look = getComputedStyle(button);
    await expect(look.color).not.toBe(getComputedStyle(quiet).color);
    await expect(look.borderTopColor).not.toBe(getComputedStyle(quiet).borderTopColor);
    quiet.remove();
  },
};

/** The question in its place: what will happen, the action by name, and Cancel. */
export const Asking: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Deactivate' }));
    await expect(canvas.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await expect(args.onConfirm).not.toHaveBeenCalled();
  },
};

export const Busy: Story = { args: { busy: true } };
