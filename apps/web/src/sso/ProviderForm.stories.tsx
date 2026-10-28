import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ApiError } from '../api/client';
import { GROUPS, PROVIDERS, SAML_PROVIDER } from './fixtures';
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

/** A new provider switched to SAML 2.0: metadata, or the settings by hand. */
export const NewSamlProvider: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('radio', { name: 'SAML 2.0' }));
    await expect(canvas.getByLabelText('Identity provider metadata')).toBeVisible();
  },
};

export const EditingSaml: Story = { args: { provider: SAML_PROVIDER } };

export const SamlIncomplete: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText('Name'), 'Agency');
    await userEvent.click(canvas.getByRole('radio', { name: 'SAML 2.0' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Add provider' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('Paste the metadata');
  },
};

export const InvalidMetadata: Story = {
  args: {
    provider: SAML_PROVIDER,
    onSave: async () => {
      throw new ApiError(400, { error: 'invalid_metadata', detail: 'No identity provider' });
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText('Identity provider metadata'), '<not-metadata/>');
    await userEvent.click(canvas.getByRole('button', { name: 'Save changes' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('metadata');
  },
};

export const SamlPhone: Story = {
  args: { provider: SAML_PROVIDER },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
