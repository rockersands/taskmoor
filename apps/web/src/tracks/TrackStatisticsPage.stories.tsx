import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import type { Board } from '../boards/client';
import { fakeReportClient, REPORT_BOARD, SCRUM_REPORT_BOARD } from '../reports/fixtures';
import { fakeSprintClient } from '../sprints/fixtures';
import { fakeTrackClient } from './fixtures';
import { TrackStatisticsPage } from './TrackStatisticsPage';

const inTrack = (board: Board): Board => ({
  ...board,
  location: { type: 'track', track: { id: 1, key: 'SHOP', name: 'Shop' } },
});
const KANBAN = inTrack(REPORT_BOARD);
const SCRUM = inTrack(SCRUM_REPORT_BOARD);

const meta = {
  title: 'Tracks/TrackStatisticsPage',
  component: TrackStatisticsPage,
  args: {
    trackKey: 'SHOP',
    board: KANBAN,
    report: 'cumulative-flow',
    reports: fakeReportClient(KANBAN),
    sprints: fakeSprintClient(),
    client: fakeTrackClient(),
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof TrackStatisticsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Every report of the track in its groups, here how its work flows. */
export const Flow: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('figure', { name: 'Cumulative flow' })).toBeVisible();
  },
};

/** A report of the track's tickets, with the period to choose. */
export const CreatedVsClosed: Story = {
  args: { report: 'created-vs-closed' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('figure', { name: 'Created vs closed' })).toBeVisible();
  },
};

/** Any two fields against each other. */
export const TwoDimensional: Story = {
  args: { report: 'two-dimensional' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('region', { name: 'Two-dimensional statistics' }),
    ).toBeVisible();
  },
};

/** A sprint report on a Kanban board says what it needs. */
export const NeedsScrum: Story = {
  args: { report: 'sprint-report' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Sprint report needs a Scrum board')).toBeVisible();
  },
};

/** The running sprint on a Scrum board, and the others to choose. */
export const SprintReport: Story = {
  args: { report: 'sprint-report', board: SCRUM, reports: fakeReportClient(SCRUM) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('figure', { name: 'Burndown' })).toBeVisible();
  },
};

export const Velocity: Story = {
  args: { report: 'velocity', board: SCRUM, reports: fakeReportClient(SCRUM) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('figure', { name: 'Velocity' })).toBeVisible();
  },
};

/** Tickets counted by one of their dates, period by period (RPT-002). */
export const TicketsByDate: Story = {
  args: { report: 'time-since' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('figure', { name: 'Tickets by date' })).toBeVisible();
  },
};

/** The track's tickets grouped by one field, each group with its done share and first tickets. */
export const GroupedTickets: Story = {
  args: { report: 'group-by' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('list', { name: 'Grouped tickets' })).toBeVisible();
  },
};

/** Estimates and time spent added up, with the tickets that carry them. */
export const TimeTracking: Story = {
  args: { report: 'time-tracking', board: SCRUM, reports: fakeReportClient(SCRUM) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('region', { name: 'Time tracking' })).toBeVisible();
  },
};

/** The remaining estimate of the open tickets, by assignee. */
export const WorkloadByPerson: Story = {
  args: { report: 'user-workload' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('region', { name: 'Workload by person' })).toBeVisible();
  },
};

/** A time statistic by any field, as a pie. */
export const WorkloadPie: Story = {
  args: { report: 'workload-pie' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('figure', { name: 'Workload pie chart' })).toBeVisible();
  },
};

/** An outcome's work day by day, with its tickets done and still open (RPT-001). */
export const OutcomeReport: Story = {
  args: { report: 'outcome-report', board: SCRUM, reports: fakeReportClient(SCRUM) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(
      await canvas.findByRole('combobox', { name: 'Outcome' }),
      'SHOP-51',
    );
    await expect(
      await canvas.findByRole('region', { name: 'Tickets under the outcome' }),
    ).toBeVisible();
  },
};

/**
 * In a narrow column the links wrap: every row of a group starts where its first link does, in
 * a column of its own beside the labels, never back under the label (TR-6).
 */
export const WrappedLinksLineUp: Story = {
  args: { board: SCRUM, reports: fakeReportClient(SCRUM) },
  decorators: [
    (Story) => (
      <div style={{ width: 520 }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const nav = await canvas.findByRole('navigation', { name: 'Reports' });
    const starts = new Set<number>();
    let wrapped = 0;
    for (const group of within(nav).getAllByRole('group')) {
      const links = within(group).getAllByRole('link');
      const first = links[0]?.getBoundingClientRect();
      const label = group.querySelector('.statistics-tab-label')?.getBoundingClientRect();
      if (!first || !label) throw new Error('a group with no label or links');
      await expect(label.right).toBeLessThanOrEqual(first.left);
      starts.add(Math.round(first.left));
      for (const link of links.slice(1)) {
        const box = link.getBoundingClientRect();
        if (box.top > first.top + 1 && box.left < first.left + 1) {
          wrapped += 1;
          await expect(Math.round(box.left)).toBe(Math.round(first.left));
        }
      }
    }
    // The column of links is one for every group, and some rows did wrap.
    await expect(starts.size).toBe(1);
    await expect(wrapped).toBeGreaterThan(0);
  },
};

export const Phone: Story = {
  args: { report: 'created-vs-closed' },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

/** The longest table of the new reports, on a phone. */
export const PhoneTimeTracking: Story = {
  args: { report: 'time-tracking', board: SCRUM, reports: fakeReportClient(SCRUM) },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
