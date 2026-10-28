import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ApiError } from '../api/client';
import { DirectoryForm } from './DirectoryForm';
import { HEAD_OFFICE, LAB, PRESETS } from './fixtures';

const meta = {
  title: 'Admin/DirectoryForm',
  component: DirectoryForm,
  args: {
    presets: PRESETS,
    onSave: async () => {},
    onTest: async () => ({ ok: false, error: 'bind_refused' }),
    onCancel: () => {},
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 720 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof DirectoryForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NewDirectory: Story = {};

export const Editing: Story = { args: { directory: HEAD_OFFICE } };

export const EditingReadWrite: Story = {
  args: { directory: LAB },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText('Attribute names'));
    await expect(canvas.getByLabelText('Email')).toHaveValue('mailPrimaryAddress');
  },
};

export const ServiceAccountRefused: Story = {
  args: { directory: HEAD_OFFICE },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Test connection' }));
    await expect(await canvas.findByText(/refused the service account/)).toBeVisible();
  },
};

export const PlainLdapRefused: Story = {
  args: {
    onSave: async () => {
      throw new ApiError(400, { error: 'insecure_transport' });
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.keyboard('Lab');
    await userEvent.type(canvas.getByLabelText('URL'), 'ldap://ldap.lab.example');
    await userEvent.type(canvas.getByLabelText('Bind DN'), 'cn=taskmoor,dc=lab,dc=example');
    await userEvent.type(canvas.getByLabelText('Password'), 'stories-only');
    await userEvent.type(canvas.getByLabelText('Base DN'), 'dc=lab,dc=example');
    await userEvent.click(canvas.getByRole('button', { name: 'Add directory' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('StartTLS');
  },
};

export const Phone: Story = {
  args: { directory: HEAD_OFFICE },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
