import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ADMIN } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { FieldsAdminPage } from './FieldsAdminPage';
import { fakeFieldsClient } from './fixtures';

const meta = {
  title: 'Admin/Fields',
  component: FieldsAdminPage,
  args: { client: fakeFieldsClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof FieldsAdminPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The fields, one choice list open with its options. */
export const Fields: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Manage field Severity' }));
    await expect(await canvas.findByRole('button', { name: 'Rename Medium' })).toBeVisible();
  },
};

/** An option on tickets is not deleted: the page says how many hold it. */
export const OptionInUse: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Manage field Severity' }));
    await userEvent.click(await canvas.findByRole('button', { name: 'Delete Medium' }));
    await expect(await canvas.findByRole('alert')).toBeVisible();
  },
};
