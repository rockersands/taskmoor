import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { EraseUserForm } from './EraseUserForm';
import { PEOPLE } from './fixtures';

const meta = {
  title: 'Admin/EraseUserForm',
  component: EraseUserForm,
  args: { user: PEOPLE[1] as (typeof PEOPLE)[number], onErase: fn(async () => {}), onCancel: fn() },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 720 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof EraseUserForm>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The button waits for the person's email. */
export const Confirming: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const erase = canvas.getByRole('button', { name: 'Erase permanently' });
    await expect(erase).toBeDisabled();
    await userEvent.type(canvas.getByLabelText('Type bo@example.com to confirm'), 'BO@example.com');
    await expect(erase).toBeEnabled();
    await userEvent.click(erase);
    await expect(args.onErase).toHaveBeenCalledWith('BO@example.com');
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
