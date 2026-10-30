import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { McpPage } from './McpPage';

const meta = {
  title: 'Admin/McpPage',
  component: McpPage,
  args: {
    origin: 'https://tracker.example.com',
    client: {
      load: async () => ({ enabled: true, allowedClients: ['claude-code'], profile: 'planner' }),
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
