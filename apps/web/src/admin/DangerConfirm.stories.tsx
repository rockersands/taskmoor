import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { DangerConfirm } from './DangerConfirm';

const meta = {
  title: 'Admin/DangerConfirm',
  component: DangerConfirm,
  args: {
    message:
      'Bo Rivera is signed out everywhere at once and can no longer sign in. Their tickets and history stay, and you can reactivate them later.',
    confirmLabel: 'Deactivate',
    cancelLabel: 'Keep active',
    onConfirm: fn(),
    onCancel: fn(),
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 720 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof DangerConfirm>;

export default meta;
type Story = StoryObj<typeof meta>;

/** What will happen, the action in the danger style, and a way back that has the focus (D13). */
export const Asking: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const group = canvas.getByRole('group', { name: /signed out everywhere/ });
    const yes = within(group).getByRole('button', { name: 'Deactivate' });
    await expect(within(group).getByRole('button', { name: 'Keep active' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await expect(args.onCancel).toHaveBeenCalled();
    await userEvent.click(yes);
    await expect(args.onConfirm).toHaveBeenCalled();
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
