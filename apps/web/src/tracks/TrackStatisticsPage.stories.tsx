import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
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

export const Phone: Story = {
  args: { report: 'created-vs-closed' },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
