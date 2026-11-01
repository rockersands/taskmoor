import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { fakeAiNoticeClient } from '../admin/aiUsageFixtures';
import { allAiFeatures, fakeAiClient, noAiFeatures } from './aiFixtures';
import { SummaryPanel } from './SummaryPanel';

const meta = {
  title: 'AI/SummaryPanel',
  component: SummaryPanel,
  args: {
    ticket: { id: 7, key: 'SHOP-7' },
    trackId: 1,
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
} satisfies Meta<typeof SummaryPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A summary streamed in, each cited comment a numbered link to it. */
export const Summarised: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Summarise ticket' }));
    const cite = await canvas.findByRole('link', { name: 'Comment 1, by Ana Ortiz' });
    await expect(cite).toHaveAttribute('href', expect.stringContaining('comment=11'));
    await expect(canvas.getByText(/Cites 2 comments/)).toBeVisible();
  },
};

/** The first use: the AI notice, then the summary once it is read. */
export const FirstUse: Story = {
  args: { notice: fakeAiNoticeClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Summarise comments' }));
    await userEvent.click(await canvas.findByRole('button', { name: 'I understand' }));
    // Comment 2 is cited twice: two links to it.
    await expect(await canvas.findAllByRole('link', { name: /Comment 2/ })).toHaveLength(2);
  },
};

/** Cancelled while it was being written: what came so far stays, marked as cancelled. */
export const Cancelled: Story = {
  args: { client: fakeAiClient({ pieceMs: 300 }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Summarise ticket' }));
    await userEvent.click(await canvas.findByRole('button', { name: 'Cancel' }));
    await expect(await canvas.findByText(/Cancelled/)).toBeVisible();
  },
};

/** The provider declined: its words are not shown, only why. */
export const Refused: Story = {
  args: { client: fakeAiClient({ summary: { status: 'refused' } }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Summarise ticket' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(
      'AI could not help with this request.',
    );
  },
};

/** No provider set up: nothing shows (NFR-011). */
export const Hidden: Story = {
  args: { features: noAiFeatures },
  play: async ({ canvasElement }) => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(within(canvasElement).queryByRole('button')).toBeNull();
  },
};
