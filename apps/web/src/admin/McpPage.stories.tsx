import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, within } from 'storybook/test';
import { McpPage } from './McpPage';
import { textLines } from './textLines';

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

/**
 * 'Tools agents get' heads its group inside the panel, as the groups on Security and Network
 * access do, not on the panel's top border (S3-AC-9).
 */
export const ToolsGroupHeadingInside: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const group = await canvas.findByRole('group', { name: 'Tools agents get' });
    const legend = group.querySelector('legend') as HTMLElement;
    const box = group.getBoundingClientRect();
    const top = box.top + parseFloat(getComputedStyle(group).borderTopWidth);
    await expect(legend.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      top + parseFloat(getComputedStyle(group).paddingTop) - 1,
    );
    await expect(legend.getBoundingClientRect().left).toBeGreaterThan(box.left);
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

/**
 * On a phone the stdio command wraps at its spaces and after a '/', never inside the host or the
 * port: it once broke as 'localhost:809' and '0' (AD-35).
 */
export const CommandBreaksAtSlashes: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 300 }}>
        <Story />
      </div>
    ),
  ],
  args: { origin: 'http://localhost:8090' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const command = (await canvas.findByText(/^TASKMOOR_URL=/)).closest('code') as HTMLElement;
    await expect(command.textContent).toBe(
      'TASKMOOR_URL=http://localhost:8090 TASKMOOR_TOKEN=<token> node cli.mjs mcp',
    );
    const lines = textLines(command);
    await expect(lines.length).toBeGreaterThan(1);
    await expect(lines.slice(0, -1).filter((line) => !/[/\s]$/.test(line))).toEqual([]);
  },
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
