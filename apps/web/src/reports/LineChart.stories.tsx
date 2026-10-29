import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { LineChart } from './LineChart';

const hours = (v: number) => `${Math.round((v / 3600) * 10) / 10}h`;
const H = 3600;
const days = [
  'Oct 26',
  'Oct 27',
  'Oct 28',
  'Oct 29',
  'Oct 30',
  'Oct 31',
  'Nov 1',
  'Nov 2',
  'Nov 3',
  'Nov 4',
];

const meta = {
  title: 'Reports/LineChart',
  component: LineChart,
  args: {
    title: 'Burndown',
    summary: 'Burndown: 8h at the start, 3h remaining now.',
    xLabels: days,
    series: [
      {
        id: 'remaining',
        label: 'Remaining',
        tone: 'one',
        values: [8, 6, 6, 4, 5, 5, 3, 3, null, null].map((v) => (v === null ? null : v * H)),
      },
      {
        id: 'guideline',
        label: 'Guideline',
        tone: 'guide',
        values: days.map((_, i) => 8 * H * (1 - i / 9)),
      },
    ],
    format: hours,
    unit: H,
    tableLabel: 'Show the numbers',
    xHeader: 'Day',
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 720 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof LineChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Burndown: Story = {};

export const Burnup: Story = {
  args: {
    title: 'Burnup',
    summary: 'Burnup: 6h completed of 9h in scope.',
    series: [
      {
        id: 'completed',
        label: 'Completed',
        tone: 'one',
        values: [0, 2, 2, 4, 4, 4, 6, 6, null, null].map((v) => (v === null ? null : v * H)),
      },
      {
        id: 'scope',
        label: 'Scope',
        tone: 'two',
        values: [8, 8, 8, 8, 9, 9, 9, 9, null, null].map((v) => (v === null ? null : v * H)),
      },
    ],
  },
};

export const Hovered: Story = {
  play: async ({ canvasElement }) => {
    const plot = canvasElement.querySelector('.chart-plot') as HTMLElement;
    const box = plot.getBoundingClientRect();
    await userEvent.pointer({
      target: plot,
      coords: { clientX: box.left + box.width / 2, clientY: box.top + 60 },
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
