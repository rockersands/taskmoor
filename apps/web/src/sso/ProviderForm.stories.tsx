import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ApiError } from '../api/client';
import { GROUPS, PROVIDERS } from './fixtures';
import { ProviderForm } from './ProviderForm';

const meta = {
  title: 'Admin/ProviderForm',
  component: ProviderForm,
  args: { groups: GROUPS, onSave: async () => {}, onCancel: () => {} },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 720 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof ProviderForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NewProvider: Story = {};

export const Editing: Story = { args: { provider: PROVIDERS[0] } };

export const EditingWithoutSecret: Story = { args: { provider: PROVIDERS[1] } };

export const GroupsUnavailable: Story = { args: { provider: PROVIDERS[0], groups: null } };

export const InsecureIssuer: Story = {
  args: {
    provider: PROVIDERS[1],
    onSave: async () => {
      throw new ApiError(400, { error: 'insecure_issuer', detail: 'The issuer must use HTTPS' });
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Enabled' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Save changes' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('https://');
  },
};

export const Phone: Story = {
  args: { provider: PROVIDERS[0] },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
