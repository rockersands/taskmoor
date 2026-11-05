import type { Meta as StoryMeta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, within } from 'storybook/test';
import type { MetaClient } from './client';
import { UpdateBanner, VersionGate } from './VersionGate';

const backend: MetaClient = {
  meta: async () => ({
    version: '1.4.2',
    frontend: { minimum: '1.3.0', recommended: '1.4.0' },
    instance: { id: 'i-1', name: 'Acme', publicKey: '' },
  }),
};

const meta = {
  title: 'Shell/VersionGate',
  component: VersionGate,
  args: {
    client: backend,
    version: '1.3.5',
    children: (
      <main style={{ padding: 24 }}>
        <UpdateBanner />
        <h1>Board</h1>
      </main>
    ),
  },
} satisfies StoryMeta<typeof VersionGate>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One release behind: the app works, with a notice above the page. */
export const UpdateAvailable: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('region', { name: 'A newer version is available.' }),
    ).toBeVisible();
  },
};

/** Older than the backend serves: this page instead of the app. */
export const UpdateRequired: Story = {
  args: { version: '1.2.0' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', { level: 1, name: 'Update required' }),
    ).toBeVisible();
  },
};

/** A frontend kit pinned to another instance than the backend that answers. */
export const WrongInstance: Story = {
  args: {
    version: '1.4.0',
    pin: { id: 'another-instance', publicKey: `MCowBQYDK2VwAyEA${'A'.repeat(43)}` },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', { level: 1, name: 'This app belongs to another server' }),
    ).toBeVisible();
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

export const UpdateAvailableAtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('region', { name: 'A newer version is available.' }),
    ).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

export const UpdateRequiredAtPhoneWidth: Story = {
  args: { version: '1.2.0' },
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', { level: 1, name: 'Update required' }),
    ).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};
