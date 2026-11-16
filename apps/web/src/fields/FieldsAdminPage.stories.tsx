import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { ADMIN } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { FieldsAdminPage } from './FieldsAdminPage';
import { fakeFieldsClient } from './fixtures';

/** The width of a small phone; nothing inside may stick out sideways. */
const atPhoneWidth = (Story: () => ReactElement) => (
  <div data-testid="phone-width" style={{ width: 360 }}>
    <Story />
  </div>
);
const fitsPhoneWidth = async (canvas: ReturnType<typeof within>) => {
  const box = canvas.getByTestId('phone-width');
  await expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
};

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

/**
 * Deleting an option that takes its second-level options and the default with it asks first,
 * saying so (D13, T-267); at a phone's width nothing sticks out.
 */
export const DeletingAnOptionAsksAtPhoneWidth: Story = {
  args: { client: fakeFieldsClient() },
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Manage field Office' }));
    await userEvent.click(await canvas.findByRole('button', { name: 'Delete Madrid' }));
    const question = canvas.getByRole('group', { name: /^Deleting Madrid also deletes/ });
    await expect(within(question).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await fitsPhoneWidth(canvas);
  },
};

export const NoFieldsYet: Story = {
  args: { client: { ...fakeFieldsClient(), fields: async () => [] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('There are no custom fields yet.')).toBeVisible();
    await expect(canvas.getByText(/^A custom field adds/)).toBeVisible();
  },
};

export const AtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Manage field Severity' }));
    await expect(await canvas.findByRole('button', { name: 'Rename Medium' })).toBeVisible();
    await expect(canvas.getByText(/^Add custom fields and keep/)).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};
