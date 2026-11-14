import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import type { Board } from '../boards/client';
import { fakeReportClient, REPORT_BOARD, SCRUM_REPORT_BOARD } from '../reports/fixtures';
import { fakeSprintClient } from '../sprints/fixtures';
import { fakeTrackClient, GROUP_BY, TIME_TRACKING, TWO_DIMENSIONAL } from './fixtures';
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

/**
 * The longest table of the new reports, on a phone. The three figures share a row and the verdict
 * takes the next one whole, so no tile stands half empty beside a wrapped verdict (S3-ST-1).
 */
export const PhoneTimeTracking: Story = {
  args: { report: 'time-tracking', board: SCRUM, reports: fakeReportClient(SCRUM) },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const verdict = (await canvas.findByText('1h under the estimate')).closest('div');
    const list = verdict?.closest('dl');
    if (!verdict || !list) throw new Error('no verdict tile');
    const tiles = [...list.children].map((tile) => tile.getBoundingClientRect());
    const [original, spent, remaining, last] = tiles;
    if (!original || !spent || !remaining || !last) throw new Error('four tiles expected');
    await expect(Math.round(spent.top)).toBe(Math.round(original.top));
    await expect(Math.round(remaining.top)).toBe(Math.round(original.top));
    await expect(last.top).toBeGreaterThanOrEqual(original.bottom);
    await expect(Math.round(last.width)).toBe(Math.round(list.getBoundingClientRect().width));
  },
};

/** The colour a custom property resolves to, as computed styles write colours. */
function resolved(property: string): string {
  const probe = document.createElement('span');
  probe.style.color = `var(${property})`;
  document.body.append(probe);
  const colour = getComputedStyle(probe).color;
  probe.remove();
  return colour;
}

/** Keys of different lengths, so summaries that start where each key ends would show it. */
const UNEVEN_GROUPS = {
  ...GROUP_BY,
  values: GROUP_BY.values.map((group, i) => ({
    ...group,
    tickets: group.tickets.map((ticket, j) => ({
      ...ticket,
      key: i === 0 && j === 0 ? 'SHOP-7' : `SHOP-${1200 + j + i}`,
    })),
  })),
};

/**
 * Grouped tickets read as one table: every summary starts at one place across the groups, a long
 * group links to the search for all of it, apart from its last ticket, and an empty progress
 * track keeps the field's edge (S3-ST-2, S3-ST-6, S3-ST-7).
 */
export const GroupedTicketsLineUp: Story = {
  args: {
    report: 'group-by',
    client: (() => {
      const client = fakeTrackClient();
      client.statistics = async () => UNEVEN_GROUPS;
      return client;
    })(),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const groups = await canvas.findByRole('list', { name: 'Grouped tickets' });
    const starts = new Set(
      [...groups.querySelectorAll('.widget-ticket-summary')].map((summary) =>
        Math.round(summary.getBoundingClientRect().left),
      ),
    );
    await expect(starts.size).toBe(1);
    const all = within(groups).getByRole('link', { name: 'See all 3 in Search' });
    await expect(all).toBeVisible();
    const lastTicket = groups.querySelector('.widget-tickets li:last-child');
    const more = all.closest('p');
    if (!lastTicket || !more) throw new Error('no group to measure');
    await expect(more.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      groups.querySelector('.widget-tickets')?.getBoundingClientRect().bottom ?? 0,
    );
    const empty = [...groups.querySelectorAll('.widget-share-track')].at(-1);
    if (!empty) throw new Error('no progress track');
    await expect(getComputedStyle(empty).boxShadow).toContain(resolved('--color-field-border'));
  },
};

/** Four statuses by five priorities, as the sweep's track has them. */
const WIDE_GRID = {
  ...TWO_DIMENSIONAL,
  x: ['New', 'Active', 'In Review', 'Closed'].map((name, i) => ({
    id: String(i + 1),
    name,
    kind: 'value',
    total: 10,
  })),
  y: [
    ...['Urgent', 'High', 'Normal', 'Low'].map((name, i) => ({
      id: String(i + 1),
      name,
      kind: 'value',
      total: 10,
    })),
    { id: null, name: null, kind: 'none', total: 0 },
  ],
  cells: [
    [2, 3, 12, 3, 0],
    [1, 3, 10, 6, 0],
    [0, 4, 3, 1, 0],
    [0, 1, 3, 2, 0],
  ],
  total: 40,
};

/**
 * Two-dimensional statistics on a phone, in a card as wide as the sweep's at 375 px: every column
 * fits, Total included, and the corner heading sits in the header band (second sweep, S3-ST-8).
 */
export const PhoneTwoDimensional: Story = {
  args: {
    report: 'two-dimensional',
    client: (() => {
      const client = fakeTrackClient();
      client.statistics = async () => WIDE_GRID;
      return client;
    })(),
  },
  globals: { viewport: { value: 'mobile2', isRotated: false } },
  decorators: [
    (Story) => (
      <div style={{ width: 343 }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const region = await canvas.findByRole('region', { name: 'Two-dimensional statistics' });
    await expect(window.innerWidth).toBeLessThan(768);
    await expect(within(region).getByRole('columnheader', { name: 'Total' })).toBeVisible();
    await expect(region.scrollWidth).toBeLessThanOrEqual(region.clientWidth);
    const [corner, first] = within(region).getAllByRole('columnheader');
    if (!corner || !first) throw new Error('no header');
    await expect(corner.textContent).toBe('Status');
    await expect(getComputedStyle(corner).backgroundColor).toBe(
      getComputedStyle(first).backgroundColor,
    );
  },
};

/** Nothing estimated and nothing logged: a reason, not zeros and a verdict on them (S3-ST-1). */
export const TimeTrackingWithNothingEstimated: Story = {
  args: {
    report: 'time-tracking',
    board: SCRUM,
    reports: fakeReportClient(SCRUM),
    client: (() => {
      const client = fakeTrackClient();
      client.statistics = async () => ({
        ...TIME_TRACKING,
        estimated: 0,
        original: 0,
        remaining: 0,
        spent: 0,
        rows: [],
      });
      return client;
    })(),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Nothing estimated or logged yet')).toBeVisible();
    await expect(canvas.queryByText('On the estimate')).toBeNull();
  },
};
