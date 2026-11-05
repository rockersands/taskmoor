import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { BoardReportsPage } from './BoardReportsPage';
import { fakeReportClient, flowFixture, SCRUM_REPORT_BOARD } from './fixtures';

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

/** A Scrum board's release, sprint by sprint, with a forecast at its velocity (M1-062). */
export const ReleaseBurndown: Story = {
  args: { report: 'release-burndown', client: fakeReportClient(SCRUM_REPORT_BOARD) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('figure', { name: 'Remaining work' })).toBeVisible();
    await expect(canvas.getByRole('figure', { name: 'Work per sprint' })).toBeVisible();
  },
};

export const OutcomeBurndown: Story = {
  args: { report: 'outcome-burndown', client: fakeReportClient(SCRUM_REPORT_BOARD) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByRole('textbox', { name: 'Outcome' }), 'SHOP-7');
    await userEvent.click(canvas.getByRole('button', { name: 'Show' }));
    await expect(await canvas.findByRole('link', { name: 'SHOP-7' })).toBeVisible();
  },
};

export const ReleaseReport: Story = {
  args: { report: 'release-report', client: fakeReportClient(SCRUM_REPORT_BOARD) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('figure', { name: 'Release progress' })).toBeVisible();
  },
};

export const ReleaseBurndownPhone: Story = {
  args: { report: 'release-burndown', client: fakeReportClient(SCRUM_REPORT_BOARD) },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

/** A period with nothing to chart: what would be here and what to try. */
export const EmptyPeriod: Story = {
  args: {
    client: {
      ...fakeReportClient(),
      cumulativeFlow: async () => ({ ...flowFixture(), dates: [], columns: [], unmapped: [] }),
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText('No ticket of this board existed in this period.'),
    ).toBeVisible();
    await expect(canvas.getByText(/^Choose a longer period/)).toBeVisible();
  },
};
