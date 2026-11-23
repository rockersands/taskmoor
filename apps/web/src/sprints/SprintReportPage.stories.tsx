import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { fakeSprintClient } from './fixtures';
import { SprintReportPage } from './SprintReportPage';

const meta = {
  title: 'Sprints/SprintReportPage',
  component: SprintReportPage,
  args: { boardId: 7, sprintId: 11, client: fakeSprintClient() },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof SprintReportPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Burndown, burnup and velocity; completed and open tickets, one added after the start. The
 * sprint says it is in progress and its dates, and the stacked tables' columns line up whatever
 * each holds (S3-ST-4, S3-ST-5).
 */
export const Report: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('3h → 5h')).toBeVisible();
    await expect(await canvas.findByRole('figure', { name: 'Burndown' })).toBeVisible();
    await expect(canvas.getByRole('figure', { name: 'Velocity' })).toBeVisible();
    await expect(canvas.getByText(/^In progress: /)).toBeVisible();
    const columns = (name: string) =>
      within(canvas.getByRole('region', { name }))
        .getAllByRole('columnheader')
        .map((header) => Math.round(header.getBoundingClientRect().left))
        .slice(2);
    await expect(columns('Tickets not completed')).toEqual(columns('Completed tickets'));
  },
};

/**
 * In a phone-wide card each row folds into two lines: the key and summary, then the status and
 * the estimate together, never a dash alone under the key (TR-11).
 */
export const RowsFoldInANarrowCard: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 340 }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const open = await canvas.findByRole('region', { name: 'Tickets not completed' });
    for (const row of within(open).getAllByRole('row').slice(1)) {
      const [key, summary, status, estimate] = within(row)
        .getAllByRole('cell')
        .map((cell) => cell.getBoundingClientRect());
      if (!key || !summary || !status || !estimate) throw new Error('a row with a missing cell');
      await expect(Math.round(summary.top)).toBe(Math.round(key.top));
      await expect(Math.round(estimate.top)).toBe(Math.round(status.top));
      await expect(status.top).toBeGreaterThanOrEqual(key.bottom - 1);
      await expect(estimate.right).toBeLessThanOrEqual(row.getBoundingClientRect().right + 0.5);
    }
  },
};

/** A key much longer than the one above it, as a long-lived track has (S3-TR-4). */
const longKeys = (() => {
  const client = fakeSprintClient();
  return {
    ...client,
    report: async (sprintId: number) => {
      const report = await client.report(sprintId);
      return {
        ...report,
        notCompleted: report.notCompleted.map((ticket, at) =>
          at === 1 ? { ...ticket, key: 'CHK-10666' } : ticket,
        ),
      };
    },
  };
})();

/**
 * S3-TR-4: folded in a phone-wide card, the rows still share the table's columns, so every
 * summary starts at the same place whatever its key's length, and the heading's "Summary" over
 * them; the heading is one band, with no notch where a cell's background stops.
 */
export const SummariesLineUpInANarrowCard: Story = {
  args: { client: longKeys },
  decorators: [
    (Story) => (
      <div style={{ width: 340 }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const open = await canvas.findByRole('region', { name: 'Tickets not completed' });
    await within(open).findByText('CHK-10666');
    const lefts = Array.from(open.querySelectorAll<HTMLElement>('.sprint-report-summary'), (cell) =>
      Math.round(cell.getBoundingClientRect().left),
    );
    await expect(lefts).toHaveLength(3);
    await expect(new Set(lefts).size).toBe(1);
    const head = open.querySelector('thead tr');
    if (!head) throw new Error('the table has its heading');
    await expect(getComputedStyle(head).backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    for (const cell of head.querySelectorAll('th')) {
      await expect(getComputedStyle(cell).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    }
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
