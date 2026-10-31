import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { fakeAiNoticeClient } from '../admin/aiUsageFixtures';
import { AiNotice } from './AiNotice';

const meta = {
  title: 'AI/AiNotice',
  component: AiNotice,
  args: { client: fakeAiNoticeClient(), children: <p>The AI feature</p> },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 640 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof AiNotice>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A person's first use: the notice, then the feature once they have read it. */
export const FirstUse: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'I understand' }));
    await expect(await canvas.findByText('The AI feature')).toBeVisible();
  },
};

export const AlreadyRead: Story = {
  args: { client: fakeAiNoticeClient('2026-10-30T09:00:00Z') },
};
