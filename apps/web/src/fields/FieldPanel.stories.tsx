import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { FieldPanel } from './FieldPanel';
import { fakeFieldsClient, sampleFields } from './fixtures';

const atPhoneWidth = (Story: () => ReactElement) => (
  <div data-testid="phone-width" style={{ width: 360 }}>
    <Story />
  </div>
);

const meta = {
  title: 'Admin/Fields/FieldPanel',
  component: FieldPanel,
  args: {
    id: 7,
    fields: sampleFields(),
    client: fakeFieldsClient(),
    onChanged: () => {},
    onDeleted: () => {},
    onProblem: () => {},
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <ul className="people-list">
          <li className="people-item">
            <Story />
          </li>
        </ul>
      </main>
    ),
  ],
} satisfies Meta<typeof FieldPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A number field shown as euros: its settings with a sample, its context and default. */
export const NumberSettings: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const settings = await canvas.findByRole('form', { name: 'Settings of Cost' });
    await expect(within(settings).getByText(/shows as €1,234\.50/)).toBeVisible();
  },
};

/** A formula field: its expression, output and help. */
export const Formula: Story = {
  args: { id: 8, client: fakeFieldsClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const settings = await canvas.findByRole('form', { name: 'Formula of Days left' });
    await userEvent.click(within(settings).getByRole('button', { name: 'What a formula can use' }));
    await expect(within(settings).getByRole('list', { name: 'Functions' })).toBeVisible();
  },
};

/** A person field limited to a group, with its default picker. */
export const PersonField: Story = {
  args: { id: 6, client: fakeFieldsClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText('People to choose from: the members of Reviewers'),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Change context Everywhere' }));
    await expect(canvas.getByLabelText('Offer')).toHaveValue('group');
  },
};

export const AtPhoneWidth: Story = {
  args: { id: 2, client: fakeFieldsClient() },
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Change context Payments bugs' }),
    );
    await expect(canvas.getByLabelText('OPS Operations')).toBeVisible();
    const box = canvas.getByTestId('phone-width');
    await expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
  },
};
