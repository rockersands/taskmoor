import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { DonutChart } from './DonutChart';

const percent = (v: number) => `${Math.round(v * 100)}%`;

const meta = {
  title: 'Reports/DonutChart',
  component: DonutChart,
  args: {
    title: 'Tickets by priority',
    summary: 'How 41 tickets divide by priority.',
    slices: [
      { id: 'medium', label: 'Medium', value: 17 },
      { id: 'high', label: 'High', value: 11 },
      { id: 'low', label: 'Low', value: 8 },
      { id: 'none', label: 'None', value: 3 },
      { id: 'urgent', label: 'Urgent', value: 2 },
    ],
    format: String,
    formatShare: percent,
    formatEntry: (v: number, s: number) => `${v} · ${percent(s)}`,
    tableLabel: 'Show the numbers',
    headers: ['Value', 'Tickets', 'Share'],
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 520 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof DonutChart>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Five values in the categorical hues' order, numbers beside each swatch. */
export const Priorities: Story = {};

/** Six, the most a ring shows; the page folds the rest into one. */
export const Six: Story = {
  args: {
    slices: ['A', 'B', 'C', 'D', 'E', 'F'].map((label, i) => ({ id: label, label, value: 6 - i })),
  },
};

export const WithTable: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText('Show the numbers'));
    await expect(canvas.getByRole('table')).toBeVisible();
  },
};
