import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { type DuplicateAnswer, DuplicateSuggestions } from './DuplicateSuggestions';

const embeddings: DuplicateAnswer = {
  similar: [
    {
      ticket: { id: 4, key: 'SHOP-4', summary: 'Expired card leaves checkout blank' },
      score: 0.82,
    },
    { ticket: { id: 9, key: 'SHOP-9', summary: 'Card form loses the expiry date' }, score: 0.61 },
  ],
};

const meta = {
  title: 'Tickets/DuplicateSuggestions',
  component: DuplicateSuggestions,
  args: {
    text: 'Checkout is blank with an expired card',
    track: 'SHOP',
    lookup: async () => embeddings,
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 640 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof DuplicateSuggestions>;

export default meta;
type Story = StoryObj<typeof meta>;

/** From the bundled embedding model alone: no AI key needed (AI-016 (2)). */
export const FromEmbeddings: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('link', { name: 'SHOP-4: Expired card leaves checkout blank' }),
    ).toBeVisible();
  },
};

/** Re-ranked by a model, with its reasons marked as written by AI. */
export const WithReasons: Story = {
  args: {
    reasons: true,
    lookup: async () => ({
      reranked: true,
      similar: [
        { ...embeddings.similar[0], likely: true, reason: 'Same blank page with an expired card.' },
        { ...embeddings.similar[1], likely: false, reason: 'About the form, not the page.' },
      ] as DuplicateAnswer['similar'],
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText('Likely the same. Same blank page with an expired card.'),
    ).toBeVisible();
    await expect(canvas.getByText(/Ordered by AI/)).toBeVisible();
  },
};
