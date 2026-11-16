import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { ADMIN, MEMBER } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { DirectoriesPage } from './DirectoriesPage';
import { fakeDirectoriesClient, HEAD_OFFICE, LAB, SUCCEEDED } from './fixtures';

const meta = {
  title: 'Admin/DirectoriesPage',
  component: DirectoriesPage,
  args: { client: fakeDirectoriesClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof DirectoriesPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Directories: Story = {};

export const NoDirectories: Story = {
  args: { client: fakeDirectoriesClient([]) },
};

export const AddingADirectory: Story = {
  // Its own store: adding changes it.
  args: { client: fakeDirectoriesClient([]) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Add a directory' }));
    await userEvent.keyboard('Head office');
    await userEvent.type(canvas.getByLabelText('URL'), 'ldaps://dc1.corp.example');
    await userEvent.type(canvas.getByLabelText('Bind DN'), 'CN=Taskmoor,DC=corp,DC=example');
    await userEvent.type(canvas.getByLabelText('Password'), 'stories-only');
    await userEvent.type(canvas.getByLabelText('Base DN'), 'DC=corp,DC=example');
    await userEvent.click(canvas.getByRole('button', { name: 'Test connection' }));
    await expect(await canvas.findByText(/More than 1,000 people/)).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Add directory' }));
    await expect(await canvas.findByText(/Added Head office/)).toBeVisible();
  },
};

export const EditingADirectory: Story = {
  args: { client: fakeDirectoriesClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Edit Research lab' }));
    await expect(canvas.getByRole('form', { name: 'Edit Research lab' })).toBeVisible();
  },
};

export const History: Story = {
  args: { client: fakeDirectoriesClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'History of Head office' }));
    await expect(await canvas.findByText(/Skipped, it has no email address/)).toBeVisible();
  },
};

export const ConfirmingDelete: Story = {
  args: { client: fakeDirectoriesClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Delete Head office' }));
    await expect(canvas.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  },
};

export const ConfirmingRemovals: Story = {
  args: { client: fakeDirectoriesClient([HEAD_OFFICE, { ...LAB, enabled: true }]) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Sync and remove what left Research lab' }),
    );
    await expect(
      canvas.getByRole('group', { name: /removes 812 of its 1,200 people/ }),
    ).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  },
};

export const SyncWaiting: Story = {
  args: {
    client: fakeDirectoriesClient([
      { ...HEAD_OFFICE, lastRun: { ...SUCCEEDED, status: 'running' } },
      LAB,
    ]),
    pollMs: 60_000,
  },
};

export const Loading: Story = {
  args: { client: { ...fakeDirectoriesClient(), list: () => new Promise(() => {}) } },
};

export const Failed: Story = {
  args: {
    client: {
      ...fakeDirectoriesClient(),
      list: async () => {
        throw new Error('network');
      },
    },
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
  args: { client: fakeDirectoriesClient() },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Edit Head office' }));
  },
};

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

export const AtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Edit Head office' }));
    await expect(await canvas.findByRole('form')).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

/** The empty list says what would be here and how it gets here. */
export const NoDirectoriesExplains: Story = {
  ...NoDirectories,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('No directories yet')).toBeVisible();
    await expect(canvas.getByText(/^People and groups are managed/)).toBeVisible();
  },
};
