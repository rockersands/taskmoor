import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { fakeAiNoticeClient } from '../admin/aiUsageFixtures';
import { allAiFeatures, fakeAiClient } from './aiFixtures';
import { DraftFromText } from './DraftFromText';

const meta = {
  title: 'AI/DraftFromText',
  component: DraftFromText,
  args: {
    track: 'SHOP',
    trackId: 1,
    onUse: fn(),
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
} satisfies Meta<typeof DraftFromText>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Pasted text becomes proposals; using one hands it to the form, which creates nothing yet. */
export const Drafted: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Draft from text' }));
    await userEvent.type(
      canvas.getByRole('textbox', { name: 'Paste notes, an email or a bug report' }),
      'Refunds do nothing on Safari. Also ask why.',
    );
    await userEvent.click(canvas.getByRole('button', { name: 'Draft' }));
    const use = await canvas.findByRole('button', {
      name: 'Use the draft Refund button does nothing on Safari',
    });
    await userEvent.click(use);
    await expect(args.onUse).toHaveBeenCalledOnce();
  },
};
