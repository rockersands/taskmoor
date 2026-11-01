import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { fakeAiNoticeClient } from '../admin/aiUsageFixtures';
import { AskQuery } from './AskQuery';
import { allAiFeatures, fakeAiClient } from './aiFixtures';

const meta = {
  title: 'AI/AskQuery',
  component: AskQuery,
  args: {
    onRun: fn(),
    client: fakeAiClient(),
    notice: fakeAiNoticeClient('2026-10-30T09:00:00Z'),
    features: allAiFeatures,
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 720 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof AskQuery>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A question becomes a query to edit, with what it means; Run runs it. */
export const Asked: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.type(
      await canvas.findByRole('textbox', { name: 'Your question' }),
      'my open bugs updated this week',
    );
    await userEvent.click(canvas.getByRole('button', { name: 'Ask' }));
    const query = await canvas.findByRole('textbox', { name: 'Query to run (you can edit it)' });
    await expect(query).toHaveValue(
      'assignee = currentUser() AND type = Bug AND stage != closed AND updated >= startOfWeek()',
    );
    await expect(canvas.getByText('Your open bugs changed since Sunday.')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Run' }));
    await expect(args.onRun).toHaveBeenCalledOnce();
  },
};

/** A query the server could not parse: shown with why, and Run waits for an edit. */
export const Invalid: Story = {
  args: {
    client: fakeAiClient({
      query: {
        query: 'assignee = = me',
        explanation: 'Your tickets.',
        valid: false,
        problem: { stage: 'parse', message: 'Expected a value' },
      },
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByRole('textbox', { name: 'Your question' }), 'mine');
    await userEvent.click(canvas.getByRole('button', { name: 'Ask' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('Expected a value');
    await expect(canvas.getByRole('button', { name: 'Run' })).toBeDisabled();
  },
};
