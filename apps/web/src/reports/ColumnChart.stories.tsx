import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent } from 'storybook/test';
import { ColumnChart } from './ColumnChart';

const meta = {
  title: 'Reports/ColumnChart',
  component: ColumnChart,
  args: {
    title: 'Velocity',
    summary: 'Velocity of the last 5 sprints: 23 points completed on average.',
    categories: [5, 6, 7, 8, 9].map((n) => ({ key: String(n), label: `Sprint ${n}` })),
    series: [
      { id: 'committed', label: 'Committed', tone: 'two', values: [30, 28, 34, 26, 31] },
      { id: 'completed', label: 'Completed', tone: 'one', values: [24, 21, 30, 18, 22] },
    ],
    format: String,
    tableLabel: 'Show the numbers',
    categoryHeader: 'Sprint',
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 720 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof ColumnChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Velocity: Story = {};

export const OneSprint: Story = {
  args: {
    categories: [{ key: '1', label: 'Sprint 1' }],
    series: [
      { id: 'committed', label: 'Committed', tone: 'two', values: [13] },
      { id: 'completed', label: 'Completed', tone: 'one', values: [8] },
    ],
  },
};

export const Hovered: Story = {
  play: async ({ canvasElement }) => {
    const hit = canvasElement.querySelectorAll('.chart-hit')[2] as Element;
    await userEvent.hover(hit);
    await expect(canvasElement.querySelector('.chart-tooltip')?.textContent).toContain('Sprint 7');
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
