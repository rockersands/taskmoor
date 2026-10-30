import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { BoardReportsPage } from './BoardReportsPage';
import { fakeReportClient } from './fixtures';

const meta = {
  title: 'Reports/BoardReportsPage',
  component: BoardReportsPage,
  args: { boardId: 7, report: 'cumulative-flow', client: fakeReportClient() },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof BoardReportsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Tickets per column over four weeks, with the board filters to narrow them. */
export const CumulativeFlow: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('figure', { name: 'Cumulative flow' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Cumulative flow' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  },
};

/** Cycle time per ticket over the doing, blocked and review columns, averaged over seven. */
export const ControlChart: Story = {
  args: { report: 'control-chart' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('figure', { name: 'Control chart' })).toBeVisible();
    await expect(canvas.getByRole('checkbox', { name: 'Doing' })).toBeChecked();
  },
};

export const CycleTime: Story = {
  args: { report: 'cycle-time' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('figure', { name: 'Cycle time distribution' }),
    ).toBeVisible();
  },
};

export const TimeInStatus: Story = {
  args: { report: 'time-in-status' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('figure', { name: 'Average time in status' }),
    ).toBeVisible();
    // The full table, after the chart's own.
    await expect(canvas.getAllByRole('rowheader', { name: 'Parked' }).at(-1)).toBeVisible();
  },
};

export const Phone: Story = {
  args: { report: 'control-chart' },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
