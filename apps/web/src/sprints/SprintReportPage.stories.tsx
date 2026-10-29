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

/** Completed and open tickets, one added after the start, one re-estimated. */
export const Report: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('3h → 5h')).toBeVisible();
  },
};
