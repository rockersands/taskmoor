import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { expect, waitFor, within } from 'storybook/test';
import { ReportTable } from './ReportTable';

const SPRINTS = ['Sprint 1', 'Sprint 2', 'Sprint 3', 'Sprint 4', 'Sprint 5', 'Sprint 6'];
const ROWS = [
  { name: 'Committed', values: [30, 28, 34, 26, 31, 29] },
  { name: 'Completed', values: [24, 21, 30, 18, 22, 27] },
];

/** Tells the table below to load its other columns, as a report's later data would. */
const more = new EventTarget();

/**
 * A report table whose columns arrive after the first paint, from state of its own: the report
 * table's children stay the same element, so only watching the table's size can see it grow.
 */
function LoadingTable({ columns }: { columns: number }) {
  const [shown, setShown] = useState(columns);
  useEffect(() => {
    const grow = () => setShown(SPRINTS.length);
    more.addEventListener('grow', grow);
    return () => more.removeEventListener('grow', grow);
  }, []);
  return (
    <table className="data-table report-numbers">
      <thead>
        <tr>
          <th scope="col">Points</th>
          {SPRINTS.slice(0, shown).map((sprint) => (
            <th key={sprint} scope="col">
              {sprint}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {ROWS.map((row) => (
          <tr key={row.name}>
            <th scope="row">{row.name}</th>
            {row.values.slice(0, shown).map((value, i) => (
              <td key={SPRINTS[i]}>{value}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const meta = {
  title: 'Reports/ReportTable',
  component: ReportTable,
  args: { label: 'Points per sprint', children: null },
  render: (args, { parameters }) => (
    <ReportTable label={args.label}>
      <LoadingTable columns={Number(parameters.columns ?? 1)} />
    </ReportTable>
  ),
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <div style={{ width: 280, maxWidth: '100%' }}>
          <Story />
        </div>
      </main>
    ),
  ],
} satisfies Meta<typeof ReportTable>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A table wider than its card: the end fades, saying more columns wait that way. */
export const Wide: Story = {
  parameters: { columns: SPRINTS.length },
  play: async ({ canvasElement }) => {
    const region = within(canvasElement).getByRole('region', { name: 'Points per sprint' });
    await waitFor(() => expect(region).toHaveAttribute('data-more', 'end'));
  },
};

/**
 * The table grows wider than its card after the first paint (T-275): the fade appears, though the
 * card kept its width, and lifts while focus is in the table so its ring is never faded. Where
 * scroll bars take room, the bar's arrival changes the card's height too; where they float over
 * the content (phones, macOS) nothing but the table's own growth says so.
 */
export const GrowsAfterMount: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const region = canvas.getByRole('region', { name: 'Points per sprint' });
    await waitFor(() => expect(region).toHaveAttribute('data-more', 'none'));
    await expect(getComputedStyle(region).maskImage).toBe('none');
    const width = region.getBoundingClientRect().width;

    more.dispatchEvent(new Event('grow'));
    await canvas.findByRole('columnheader', { name: 'Sprint 6' });
    await expect(region.scrollWidth).toBeGreaterThan(region.clientWidth);
    await expect(region.getBoundingClientRect().width).toBe(width);
    await waitFor(() => expect(region).toHaveAttribute('data-more', 'end'));
    await expect(getComputedStyle(region).maskImage).toContain('linear-gradient');

    region.focus();
    await expect(getComputedStyle(region).maskImage).toBe('none');
    region.blur();
  },
};

/**
 * Scrolled to the end of a table that already overflows, and more columns load (T-275): the card's
 * size and its scroll bar stay as they were, so only the table's own growth can say that more now
 * waits past the end too. The fade covers both ends.
 */
export const GrowsWhileScrolledToTheEnd: Story = {
  parameters: { columns: 4 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const region = canvas.getByRole('region', { name: 'Points per sprint' });
    await waitFor(() => expect(region).toHaveAttribute('data-more', 'end'));
    region.scrollLeft = region.scrollWidth;
    await waitFor(() => expect(region).toHaveAttribute('data-more', 'start'));
    const size = region.getBoundingClientRect().toJSON();

    more.dispatchEvent(new Event('grow'));
    await canvas.findByRole('columnheader', { name: 'Sprint 6' });
    await expect(region.getBoundingClientRect().toJSON()).toEqual(size);
    await waitFor(() => expect(region).toHaveAttribute('data-more', 'both'));
    await expect(getComputedStyle(region).maskImage).toContain('linear-gradient');
  },
};
