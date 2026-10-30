import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { CalendarPage } from './CalendarPage';
import { fakeCalendarClient } from './fixtures';

const meta = {
  title: 'Views/CalendarPage',
  component: CalendarPage,
  args: {
    trackKey: 'CAL',
    client: fakeCalendarClient(),
    now: () => new Date('2026-11-06T09:00:00Z'),
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof CalendarPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** November with due and start days, a sprint, a release and today. */
export const Month: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'November 2026' })).toBeVisible();
    await expect(canvas.getByText('◆ Launch')).toBeVisible();
  },
};
