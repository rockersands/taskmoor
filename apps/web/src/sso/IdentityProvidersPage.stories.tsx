import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ADMIN, MEMBER } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { fakeIdentityProvidersClient, PROVIDERS } from './fixtures';
import { IdentityProvidersPage } from './IdentityProvidersPage';

const meta = {
  title: 'Admin/IdentityProvidersPage',
  component: IdentityProvidersPage,
  args: { client: fakeIdentityProvidersClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof IdentityProvidersPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Providers: Story = {};

export const NoProviders: Story = {
  args: { client: fakeIdentityProvidersClient([]) },
};

export const AddingAProvider: Story = {
  // Its own store: adding changes it.
  args: { client: fakeIdentityProvidersClient([]) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Add an identity provider' }));
    await userEvent.keyboard('Contractors');
    await userEvent.type(canvas.getByLabelText('Issuer URL'), 'https://login.contractors.example');
    await userEvent.type(canvas.getByLabelText('Client ID'), 'taskmoor-web');
    await userEvent.type(canvas.getByLabelText('Domain'), 'contractors.example{Enter}');
    await userEvent.click(canvas.getByRole('button', { name: 'Add provider' }));
    await expect(await canvas.findByText('Added Contractors.')).toBeVisible();
  },
};

export const AddingASamlProvider: Story = {
  // Its own store: adding changes it.
  args: { client: fakeIdentityProvidersClient([]) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Add an identity provider' }));
    await userEvent.keyboard('Agency');
    await userEvent.click(canvas.getByRole('radio', { name: 'SAML 2.0' }));
    await userEvent.type(
      canvas.getByLabelText('Identity provider metadata'),
      '<md:EntityDescriptor entityID="https://id.agency.example"/>',
    );
    await userEvent.type(canvas.getByLabelText('Domain'), 'agency.example{Enter}');
    await userEvent.click(canvas.getByRole('button', { name: 'Add provider' }));
    await expect(await canvas.findByText('Added Agency.')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Taskmoor metadata for Agency' })).toBeVisible();
  },
};

export const EditingASamlProvider: Story = {
  args: { client: fakeIdentityProvidersClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Edit Contractors' }));
    await expect(canvas.getByRole('form', { name: 'Edit Contractors' })).toBeVisible();
  },
};

export const EditingAProvider: Story = {
  args: { client: fakeIdentityProvidersClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Edit Staff accounts' }));
    await expect(canvas.getByRole('form', { name: 'Edit Staff accounts' })).toBeVisible();
  },
};

export const DomainAlreadyServed: Story = {
  args: { client: fakeIdentityProvidersClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Edit Partners' }));
    await userEvent.type(canvas.getByLabelText('Domain'), 'corp.example{Enter}');
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Enabled' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Save changes' }));
    await expect(await canvas.findByText(/already serves corp\.example/)).toBeVisible();
  },
};

export const ConfirmingDelete: Story = {
  args: { client: fakeIdentityProvidersClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Delete Partners' }));
    await expect(canvas.getByRole('button', { name: 'Delete provider' })).toHaveFocus();
  },
};

export const GroupsUnavailable: Story = {
  args: {
    client: fakeIdentityProvidersClient(PROVIDERS, {
      groups: async () => {
        throw new Error('network');
      },
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Edit Staff accounts' }));
  },
};

export const Loading: Story = {
  args: { client: fakeIdentityProvidersClient(PROVIDERS, { list: () => new Promise(() => {}) }) },
};

export const Failed: Story = {
  args: {
    client: fakeIdentityProvidersClient(PROVIDERS, {
      list: async () => {
        throw new Error('network');
      },
    }),
  },
};

export const NotAnAdministrator: Story = {
  decorators: [
    (Story) => (
      <SessionProvider session={MEMBER}>
        <Story />
      </SessionProvider>
    ),
  ],
};

export const Phone: Story = {
  args: { client: fakeIdentityProvidersClient() },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Edit Staff accounts' }));
  },
};
