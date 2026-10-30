import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { cycleFixture } from './fixtures';
import { ScatterChart } from './ScatterChart';

const cycle = cycleFixture();
const H = 3600;
const hours = (v: number) => `${Math.round((v / H) * 10) / 10}h`;
const date = (ms: number) =>
  new Date(ms).toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const points = cycle.points.map((p) => ({
  id: String(p.ticket.id),
  x: Date.parse(p.at),
  y: p.cycle,
  average: p.average,
  deviation: p.deviation,
  label: p.ticket.key,
  detail: p.ticket.summary,
  href: `#/tickets/${p.ticket.key}`,
}));

const meta = {
  title: 'Reports/ScatterChart',
  component: ScatterChart,
  args: {
    title: 'Control chart',
    summary: 'Control chart of 36 finished tickets: median cycle time 51h, average 54h.',
    points,
    from: Date.parse(`${cycle.from}T00:00:00Z`),
    to: Date.parse(`${cycle.to}T00:00:00Z`) + 86_400_000,
    formatX: date,
    formatY: hours,
    unit: H,
    labels: {
      points: 'Ticket',
      average: 'Rolling average',
      band: 'Standard deviation',
      table: 'Show the numbers',
      headers: ['Ticket', 'Finished', 'Cycle time', 'Rolling average'],
    },
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 820 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof ScatterChart>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A dot per ticket, the rolling average over seven tickets and its spread. */
export const ControlChart: Story = {};

/** No ticket finished: the dates still show. */
export const Empty: Story = { args: { points: [] } };

export const Hovered: Story = {
  play: async ({ canvasElement }) => {
    const dot = canvasElement.querySelector('.chart-dot') as SVGCircleElement;
    const box = dot.getBoundingClientRect();
    const plot = canvasElement.querySelector('.chart-plot') as HTMLElement;
    await userEvent.pointer({
      target: plot,
      coords: { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 },
    });
    await expect(canvasElement.querySelector('.chart-tooltip')?.textContent).toContain('SHOP-100');
  },
};

export const WithTable: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText('Show the numbers'));
    await expect(canvas.getByRole('link', { name: 'SHOP-135' })).toBeVisible();
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
