import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import {
  fakeTemplateClient,
  HOTFIX_TEMPLATE,
  RELEASE_TEMPLATE,
  TEMPLATE_OPTIONS,
} from './fixtures';
import { TemplateForm } from './TemplateForm';

const meta = {
  title: 'Tickets/TemplateForm',
  component: TemplateForm,
  args: {
    client: fakeTemplateClient(),
    track: 'SHOP',
    options: TEMPLATE_OPTIONS,
    template: null,
    onSaved: () => {},
    onCancel: () => {},
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof TemplateForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NewTemplate: Story = {};

export const Editing: Story = { args: { template: RELEASE_TEMPLATE } };

/** Custom release and area values by name, an archived one marked, each with Remove (T-291). */
export const ReleaseAndAreaValues: Story = {
  args: { template: HOTFIX_TEMPLATE, client: fakeTemplateClient([HOTFIX_TEMPLATE]) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const fixedIn = canvas.getByRole('list', { name: 'Fixed in' });
    await expect(within(fixedIn).getByText('0.9 (archived)')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Remove Checkout from Owning area' }));
    await expect(canvas.getByText('None: saving leaves this field empty.')).toHaveFocus();
  },
};

/** A refused save: each reason under its value, the line above the buttons says so (T-291). */
export const Refused: Story = {
  args: {
    template: HOTFIX_TEMPLATE,
    client: fakeTemplateClient([HOTFIX_TEMPLATE], {
      refuse: {
        'defaults.targetReleaseIds.0': 'archived',
        'defaults.fields.12': 'not_in_track',
        'defaults.priorityId': 'not_found',
      },
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Save the template' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(
      'Some values cannot be used. The reason is under each of them.',
    );
    await expect(
      canvas.getByRole('listbox', { name: 'Target releases' }),
    ).toHaveAccessibleDescription('This release or area is archived. Choose another.');
  },
};

export const RefusedOnAPhone: Story = {
  ...Refused,
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
