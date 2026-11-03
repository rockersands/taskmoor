import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ApiError } from '../api/client';
import { GOOGLE_PROVIDER, GROUPS, PROVIDERS, REDIRECT_URI, SAML_PROVIDER } from './fixtures';
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

/** The Google choice (IAM-031): safe settings filled in, and what to register at Google. */
const chooseGoogle = async (canvasElement: HTMLElement) => {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole('radio', { name: 'Google' }));
  await expect(canvas.getByLabelText('Issuer URL')).toHaveValue('https://accounts.google.com');
  await expect(canvas.getByText(REDIRECT_URI)).toBeVisible();
  return canvas;
};

export const NewGoogleProvider: Story = {
  args: { redirectUri: REDIRECT_URI },
  play: async ({ canvasElement }) => {
    await chooseGoogle(canvasElement);
  },
};

export const GoogleOpensToAnyone: Story = {
  args: { redirectUri: REDIRECT_URI },
  play: async ({ canvasElement }) => {
    const canvas = await chooseGoogle(canvasElement);
    await userEvent.click(canvas.getByRole('checkbox', { name: /Create accounts/ }));
    await expect(canvas.getByRole('alert')).toHaveTextContent('could join this site');
  },
};

export const GoogleEnforcedOnPublicDomain: Story = {
  args: { redirectUri: REDIRECT_URI },
  play: async ({ canvasElement }) => {
    const canvas = await chooseGoogle(canvasElement);
    await userEvent.click(canvas.getByRole('checkbox', { name: /Enforce single sign-on/ }));
    await expect(canvas.getByRole('alert')).toHaveTextContent('blocks password sign-in');
  },
};

export const EditingGoogle: Story = {
  args: { provider: GOOGLE_PROVIDER, redirectUri: REDIRECT_URI },
};

export const GooglePhone: Story = {
  args: { redirectUri: REDIRECT_URI },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  decorators: [
    (Story) => (
      <div style={{ width: 320 }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = await chooseGoogle(canvasElement);
    await userEvent.click(canvas.getByRole('checkbox', { name: /Create accounts/ }));
    await userEvent.click(canvas.getByRole('checkbox', { name: /Enforce single sign-on/ }));
    await expect(canvas.getAllByRole('alert')).toHaveLength(2);
    // No sideways scrolling, with the long redirect URI and both warnings on screen.
    const form = canvas.getByRole('form');
    await expect(form.scrollWidth).toBeLessThanOrEqual(form.clientWidth);
  },
};
