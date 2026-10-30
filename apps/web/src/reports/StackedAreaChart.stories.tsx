import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { flowFixture } from './fixtures';
import { StackedAreaChart } from './StackedAreaChart';

const flow = flowFixture();
const day = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

const meta = {
  title: 'Reports/StackedAreaChart',
  component: StackedAreaChart,
  args: {
    title: 'Cumulative flow',
    summary: 'Cumulative flow over 28 days: 63 tickets on the board on the last day.',
    xLabels: flow.dates.map(day),
    layers: flow.columns.map((c) => ({ id: c.id, label: c.name, values: c.counts })),
    format: String,
    tableLabel: 'Show the numbers',
    xHeader: 'Day',
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 820 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof StackedAreaChart>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Five columns, from the lightest blue (to do) to the darkest (done) at the bottom. */
export const CumulativeFlow: Story = {};

/** Three columns take the ramp's ends and its middle. */
export const ThreeColumns: Story = {
  args: {
    layers: flow.columns
      .filter((c) => ['todo', 'doing', 'done'].includes(c.id))
      .map((c) => ({ id: c.id, label: c.name, values: c.counts })),
  },
};

export const Hovered: Story = {
  play: async ({ canvasElement }) => {
    const plot = canvasElement.querySelector('.chart-plot') as HTMLElement;
    const box = plot.getBoundingClientRect();
    await userEvent.pointer({
      target: plot,
      coords: { clientX: box.left + box.width / 2, clientY: box.top + 80 },
    });
    await expect(canvasElement.querySelector('.chart-tooltip')).not.toBeNull();
  },
};

export const WithTable: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText('Show the numbers'));
    await expect(canvas.getByRole('table')).toBeVisible();
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
