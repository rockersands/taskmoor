import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, within } from 'storybook/test';
import { McpPage } from './McpPage';

const meta = {
  title: 'Admin/McpPage',
  component: McpPage,
  args: {
    origin: 'https://tracker.example.com',
    client: {
      load: async () => ({
        enabled: true,
        allowedClients: ['claude-code'],
        profile: 'planner',
        oauthRegistration: true,
      }),
      save: async (s) => s,
    },
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof McpPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The settings with one allowed client, and how to connect. */
export const Settings: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('radio', { name: /Planner/ })).toBeChecked();
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
    await expect(await canvas.findByRole('radio', { name: /Planner/ })).toBeChecked();
    await fitsPhoneWidth(canvas);
  },
};

/** The settings could not be read: the header stays, with the failure under it. */
export const LoadFailed: Story = {
  args: {
    client: {
      load: async () => {
        throw new Error('network');
      },
      save: async (s) => s,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toBeVisible();
    await expect(canvas.getByRole('heading', { level: 1 })).toBeVisible();
  },
};
