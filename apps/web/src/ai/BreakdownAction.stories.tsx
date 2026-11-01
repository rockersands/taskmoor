import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { fakeAiNoticeClient } from '../admin/aiUsageFixtures';
import { allAiFeatures, fakeAiClient } from './aiFixtures';
import { BreakdownAction } from './BreakdownAction';

const meta = {
  title: 'AI/BreakdownAction',
  component: BreakdownAction,
  args: {
    ticket: { id: 7, key: 'SHOP-7' },
    trackId: 1,
    client: fakeAiClient(),
    notice: fakeAiNoticeClient('2026-10-30T09:00:00Z'),
    features: allAiFeatures,
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof BreakdownAction>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Proposed children to edit and deselect; only the chosen ones are created, on confirmation. */
export const Proposed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Break down' }));
    const dialog = await canvas.findByRole('dialog', { name: 'Break down SHOP-7' });
    const inside = within(dialog);
    await userEvent.click(await inside.findByRole('checkbox', { name: 'Create child 2' }));
    const summary = inside.getByRole('textbox', { name: 'Summary of child 1' });
    await userEvent.clear(summary);
    await userEvent.type(summary, 'Store cards in the vault');
    await userEvent.click(inside.getByRole('button', { name: 'Create 2 tickets' }));
    await expect(await inside.findByRole('link', { name: 'Created SHOP-101' })).toBeVisible();
    await expect(inside.getByRole('link', { name: 'Created SHOP-102' })).toBeVisible();
  },
};

/** Open, before anything is created. */
export const Open: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Break down' }));
    await expect(await canvas.findByRole('button', { name: 'Create 3 tickets' })).toBeVisible();
  },
};
