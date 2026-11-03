import type { Meta, StoryObj } from '@storybook/react-vite';
import { fakeTemplateClient, RELEASE_TEMPLATE, TEMPLATE_OPTIONS } from './fixtures';
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
