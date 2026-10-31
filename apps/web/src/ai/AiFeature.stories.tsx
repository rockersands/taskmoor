import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { AiFeature, type AiFeatures } from './AiFeature';

const meta = {
  title: 'AI/AiFeature',
  component: AiFeature,
  args: {
    feature: 'summarize',
    load: async (): Promise<AiFeatures> => ({ summarize: { available: true } }),
    children: (
      <button type="button" className="button-secondary">
        Summarise
      </button>
    ),
  },
} satisfies Meta<typeof AiFeature>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Available: the control shows. */
export const Available: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole('button', { name: 'Summarise' }),
    ).toBeVisible();
  },
};

/** Switched off (here by strict mode): nothing shows. */
export const Hidden: Story = {
  args: {
    load: async (): Promise<AiFeatures> => ({
      summarize: { available: false, reason: 'strict' },
    }),
  },
};
