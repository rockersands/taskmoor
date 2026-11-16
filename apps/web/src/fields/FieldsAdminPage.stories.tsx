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

/** The fields, one choice list open with its contexts, defaults and options. */
export const Fields: Story = {
  args: { client: fakeFieldsClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Manage field Severity' }));
    await expect(await canvas.findByRole('button', { name: 'Rename Medium' })).toBeVisible();
    await expect(canvas.getByText('Tracks: Payments; ticket types: Bug')).toBeVisible();
  },
};

/** An option on tickets is not deleted: the page says how many hold it. */
export const OptionInUse: Story = {
  args: { client: fakeFieldsClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Manage field Severity' }));
    await userEvent.click(await canvas.findByRole('button', { name: 'Delete Medium' }));
    await expect(await canvas.findByRole('alert')).toBeVisible();
  },
};

/** A two-level list open: each option with its child options. */
export const TwoLevelList: Story = {
  args: { client: fakeFieldsClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Manage field Region' }));
    await expect(
      await canvas.findByRole('list', { name: 'Child options of Europe' }),
    ).toBeVisible();
  },
};

/** New field with a formula, its check saying what it reads. */
export const NewFormula: Story = {
  args: { client: fakeFieldsClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'New field' }));
    const form = canvas.getByRole('form', { name: 'Add a field' });
    await userEvent.type(within(form).getByLabelText('Field name'), 'Spend');
    await userEvent.selectOptions(within(form).getByLabelText('Type'), 'formula');
    await userEvent.type(within(form).getByLabelText('Expression'), '{{Cost} * 2');
    await expect(
      await within(form).findByText('It gives a number. It reads {Cost}.'),
    ).toBeVisible();
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
  args: { client: fakeFieldsClient() },
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Manage field Region' }));
    await expect(await canvas.findByRole('button', { name: 'Rename Madrid' })).toBeVisible();
    await expect(canvas.getByText(/^Add custom fields and keep/)).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};
